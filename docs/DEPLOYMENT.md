# Muse fleet deployment on VPS01

Production consists of one control plane and five isolated music workers.

```text
Nginx Proxy Manager
        |
        v
    muse-edge
        |
        v
muse-orchestrator
        |
   private control network
        |
  +-----+-----+-----+-----+
  |     |     |     |     |
  v     v     v     v     v
muse-01 ...             muse-05
```

Only `muse-edge` joins `proxy_net`. The orchestrator and music workers are not directly attached to the shared reverse-proxy network.

## Branch model

- `master`: upstream tracking branch.
- `main`: hardened production branch.

Set `main` as the default branch after the orchestrator pull request has been reviewed and merged.

## Discord applications

### Five music bot applications

Create five Discord applications with bot users.

Each application has its own bot credential and should be invited to the Discord servers that may use that worker.

Workers are mapped as:

```text
Music 1 -> muse-01
Music 2 -> muse-02
Music 3 -> muse-03
Music 4 -> muse-04
Music 5 -> muse-05
```

Each worker receives only its own bot credential.

### Dashboard OAuth application

Create a separate Discord application for dashboard login. A bot user is not required for this application.

Add this redirect URI:

```text
https://YOUR-MUSE-DASHBOARD-HOST/auth/callback
```

The orchestrator requests only:

```text
identify guilds
```

The dashboard then filters the returned guilds to servers where the user is the owner or has Manage Server / Administrator permission.

The OAuth access token is used only during login to read the current user and guild list. It is not persisted.

## Deploy SSH key

On a trusted workstation:

```bash
ssh-keygen -t ed25519 -a 100 -f muse_deploy -C "muse-github-actions"
```

Keep the private key for the GitHub production environment. Copy only the public key to the VPS installer.

## SSH AllowUsers preflight

VPS01 currently restricts SSH users.

Before installing, add `muse-deploy` to the existing `AllowUsers` directive while preserving the existing administrative users.

Validate before reloading:

```bash
sudo sshd -t
sudo systemctl reload ssh
sudo sshd -T | grep '^allowusers'
```

Keep the current administrative SSH session open until the new configuration is verified.

## Install the fleet

Clone the production branch temporarily:

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
├── workers.json
├── nginx.conf
├── control/
├── data/
│   ├── muse-01/
│   ├── muse-02/
│   ├── muse-03/
│   ├── muse-04/
│   └── muse-05/
├── backups/
├── secrets/
└── .deploy-state/
```

Internal worker-control authentication material is generated automatically on the VPS.

## Configure music bot credentials

Edit the five worker credential files with a root editor:

```bash
sudoedit /srv/docker/muse/secrets/discord_token_01
sudoedit /srv/docker/muse/secrets/discord_token_02
sudoedit /srv/docker/muse/secrets/discord_token_03
sudoedit /srv/docker/muse/secrets/discord_token_04
sudoedit /srv/docker/muse/secrets/discord_token_05
```

Configure the shared YouTube API credential:

```bash
sudoedit /srv/docker/muse/secrets/youtube_api_key
```

Spotify is optional. If used, configure both Spotify credential files.

## Configure dashboard OAuth

Store the Discord OAuth application client secret:

```bash
sudoedit /srv/docker/muse/secrets/orchestrator_discord_client_secret
```

Then edit:

```bash
sudoedit /srv/docker/muse/.env
```

Set:

```dotenv
ORCHESTRATOR_PUBLIC_BASE_URL=https://YOUR-MUSE-DASHBOARD-HOST
ORCHESTRATOR_DISCORD_CLIENT_ID=YOUR_OAUTH_APPLICATION_CLIENT_ID
```

The public URL must use HTTPS in production.

## Nginx Proxy Manager

Create a Proxy Host for the dashboard hostname.

Forward to:

```text
Forward Hostname: muse-edge
Forward Port:     8080
Scheme:           http
```

Do not point NPM directly at `muse-orchestrator`.

The edge is the only Muse service on `proxy_net`.

Use the existing Cloudflare / NPM TLS model and keep the public dashboard on HTTPS.

## Dashboard configuration model

Configuration is scoped to a Discord guild.

Resolution order:

```text
platform defaults
      |
      v
guild configuration
      |
      v
guild group configuration
      |
      v
worker override
```

A server administrator can therefore:

- apply one configuration to all five workers;
- create arbitrary groups such as 3 + 2;
- group the same workers differently in another Discord server;
- select any temporary subset of workers and apply a bulk override;
- configure one worker independently;
- disable a worker for that guild;
- set a maximum number of simultaneous players;
- choose worker priority.

The orchestrator stores the desired state and periodically reconciles it with the worker-local settings.

## Network model

```text
proxy_net
   |
muse-edge
   |
muse-dashboard-internal
   |
muse-orchestrator
   |
   +-- muse-control (internal only) --> five worker control APIs
   |
   +-- muse-egress -----------------> public Internet

muse-01..05
   |
   +-- muse-control
   +-- muse-egress
```

No worker publishes a host port.

The orchestrator does not receive music-bot credentials.

Worker control APIs require signed requests and are reachable only on the private Docker control network.

Do not mount the Docker socket into any Muse container.

## GitHub production environment

Create a GitHub Environment named `production` and restrict it to the production branch.

Configure:

- `VPS_HOST`
- `VPS_PORT`
- `VPS_DEPLOY_KEY`
- `VPS_KNOWN_HOSTS`

Then create the repository variable:

```text
ENABLE_VPS_DEPLOY=true
```

Leave it disabled until the VPS files, Discord applications, NPM proxy and OAuth callback are configured.

## Deploy flow

A production push performs:

```text
lint + typecheck + tests
          |
          v
multi-arch image build
          |
          v
GHCR + SBOM + provenance
          |
          v
immutable image digest
          |
          v
restricted SSH command
          |
          v
stop fleet
          |
          v
backup 6 SQLite databases
          |
          v
start orchestrator + edge + 5 workers
          |
          v
require 7/7 healthy
          |
      +---+---+
      |       |
   success  failure
      |       |
 commit    restore previous
 state     image + databases
```

The six databases are:

- orchestrator control database;
- one local Muse database for each of the five workers.

Audio caches are excluded from backups.

## Status and rollback

From the VPS administrative account:

```bash
sudo /usr/local/sbin/muse-deploy status
sudo /usr/local/sbin/muse-deploy rollback
```

Rollback is also available through the dedicated GitHub Actions workflow.

## Security boundary

Compromise of one music worker exposes only that worker's mounted music-bot credential.

Compromise of the orchestrator can alter worker configuration through its control keys, but the orchestrator has no music-bot credentials and no Docker socket.

Compromise of the minimal edge container does not provide application secrets.

No design can make a Discord-connected process mathematically incapable of sending data through its permitted Discord/Internet connectivity, so the deployment focuses on least privilege and limiting blast radius.
