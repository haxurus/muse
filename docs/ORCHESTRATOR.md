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
- persistent per-guild worker groups and quotas;
- automatic voice-channel worker assignment.

Not implemented yet:

- audit log UI.

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
PATCH /v1/guilds/:guildId/workers/settings
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

## Pool routing

See [POOL.md](POOL.md) for worker grouping, quota enforcement, reservations and voice-channel assignment.
