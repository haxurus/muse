# Production deployment on VPS01

This fork keeps upstream integration separate from production:

- `master` is reserved for tracking `museofficial/muse`;
- `main` is the hardened Haxurus production branch;
- production images are built from `main` and published to `ghcr.io/haxurus/muse`;
- the VPS deploys immutable image digests only.

The five music workers and orchestrator publish no host ports. The web dashboard is exposed only through the secret-free `dashboard-edge` container, which joins a dedicated internal Docker network (`muse-edge`) shared with Nginx Proxy Manager only. NPM remains the single HTTPS ingress; the edge is never attached to `proxy_net`, so it cannot reach WordPress, Sentinel or anything else on that network.

## 1. Pre-production checklist

Work through this list in order. `ENABLE_VPS_DEPLOY` is deliberately the last step.

GitHub:

1. Default branch is `main` (Settings -> General).
2. Upstream workflows inherited on `master` are disabled (Actions -> select each workflow that only exists on `master` -> **Disable workflow**), so nothing upstream-specific can publish or run with this repository's token.
3. Branch protection (or a ruleset) on `main`: pull request required, the `CI` checks (`validate`, `shell`) required, force pushes and deletion blocked.
4. Settings -> Actions -> General -> Workflow permissions: **Read repository contents** by default, and **Allow GitHub Actions to create and approve pull requests** enabled (needed only by the yt-dlp refresh workflow to open its bump PR).
5. Settings -> Code security: **Private vulnerability reporting** enabled (see [SECURITY.md](../SECURITY.md)) and Dependabot alerts enabled.
6. Environment `production`: deployment branches restricted to `main`, at least one **required reviewer**, and environment secrets `VPS_HOST`, `VPS_PORT`, `VPS_DEPLOY_KEY`, `VPS_KNOWN_HOSTS` (see section 9).

VPS:

7. DNS resolver: note what `/etc/resolv.conf` (and `resolvectl dns` with systemd-resolved) points to. The firewall allows DNS from the Muse egress bridges to those resolvers automatically; if you change resolvers later, rerun `sudo /usr/local/sbin/muse-host-firewall`.
8. Firewall backend: Docker must use the iptables backend (`iptables-nft` or legacy both work). Verify after Docker is running: `sudo iptables -S FORWARD | grep DOCKER-USER` shows a jump. With Docker's experimental nftables backend the Muse rules would not apply. If firewalld or `netfilter-persistent` reload the ruleset at runtime, rerun the Muse firewall afterwards.
9. IPv6: all Muse networks are created with IPv6 disabled. Check with `docker network inspect muse_egress --format '{{.EnableIPv6}}'` (after the first deploy) and confirm `sudo ip6tables -S MUSE-FORWARD` exists when the host has IPv6.
10. `net.bridge.bridge-nf-call-iptables`: if it is not `1`, the firewall prints a warning; `muse-edge` stays an internal network, but peer-to-peer filtering on it is then not enforced.
11. SSH `AllowUsers` includes `muse-deploy` (section 3).
12. Nginx Proxy Manager is attached to `muse-edge` and the attachment is persisted in NPM's Compose file (section 7).
13. Off-host backups: `/srv/docker/muse/backups` lives on the same disk as the data. Copy it (and the secrets, encrypted) to another host on a schedule.

Discord:

14. Five bot applications exist, one per worker, each token stored in its own secret file.
15. The dashboard OAuth application has `https://<dashboard-host>/auth/discord/callback` registered as redirect URI.

Finally:

16. The first deploy was run manually and passed (section 10).
17. Only then set the repository variable `ENABLE_VPS_DEPLOY=true`.

## 2. Create the deploy SSH key

On a trusted workstation:

```bash
ssh-keygen -t ed25519 -a 100 -f muse_deploy -C "muse-github-actions"
```

Keep `muse_deploy` private. The `.pub` file is used once by the VPS installer.

