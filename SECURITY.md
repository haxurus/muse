# Security Policy

## Production architecture

The production deployment follows least privilege and separates control from music playback.

- five music workers run in separate containers;
- each worker receives only its own Discord bot credential;
- the orchestrator receives no music-bot credentials;
- the dashboard edge receives no application credentials;
- no Muse container receives the Docker socket;
- workers and orchestrator run non-root with Linux capabilities dropped;
- no-new-privileges is enabled;
- root filesystems are read-only;
- writable state is limited to dedicated data/control directories and tmpfs;
- CPU, memory and PID use are bounded;
- no music worker publishes a host port.

## Dashboard authorization

Dashboard authentication uses Discord OAuth2.

The application requests `identify guilds`. Only guilds where the authenticated user is the owner or has Manage Server / Administrator permission are exposed for management.

OAuth state is single-use and time limited. Dashboard sessions use random server-side identifiers in HttpOnly SameSite cookies. Mutating API calls require a per-session CSRF token.

Discord OAuth access tokens are not stored after the login exchange completes.

## Orchestrator to worker RPC

Worker control APIs are reachable only on a private Docker network.

Every control request includes:

- a millisecond timestamp;
- a SHA-256 body digest;
- an HMAC-SHA256 signature over timestamp, method, path and body digest.

Workers reject signatures outside the configured clock-skew window or requests with altered content.

Each worker has a distinct control key. The orchestrator has the control keys but not worker Discord credentials.

## Configuration isolation

Desired settings are stored per Discord guild.

Configuration resolution is:

```text
platform -> guild -> guild group -> worker override
```

A worker also receives a per-guild enabled policy. Disabled workers reject Discord interactions for that guild and are disconnected during reconciliation.

## URL safety

YouTube, SoundCloud and Spotify are handled as known providers.

Generic HTTP/HTTPS streams are disabled by default. If explicitly enabled, configure a narrow hostname allowlist.

Host firewall policy should additionally prevent Muse egress traffic from reaching the VPS host, Docker management networks, link-local addresses and private/LAN ranges.

## Reverse proxy boundary

Only the minimal `muse-edge` service joins the shared `proxy_net` network.

The orchestrator is behind a dedicated internal dashboard network. Workers are reachable from the orchestrator only over the private control network.

## Secrets

Do not commit production credentials, cookie exports, SSH private keys, or database backups.

If a credential may have been exposed, rotate it before restoring normal service.

No connected system can guarantee zero data exfiltration if the process that legitimately communicates with Discord or public media providers is fully compromised. The deployment therefore minimizes mounted secrets, network reachability and lateral movement.
