# Super console

The super console lets the configured super admin see the whole fleet, force bots out of a Discord server, block servers or users across all five bots, choose the Discord channel where the bots announce that they are online, and review an audit log of those actions.

This document describes the backend (orchestrator and workers). The dashboard pages and the super-admin gate are described in `DASHBOARD.md`.

## Backend

### Trust model

```text
browser --session/CSRF--> dashboard --orchestrator token + actor headers--> orchestrator --control token--> muse-0N
```

- Every `/v1/super/*` and `/v1/blocks/*` route requires the orchestrator API token, like the other admin routes. Worker control tokens are rejected (401).
- The orchestrator does not authenticate Discord users. The dashboard authorizes the super admin and then passes the acting user in headers, which the orchestrator trusts because only the dashboard holds the API token:
  - `x-muse-actor-id`: Discord user id (snowflake). **Required on every mutation** (POST/PUT/DELETE); missing or malformed gives `400 {code: "INVALID_ACTOR"}`.
  - `x-muse-actor-name`: optional display name, 1-64 printable characters after trimming. Send plain ASCII, or percent-encode UTF-8 with `encodeURIComponent`; values that do not decode are used as sent. Missing or empty means `"unknown"`; a control character or more than 64 characters gives `400 INVALID_ACTOR`.
- Tokens are never written to the audit log or to any state file.

### State files

They live in the orchestrator `/state` volume (`./data/orchestrator` in production) next to `groups.json`:

