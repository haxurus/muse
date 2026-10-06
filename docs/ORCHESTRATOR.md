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
POST  /v1/guilds/:guildId/leave
PUT   /v1/blocklist
POST  /v1/playback        (only when the worker's MUSE_BOT_*_PLAYBACK flag is "true")
```

`GET /v1/status` reports, per guild, `id`, `name`, `iconUrl`, `memberCount`, `ownerId` and `playerActive` (the bot has a voice connection there), and `bot.avatarUrl`. The extra fields are optional for the orchestrator, so mixed-version fleets keep working.

`POST /v1/guilds/:guildId/leave` makes the bot leave the guild: `200 {workerId, guildId, left: true}`, `404 {error, code: "NOT_IN_GUILD"}` when it is not a member, `400` for a malformed id.

`PUT /v1/blocklist` with `{guildIds: string[], userIds: string[]}` (Discord ids, at most 5000 each, duplicates removed, body up to 512 KiB) replaces the worker's in-memory blocklist and immediately leaves every blocked guild it is in: `200 {workerId, left: string[], failed: string[]}` (`failed` lists guilds it could not leave). Invalid input is `400 {error, code: "INVALID_BLOCKLIST"}` and leaves the current list unchanged.

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
