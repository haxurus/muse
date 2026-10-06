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

The callback verifies that the granted token includes both `identify` and `guilds`. A cancelled or failed login (Discord `error` parameter, invalid/expired/replayed state, missing scopes, Discord errors) redirects to `MUSE_DASHBOARD_PUBLIC_URL/dashboard?login=failed`, where the page shows a short message. A successful login redirects to `MUSE_DASHBOARD_PUBLIC_URL/dashboard`; `POST /auth/logout` also returns to `/dashboard` (login view). Every redirect target is built with `new URL(path, MUSE_DASHBOARD_PUBLIC_URL)`, which must stay a bare origin.

### Blocked users

After loading the Discord user, the callback asks the orchestrator `GET /v1/blocks/users/:userId` (see [SUPER_CONSOLE.md](SUPER_CONSOLE.md)):

- `{blocked: true}`: the OAuth token is revoked, no session is created and the browser goes to `/dashboard?login=blocked` ("Accesso non consentito.").
- orchestrator error, timeout or malformed answer: **fail closed**. The token is revoked, no session is created and the browser goes to `/dashboard?login=failed`. Signing in therefore needs the orchestrator to be reachable; existing sessions keep working.
- the configured super admin is never checked (no self-lockout, and the super console stays reachable while the orchestrator is degraded).

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

## Super admin

`MUSE_SUPER_ADMIN_USER_ID` (optional) is the Discord user ID of the Muse owner. It must be a 17-20 digit snowflake; any other non-empty value stops the dashboard at startup. Empty or unset means **no super admin**: the super console and the bot invite links are disabled for everyone (fail closed).

In production it comes from `deploy/.env` (`MUSE_SUPER_ADMIN_USER_ID: ${MUSE_SUPER_ADMIN_USER_ID:-}` in `docker-compose.prod.yml`).

`GET /api/session` returns `superAdmin: true` only for that user. The browser uses it to show the "Super console" link and the invite buttons; the server enforces the check on every super-admin route independently.

### Bot invite links

```text
GET /invite/:workerId        workerId = muse-NN
```

- no session: `302 /auth/discord` (the login starts; afterwards the user lands on `/dashboard`);
- signed in but not the super admin (or no super admin configured): `302 /development`, a static "Muse è ancora in sviluppo." notice with links to the GitHub repository;
- super admin: the worker is looked up in the orchestrator `GET /v1/workers`; unknown or malformed ids give `404`, an offline worker (no bot identity) gives `503`, otherwise `302` to
  `https://discord.com/oauth2/authorize?client_id=<bot id>&scope=bot+applications.commands&permissions=3230720`
  (View Channels, Send Messages, Read Message History, Connect, Speak).

### "Aggiungi a Discord" (`/add`)

```text
GET /add
```

Target of the "Aggiungi a Discord" buttons on the public home page:

- super admin: `302 /dashboard#nuovo-server` (the "Nuovo server · Aggiungi i bot" card with one invite per bot);
- anybody else (no session, signed-in non-admin, or no super admin configured): `302 /development`.

### Super console API

All routes need a session (`401 {code: "UNAUTHORIZED"}`) and the super admin (`403 {code: "SUPER_ADMIN_REQUIRED"}`). Mutations additionally need the exact Origin and the `x-csrf-token` header, share the per-session mutation budget and write the usual `dashboard_mutation` audit line (actions `super.guild.leave`, `super.block.put`, `super.block.delete`, with `subjectKind`/`subjectId`).

```text
GET    /api/super/overview                     -> orchestrator GET    /v1/super/overview
GET    /api/super/bots                         -> orchestrator GET    /v1/workers (id, ready, bot id/name)
POST   /api/super/guilds/:guildId/leave        -> orchestrator POST   /v1/super/guilds/:guildId/leave
PUT    /api/super/blocks/:kind/:subjectId      -> orchestrator PUT    /v1/super/blocks/:kind/:subjectId
DELETE /api/super/blocks/:kind/:subjectId      -> orchestrator DELETE /v1/super/blocks/:kind/:subjectId
```