| File | Env override | Content |
| --- | --- | --- |
| `/state/blocks.json` | `MUSE_ORCHESTRATOR_BLOCKS_FILE` | `{"version": 1, "blocks": [Block...]}` |
| `/state/super-audit.json` | `MUSE_ORCHESTRATOR_AUDIT_FILE` | `{"version": 1, "entries": [AuditEntry...]}` (oldest first) |
| `/state/platform-settings.json` | `MUSE_ORCHESTRATOR_PLATFORM_FILE` | `{"version": 1, "statusChannel": StatusChannelSetting}` (see [Bot status channel](#bot-status-channel)) |
| `/state/plans.json` | `MUSE_ORCHESTRATOR_PLANS_FILE` | `{"version": 1, "guilds": {guildId: GuildPlan}, "coupons": [Coupon...]}` (see [Plans and coupons](#plans-and-coupons)) |

Overrides must normalize to a path under `/state/` and be distinct from each other and from the groups file, or the orchestrator refuses to start. A missing `platform-settings.json` means "no status channel".

Writes follow the group store rules: the previous good state is saved as `<file>.bak`, the next state is written to a temp file, fsynced and renamed (directory fsync where supported), and memory only changes after the write succeeded. On startup each file is schema-validated; an invalid file falls back to `<file>.bak` with a warning, and the orchestrator refuses to start if neither is valid. Only one orchestrator may run per state volume.

```ts
type Block = {
  kind: 'GUILD' | 'USER';
  subjectId: string;            // Discord id; unique per (kind, subjectId)
  reason?: string;              // 1-500 printable characters
  createdBy: {userId: string; username: string};
  createdAt: string;            // ISO 8601
};

type AuditEntry = {
  id: string;                   // UUID
  at: string;                   // ISO 8601
  actor: {userId: string; username: string};
  action: 'guild.leave' | 'block.upsert' | 'block.delete'
    | 'status_channel.set' | 'status_channel.clear' | 'status_channel.test'
    | 'worker.down' | 'worker.recovered';
  subjectType: 'GUILD' | 'USER' | 'CHANNEL' | 'WORKER';
  subjectId: string;
  details: Record<string, unknown>;   // small; replaced by {truncated: true} above 4 KiB
  outcome: 'ok' | 'partial' | 'failed';
};
```

At most 5000 blocks per kind (`409 BLOCKLIST_FULL`). The audit log keeps the last **1000** entries (ring buffer).

### Enforcement semantics

- **GUILD block**: every bot leaves that server as soon as it receives the blocklist, and any bot that is added to it again leaves immediately on `guildCreate` (before creating settings, registering commands or sending the welcome DM).
- **USER block**: every bot refuses that user's interactions. Slash commands, buttons and other repliable interactions get an ephemeral refusal in the guild's bot language ("You can't use this bot." in English, "Non puoi usare questo bot." in Italian; see `I18N.md`); autocomplete gets an empty suggestion list. The dashboard checks `GET /v1/blocks/users/:userId` at login and denies blocked users (the configured super admin is never denied).
- Workers keep the blocklist **in memory only**; it starts empty when a worker starts. The orchestrator pushes the full list (`PUT /v1/blocklist` on every worker) when it starts, after every block change, and every **60 seconds** (reconcile loop: no overlapping passes, timer unref'd, stopped on shutdown). A restarted worker is therefore enforcing again within 60 seconds. Pushes are serialized so an older list never overwrites a newer one. Reconcile failures are logged once per change of the failing set, not every minute.
- Removing a block does not make bots rejoin a server; they have to be invited again.

### API

All responses are JSON. Errors are `{"error": "<message>", "code"?: "<CODE>"}`.

#### `GET /v1/super/overview`

`200`:

```ts
{
  workers: Array<{
    id: string;
    reachable: boolean;
    ready: boolean;                    // Discord gateway ready
    bot: {id: string; username: string; avatarUrl: string | null} | null;
    guildCount: number;
    activePlayers: number;             // guilds with a voice connection
    uptimeSeconds: number | null;      // null when unreachable
    error?: string;                    // only when unreachable (error class name)
    downSince: string | null;          // ISO 8601: a "bot offline" alert is outstanding since then (see Health alerts)
  }>;
  guilds: Array<{                      // merged across reachable workers, sorted by name
    id: string;
    name: string;
    iconUrl: string | null;
    memberCount: number | null;
    ownerId: string | null;
    workerIds: string[];               // sorted
    blocked: boolean;                  // a GUILD block exists
  }>;
  blocks: Block[];                     // newest first
  audit: AuditEntry[];                 // newest first, at most 200
  statusChannel: StatusChannelSetting; // see "Bot status channel"
}
```

Unreachable workers are listed with `reachable: false`; they never fail the request. Actor headers are accepted but not required.

#### `POST /v1/super/guilds/:guildId/leave`

Headers: actor (required). Body (optional): `{"workerIds": ["muse-01", ...]}`.

- Without `workerIds`: every reachable worker that is a member of the guild leaves. `404 GUILD_NOT_FOUND` if none is.
- With `workerIds` (non-empty string array, duplicates removed): only those workers are asked; listed workers that are not in the guild are reported as `WorkerNotInGuild`, unreachable ones as `WorkerUnreachable`.
- `200 {guildId, left: string[], failed: [{workerId, error}]}`. Audited as `guild.leave` with outcome `ok` (no failures), `partial` or `failed` (nothing left), details `{requestedWorkerIds: string[] | null, left, failed}`.
- `400 INVALID_ACTOR`, `400` malformed guild id, `400 INVALID_BODY`, `400 INVALID_WORKER_IDS`, `400 UNKNOWN_WORKERS`.

#### `PUT /v1/super/blocks/:kind/:subjectId`

`kind` is exactly `GUILD` or `USER` (case-sensitive). Headers: actor (required). Body (optional): `{"reason": "..."}` (trimmed; empty means none).

- Creates the block, or replaces the reason of an existing one (`createdBy`/`createdAt` are kept), persists it, then pushes the blocklist to every worker (best effort).
- `200 {block: Block, created: boolean, pushed: string[], failed: [{workerId, error}]}`.
- Audited as `block.upsert`, outcome `ok` when every worker accepted the push, otherwise `partial` (the block is stored and the reconcile loop retries). Details: `{created, reason, pushed, failed, leftWorkerIds?}` (`leftWorkerIds` for GUILD blocks: workers that left the server).
- `400 CANNOT_BLOCK_SELF` when `kind` is `USER` and `subjectId` equals `x-muse-actor-id`; `400 INVALID_ACTOR`, `400 INVALID_BLOCK_KIND`, `400 INVALID_SUBJECT_ID`, `400 INVALID_BODY`, `400 INVALID_REASON`, `409 BLOCKLIST_FULL`.

#### `DELETE /v1/super/blocks/:kind/:subjectId`

Headers: actor (required). Removes the block and pushes the blocklist.

- `200 {block: Block, pushed: string[], failed: [{workerId, error}]}` (`block` is the removed block).
- `404 BLOCK_NOT_FOUND` when absent; `400 INVALID_ACTOR`, `INVALID_BLOCK_KIND`, `INVALID_SUBJECT_ID`.
- Audited as `block.delete` (`ok` / `partial`).

#### `GET /v1/blocks/users/:userId`

`200 {blocked: boolean}`; `400 INVALID_SUBJECT_ID` for a malformed id. Used by the dashboard login.

### Bot status channel

The super admin chooses one server and one channel of it, from the servers the bots are in, where **every bot of that server posts a message when it comes online**. It is a single platform setting: it is not shown in, and cannot be changed from, the per-server consoles. Only the "online" event is announced (no offline, crash or deploy messages). Each bot posts itself, with its own identity, and needs **View Channel**, **Send Messages** and **Embed Links** in the channel; bots that are not members of the chosen server stay silent.

```ts
type StatusChannelSetting = {
  statusGuildId: string | null;            // server of the channel; null when disabled (or for a setting saved before the server was stored)
  statusChannelId: string | null;          // Discord channel id; null = disabled (default)
  mentionRoleIds: string[];                // 0-10 role ids pinged by every status message (default [])
  updatedAt: string | null;                // ISO 8601
  updatedBy: {userId: string; username: string} | null;
};
```

When a bot announces:

- After the Discord `ready` event, once startup has completed (commands registered, presence set, ready file written), and again after a full reconnect (`shardReady` after startup, i.e. a new session that could not be resumed; plain resumes never announce).
- At most **once per 5 minutes** per bot process, so a flapping connection does not spam the channel. Every post attempt counts, including one that failed for missing permissions; a failed orchestrator request does not, so the next full reconnect tries again.
- Only managed workers (`MUSE_WORKER_ID` set) announce. The bot reads the channel from the orchestrator (`GET /v1/worker/config`, 5 second timeout, see `ORCHESTRATOR.md`); this runs in the background and never delays or fails readiness. Failures (orchestrator unreachable, channel missing, missing permissions) are only logged as one concise warning.

The message mirrors Sentinel's "Bot avviato" message:

- **content**: only the mentions of the configured roles (`<@&roleA> <@&roleB>`), no content at all when no role is configured; `allowedMentions` is exactly `{parse: [], roles: [<configured role ids>]}`, so users, `@everyone` and `@here` are never pinged;
- **embed**, green left bar (`#3ccf8e`):
  - title "Bot started" (Italian "Bot avviato");
  - description "Bot connected as `<bot tag>`." ("Bot connesso come `<bot tag>`.");
  - field "Action author" ("Autore azione"): ``**<bot username>** · <@botId> · `botId` ``;
  - field "Details" ("Dettagli"): `**Guild Count:** <servers>` and ``**Bot:** <bot username> · <@botId> · `botId` `` on two lines (the "Guild Count" / "Bot" labels are the same in both languages, as in Sentinel);
  - footer: the hostname of `MUSE_DASHBOARD_PUBLIC_URL` (workers receive the whole `.env`), or `Muse` when it is missing or invalid; timestamp: now (Discord shows "Today at 19:29" in each reader's timezone).
- **Test message** (super console button): same layout and the same role mentions (so the admin can check that they ping), title "Test message" ("Messaggio di prova"), description "Status channel test sent by `<bot tag>`." ("Prova del canale di stato inviata da `<bot tag>`."), violet left bar (`#a78bfa`).
- Language: the `locale` setting of the channel's server **for that bot** (see `I18N.md`), English by default.

Role mentions only notify people when the role is **mentionable** (Server Settings → Roles → "Allow anyone to @mention this role") or the bots have the **Mention @everyone, @here and All Roles** permission in the channel; otherwise Discord shows the mention without pinging anybody.

The channel must be a standard text or announcement channel of the chosen server (threads, forum posts, voice channel chats and DMs are refused with `INVALID_CHANNEL`). A bot never posts in a channel of another server than `statusGuildId`, even if the stored id was tampered with (`CHANNEL_NOT_FOUND`).

Worker error codes, reported by the test action and in the worker logs:

| Code | Meaning |
| --- | --- |
| `NOT_READY` | The bot is not connected to Discord (yet). |
| `CHANNEL_NOT_FOUND` | The channel does not exist, the bot is not in its server, or it is not in the chosen server. |
| `INVALID_CHANNEL` | Not a standard text or announcement channel. |
| `MISSING_PERMISSIONS` | The bot lacks View Channel, Send Messages or Embed Links there. |
| `DISCORD_ERROR` | Any other Discord failure (or an unexpected worker answer). |
| `UNREACHABLE` | Orchestrator only: the worker did not answer (down, restarting, timeout). |

#### `GET /v1/super/status-channel`

`200 StatusChannelSetting`. Actor headers are accepted but not required. The same object is in the overview as `statusChannel`.

#### `GET /v1/super/guilds/:guildId/meta`

The pickers of the status channel card. The orchestrator asks every reachable bot that is a member of the server (`GET /v1/guilds/:guildId/meta` on the worker, see `ORCHESTRATOR.md`) and merges the answers:

```ts
type MergedGuildMeta = {
  guildId: string;
  workerIds: string[];        // bots of the server that were asked, in configuration order
  sourceWorkerId: string;     // the (ready) bot whose view of channels and roles is returned
  channels: Array<{id: string; name: string; type: 'text' | 'announcement'; parentName: string | null; position: number;
    postableBy: string[]}>;   // bots with View Channel, Send Messages and Embed Links there
  roles: Array<{id: string; name: string; color: number; mentionable: boolean; position: number}>; // no @everyone, no managed roles
  failed: Array<{workerId: string; error: string}>;
};
```

`404 NOT_IN_GUILD` when no reachable bot is in the server, `503 META_UNAVAILABLE` when none of them answered, `400` for a malformed id.

#### `PUT /v1/super/status-channel`

Headers: actor (required). Body: `{"guildId": "<snowflake>", "channelId": "<snowflake>" | null, "mentionRoleIds"?: ["<snowflake>", ...]}`. `channelId: null` disables the messages (and clears the server); otherwise `guildId` is required. `mentionRoleIds` omitted keeps the current roles when the server does not change (and none otherwise), `[]` removes every mention; duplicates are removed, at most 10 roles. The channel and the roles are checked against the bots' current view of the server (the meta route above), so only real choices are stored.

- `200 StatusChannelSetting` (the stored value). Saving does not ask the bots to post: they read the setting the next time they announce.
- Audited as `status_channel.set` or `status_channel.clear`, subject type `CHANNEL`, subject the new channel (or the previous one when clearing), details `{previousGuildId, previousChannelId, statusGuildId, statusChannelId, mentionRoleCount}`.
- `400 INVALID_ACTOR`, `400 INVALID_BODY` (not an object), `400 INVALID_CHANNEL_ID` (missing, or neither a snowflake nor `null`), `400 INVALID_GUILD_ID` (missing or malformed with a channel), `400 INVALID_ROLE_IDS` (not an array, a value that is not a snowflake, or more than 10 roles), `400 INVALID_STATUS_CHANNEL` (not a text or announcement channel of that server), `400 INVALID_STATUS_ROLES` (not a role of that server, `@everyone` or a managed role), `404 NOT_IN_GUILD` / `503 META_UNAVAILABLE` as for the meta route.

#### `POST /v1/super/status-channel/test`

Headers: actor (required). No body. Every configured worker is asked (`POST /v1/status-channel/announce` with `{guildId, channelId, test: true, mentionRoleIds}`, 10 second timeout) to post the test message in the configured channel; bots that are not in the server answer `CHANNEL_NOT_FOUND`.

- `200 {statusGuildId, statusChannelId, results: [{workerId, ok: true} | {workerId, ok: false, error}]}` in worker order, `error` being one of the codes above.
- Audited as `status_channel.test` (subject the channel, details `{mentionRoleCount, results}`), outcome `ok` (every bot posted), `partial` or `failed` (none did).
- `400 STATUS_CHANNEL_NOT_SET` when no channel is configured; `400 INVALID_ACTOR`.

### Worker logs

Every process keeps its last **1000** console lines in memory (`src/utils/log-buffer.ts`, installed when the worker and the orchestrator start; printing is unchanged). A line is `{at, level: 'debug' | 'info' | 'warn' | 'error', message}`, the message at most 2000 characters. Before a line is stored, Discord bot tokens, `Bearer` tokens, `Authorization` and `Cookie` values, `token`, `secret`, `password` and `key` values, and URL query strings are replaced with `[redacted]`. The buffer is lost when the process restarts. The console only reads logs: there is no restart action and no access to the Docker socket.

- **Worker**: `GET /v1/logs?limit=N` (control token; `N` from 1 to 1000, default 200) answers `{workerId, entries}`, oldest first. The answer is capped at about 512 KiB, so the newest lines win when the limit is large.
- **Orchestrator**: `GET /v1/super/workers/:workerId/logs?limit=N` (API token). `:workerId` is a bot id, or `orchestrator` for the orchestrator's own buffer. `404 WORKER_NOT_FOUND` for an unknown id, `503 WORKER_UNAVAILABLE` when the bot does not answer, `400 INVALID_LIMIT` for a bad limit. The lines of a bot are validated and redacted again before they are returned.
- **Dashboard**: `GET /api/super/workers/:workerId/logs?limit=N` (super admin only). The super console shows the last 200 lines of a bot, or of the orchestrator, in a monospace panel with a minimum-level filter and a refresh button.

### Health alerts

The reconcile loop (every 60 seconds, the same pass as the blocklist push) checks every bot. A bot is **healthy** when it is reachable and connected to Discord.

- A bot that has been healthy since the orchestrator started and fails **two checks in a row** is reported down. A bot that was never healthy since start never alerts, so a fleet that is down at start-up stays quiet.
- When that bot is healthy again, a recovery alert is sent.
- The alert is a status message (red "Bot offline" / green "Bot back online", the outage start shown as a Discord time). It is posted in the status channel by the first healthy bot that is a member of the status server. Only the down alert pings the configured roles. Without a status channel, or with a status channel but no server stored, nothing is posted.
- Every alert is audited with the system actor `{userId: "system", username: "Muse"}`: action `worker.down` or `worker.recovered`, subject type `WORKER`, subject the bot id. Details: `{since, notified, postedBy?, reason?, error?, downtimeSeconds?}`. `reason` is `NO_STATUS_CHANNEL` or `NO_STATUS_GUILD` when nothing was posted; `error` is a status error code (see the table above) or `NO_HEALTHY_POSTER`. Outcome `failed` when a channel was set but the post failed.
- The alert state lives in memory. After an orchestrator restart it starts again from scratch. The overview carries `downSince` per bot, and the worker list shows it as "Down since HH:MM".

### Plans and coupons

Muse uses the same plan model as Sentinel: four tiers, prices in euro, billing `MONTHLY`, `YEARLY` or `GIFT` (trial / complimentary), and **no online payments**. The pricing page asks people to get in touch; the super admin assigns the plan by hand ("Gestisci piano") and coupons only change the price shown in the editor and count redemptions. The catalog lives in `src/plans/plans.ts`, shared by the workers, the orchestrator and (through the API) the dashboard.

| Tier | Name | Monthly | Yearly | Bots usable in the server | Saved groups | Tracks per playlist | Favorites | 24/7 | Priority support | Custom bot name and banner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FREE` | Free | €0 | €0 | 1 | 0 | 50 | 10 | no | no | no |
| `TIER1` | Plus | €2 | €20 | 2 | 2 | 200 | 50 | no | yes | no |
| `TIER2` | Pro | €5 | €50 | 5 | 10 | 500 | 200 | yes | yes | no |
| `TIER3` | Brand | €10 | €90 | 5 | 10 | 500 | 200 | yes | yes | yes |

How the limits apply:

- **Bots**: the first N bots of a server, in configuration order (`muse-01`, `muse-02`, ...), are the plan's bots; the others answer every command, button and autocomplete in that server with an ephemeral refusal that names the included bots and links the pricing page.
- **24/7**: below Pro the bots always leave an empty voice channel, and leave at most 600 seconds after the queue ends (`0` = never is Pro only).
- **Playlists, favorites, groups**: imports are cut at the plan limit, `/favorites create` and new dashboard groups are refused at the limit (`403 PLAN_LIMIT`).
- **Settings**: `/config` and dashboard changes beyond the plan are refused (`403 PLAN_LIMIT` / `403 PLAN_REQUIRED`). Stored values are never rewritten on a downgrade: they are clamped to the plan in force at play time, so they come back when the plan does.
- **Expiry**: an expired plan behaves as Free at once; every 10 minutes (and at startup) the orchestrator sweeps expired plans back to `FREE` (expiry date and note are kept) and audits `plan.expired` with the system actor `{userId: "system", username: "Muse"}`.

The workers learn their guilds' plans from the orchestrator: `PUT /v1/entitlements` (worker control token, see `ORCHESTRATOR.md`) is pushed at startup, with every reconcile pass (60 seconds) and right after every plan change or expiry. A guild that a worker has not been told about yet gets the Free limits and is not refused.

#### `PUT /v1/super/guilds/:guildId/plan`

Headers: actor (required). Body: `{"tier": "FREE"|"TIER1"|"TIER2"|"TIER3", "billing"?: "MONTHLY"|"YEARLY"|"GIFT"|null, "expiresAt"?: ISO 8601|null, "couponCode"?: string|null, "note"?: string|null}`.

- `FREE` clears billing, expiry and coupon (the note is kept). A coupon is validated and redeemed only when it differs from the stored one (one redemption per server).
- `200 {ok, previousTier, tier, effectiveTier, couponRedeemed, plan}`; audited as `plan.update` (subject the guild, details `{previousTier, tier, billing, expiresAt, couponCode, couponRedeemed}`).
- `400 INVALID_PLAN`, `400 EXPIRY_IN_PAST`, `404 GUILD_NOT_FOUND` (no reachable bot is in the guild), `404 COUPON_NOT_FOUND`, `400 COUPON_*` (`INACTIVE`, `NOT_STARTED`, `EXPIRED`, `EXHAUSTED`, `FREE_PLAN`, `WRONG_TIER`, `WRONG_BILLING`).

#### Coupons

`POST /v1/super/coupons`, `PUT /v1/super/coupons/:code` (partial update) and `DELETE /v1/super/coupons/:code`, actor required. Body fields: `code` (3-32 letters, digits, `_`, `-`; stored upper case), `description` (at most 200), exactly one of `percentOff` (1-100) or `amountOffCents` (1-100000), `tiers` (paid tiers; empty = every paid plan), `billing` (`ANY`, `MONTHLY`, `YEARLY`), `maxRedemptions` (1-100000 or null = unlimited), `validFrom` / `validUntil`, `active`, `public` (shown as a promotion on the pricing page). Errors: `400 INVALID_COUPON`, `409 COUPON_EXISTS`, `404 COUPON_NOT_FOUND`. Audited as `coupon.create`, `coupon.update`, `coupon.delete`.

#### Public contacts

`PUT /v1/super/config` (actor required) with any of `contactEmail` (email, at most 200), `contactDiscord` (a username, or an https link, at most 200), `contactUrl` (https, at most 500) and `waitlistOpen` (boolean); an empty string clears a contact. `400 INVALID_CONFIG` otherwise; audited as `instance.config`. They are stored in `platform-settings.json` (`instance`) and published, with the live public coupons, by `GET /v1/public/info` (API token) for the pricing page: `{waitlistOpen, contacts: {email, discord, url}, promotions: [...]}`. The overview includes them as `config`.

The overview adds `plan` to every guild (stored plan with note and coupon, plus `effectiveTier`), and `coupons` and `planCatalog` at the top level.

### Worker endpoints

Documented in `ORCHESTRATOR.md` (`POST /v1/guilds/:guildId/leave`, `PUT /v1/blocklist`, `PUT /v1/entitlements`, `POST /v1/status-channel/announce`, `GET /v1/guilds/:guildId/meta`, extended `GET /v1/status`). They use each worker's control token and are only called by the orchestrator. The orchestrator route `GET /v1/worker/config` goes the other way: workers call it with their own control token.

### Audit and failure handling

- Audit entries are written after the action. A failed audit write is logged and never fails or reverts the action.
- A store write that fails unexpectedly returns `500` and is audited with outcome `failed`. Validation errors (4xx) are not audited.
- Worker errors are reported by error class name only (for example `HTTPError`, `RequestError`), never with response bodies or tokens.

## Dashboard

The super console UI lives at `/it/super` and `/en/super` in the dashboard (`/super` redirects by language) and is only usable by the user configured in `MUSE_SUPER_ADMIN_USER_ID` (empty disables it, fail closed). The dashboard gate, the browser API (`/api/super/*`), the bot invite links (`/invite/:workerId`) and the blocked-user login check are documented in [DASHBOARD.md](DASHBOARD.md#super-admin).

Layout (Sentinel super console style):

- kicker `SUPER CONSOLE`, title "Controllo globale di Muse.";
- KPI row: Bot online (ready / total), Server collegati, Player attivi (sum of `activePlayers`), Blacklist;
- **BOT · Stato dei worker**: avatar, username, worker id and bot id, Pronto / Non pronto / Offline, "Offline dal HH:MM" while a down alert is outstanding, server and player counts, uptime, "Log" (worker logs panel, also one for the orchestrator), "Aggiungi a un server" (`/invite/:id`);
- **STATO · Canale di log dei bot** (EN "STATUS · Bot status channel"): a server menu (the servers of the overview), a channel menu grouped by category (loaded from the meta route; channels where some bot cannot post are marked "⚠ non può scrivere: …" with a warning naming those bots), and a role menu with removable colored chips (at most 10; roles that are not mentionable get a warning). Changing server clears the channel and the roles. "Salva", "Invia messaggio di prova" and "Disattiva" (asks for confirmation); the current server and channel, number of mentioned roles and who changed it and when; after a test, one row per bot with "Pubblicato" or the translated error code;
- **DISCORD · Server collegati**: icon, name, id, owner id, members, chips of the bots present, "Bloccato" tag, "Fai uscire" (all bots) and "Blocca ed espelli" (both ask for confirmation);
- **POLICY · Blacklist**: forms to block a user or a server (client-side 17-20 digit check, optional reason up to 500 characters) and rows with "Sblocca";
- **AUDIT · Azioni super-admin**: action, subject, actor, outcome (`ok` / `partial` / `failed`) and time.

After every action the overview is reloaded; successes show a toast, failures and partial results a notice. Orchestrator errors such as `CANNOT_BLOCK_SELF` or `BLOCK_NOT_FOUND` are shown with their message.

## Closed access: authorized servers

`GET /v1/super/install-grants` -> `{enabled, grants: [{guildId, source, note, createdAt, createdBy}]}`; `PUT /v1/super/install-grants/:guildId {note?}` authorizes a server (source `MANUAL`, audit `install.grant`); `DELETE` revokes it (audit `install.revoke`; the bots already there stay). Dashboard: `/api/super/install-grants[/:guildId]`, card "Server autorizzati".

Grant sources: `LEGACY` (servers the bots were in when `MUSE_INSTALL_GATE` was first enabled), `EXISTING` (a Muse bot was already there), `OWNER` (added by `MUSE_SUPER_ADMIN_USER_ID`, read from the audit log), `MANUAL`. A refused installation is audited as `install.rejected` (system actor, with server name, member count, installer and delivery) and announced in the status channel without role mentions. State file: `install-grants.json` (backed up by `muse-deploy`).
