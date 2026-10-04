# Muse Control dashboard

Muse Control is the web administration layer for the multi-worker music fleet.

## Authentication

The dashboard uses Discord OAuth2 Authorization Code Grant with exactly these scopes:

- `identify`
- `guilds`

The browser never receives the Discord OAuth access token. The access token is stored only in the dashboard process memory for the lifetime of the server-side session.

The dashboard authorizes a guild only when the authenticated Discord user is:

- the guild owner;
- an Administrator; or
- granted Manage Guild.

Permissions are rechecked against Discord before every configuration mutation.

## Discord application setup

Use a dedicated Discord application for the dashboard when possible.

In the Discord Developer Portal:

1. Create or select the OAuth application.
2. Copy its Application ID to `MUSE_DASHBOARD_DISCORD_CLIENT_ID`.
3. Put its OAuth client secret in `/srv/docker/muse/secrets/dashboard_discord_client_secret`.
4. Add this exact redirect URI:

```text
https://<dashboard-host>/auth/discord/callback
```

5. Set `MUSE_DASHBOARD_PUBLIC_URL` to the same HTTPS origin, without a path.

The dashboard does not require a bot user on this OAuth application.

## Session security

Muse Control uses:

- random one-time OAuth `state`;
- server-side sessions;
- `HttpOnly` cookies;
- `Secure` cookies in production;
- `SameSite=Lax`;
- per-session CSRF tokens;
- strict Origin validation on mutations;
- CSP and clickjacking protection;
- no CORS exposure;
- no browser storage for OAuth tokens.

Sessions currently live in process memory and last at most 8 hours by default. A dashboard restart signs all users out. This is intentional for the first production version and avoids adding Redis solely for sessions.

## Authorization boundary

The dashboard is not trusted to administer the host.

It has:

- no Docker socket;
- no Discord bot tokens;
- no worker control tokens;
- no access to Sentinel or unrelated Docker networks.

It receives only:

- the dashboard OAuth client secret;
- the orchestrator API token.

The public `dashboard-edge` receives no secrets at all.

## Network path

```text
Internet
   |
Cloudflare / NPM
   |
proxy_net
   |
dashboard-edge        no secrets
   |
dashboard-web         internal
   |
dashboard             OAuth session + orchestrator token
   |  \
   |   dashboard-egress  Discord OAuth/API only
   |
dashboard-control     internal
   |
orchestrator
   |
control-01 ... control-05
   |
muse-01 ... muse-05
```

Only `dashboard-edge` joins `proxy_net`.

## Dashboard API

Browser-facing endpoints:

```text
GET  /auth/discord
GET  /auth/discord/callback
POST /auth/logout

GET   /api/session
GET   /api/guilds/:guildId
PATCH  /api/guilds/:guildId
POST   /api/guilds/:guildId/groups
PATCH  /api/guilds/:guildId/groups/:groupId
DELETE /api/guilds/:guildId/groups/:groupId
```

The dashboard also exposes persistent worker groups scoped to the selected Discord server. An administrator can create any combination, edit membership, delete a group, or select a group and then apply a settings patch to its currently available workers.

Groups may overlap and are intentionally not global. A `Principali = 1+2+3` group in Server A has no effect on Server B.

The PATCH settings endpoint accepts a subset of workers plus a settings patch.

Example:

```json
{
  "workerIds": ["muse-01", "muse-02", "muse-03"],
  "settings": {
    "defaultVolume": 65,
    "leaveIfNoListeners": true
  }
}
```

The orchestrator and each worker validate the request again before persistence.

## Nginx Proxy Manager

Create one Proxy Host for the dashboard hostname.

Forward to:

```text
muse-dashboard:8080
```

Use HTTP between NPM and the edge container. TLS terminates at NPM/Cloudflare according to the VPS01 proxy design.

Do not proxy the dashboard container, orchestrator, or worker control ports directly.