## 3. SSH AllowUsers preflight

VPS01 restricts SSH users. Before running the installer, add `muse-deploy` to the existing `AllowUsers` directive yourself; the installer never edits it and stops with instructions when the user is missing.

Example:

```text
AllowUsers user007 sentinel-deploy muse-deploy
```

Validate before reloading SSH:

```bash
sudo sshd -t
sudo systemctl reload ssh
sudo sshd -T | grep '^allowusers'
```

Do not close the existing administrative SSH session until the new configuration has been verified.

## 4. Install the production infrastructure

Clone the repository temporarily on the VPS:

```bash
git clone --branch main https://github.com/haxurus/muse.git /tmp/muse
cd /tmp/muse
sudo ./ops/install-vps.sh /path/to/muse_deploy.pub
# Optionally attach NPM in the same run:
# sudo MUSE_NPM_CONTAINER=<npm-container-name> ./ops/install-vps.sh /path/to/muse_deploy.pub
```

The installer creates:

```text
/srv/docker/muse/
├── .env
├── docker-compose.yml
├── config/workers.json
├── overlays/            playback pilot overlays
├── data/
├── backups/
├── secrets/
└── .deploy-state/
```

and additionally:

- the internal Docker network `muse-edge` (bridge `muse-ed`) for the dashboard edge;
- the `muse-deploy` account, whose only key lives in the root-owned `/etc/ssh/authorized_keys/muse-deploy` with `restrict,command="/usr/local/libexec/muse-deploy-entrypoint"`;
- `/etc/ssh/sshd_config.d/60-muse-deploy.conf` (`Match User muse-deploy`: root-owned `AuthorizedKeysFile`, public key only, no TTY or forwarding). It is validated with `sshd -t` before SSH is reloaded and removed again if validation fails;
- `/etc/sudoers.d/muse-deploy`, validated with `visudo -cf`, allowing exactly `muse-deploy status`, `muse-deploy rollback` and `muse-deploy deploy ghcr.io/haxurus/muse@sha256:*`;
- `/usr/local/sbin/muse-deploy`, `/usr/local/sbin/muse-host-firewall` and the `muse-firewall.service` unit.

The deploy account is not added to the Docker group and cannot execute arbitrary commands through its deployment key.

The Compose file, `workers.json` and overlays are copied from the checkout only when they do not exist yet. After that, every deploy installs the copies shipped inside the deployed image (section 11), so the VPS configuration always matches the running release and rerunning an old checkout of the installer never downgrades it. Rerunning the installer is safe and also migrates an older installation (key moved out of the home directory, sudoers tightened, firewall chains replaced).

## 5. Configure runtime secrets

Edit secrets through a root editor:

```bash
sudoedit /srv/docker/muse/secrets/discord_token_01
sudoedit /srv/docker/muse/secrets/discord_token_02
sudoedit /srv/docker/muse/secrets/discord_token_03
sudoedit /srv/docker/muse/secrets/discord_token_04
sudoedit /srv/docker/muse/secrets/discord_token_05
sudoedit /srv/docker/muse/secrets/youtube_api_key
sudoedit /srv/docker/muse/secrets/dashboard_discord_client_secret
sudoedit /srv/docker/muse/secrets/spotify_client_id
sudoedit /srv/docker/muse/secrets/spotify_client_secret
```

Spotify is optional. If disabled, keep both Spotify files empty.

Verify permissions:

```bash
sudo find /srv/docker/muse/secrets -maxdepth 1 -type f -printf '%m %u:%g %p\n'
```

The runtime secret files are installed as `640 root:10001`, so the non-root Muse runtime can read only the secrets explicitly mounted into its container.

## 6. Configure non-secret settings

Edit:

```bash
sudoedit /srv/docker/muse/.env
```

Recommended baseline:

