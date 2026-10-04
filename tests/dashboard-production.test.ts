import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

describe('dashboard production isolation', () => {
  it('keeps the public edge secret-free and the dashboard behind private networks', async () => {
    const compose = await readFile(new URL('../deploy/docker-compose.prod.yml', import.meta.url), 'utf8');

    expect(compose).toContain('dashboard-edge:');
    expect(compose).toContain('muse-dashboard');
    expect(compose).toContain('dashboard_discord_client_secret');
    expect(compose).toContain('dashboard-control:');
    expect(compose).toContain('dashboard-web:');
    expect(compose).toContain('proxy_net:');
    expect(compose).not.toContain('/var/run/docker.sock');
    expect(compose).not.toMatch(/ports:\s*\n/u);
  });

  it('ships the dashboard assets in the hardened image', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');

    expect(dockerfile).toContain('/usr/app/dashboard ./dashboard');
    expect(dockerfile).toContain('USER 10001:10001');
  });
});
