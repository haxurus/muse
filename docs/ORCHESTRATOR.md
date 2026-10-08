# Muse orchestrator foundation

This document describes the first multi-bot foundation.

## Scope of this step

Implemented:

- one orchestrator service;
- five isolated Muse worker containers;
- one Discord token per worker;
- one internal control token per worker;
- separate SQLite data directory per worker;
- private point-to-point control networks;
- worker health/status API;
- guild discovery through the orchestrator;
- read/write guild settings through the orchestrator;
- single-worker, subset, or all-present-worker settings updates;
- fleet health checks, database backup, deploy and rollback awareness;
- Discord OAuth dashboard with guild-level authorization;
- one/subset/all worker settings management from the dashboard;
- persistent per-guild worker groups with arbitrary overlapping membership;
- super console backend: fleet overview, forced guild leave, guild/user blocks and an audit log (see `SUPER_CONSOLE.md`).

Not implemented yet:

- automatic voice-channel worker assignment;
- player reservations/leases;
- per-guild quotas.

## Container topology

```text
                     orchestrator
                /      /  |  \      \
          control01 ...    ... control05
              |                 |
           muse-01           muse-05
              |                 |
             egress network to Discord/media
```

Each control network contains only the orchestrator and one worker. Workers do not share a control network with each other.

No Docker socket is mounted.

## Worker API

The worker control API is internal only and requires its unique bearer token.

Endpoints:

```text
GET   /health
GET   /v1/status
GET   /v1/guilds/:guildId/settings
PATCH /v1/guilds/:guildId/settings
GET   /v1/guilds/:guildId/meta
POST  /v1/guilds/:guildId/status-channel/test
POST  /v1/guilds/:guildId/leave
PUT   /v1/blocklist
POST  /v1/playback        (only when the worker's MUSE_BOT_*_PLAYBACK flag is "true")
```

`GET /v1/status` reports, per guild, `id`, `name`, `iconUrl`, `memberCount`, `ownerId` and `playerActive` (the bot has a voice connection there), and `bot.avatarUrl`. The extra fields are optional for the orchestrator, so mixed-version fleets keep working.

`POST /v1/guilds/:guildId/leave` makes the bot leave the guild: `200 {workerId, guildId, left: true}`, `404 {error, code: "NOT_IN_GUILD"}` when it is not a member, `400` for a malformed id.

`PUT /v1/blocklist` with `{guildIds: string[], userIds: string[]}` (Discord ids, at most 5000 each, duplicates removed, body up to 512 KiB) replaces the worker's in-memory blocklist and immediately leaves every blocked guild it is in: `200 {workerId, left: string[], failed: string[]}` (`failed` lists guilds it could not leave). Invalid input is `400 {error, code: "INVALID_BLOCKLIST"}` and leaves the current list unchanged.

`GET /v1/guilds/:guildId/meta` lists what the dashboard "Log" tab pickers offer, as this bot sees the guild: `200 {workerId, guildId, channels: [{id, name, type: "text" | "announcement", parentName: string | null, position, canPost}], roles: [{id, name, color, mentionable, position}]}`. Channels are the standard text and announcement channels in Discord sidebar order (uncategorized first, then by category and position); `canPost` is true when this bot has View Channel, Send Messages and Embed Links there. Roles exclude `@everyone` and managed roles (bots, integrations, boosters) and are sorted by position, highest first; `color` is the Discord integer (0 = none). `404 NOT_IN_GUILD` when the bot is not a member, `503 NOT_READY` while it is not connected to Discord.

`POST /v1/guilds/:guildId/status-channel/test` (no body) makes the bot post the test message with its own saved status setting for that guild (see "Bot status channel" in `DASHBOARD.md`). Discord-side failures are not HTTP errors: the answer is `200 {workerId, ok: true}` or `200 {workerId, ok: false, error}` with `error` one of `NOT_CONFIGURED` (no status channel saved for this guild), `NOT_READY`, `CHANNEL_NOT_FOUND`, `INVALID_CHANNEL`, `MISSING_PERMISSIONS`, `DISCORD_ERROR`. `404 NOT_IN_GUILD` when the bot is not a member.

The settings endpoint only accepts the existing Muse guild settings:

