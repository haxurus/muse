# Production deployment on VPS01

This fork keeps upstream integration separate from production:

- `master` is reserved for tracking `museofficial/muse`;
- `main` is the hardened Haxurus production branch;
- production images are built from `main` and published to `ghcr.io/haxurus/muse`;
- the VPS deploys immutable image digests only.

Muse does not need Nginx Proxy Manager and publishes no host ports. Discord Gateway, REST, voice and media traffic are outbound connections.

## 1. Create the deploy SSH key

On a trusted workstation:

```bash
ssh-keygen -t ed25519 -a 100 -f muse_deploy -C "muse-github-actions"
```

Keep `muse_deploy` private. The `.pub` file is used once by the VPS installer.

## 2. SSH AllowUsers preflight

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

## 3. Install the production infrastructure

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
├── data/
├── backups/
├── secrets/
└── .deploy-state/
```

It also creates the restricted `muse-deploy` account, installs the forced SSH command, deploy/rollback scripts and the persistent Muse egress firewall unit.

The deploy account is not added to the Docker group and cannot execute arbitrary commands through its deployment key.

## 4. Configure runtime secrets

Edit secrets through a root editor:

```bash
sudoedit /srv/docker/muse/secrets/discord_token
sudoedit /srv/docker/muse/secrets/youtube_api_key
sudoedit /srv/docker/muse/secrets/spotify_client_id
sudoedit /srv/docker/muse/secrets/spotify_client_secret
```

Spotify is optional. If disabled, keep both Spotify files empty.

Verify permissions:

```bash
sudo find /srv/docker/muse/secrets -maxdepth 1 -type f -printf '%m %u:%g %p\n'
```

The expected host permissions are `600 root:root`.

## 5. Configure non-secret settings

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
```

Keep `YT_DLP_AUTO_UPDATE=false` in the hardened container. Updating executables inside a running read-only container defeats immutable-image deployment. Refresh yt-dlp by rebuilding the image instead.

## 6. GitHub production environment

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

## 7. GHCR

The easiest deployment is to make the `haxurus/muse` container package public.

If the package remains private, authenticate the root Docker client on VPS01 once using a read-only package token. Do not place that token in the repository or application container.

## 8. Deployment flow

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

## 9. Backups

Before replacing a running release the deploy script stops Muse cleanly and archives the SQLite database.

Backups are stored in:

```text
/srv/docker/muse/backups/
```

They are root-only and files older than 14 days are removed automatically.

The audio cache is intentionally excluded.

## 10. Status and rollback

From an administrative VPS shell:

```bash
sudo /usr/local/sbin/muse-deploy status
sudo /usr/local/sbin/muse-deploy rollback
```

Rollback can also be launched through GitHub Actions -> **Rollback production**.

## 11. Network model

The bot has no inbound application ports.

The dedicated bridge is named:

```text
muse-eg
```

The host firewall blocks traffic arriving from this bridge toward services on the VPS and blocks forwarded access to private, link-local and other non-public ranges. Public outbound traffic remains available for Discord, YouTube, SoundCloud, Spotify and approved integrations.

Do not attach Muse to `proxy_net`, database networks, Sentinel networks, or the Docker socket.
