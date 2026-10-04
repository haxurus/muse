# Coordinated playback pool

This opt-in mode uses the existing five Discord bot accounts and eight-service production Compose. It does not add a sixth Discord bot, expose a worker port, mount the Docker socket, or grant the controller the dashboard's administrative credential.

## Scope

`muse-01` exposes the Discord commands and may also serve as an audio player. `muse-02` through `muse-05` are audio workers. Each account can maintain one voice session per guild, so the same worker can serve different guilds concurrently.

Commands in pool mode:

- `/join`
- `/play query:<title or supported URL>`
- `/pause`, `/resume`, `/skip`
- `/stop`, `/disconnect` (both disconnect and clear this session's queue)
- `/queue` (current track and first ten queued tracks)
- `/volume level:<0-100>`
- `/players` (guild availability, without exposing other private channel IDs)

All commands currently require the caller to be in a standard voice channel. Stage channels and the remaining native Muse commands, including favorites and interactive queue pagination, are not part of this step. Enabling pool mode replaces legacy slash registrations; disabling it restores the native registration path on restart.

## Per-server group routing

Open `/pool` from Muse Control. Select an administrable Discord server, select a default group, and optionally associate Discord voice channel/category IDs with that server's saved groups.

Precedence is exact voice channel, then parent category, then server default. A null default means every present worker is eligible. Existing voice sessions stay on their assigned worker even if routing changes. An exhausted group returns an error rather than borrowing a bot from an unrelated group. Deleting a referenced group is blocked until its routes are removed.

Rules are persisted in `/state/pool-routes.json`, alongside `/state/groups.json`. Writes validate guild/group scope and use a temporary file and atomic rename. Settings and routes for one guild do not modify another guild.

## Reservation and failure behavior

The orchestrator serializes allocation per guild and commands per voice channel. It acknowledges a worker-side reservation before sending an audio command. A reserve does not join a channel or start playback. An unused reservation expires after 30 seconds; replaying that reserve cannot renew it. Commands carry a per-process worker instance UUID, a lease UUID, a request ID and a 180-second deadline.

Workers validate the caller's current voice membership, guild, channel/category context and voice permissions before playback. They recheck the context after media resolution. A fresh room clears the previous room's queue, loop flags and volume override. Administrative voice moves invalidate the old lease instead of carrying the private queue into the destination.

The coordinator re-observes worker state when handling commands. Paused sessions remain occupied. Disconnected workers become available again. An unreachable worker causes new allocation to fail closed, since it may still own a voice session. An ambiguous HTTP result is not automatically retried or failed over to another worker; inspect `/players` and `/queue` first.

This implementation supports one orchestrator replica. Replay records are bounded and kept in process memory for 15 minutes after completion. They are not a durable exactly-once event ledger across process restarts. Worker instance IDs and acknowledged leases reject stale commands and help a restarted orchestrator discover current sessions. Worker restart recovery does not persist or resume audio queues.

## Configuration and secrets

Keep `MUSE_POOL_ENABLED=false` until a staging test is ready. The current Compose reads this setting for all five workers and the orchestrator. It assigns `controller` to `muse-01` and `worker` to the other four automatically.

The updated installer generates `secrets/pool_client_token` as 32 random bytes encoded as hex, with the existing restricted host permissions. It is mounted only in `muse-01` and the orchestrator. The dashboard and other workers do not receive it. It authenticates playback requests but cannot modify groups, routing or guild settings. Per-worker control tokens remain separate. The API rejects using the same value for playback and administrative credentials.

When upgrading an installation, update the installed Compose and operator scripts with the current installer before deploying this image. The installer does not overwrite populated secrets or an existing `.env`. Explicitly set `MUSE_POOL_ENABLED=true` in the VPS `.env` only after reviewing the staging checklist. Do not enable a second controller or scale the orchestrator.

## Backups and rollback

Pre-deploy backups include all worker databases plus both `groups.json` and `pool-routes.json`. Automatic rollback after a failed deployment restores the pre-deploy state when a previous image and recorded backup exist. The manual `rollback` command is an image rollback: it retains the current state and creates a safety backup; it is not a historical database restore. No queue persistence is implied.

## Required staging validation

No real Discord voice test is performed by CI. Before enabling production deployment, use a test guild and verify:

1. All five distinct bot accounts are present and ready; only `muse-01` exposes the pool commands.
2. Two users invoke `/play` in different channels concurrently and receive different workers. Commands in one channel control only its existing worker.
3. `/join` followed by `/play` starts audio; pause, resume, skip, volume, queue and disconnect work.
4. Two independent guilds can use the same worker without crossing queues/settings.
5. Voice/category/default group precedence works, group exhaustion does not spill over, and changes do not move active sessions.
6. Move or disconnect a worker administratively, restart a worker, restart the orchestrator, and interrupt a control request. Verify no duplicate assignment and no queue carried to another room.
7. Verify host firewall paths, return traffic, media/Discord connectivity, OAuth permissions, and backup restoration on VPS01.

CI checks TypeScript, lint, mocked worker/coordinator behavior, routing persistence, authorization boundaries, browser syntax, operator script syntax, Compose in both modes and the production image build. These checks do not replace a live audio/network test or a full security audit.
