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
    | 'status_channel.set' | 'status_channel.clear' | 'status_channel.test';
  subjectType: 'GUILD' | 'USER' | 'CHANNEL';
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

The super admin can choose one Discord channel where **every bot posts a message when it comes online**. Only the "online" event is announced (no offline, crash or deploy messages). Each bot posts itself, with its own identity, so every bot must be a member of that channel's server with **View Channel**, **Send Messages** and **Embed Links** there.

```ts
type StatusChannelSetting = {
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

The channel must be a standard text or announcement channel of a server (threads, forum posts, voice channel chats and DMs are refused with `INVALID_CHANNEL`).

Worker error codes, reported by the test action and in the worker logs:

| Code | Meaning |
| --- | --- |
| `NOT_READY` | The bot is not connected to Discord (yet). |
| `CHANNEL_NOT_FOUND` | The channel does not exist, or the bot is not in its server. |
| `INVALID_CHANNEL` | Not a standard text or announcement channel. |
| `MISSING_PERMISSIONS` | The bot lacks View Channel, Send Messages or Embed Links there. |
| `DISCORD_ERROR` | Any other Discord failure (or an unexpected worker answer). |
| `UNREACHABLE` | Orchestrator only: the worker did not answer (down, restarting, timeout). |

#### `GET /v1/super/status-channel`

`200 StatusChannelSetting`. Actor headers are accepted but not required. The same object is in the overview as `statusChannel`.

#### `PUT /v1/super/status-channel`

Headers: actor (required). Body: `{"channelId": "<snowflake>" | null, "mentionRoleIds"?: ["<snowflake>", ...]}`. `channelId: null` disables the messages. `mentionRoleIds` omitted keeps the current roles, `[]` removes every mention; duplicates are removed, at most 10 roles.

- `200 StatusChannelSetting` (the stored value). Saving does not contact the bots: they read the setting the next time they announce.
- Audited as `status_channel.set` or `status_channel.clear`, subject type `CHANNEL`, subject the new channel (or the previous one when clearing), details `{previousChannelId, statusChannelId, mentionRoleCount}`.
- `400 INVALID_ACTOR`, `400 INVALID_BODY` (not an object), `400 INVALID_CHANNEL_ID` (missing, or neither a snowflake nor `null`), `400 INVALID_ROLE_IDS` (not an array, a value that is not a snowflake, or more than 10 roles).

#### `POST /v1/super/status-channel/test`

Headers: actor (required). No body. Every configured worker is asked (`POST /v1/status-channel/announce` with `{channelId, test: true, mentionRoleIds}`, 10 second timeout) to post the test message in the configured channel.

- `200 {statusChannelId, results: [{workerId, ok: true} | {workerId, ok: false, error}]}` in worker order, `error` being one of the codes above.
- Audited as `status_channel.test` (subject the channel, details `{mentionRoleCount, results}`), outcome `ok` (every bot posted), `partial` or `failed` (none did).
- `400 STATUS_CHANNEL_NOT_SET` when no channel is configured; `400 INVALID_ACTOR`.

### Worker endpoints

Documented in `ORCHESTRATOR.md` (`POST /v1/guilds/:guildId/leave`, `PUT /v1/blocklist`, `POST /v1/status-channel/announce`, extended `GET /v1/status`). They use each worker's control token and are only called by the orchestrator. The orchestrator route `GET /v1/worker/config` goes the other way: workers call it with their own control token.

### Audit and failure handling

- Audit entries are written after the action. A failed audit write is logged and never fails or reverts the action.
- A store write that fails unexpectedly returns `500` and is audited with outcome `failed`. Validation errors (4xx) are not audited.
- Worker errors are reported by error class name only (for example `HTTPError`, `RequestError`), never with response bodies or tokens.

## Dashboard

The super console UI lives at `/it/super` and `/en/super` in the dashboard (`/super` redirects by language) and is only usable by the user configured in `MUSE_SUPER_ADMIN_USER_ID` (empty disables it, fail closed). The dashboard gate, the browser API (`/api/super/*`), the bot invite links (`/invite/:workerId`) and the blocked-user login check are documented in [DASHBOARD.md](DASHBOARD.md#super-admin).

Layout (Sentinel super console style):

- kicker `SUPER CONSOLE`, title "Controllo globale di Muse.";
- KPI row: Bot online (ready / total), Server collegati, Player attivi (sum of `activePlayers`), Blacklist;
- **BOT · Stato dei worker**: avatar, username, worker id and bot id, Pronto / Non pronto / Offline, server and player counts, uptime, "Aggiungi a un server" (`/invite/:id`);
- **STATO · Canale di log dei bot** (EN "STATUS · Bot status channel"): Channel ID field (client-side 17-20 digit check), "Salva", "Disattiva" (asks for confirmation) and "Invia messaggio di prova"; a role field ("Aggiungi ruolo", 17-20 digit check, no duplicates, at most 10) with removable chips, saved together with the channel by "Salva" (a hint explains Developer Mode → Server Settings → Roles → right click → Copia ID ruolo, and that the role must be mentionable or the bots need "Mention @everyone, @here and All Roles"); the current channel, number of mentioned roles and who changed it and when; after a test, one row per bot with "Pubblicato" or the translated error code. A hint explains how to copy the ID (Discord Developer Mode, right click on the channel → Copia ID canale) and the permissions every bot needs;
- **DISCORD · Server collegati**: icon, name, id, owner id, members, chips of the bots present, "Bloccato" tag, "Fai uscire" (all bots) and "Blocca ed espelli" (both ask for confirmation);
- **POLICY · Blacklist**: forms to block a user or a server (client-side 17-20 digit check, optional reason up to 500 characters) and rows with "Sblocca";
- **AUDIT · Azioni super-admin**: action, subject, actor, outcome (`ok` / `partial` / `failed`) and time.

After every action the overview is reloaded; successes show a toast, failures and partial results a notice. Orchestrator errors such as `CANNOT_BLOCK_SELF` or `BLOCK_NOT_FOUND` are shown with their message.
