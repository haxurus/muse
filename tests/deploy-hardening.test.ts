import {readdir, readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const read = async (path: string) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

const overlayNames = async () => (await readdir(new URL('../deploy/', import.meta.url)))
  .map(file => /^docker-compose\.(bot-[a-z]+-playback)\.yml$/u.exec(file)?.[1])
  .filter((name): name is string => name !== undefined)
  .sort();

describe('image supply chain', () => {
  it('pins the base image by digest and installs a hash-locked yt-dlp', async () => {
    const dockerfile = await read('Dockerfile');
    const lock = await read('deploy/yt-dlp-requirements.txt');

    expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64} AS base$/mu);
    const version = /^ARG YT_DLP_VERSION=(\S+)$/mu.exec(dockerfile)?.[1];
    expect(version).toMatch(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/u);
    expect(lock.split('\n')).toContain(`yt-dlp[default]==${version ?? ''} \\`);
    expect(dockerfile).toContain('--require-hashes --only-binary=:all:');

    for (const requirement of lock.split('\n').filter(line => /^[a-z]/u.test(line))) {
      expect(requirement).toMatch(/^[a-z0-9-]+(\[default\])?==\S+ \\$/u);
    }
  });

  it('keeps application files root-owned and ships the deployment bundle', async () => {
    const dockerfile = await read('Dockerfile');

    expect(dockerfile).not.toMatch(/--chown=10001/u);
    expect(dockerfile).toContain('CHECKPOINT_DISABLE=1');
    expect(dockerfile).toContain('/opt/muse-deploy/');
    expect(dockerfile).toContain('deploy/docker-compose.prod.yml');
    expect(dockerfile).toContain('deploy/workers.json');
    for (const name of await overlayNames()) {
      expect(dockerfile).toContain(`deploy/docker-compose.${name}.yml`);
    }
  });

  it('keeps secrets and env files out of the build context', async () => {
    const dockerignore = (await read('.dockerignore')).split('\n').map(line => line.trim());

    expect(dockerignore).toEqual(expect.arrayContaining(['**/secrets', '**/.env', '**/.env.*']));
  });
});

describe('deploy tooling', () => {
  it('serialises deploy and rollback on the VPS and in GitHub Actions', async () => {
    const muse = await read('ops/muse-deploy');
    const deploy = await read('.github/workflows/deploy.yml');
    const rollback = await read('.github/workflows/rollback.yml');

    expect(muse).toContain('flock -n 9');
    expect(muse).toContain('die 75');
    expect(deploy).toContain('group: muse-production');
    expect(rollback).toContain('group: muse-production');
  });

  it('accepts exactly the overlays that exist in deploy/', async () => {
    const muse = await read('ops/muse-deploy');
    const install = await read('ops/install-vps.sh');
    const allowed = /^ALLOWED_OVERLAYS=\(([^)]*)\)$/mu.exec(muse)?.[1].split(' ').sort();
    const installed = /^OVERLAYS=\(([^)]*)\)$/mu.exec(install)?.[1].split(' ').sort();

    expect(allowed).toEqual(await overlayNames());
    expect(installed).toEqual(await overlayNames());
  });

  it('records rollback pointers only after the new release is healthy', async () => {
    const muse = await read('ops/muse-deploy');
    const deployBody = muse.slice(muse.indexOf('deploy_image() {'), muse.indexOf('rollback() {'));

    expect(deployBody.indexOf('if start_fleet; then')).toBeGreaterThan(-1);
    expect(deployBody.indexOf('write_state "$PREVIOUS" "$old"'))
      .toBeGreaterThan(deployBody.indexOf('if start_fleet; then'));
    expect(muse).toContain('compose ps -a -q');
    expect(muse).toContain('muse-rollback-safety');
  });

  it('prunes old Muse images and guards disk space before pulling a release', async () => {
    const muse = await read('ops/muse-deploy');
    const deployBody = muse.slice(muse.indexOf('deploy_image() {'), muse.indexOf('rollback() {'));
    const rollbackBody = muse.slice(muse.indexOf('rollback() {'), muse.indexOf('status() {'));

    expect(muse).toContain('IMAGE_REPO=ghcr.io/haxurus/muse');
    expect(muse).toContain('DISK_PRUNE_BELOW_KB=$((5 * 1024 * 1024))');
    expect(muse).toContain('DISK_REFUSE_BELOW_KB=$((3 * 1024 * 1024))');
    expect(deployBody.indexOf('ensure_disk_space "$image" "$old"'))
      .toBeLessThan(deployBody.indexOf('docker pull "$image"'));
    expect(deployBody.indexOf('prune_images "$image"'))
      .toBeGreaterThan(deployBody.indexOf('write_state "$CURRENT" "$image"'));
    expect(rollbackBody.indexOf('ensure_disk_space "$target" "$current"'))
      .toBeLessThan(rollbackBody.indexOf('docker pull "$target"'));
    expect(rollbackBody).toContain('prune_images "$current"');
  });

  it('fails fast when a service restarts during startup', async () => {
    const muse = await read('ops/muse-deploy');
    expect(muse).toContain('{{.RestartCount}}');
    expect(muse).toContain('"$state" == "restarting"');
  });

  it('limits the deploy account to the three forced-command operations', async () => {
    const install = await read('ops/install-vps.sh');
    const entrypoint = await read('ops/muse-deploy-entrypoint');

    expect(install).toContain('muse-deploy ALL=(root) NOPASSWD: /usr/local/sbin/muse-deploy status, /usr/local/sbin/muse-deploy rollback, /usr/local/sbin/muse-deploy deploy ghcr.io/haxurus/muse@sha256\\:*');
    expect(install).toContain('AuthorizedKeysFile $KEYS_DIR/%u');
    expect(install).toContain('sshd -t');
    expect(install).not.toMatch(/sed[^\n]*AllowUsers/u);
    expect(entrypoint).toContain('exec sudo -n /usr/local/sbin/muse-deploy');
    // The case pattern must be quoted: an unquoted space is a shell syntax error.
    expect(entrypoint).toContain('"deploy ghcr.io/haxurus/muse@sha256:"*)');
  });
});

