# Bot 05 playback pilot

This fifth incremental step adds `muse-05` to the existing opt-in playback path. All five configured workers can now use the shared controller, transport, admission guard and music player independently. There is no duplicated fifth music engine.

```text
Command on Music 5 -> orchestrator /v1/playback -> muse-05 /v1/playback -> Muse player
```

## Supported behavior

Commands: `/play`, `/pause`, `/resume`, `/skip`, `/next`, `/stop`, `/disconnect`, `/queue` and `/volume`. Existing play options and per-guild settings are retained. Replies are ephemeral text. `/config` and autocomplete stay local; unsupported playback commands and old message buttons refuse execution in pilot mode. Only ordinary guild text and voice channels are supported, not threads or Stage channels.

Routing is still manual and credential-bound: a command issued to Music 5 is executed by Music 5. Completing the five individual workers does not implement the automatic pool. The orchestrator does not yet choose a free bot or use X+Y groups for playback routing.

## Independent activation

Nothing is enabled by default. `MUSE_BOT_FIVE_PLAYBACK=true` must be configured on both the orchestrator and `muse-05`. Use `deploy/docker-compose.bot-five-playback.yml` with the base production Compose file, never standalone.

Only the environment of those two services changes. Existing `discord_token_05`, `control_token_05`, `control-05`, data/cache volumes and resource limits are reused. No additional tokens, services, networks, public ports or Docker socket mounts are introduced.

The production installer/deployment helper still uses the base Compose configuration and does not activate or install pilot overlays. Before a controlled test, use an image built from a revision containing this change and copy the selected overlays alongside the installed base Compose file. The following commands are instructions, not actions performed by this change.

For an installation testing ONLY bot 05:

```sh
sudo docker compose --env-file /srv/docker/muse/.env \
  -f /srv/docker/muse/docker-compose.yml \
  -f /srv/docker/muse/docker-compose.bot-five-playback.yml \
  up -d orchestrator muse-05
```

Retain every already-active pilot overlay on each Compose invocation. To test all five:

```sh
sudo docker compose --env-file /srv/docker/muse/.env \
  -f /srv/docker/muse/docker-compose.yml \
  -f /srv/docker/muse/docker-compose.bot-one-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-two-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-three-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-four-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-five-playback.yml \
  up -d orchestrator muse-01 muse-02 muse-03 muse-04 muse-05
```

To disable the fifth pilot, omit its overlay and recreate the orchestrator and bot 05 while retaining any other active overlays. Never start duplicate containers with the same Discord bot token. Do not enable automated VPS deployment as part of this increment.

## Isolation and failure behavior

With distinct configured control credentials, the orchestrator forwards a request only to its authenticated worker. Caller-supplied target worker IDs, URLs or credentials in the request body are rejected. Responses must match the expected worker, guild and request identifiers. Ambiguous credentials shared by enabled workers are rejected.

Discord bot tokens and interaction tokens are not forwarded by this playback API. Each worker retains its own player, queue and per-guild admission guard. Guild/voice membership and channel permissions are rechecked before acting and around media lookup/voice connection. A session already assigned to another voice channel is not moved or controlled.

Deduplication is bounded and process-local, not a durable exactly-once guarantee across restarts. An uncertain transport timeout never triggers an automatic retry, local fallback or another worker. Inspect the playback state before retrying manually. These controls are not a guarantee against every possible compromise.

## Verification

The shared worker regression suite exercises all five identities and checks that a busy worker does not block the other four in the same guild. The fifth-pilot suite tests all 32 activation combinations including all-off, all five credential routes, incorrect/ambiguous credentials, absent workers, forged routing fields, mismatched responses, every supported command, and timeout behavior. Earlier bot 03/04 tests now distinguish supported-but-disabled bot 05 from unknown worker IDs.

CI validates the base production Compose file plus all 31 non-empty combinations of the five overlays with `docker compose config`. It also runs the existing lint, TypeScript, test and image-build checks. Compose validation does not start containers. Automated Discord/media tests use mocks, not live audio.

A real Discord/VPS test is still required before production activation. Test bot 05 commands, cross-channel denial, permission changes, concurrent use of the first four bots, stop/disconnect and an orchestrator outage. No VPS commands, production credential changes or live playback tests are performed by this code increment.

Still deferred: automatic allocation/failover, operational X+Y routing, durable fleet reservations, runtime dashboard playback controls and quotas. Per-server groups remain configuration selection presets.
