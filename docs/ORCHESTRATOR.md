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
- persistent per-guild worker groups with arbitrary overlapping membership.

Implemented playback pool:

- `muse-01` is the user-facing controller and remains available as an audio worker;
- `muse-02` through `muse-05` are commandless audio workers;
- leases are scoped to Discord guild + voice channel;
- a worker can serve different guilds concurrently, but only one voice channel per guild;
- allocations are serialized per guild to prevent double assignment;
- worker state is reconciled every 15 seconds and after orchestrator restarts;
- groups can be routed as default, per Discord category, or per voice channel;
- routing priority is voice channel > category > default > all available workers;
- core playback operations are remotely controlled through private worker APIs.

Not implemented yet:

- per-guild simultaneous-player quotas;
- dashboard audit log;
- advanced queue editing commands in controller mode.

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
GET   /v1/guilds/:guildId/channels
POST  /v1/guilds/:guildId/playback/play
POST  /v1/guilds/:guildId/playback/pause
POST  /v1/guilds/:guildId/playback/resume
POST  /v1/guilds/:guildId/playback/skip
POST  /v1/guilds/:guildId/playback/stop
POST  /v1/guilds/:guildId/playback/disconnect
POST  /v1/guilds/:guildId/playback/volume
GET   /v1/guilds/:guildId/playback/queue
GET   /v1/guilds/:guildId/playback/now-playing
```

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
GET    /v1/guilds/:guildId/channels
GET    /v1/guilds/:guildId/routing
PUT    /v1/guilds/:guildId/routing
GET    /v1/guilds/:guildId/playback
POST   /v1/guilds/:guildId/playback/:action
GET    /v1/guilds/:guildId/playback/queue
GET    /v1/guilds/:guildId/playback/now-playing
```

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

The group state is included in production backup and rollback together with the five worker SQLite databases.


## Controller and audio workers

Only `muse-01` exposes the managed playback commands:

```text
/play
/pause
/resume
/skip
/next
/stop
/disconnect
/queue
/volume
/now-playing
```

The other four Discord applications remove their slash commands in worker mode. Users therefore interact with one application while the orchestrator can assign any of the five bot accounts to the requested voice channel.

The controller does not receive the Discord tokens of other workers.

## Playback leases

A lease binds:

```text
Discord guild + voice channel -> Muse worker
```

Within one guild, the same worker cannot be leased to two voice channels simultaneously. The same worker may still serve another guild because Discord voice connections are guild-scoped.

Lease states are:

- `RESERVED` while a worker has been claimed but playback setup is not complete;
- `ACTIVE` while playback is active;
- `PAUSED` for paused or intentionally disconnected sessions that still retain a queue.

A failed initial allocation is released. A lease held by an unreachable worker is released on a failed command so a later request can choose another worker.

The orchestrator reconstructs leases from worker-reported voice and queue state. Workers retain the last assigned voice channel while a paused queue exists, allowing an orchestrator-only restart to recover that assignment.

## Playback routing

Routing is stored in `/state/routing.json`.

An administrator can configure:

```text
Default            -> Principali
Category "Events"  -> Eventi
Voice "Radio"      -> Radio
```

Resolution priority is:

```text
specific voice rule
    ↓
category rule
    ↓
default group
    ↓
all workers
```

If the selected group has no free reachable worker, the request fails without borrowing a bot from another group. This keeps administrative routing meaningful.