```dotenv
CACHE_LIMIT=2GB
REGISTER_COMMANDS_ON_BOT=false
ENABLE_SPONSORBLOCK=false
BOT_STATUS=online
BOT_ACTIVITY_TYPE=LISTENING
BOT_ACTIVITY=music
ALLOW_HTTP_STREAMS=false
HTTP_STREAM_ALLOWED_HOSTS=
MUSE_DASHBOARD_PUBLIC_URL=https://music.example.com
MUSE_DASHBOARD_DISCORD_CLIENT_ID=000000000000000000
MUSE_DASHBOARD_SESSION_HOURS=8
MUSE_COMPOSE_OVERLAYS=
```

Replace the dashboard URL and client ID before deployment. Configure the Discord OAuth redirect URI as:

```text
https://<dashboard-host>/auth/discord/callback
```

See [DASHBOARD.md](DASHBOARD.md) for the complete OAuth and security model.

`MUSE_IMAGE` is managed by `muse-deploy`; the placeholder digest from the example is never deployed.

`MUSE_COMPOSE_OVERLAYS` selects playback pilot overlays as a comma-separated list without spaces, for example `bot-one-playback,bot-two-playback`. Allowed names are `bot-one-playback`, `bot-two-playback`, `bot-three-playback`, `bot-four-playback` and `bot-five-playback`; anything else makes `muse-deploy` refuse to run. Every Compose call made by `muse-deploy` (validation, start, health checks, status) uses the same file list. A changed selection takes effect at the next deploy.

Keep `YT_DLP_AUTO_UPDATE=false` in the hardened container. Updating executables inside a running read-only container defeats immutable-image deployment. yt-dlp is refreshed through the pinned version in the image (section 15).

## 7. Configure Nginx Proxy Manager

Attach the NPM container to the `muse-edge` network once:

```bash
docker network connect muse-edge <npm-container-name>
```

`docker network connect` does not survive the NPM container being recreated, so also declare the network in NPM's own Compose file:

```yaml
services:
  npm:
    networks:
      - proxy_net
      - muse-edge

networks:
  muse-edge:
    external: true
```

Then create a Proxy Host for the dashboard hostname and forward it to:

```text
muse-dashboard:8080
```

Do not expose or proxy ports 3000, 3100, or 3101 directly. Attach nothing other than NPM to `muse-edge`.

## 8. Firewall

`muse-firewall.service` runs `/usr/local/sbin/muse-host-firewall` before `docker.service` at boot, so no Muse bridge is ever unfiltered. It creates `DOCKER-USER` if Docker has not yet done so (Docker keeps an existing chain) and maintains its own chains `MUSE-FORWARD` and `MUSE-INPUT`, rebuilt idempotently on every run:

- egress bridges `muse-eg` / `muse-deg`: DNS to the detected host resolvers allowed, then private, loopback, CGNAT, link-local, multicast and reserved IPv4 destinations rejected;
- edge bridge `muse-ed`: only new TCP connections to port 8080 between peers on the bridge (NPM -> edge); anything the edge initiates is rejected;
- every Muse bridge: no connections to services on the host itself;
- IPv6 (best effort when `ip6tables` is available): all traffic from or to Muse bridges rejected.

To remove every rule the script owns:

```bash
sudo /usr/local/sbin/muse-host-firewall --remove
```

## 9. GitHub production environment

Create a GitHub Environment named `production`, restrict it to `main`, require a reviewer, and add:

- `VPS_HOST`
- `VPS_PORT`
- `VPS_DEPLOY_KEY`
- `VPS_KNOWN_HOSTS`

