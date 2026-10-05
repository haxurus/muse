# Bot 02 playback pilot

This is the second incremental playback step. It extends the orchestrated playback path already validated for muse-01 to muse-02, without enabling automatic allocation between workers.

```text
/play on Music 2 -> orchestrator /v1/playback -> muse-02 /v1/playback -> existing Muse player
```

## Scope

When enabled on muse-02, the same pilot command set is available:

- /play
- /pause
- /resume
- /skip and /next
- /stop
- /disconnect
- /queue
- /volume

The command request remains bound to the worker that originated it. The orchestrator authenticates the caller with that worker's control token and forwards the mutation only to the matching internal worker URL.

muse-01 and muse-02 therefore stay independent. A muse-02 token cannot control muse-01, and the orchestrator administration token cannot be used as a playback-controller credential.

## Activation

The second worker is disabled by default.

To enable only muse-02 for a controlled test, apply:

```sh
sudo docker compose --env-file /srv/docker/muse/.env \
  -f /srv/docker/muse/docker-compose.yml \
  -f /srv/docker/muse/docker-compose.bot-two-playback.yml \
  up -d orchestrator muse-02
```

To test both first and second workers simultaneously, apply both overlays:

```sh
sudo docker compose --env-file /srv/docker/muse/.env \
  -f /srv/docker/muse/docker-compose.yml \
  -f /srv/docker/muse/docker-compose.bot-one-playback.yml \
  -f /srv/docker/muse/docker-compose.bot-two-playback.yml \
  up -d orchestrator muse-01 muse-02
```

Do not start duplicate containers with the same Discord bot token.

## Security invariants

The second step preserves the first pilot's boundaries:

- Discord interaction tokens never leave the receiving bot process.
- Discord bot tokens are never sent to the orchestrator.
- Each worker authenticates with its own control token.
- Playback responses are checked against the expected worker ID, guild ID and request ID.
- A worker cannot move an existing session to a different voice channel.
- User voice membership and permissions are rechecked around media resolution and voice connection.
- Timed-out mutations are not retried automatically and do not fall back to local execution.
- No host ports, Docker socket mounts or new public services are introduced.

## Still deferred

This step does not yet implement:

- automatic choice between muse-01 and muse-02;
- failover from one worker to another;
- operational use of X+Y groups for routing;
- worker leasing across the full five-bot fleet;
- dashboard runtime playback controls;
- fleet quotas.

Those remain separate increments after muse-02 has passed live Discord testing.
