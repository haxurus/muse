# Production deployment on VPS01

This fork keeps upstream integration separate from production:

- `master` is reserved for tracking `museofficial/muse`;
- `main` is the hardened Haxurus production branch;
- production images are built from `main` and published to `ghcr.io/haxurus/muse`;
- the VPS deploys immutable image digests only.

The five music workers and orchestrator publish no host ports. The web dashboard is exposed only through the secret-free `dashboard-edge` container on the existing `proxy_net`, so Nginx Proxy Manager remains the single HTTPS ingress.

## 1. Set the production branch as default

In GitHub repository settings, set the default branch to `main`.

The GitHub connector used to prepare this fork cannot change repository administration settings, so this is intentionally a manual repository-setting step. Keep `master` available for upstream synchronization.

## 2. Create the deploy SSH key

On a trusted workstation:

```bash
ssh-keygen -t ed25519 -a 100 -f muse_deploy -C "muse-github-actions"
```

Keep `muse_deploy` private. The `.pub` file is used once by the VPS installer.

## 3. SSH AllowUsers preflight

VPS01 restricts SSH users. Before running the installer, add `muse-deploy` to the existing `AllowUsers` directive.

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
```

The installer creates:

```text
/srv/docker/muse/
├── .env
├── docker-compose.yml
├── config/
├── data/
├── backups/
├── secrets/
└── .deploy-state/
```

It also creates the restricted `muse-deploy` account, installs the forced SSH command, deploy/rollback scripts and the persistent Muse egress firewall unit.

The deploy account is not added to the Docker group and cannot execute arbitrary commands through its deployment key.

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
```

Replace the dashboard URL and client ID before deployment. Configure the Discord OAuth redirect URI as:

```text
https://<dashboard-host>/auth/discord/callback
```

See [DASHBOARD.md](DASHBOARD.md) for the complete OAuth and security model.

Keep `YT_DLP_AUTO_UPDATE=false` in the hardened container. Updating executables inside a running read-only container defeats immutable-image deployment. Refresh yt-dlp by rebuilding the image instead.

## 7. Configure Nginx Proxy Manager

Create a Proxy Host for the dashboard hostname and forward it to:

```text
muse-dashboard:8080
```

Do not expose or proxy ports 3000, 3100, or 3101 directly.

## 8. GitHub production environment

Create a GitHub Environment named `production`, restrict it to `main`, and add:

- `VPS_HOST`
- `VPS_PORT`
- `VPS_DEPLOY_KEY`
- `VPS_KNOWN_HOSTS`

Create repository variable:

```text
ENABLE_VPS_DEPLOY=true
```

Until this variable is `true`, images can be built but the VPS deployment job is skipped.

`VPS_KNOWN_HOSTS` must contain a host key verified from the VPS itself. Do not disable SSH host-key verification in CI.

## 9. GHCR

The easiest deployment is to make the `haxurus/muse` container package public.

If the package remains private, authenticate the root Docker client on VPS01 once using a read-only package token. Do not place that token in the repository or application container.

## 10. Deployment flow

A push to `main` performs:

```text
source
  |
  v
multi-arch Docker build
  |
  v
GHCR + SBOM + provenance
  |
  v
immutable manifest digest
  |
  v
restricted SSH forced-command
  |
  v
stop current Muse
  |
  v
SQLite backup
  |
  v
start new digest + Prisma migration
  |
  v
Discord readiness health check
  |
  +--> healthy: commit release state
  |
  +--> failure: restore DB + previous image
```

Muse is considered healthy only after the Discord client has reached ready state and command registration has completed.

## 11. Backups

Before replacing a running release the deploy script stops Muse cleanly and archives all five worker SQLite databases plus the orchestrator's per-guild group state.

Backups are stored in:

```text
/srv/docker/muse/backups/
```

They are root-only and files older than 14 days are removed automatically.

The audio cache is intentionally excluded. The orchestrator group file is included so X+Y layouts are restored together with a rollback.

## 12. Status and rollback

From an administrative VPS shell:

```bash
sudo /usr/local/sbin/muse-deploy status
sudo /usr/local/sbin/muse-deploy rollback
```

Rollback can also be launched through GitHub Actions -> **Rollback production**.

## 13. Network model

The worker and control services have no inbound host ports.

Networks are segmented as follows:

- `proxy_net`: NPM <-> secret-free dashboard edge only;
- `dashboard-web`: edge <-> dashboard;
- `dashboard-control`: dashboard <-> orchestrator;
- `muse-c01` ... `muse-c05`: orchestrator <-> one worker each;
- `muse-eg`: filtered outbound Internet access for music workers;
- `muse-deg`: separate filtered outbound Internet access for the OAuth dashboard.

The host firewall blocks private/link-local destinations from the egress bridge and blocks private control bridges from reaching host services.

Do not attach the dashboard, orchestrator, or workers to Sentinel networks or the Docker socket.