The dashboard validates parameters before proxying: `kind` is `GUILD` or `USER`, ids are 17-20 digit snowflakes, `reason` is an optional string of at most 500 characters (trimmed, empty dropped), `workerIds` is an optional array of `muse-NN` ids (deduplicated, at most 32). Requests to the orchestrator carry the orchestrator token plus `x-muse-actor-id` (session user id) and `x-muse-actor-name` (Discord username, control characters dropped, percent-encoded, at most 64 characters). Orchestrator 4xx responses keep their status and short message as for the other routes.

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
GET  /                                public home page (indexable)
GET  /dashboard                       app: login view or server list
GET  /server/:guildId                 app: guild view
GET  /super                           app: super console
GET  /development                     static "Accesso limitato" notice
GET  /add                             (see "Aggiungi a Discord")

GET  /auth/discord
GET  /auth/discord/callback
POST /auth/logout

GET  /invite/:workerId                 (see "Bot invite links")

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

Super-admin endpoints are listed under "Super console API" above.

## User interface

The UI is a static public home page (`dashboard/home.html` + a tiny `home.js` that only closes the mobile menu) and a small vanilla JavaScript single page app (`dashboard/index.html`, `dashboard.js`), both styled by `dashboard.css`. They share the visual language of Sentinel: dark-only palette (background `#0a0b0d`, violet accent `#9b7bff` with `#120a2b` ink on accent buttons; warnings keep a separate amber `--warn` token), Geist and Geist Mono, sticky blurred header, uppercase mono "kicker" labels, hairline metric rows, pills and switches. Copy is Italian; all strings live in the `STRINGS` object at the top of `dashboard.js` so another locale can be added without touching the markup (elements carry `data-i18n` keys).

| Path | View |
| --- | --- |
| `/` | Public home page (`home.html`): hero with an illustrative session console, stat strip, features, "Come funziona", self-hosting steps, security, call to action. "Accedi" links to `/dashboard`, "Aggiungi a Discord" to `/add` |
| `/dashboard` | Login (two cards: "Accedi con Discord" and "Nuovo server") or, when signed in, the server list: user card, guild tiles and, for the super admin only, a "Nuovo server · Aggiungi i bot" card (`#nuovo-server`) with one invite per bot |
| `/server/:guildId` | Guild app shell: 248 px sidebar (server, sections, access level, user, logout) and three sections: **Panoramica** (bots in the server with ready/voice state), **Impostazioni** (bot selection, one switch per field, mixed values shown as "Valori diversi", only enabled fields are patched) and **Gruppi** (create, edit, select, delete, keep or drop unavailable members) |
| `/super` | Super console (super admin only): KPI row, worker status with invite buttons, linked servers with "Fai uscire" / "Blocca ed espelli", blacklist forms and rows, super-admin audit log |
| `/development` | Static "Accesso limitato" notice used by the invite links |

The app views (`/dashboard`, `/server/:guildId`, `/super`) and `/development` are served with `X-Robots-Tag: noindex, nofollow` and a `robots` meta tag; only the public home page `/` is indexable. All HTML responses carry the same security headers and CSP. Navigation between views uses the History API; unknown paths are `404`. Responses that arrive after the user switched server are ignored.

The CSP stays strict: `script-src 'self'`, `style-src 'self'`, `font-src 'self'`, `img-src 'self' https://cdn.discordapp.com data:`, no inline scripts, styles or event handlers. Every Discord-provided value is rendered with `textContent`; images are only loaded from `https://cdn.discordapp.com/`.

### Fonts

Geist and Geist Mono (variable woff2 from the `geist` npm package 1.7.2) are self-hosted in `dashboard/fonts/` with their SIL Open Font License (`OFL.txt`) and loaded with `font-display: swap`. They are served from a fixed allowlist as `font/woff2` (`Cache-Control: public, max-age=604800`); no request leaves the dashboard origin. The Docker image already copies the whole `dashboard/` directory.

## Nginx Proxy Manager

Create one Proxy Host for the dashboard hostname.

Forward to:

```text
muse-dashboard:8080
```

Use HTTP between NPM and the edge container. TLS terminates at NPM/Cloudflare according to the VPS01 proxy design.

Do not proxy the dashboard container, orchestrator, or worker control ports directly.

The edge streams requests and responses with `stream.pipeline`, aborts the upstream request when the client disconnects, destroys the response if an error happens after headers were sent, strips hop-by-hop headers (including `proxy-connection` and any header listed in `Connection`), overwrites `X-Forwarded-For` with the value set by NPM (or the peer address) and shuts down gracefully on `SIGTERM`/`SIGINT`.