- playlistLimit
- secondsToWaitAfterQueueEmpties
- leaveIfNoListeners
- queueAddResponseEphemeral
- autoAnnounceNextSong
- defaultVolume
- defaultQueuePageSize
- turnDownVolumeWhenPeopleSpeak
- turnDownVolumeWhenPeopleSpeakTarget
- locale: language of the bot's messages in that guild, exactly `"en"` (default) or `"it"` (case-sensitive; any other value, including `"IT"`, is rejected with 400). `GET` always returns it. See `I18N.md`.

- statusChannelId: the channel where this bot posts the "Bot started" message for that guild, a Discord id or `null` (disabled, the default). Shape errors are `400 INVALID_STATUS_CHANNEL`.
- statusMentionRoleIds: the roles that message mentions, an array of 0-10 Discord role ids (duplicates removed; `[]` removes every mention). Shape errors are `400 INVALID_STATUS_ROLES`. Stored as a comma-separated column (`Setting.statusMentionRoleIds`), always exposed as an array; the conversion lives only in `src/control/settings-validation.ts`.

The shape of every field is checked by `sanitizeGuildSettingsPatch` (orchestrator and worker). Before saving, the worker additionally checks the status fields against the guild itself, since it has the Discord client: `statusChannelId` must be a text or announcement channel of **that** guild (`400 INVALID_STATUS_CHANNEL` otherwise: another server's channel, a voice channel, a category, a thread), and every role must be a role of that guild that is neither `@everyone` (id equal to the guild id) nor managed (`400 INVALID_STATUS_ROLES`). Nothing is saved when a check fails.

Example: `PATCH /v1/guilds/:guildId/settings` with `{"locale": "it"}`, or `"settings": {"locale": "it"}` in a multi-worker update.

Discord tokens and provider credentials are never exposed through the control API.

## Orchestrator API

The orchestrator API requires a static internal bearer token and is reachable only from private control networks. The dashboard authenticates users with Discord and performs guild-level authorization before it calls the orchestrator.

Endpoints:

```text
GET   /health
GET   /v1/workers
GET   /v1/guilds
GET   /v1/guilds/:guildId/workers
PATCH  /v1/guilds/:guildId/workers/settings
GET    /v1/guilds/:guildId/meta
POST   /v1/guilds/:guildId/status-channel/test
GET    /v1/guilds/:guildId/groups
POST   /v1/guilds/:guildId/groups
PATCH  /v1/guilds/:guildId/groups/:groupId
DELETE /v1/guilds/:guildId/groups/:groupId
GET    /v1/super/overview
POST   /v1/super/guilds/:guildId/leave
PUT    /v1/super/blocks/:kind/:subjectId
DELETE /v1/super/blocks/:kind/:subjectId
GET    /v1/blocks/users/:userId
POST   /v1/playback        (worker control token, not the API token; see below)
```

The `/v1/super/*` and `/v1/blocks/*` routes are the super console backend; their contract (actor headers, payloads, error codes, reconcile loop) is documented in `SUPER_CONSOLE.md`.

Errors are JSON `{"error": "<message>"}`. Newer routes also include a machine-readable `"code"` (for example `{"error": "you cannot block yourself", "code": "CANNOT_BLOCK_SELF"}`); clients should branch on `code` when present and on the status otherwise.

`:guildId` must be a Discord snowflake (`^[1-9]\d{9,21}$`); other values are rejected with 400 before any worker is contacted. When `workerIds` is given in a settings update, only listed workers that are reachable and members of the guild are patched; the others are reported in `failed` with `WorkerNotInGuild`.

A worker that refuses a settings patch is reported in `failed` as `{workerId, ok: false, error, code?}`; `code` is the worker's machine-readable 4xx code when the HTTP client exposes the answer (for example `INVALID_STATUS_CHANNEL`).

### Guild meta and status test

These routes serve the dashboard "Log" tab (bot status channel, see `DASHBOARD.md`). A worker is *present* in a guild when its `GET /v1/status` answered and lists the guild.

- `GET /v1/guilds/:guildId/meta` asks every present worker for `GET /v1/guilds/:guildId/meta` and merges the answers: `200 {guildId, workerIds, sourceWorkerId, channels: [{id, name, type, parentName, position, postableBy: string[]}], roles: [...], failed: [{workerId, error}]}`. Channels and roles come from the first present worker (configuration order) that is ready and answered; `postableBy` lists, per channel, the workers that reported `canPost` (workers in `failed` did not answer, so their permissions are unknown). Worker answers are validated and malformed entries dropped. `404 NOT_IN_GUILD` when no worker is present, `503 META_UNAVAILABLE` when none answered.
- `POST /v1/guilds/:guildId/status-channel/test` with an optional body `{workerIds: string[]}` (non-empty, configured ids; `400 INVALID_WORKER_IDS` / `UNKNOWN_WORKERS` otherwise) asks the present workers (all of them, or the listed ones) to post the test message with their own saved setting (10 second timeout each): `200 {guildId, results: [{workerId, ok: true} | {workerId, ok: false, error}]}` in configuration order. `error` is a worker code above, `DISCORD_ERROR` for an unexpected answer, or `UNREACHABLE` when the worker did not answer or a requested worker is not present. `404 NOT_IN_GUILD` when no selected worker is present.

The orchestrator API token and every worker control token must be at least 32 characters (`openssl rand -hex 32` produces 64). Token, worker token and state paths are normalized before the `/run/secrets/` and `/state/` prefix checks.

## Playback relay

`POST /v1/playback` is used by the orchestrated playback pilots (`BOT_*_PLAYBACK.md`):

```text
muse-0N  --POST /v1/playback, Bearer control_token_0N-->  orchestrator
orchestrator  --POST /v1/playback, Bearer control_token_0N-->  muse-0N
```

The orchestrator identifies the caller only from its bearer token, which must match exactly one enabled worker, and forwards the validated request to that same worker. Workers reach the orchestrator at `MUSE_ORCHESTRATOR_URL` (default `http://orchestrator:3100`).

Status codes are preserved end to end. Short, fixed 4xx messages from the worker are shown to the user unchanged. `503` means the bot is not ready. `504` means the outcome could not be confirmed (timeout, lost connection, malformed response or the 170-second worker deadline): the user is told to check `/queue` before retrying, and nothing is retried automatically.

### Control token reuse and rotation

Each worker's control token authenticates both directions: the orchestrator calling the worker control API, and the worker calling the orchestrator playback relay. It never grants access to the orchestrator administration API. Because the same secret is read by both containers at startup, rotate it by replacing `control_token_0N` and then restarting the orchestrator and `muse-0N` together; restarting only one side leaves them with mismatched tokens until the other restarts.

Example multi-worker update request:

```json
{
  "workerIds": ["muse-01", "muse-02", "muse-03"],
  "settings": {
    "defaultVolume": 65,
    "leaveIfNoListeners": true
  }
}
```

If `workerIds` is omitted, the orchestrator applies the patch to all currently reachable workers that are members of the guild.

This is the API primitive the dashboard uses for:

- one bot;
- any arbitrary subset of bots;
- all bots available in a guild.


## Per-guild worker groups

Groups are stored centrally by the orchestrator in `/state/groups.json` and are scoped by Discord guild ID.

They are selection presets, not exclusive partitions. For example, one server can define:

```text
Principali = muse-01 + muse-02 + muse-03
Extra      = muse-04 + muse-05
Eventi     = muse-02 + muse-03 + muse-05
```

while another Discord server can define completely different groups using the same five bot accounts.

A worker may belong to multiple groups. A group remains persisted if one of its workers is temporarily unavailable; the dashboard identifies unavailable members rather than silently deleting them.

The group state is included in production backup and rollback together with the five worker SQLite databases. The super console keeps its block list in `/state/blocks.json` and its audit log in `/state/super-audit.json` in the same volume, with the same durability rules (see `SUPER_CONSOLE.md`).

Writes are durable and atomic: the next state is written to a temporary file, fsynced and renamed over `groups.json` (the directory is fsynced where the platform supports it), and only then applied in memory. Before each write the previous good state is saved as `groups.json.bak`. On startup the file is schema-validated; if it is unreadable or invalid the orchestrator falls back to `groups.json.bak` (with a warning), and refuses to start with a clear error if neither is valid.

### Single instance

The orchestrator keeps the group, block and audit stores in memory and is the only writer of `/state/groups.json`, `/state/blocks.json` and `/state/super-audit.json`. Run exactly one orchestrator instance per state volume; multiple replicas would silently overwrite each other's changes.
