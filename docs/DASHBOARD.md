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

Permissions are rechecked against Discord before every configuration mutation. The guild list is paginated (`after` cursor, 200 per page, at most 10 pages).

The callback verifies that the granted token includes both `identify` and `guilds`. A cancelled or failed login (Discord `error` parameter, invalid/expired/replayed state, missing scopes, Discord errors) redirects to `MUSE_DASHBOARD_PUBLIC_URL/?login=failed`, where the page shows a short message.

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

- stateless OAuth `state`: HMAC-SHA256 signed (random per-process key) with a 10 minute expiry, matched against the state cookie and accepted once (a bounded used-nonce set evicts the oldest entries, so unauthenticated `/auth/discord` traffic cannot exhaust a server-side pool);
- server-side sessions, capped at 5000 in total and 5 per Discord user (oldest evicted), cleaned up every minute; signing in again deletes the session carried by the request;
- `HttpOnly` cookies;
- `Secure` cookies in production, named `__Host-muse_session` and `__Secure-muse_oauth_state` (plain `muse_session` / `muse_oauth_state` over local http);
- `SameSite=Lax`;
- per-session CSRF tokens;
- strict Origin validation on mutations;
- CSP and clickjacking protection;
- no CORS exposure;
- no browser storage for OAuth tokens.

Mutations are checked in this order: session, Origin + CSRF, mutation budget (30 per 60 s per session), then a forced Discord permission refresh. A Discord `429` is returned to the browser as `429` with `Retry-After`; a Discord `401` deletes the session and returns `401`.

Orchestrator `400`/`404`/`409`/`413`/`422` responses keep their status with the orchestrator's short JSON `error` message (generic text if longer than 200 characters or not printable); other orchestrator failures become `502`. Server errors are logged with the error name and upstream HTTP status only.

Every mutation attempt by an authenticated user writes one JSON line to stdout (`event: "dashboard_mutation"`, timestamp, userId, guildId, action, groupId, workerIds and count, outcome). Tokens, cookies and CSRF values are never logged.

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
muse-edge             internal, shared only with NPM
   |
dashboard-edge        no secrets
   |
dashboard-web         internal
   |
dashboard             OAuth session + orchestrator token
   |  \
   |   dashboard-egress  intended for Discord OAuth/API (private ranges blocked; no domain allowlist)
   |
dashboard-control     internal
   |
orchestrator
   |
control-01 ... control-05
   |
muse-01 ... muse-05
```

Only `dashboard-edge` joins `muse-edge`, an internal network that Nginx Proxy Manager is connected to (`docker network connect muse-edge <npm-container>`). No Muse service joins `proxy_net`. See [DEPLOYMENT.md](DEPLOYMENT.md).

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

The edge streams requests and responses with `stream.pipeline`, aborts the upstream request when the client disconnects, destroys the response if an error happens after headers were sent, strips hop-by-hop headers (including `proxy-connection` and any header listed in `Connection`), overwrites `X-Forwarded-For` with the value set by NPM (or the peer address) and shuts down gracefully on `SIGTERM`/`SIGINT`.
