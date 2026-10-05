# Bot 04 playback pilot

This fourth incremental step adds `muse-04` to the existing opt-in playback path. It reuses the shared controller, transport, admission guard and music player rather than duplicating them.

```text
Command on Music 4 -> orchestrator /v1/playback -> muse-04 /v1/playback -> Muse player
```

## Supported behavior

The command set is `/play`, `/pause`, `/resume`, `/skip`, `/next`, `/stop`, `/disconnect`, `/queue` and `/volume`. Existing play options and per-guild settings are retained. Replies are ephemeral text; `/config` and autocomplete stay local. Unsupported playback commands and old message buttons refuse execution in pilot mode. Only ordinary guild text and voice channels are supported initially, not threads or Stage channels.

This is still manual, credential-bound routing: the command issued to Music 4 is executed by Music 4. It does not select another bot automatically. Bots 01-03 keep their own independent activation flags; bot 05 remains on its original local command path.

## Activation

Nothing is enabled by default. `MUSE_BOT_FOUR_PLAYBACK=true` must be set on both the orchestrator and `muse-04`. Use `deploy/docker-compose.bot-four-playback.yml` together with the production Compose file, never standalone.

The overlay changes only those two services' environment settings. Existing `discord_token_04`, `control_token_04`, `control-04`, data/cache mounts and resource limits are reused. No new secrets, services, networks, host ports or Docker socket mounts are introduced.

The normal production deployment helper does not activate pilot overlays. Before a controlled test, use an image built from a revision containing this increment and copy the required overlay files alongside the installed base Compose file.

For an installation testing ONLY bot 04:

```sh
sudo docker compose --env-file /srv/docker/muse/.env \
  -f /srv/docker/muse/docker-compose.yml \
  -f /srv/docker/muse/docker-compose.bot-four-playback.yml \
  up -d orchestrator muse-04
```

If previous pilots are active, retain their overlays in every Compose invocation. To test all four:

```sh
sudo docker compose --env-file /srv/docker/muse/.env \
  -f /srv/docker/muse/docker-compose.yml \
  -f /srv/docker/muse/docker-compose.bot-one-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-two-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-three-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-four-playback.yml \
  up -d orchestrator muse-01 muse-02 muse-03 muse-04
```

To disable bot 04's pilot, omit its overlay and recreate the orchestrator and bot 04 while retaining any other active overlays. Do not run two containers with the same Discord bot token. Do not enable automated VPS deployment as part of this increment.

## Isolation and failure behavior

With distinct configured control credentials, the orchestrator selects exactly the authenticated worker. A caller-supplied target worker or URL is rejected. Responses must match the expected worker ID, guild ID and request ID. Credentials shared by multiple enabled workers are rejected as ambiguous.

Discord bot tokens and interaction tokens are not included in playback request bodies. Worker 04 receives only its own mounted Discord/control credentials plus the shared provider credentials already defined by the base Compose file. The orchestrator still requires a separate token for administration endpoints.

The shared worker revalidates the requester's current guild/voice membership and channel permissions, including around media resolution and voice connection. An existing session in another channel is not moved or controlled. Each worker has its own queue and per-guild admission guard: bot 04 being busy does not reserve bots 01-03 in the same server.

Deduplication is bounded and process-local, not a durable exactly-once guarantee across restarts. A transport timeout is an unconfirmed outcome and never triggers an automatic retry, local fallback or failover to another bot. Inspect playback before retrying manually.

## Verification

The shared worker regression suite now exercises all four identities. Additional coverage includes every independent activation-flag combination, all four credential routes, invalid/ambiguous credentials, forged target fields, response identity mismatches, command forwarding without Discord credentials, concurrent independent workers, deduplication and timeout handling.

CI validates the base Compose file and all 15 non-empty combinations of the four pilot overlays with `docker compose config`. This checks configuration, not running containers. Automated Discord/media tests use mocks and do not replace live audio testing.

Before production, test bot 04's supported commands in a real test guild, denial from a different voice channel, permission revocation, simultaneous use of bots 01-03, stop/disconnect and an orchestrator outage. This increment does not itself deploy to the VPS or verify live Discord playback.

Still deferred: bot 05 integration, automatic allocation/failover, operational X+Y group routing, durable fleet reservations, runtime dashboard playback controls and quotas. Existing per-server groups remain configuration selection presets.