describe('network isolation', () => {
  it('disables IPv6 on every project network and keeps the edge off proxy_net', async () => {
    const compose = await read('deploy/docker-compose.prod.yml');
    const networks = compose.slice(compose.indexOf('\nnetworks:\n'), compose.indexOf('\nsecrets:\n'));
    const projectNetworks = [...networks.matchAll(/^ {2}([a-z0-9-]+):$/gmu)].map(match => match[1]);

    expect(projectNetworks).toContain('muse-edge');
    expect(networks.match(/enable_ipv6: false/gu)).toHaveLength(projectNetworks.length - 1);
    expect(compose).toContain('com.docker.network.bridge.name: muse-eg');
  });

  it('firewalls the edge bridge, DNS and IPv6 idempotently', async () => {
    const firewall = await read('security/host-firewall.sh');
    const unit = await read('security/muse-firewall.service');

    expect(firewall).toContain('EDGE_IFACE=muse-ed');
    expect(firewall).toContain('--dport 53');
    expect(firewall).toContain('ip6tables');
    expect(firewall).toContain('--remove');
    expect(firewall).not.toMatch(/iptables (?!-w)-[ACDINFLX]/u);
    expect(unit).toContain('Before=network-pre.target docker.service');
    expect(unit).toContain('WantedBy=multi-user.target');
  });
});

describe('GitHub Actions', () => {
  it('pins every action to a full commit SHA', async () => {
    for (const workflow of await readdir(new URL('../.github/workflows/', import.meta.url))) {
      const content = await read(`.github/workflows/${workflow}`);
      for (const [, reference] of content.matchAll(/uses:\s*(\S+)/gu)) {
        expect(reference, `${workflow}: ${reference}`).toMatch(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/u);
      }
    }
  });

  it('only builds and deploys from main with job-level permissions', async () => {
    const deploy = await read('.github/workflows/deploy.yml');

    expect(deploy).toContain('permissions: {}');
    expect(deploy.match(/if: github\.ref == 'refs\/heads\/main'/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(deploy).toContain('BUILD_DATE=${{ steps.meta.outputs.build_date }}');
    expect(deploy).not.toContain('repository.updated_at');
  });
});
