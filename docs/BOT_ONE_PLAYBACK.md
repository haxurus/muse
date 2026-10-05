# Bot 01 playback pilot

This step connects the existing Discord interface to the orchestrator and back to the first audio worker. It does not enable automatic selection among the five bots.

```
/play on Music 1 -> orchestrator /v1/playback -> muse-01 /v1/playback -> existing Muse player
```

## Scope

Only `muse-01` uses this opt-in path. It supports `/play`, `/pause`, `/resume`, `/skip` (and `/next`), `/stop`, `/disconnect`, `/queue`, and `/volume`. Play's immediate/shuffle/split/skip options and the existing provider/SponsorBlock pipeline are retained. Queue pagination and per-guild settings are retained. Responses are ephemeral plain text in this pilot; mentions are disabled. `/config` and autocomplete remain local. Other playback commands and old message buttons explicitly refuse execution in pilot mode, so they cannot bypass the admission guard.

Only ordinary guild text and voice channels are supported initially. The worker checks current guild membership, the requester's current voice channel and channel permissions. A bot already connected elsewhere in that guild is not moved or used to control that other channel. The same bot can still serve different guilds independently.

A busy guild rejects a second command with a retryable conflict, instead of running concurrent player mutations. Completed and failed request results are retained for 15 minutes for deduplication by guild and interaction ID. This is bounded, process-local idempotency, not a durable exactly-once guarantee across restarts. Active commands do not lose their reservation when an HTTP caller times out. A timeout produces an unconfirmed-outcome error, never a local fallback or an automatic replay. Inspect playback before manually retrying.

## Security and activation

Disabled by default. Set `MUSE_BOT_ONE_PLAYBACK=true` on **both** the orchestrator and muse-01, using `deploy/docker-compose.bot-one-playback.yml` as an additional Compose file. Do not set it on the other four bots.

The existing `control_token_01` authenticates this narrowly scoped pilot endpoint. It does not grant access to the orchestrator administration API, which still requires its separate API token. Bot 01 never receives that administration token. Neither Discord bot tokens nor Discord interaction tokens are sent through the playback API. No new host ports, services, secrets or Docker socket mounts are required.

The normal production deployment helper uses only the base Compose file and does **not** enable this pilot overlay. Do not enable automated VPS deployment as part of this step. During a controlled test installation, copy the overlay alongside the installed base file and run Compose with both files:

```sh
sudo docker compose --env-file /srv/docker/muse/.env \
  -f /srv/docker/muse/docker-compose.yml \
  -f /srv/docker/muse/docker-compose.bot-one-playback.yml \
  up -d orchestrator muse-01
```

Disabling the flag on bot 01 restores its original local command handling. Recreate both services using only the base Compose file to remove the overlay. Do not run two containers with bot 01's token simultaneously.

## Verification before production

Automated tests cover validation, opt-in scope, bounded admission, duplicate/conflicting requests, per-guild isolation, playback dispatch and authorization failures. A real Discord test still requires the configured bot token, provider credentials and a test guild. Verify play/pause/resume/skip/queue/volume, cross-channel refusal, disconnect/stop release, and the behavior when the orchestrator is unavailable.

Still deferred: worker 02-05 integration, automatic allocation/failover, operational group routing, durable reservations, runtime dashboard controls and fleet quotas. Existing per-guild groups remain configuration selection presets.