`VPS_KNOWN_HOSTS` must contain a host key verified from the VPS itself (for example the output of `ssh-keyscan` compared against `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the VPS). Do not disable SSH host-key verification in CI.

Until the repository variable `ENABLE_VPS_DEPLOY` is `true`, images are built but the VPS deployment job is skipped.

Deploy and rollback jobs share the `muse-production` concurrency group, so they never run at the same time. On the VPS, `muse-deploy` additionally holds an exclusive `flock` on `/run/lock/muse-deploy.lock` for `deploy` and `rollback`; a second invocation exits with status 75 instead of waiting.

## 10. First manual deploy

Run the first deploy by hand, with `ENABLE_VPS_DEPLOY` still unset:

1. Push to `main` (or run **Deploy production** manually) and wait for the `build` job.
2. Copy the digest from the build job summary (`sha256:...`), or look it up:
   ```bash
   gh api /users/haxurus/packages/container/muse/versions --jq '.[0].name'
   ```
3. Optionally verify the provenance attestation on a trusted machine:
   ```bash
   gh attestation verify oci://ghcr.io/haxurus/muse@sha256:<digest> --repo haxurus/muse
   ```
4. On the VPS:
   ```bash
   sudo /usr/local/sbin/muse-deploy deploy ghcr.io/haxurus/muse@sha256:<digest>
   sudo /usr/local/sbin/muse-deploy status
   ```
5. Open the dashboard through NPM, sign in with Discord and check that all five workers report ready.
6. Test the restricted path from your workstation with the deploy key: `ssh -i muse_deploy muse-deploy@<vps> status` must print the status and nothing else is accepted.

Only after this succeeds set `ENABLE_VPS_DEPLOY=true`.

## 11. Deployment flow

`muse-deploy deploy <digest>` performs, under the deploy lock:

```text
validate digest, secrets, dashboard settings, muse-edge network
  |
docker pull <digest>
  |
extract /opt/muse-deploy from the image (Compose file, workers.json, overlays)
  |
docker compose config -q with the real .env, the selected overlays and the new digest
  |  (any failure stops here; nothing on the VPS has changed)
snapshot the currently installed configuration
  |
stop every container of the project and verify none is running
  |
back up worker SQLite databases + orchestrator groups (pre-deploy backup)
  |
install the new configuration, set MUSE_IMAGE, compose up
  |
wait until all eight services are healthy (exited/dead containers fail at once)
  |
  +--> healthy: record previous-image, previous-backup, previous-config, current-image
  |
  +--> failure: stop, restore configuration + pre-deploy backup + previous image
```

Muse is considered healthy only after the Discord client has reached ready state and command registration has completed.

Rollback pointers (`previous-image`, `previous-backup`, `previous-config`) are written only after the new release is healthy, and only when the digest actually changed. They always describe one consistent release: its image, the backup of its state taken just before it was replaced, and its Compose configuration.

## 12. Backups

Before replacing a running release the deploy script stops Muse, verifies that no container of the project is still running, and archives all five worker SQLite databases plus the orchestrator's per-guild group state. If any container keeps running the deploy aborts before touching data.

Backups are stored in:

```text
/srv/docker/muse/backups/
```

They are root-only. Archives older than 14 days are removed automatically, except the ones referenced by `.deploy-state/previous-backup` and `.deploy-state/last-backup`.

The audio cache is intentionally excluded. The orchestrator group file is included so X+Y layouts are restored together with a rollback.

## 13. Status and rollback

From an administrative VPS shell:

```bash
sudo /usr/local/sbin/muse-deploy status
sudo /usr/local/sbin/muse-deploy rollback
```

Rollback can also be launched through GitHub Actions -> **Rollback production** (environment approval applies).

`rollback` restores the release recorded in `previous-image` exactly as it was when it was replaced:

1. It refuses unless `previous-image`, `previous-backup` and `previous-config` are all recorded and the backup archive still exists.
2. It validates the previous Compose configuration with the current `.env` and pulls the previous digest.
3. It stops the fleet and verifies that nothing is running.
4. It takes a **safety backup** of the release being rolled back (`backups/muse-rollback-safety-<timestamp>.tar.gz`). The safety backup never replaces the `last-backup` or `previous-backup` pointers.
5. It restores the pre-deploy backup that belongs to the previous image. **Data written since that deploy is discarded from the live data directory** (it remains in the safety backup).
6. It restores the previous Compose file, `workers.json` and overlays, switches `MUSE_IMAGE`, starts the fleet and waits for health.
7. On success the consumed pointers move to `.deploy-state/rolled-back-<timestamp>/` (together with the safety backup path and the replaced image), so a second `rollback` refuses instead of restoring the same state again. Return to the newer release with a normal deploy.
8. If the previous release is not healthy, the original release is restored from the safety backup and its configuration, and the command exits non-zero.

### Manual recovery

`rollback` refuses when no matching backup is recorded, for example after upgrading from a `muse-deploy` version that did not record `previous-backup`, or when the archive was deleted. The forced SSH command offers no override on purpose. Recover from an administrative shell instead:

```bash
sudo docker compose --project-name muse --project-directory /srv/docker/muse \
  --env-file /srv/docker/muse/.env -f /srv/docker/muse/docker-compose.yml stop
sudo docker ps --filter label=com.docker.compose.project=muse   # must be empty
sudo sh -c 'cd /srv/docker/muse && tar -czf "backups/muse-manual-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" data/bot-0*/db.sqlite* data/orchestrator/groups.json'
# Optional: restore a chosen archive (removes newer state):
#   sudo tar -C /srv/docker/muse --no-same-owner -xzf /srv/docker/muse/backups/muse-<timestamp>.tar.gz
#   sudo chown -R 10001:10001 /srv/docker/muse/data
sudo /usr/local/sbin/muse-deploy deploy ghcr.io/haxurus/muse@sha256:<known-good-digest>
```

Redeploying a known-good digest also reinstalls the Compose configuration shipped in that image (images built before the deployment bundle existed cannot be redeployed this way).

## 14. Network model

The worker and control services have no inbound host ports.

Networks are segmented as follows:

- `muse-edge` (`muse-ed`, internal, external to the project): NPM <-> secret-free dashboard edge only;
- `dashboard-web` (`muse-dw`, internal): edge <-> dashboard;
- `dashboard-control` (`muse-dc`, internal): dashboard <-> orchestrator;
- `control-01` ... `control-05` (`muse-c01` ... `muse-c05`, internal): orchestrator <-> one worker each;
- `egress` (`muse-eg`): filtered outbound Internet access for music workers;
- `dashboard-egress` (`muse-deg`): separate filtered outbound Internet access for the OAuth dashboard.

All Muse networks have IPv6 disabled. The host firewall (section 8) blocks private/link-local destinations from the egress bridges, restricts `muse-ed` to NPM -> edge connections, and blocks every Muse bridge from reaching host services.

Do not attach the dashboard, orchestrator, or workers to Sentinel networks, `proxy_net` or the Docker socket.

## 15. Supply chain

- The base image is pinned by multi-arch index digest (`node:22-bookworm-slim@sha256:...`); Dependabot proposes updates against `main`.
- yt-dlp is installed with `pip --require-hashes --only-binary=:all:` from `deploy/yt-dlp-requirements.txt`, which locks yt-dlp and the dependency set yt-dlp publishes as its `pin` extra. `ARG YT_DLP_VERSION` must match the lock; the build fails otherwise.
- The **Refresh yt-dlp pin** workflow checks daily for a new yt-dlp release and opens a pull request bumping `YT_DLP_VERSION` and regenerating the lock with `.github/scripts/yt-dlp-lock.py`. Pull requests opened with `GITHUB_TOKEN` do not start CI on their own: close and reopen the PR to run CI, review, then merge to build and deploy.
- All GitHub Actions are pinned to full commit SHAs; Dependabot keeps them current.
- Images are built for `linux/amd64` and `linux/arm64` (the VPS architecture is not assumed) with SBOM, BuildKit provenance and a GitHub build provenance attestation.
