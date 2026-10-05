# Bot 03 playback pilot

This third incremental step adds `muse-03` to the existing opt-in playback protocol. It reuses the same worker implementation as bots 01 and 02, rather than creating a separate music engine.

```text
Command on Music 3 -> orchestrator /v1/playback -> muse-03 /v1/playback -> Muse player
```

Supported commands: `/play`, `/pause`, `/resume`, `/skip`, `/next`, `/stop`, `/disconnect`, `/queue`, `/volume`. The existing play options and per-guild settings remain available. Pilot replies are ephemeral text. As in the earlier pilots, `/config` and autocomplete remain native; unsupported playback commands and old message buttons refuse execution. Ordinary guild text and voice channels are supported, not threads or Stage channels.

## Independent activation

`MUSE_BOT_THREE_PLAYBACK=true` enables bot 03 only when set on both the orchestrator and `muse-03`. Nothing is enabled by default. Bots 04 and 05 remain on their existing local command path.

The new overlay is `deploy/docker-compose.bot-three-playback.yml`. It changes only the two relevant service environments. Existing `discord_token_03`, `control_token_03`, `control-03`, worker data/cache volumes and resource limits are reused. No token value, port publication, network, service or Docker socket mount is added.

The regular production deployment helper still uses the base Compose file and does not activate pilot overlays. This change is not a VPS deployment. Before a controlled test, use an image built from a revision containing this change and copy the selected overlays alongside the installed base Compose file.

For an installation where ONLY bot 03 is being tested:

```sh
sudo docker compose --env-file /srv/docker/muse/.env \
  -f /srv/docker/muse/docker-compose.yml \
  -f /srv/docker/muse/docker-compose.bot-three-playback.yml \
  up -d orchestrator muse-03
```

If other pilots are already active, retain their overlays. Compose does not remember previously supplied override files. For all three pilots:

```sh
sudo docker compose --env-file /srv/docker/muse/.env \
  -f /srv/docker/muse/docker-compose.yml \
  -f /srv/docker/muse/docker-compose.bot-one-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-two-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-three-playback.yml \
  up -d orchestrator muse-01 muse-02 muse-03
```

Never run two containers with the same Discord bot token. To disable the third pilot, remove its overlay and recreate the orchestrator and bot 03 while retaining the overlays of any other active pilots.

## Routing and isolation

The orchestrator selects the destination from the authenticated control credential, not from a user-supplied `workerId`. With distinct configured credentials, bot 03 requests are forwarded only to bot 03. Responses must match the expected worker, guild and request identifiers. Ambiguous credentials shared by enabled workers are rejected.

Each worker retains its own queue, player, per-guild admission guard and bounded in-memory request deduplication. The worker rechecks guild/channel membership and permissions before acting and around media lookup/voice connection. An occupied bot is not moved into a different voice channel. A transport timeout never triggers automatic retry, another bot or local fallback; inspect the state before retrying manually. Deduplication is process-local, not an exactly-once guarantee across restarts.

Discord bot tokens and interaction tokens are not forwarded through this API. These controls do not constitute a guarantee against every possible compromise.

## Automated coverage and live verification

The worker regression suite runs for all three worker identities, covering play, pause/resume, skip, stop/disconnect, queue, volume, authorization changes, cross-channel denial and failure handling. Additional tests cover bot 03 activation, all three credential routes, wrong/ambiguous credentials, response identity, duplicate/concurrent requests and Discord controller forwarding.

CI validates the base production Compose configuration plus every non-empty combination of the three playback overlays using `docker compose config`; it does not start them or contact Discord.

A live Discord/VPS test is still required. Exercise bot 03 in a test voice channel, ensure a user in another voice channel cannot control it, verify that bots 01 and 02 are unaffected, and check stop/disconnect and an orchestrator outage. Automated tests use mocked Discord/media dependencies, not actual audio playback.

## Remaining increments

No automatic allocation, failover, operational X+Y routing, fleet quotas or runtime dashboard playback controls are added. An administrator still chooses the relevant bot's Discord command. Per-server groups remain configuration selection presets. Bots 04 and 05 are separate future increments.
