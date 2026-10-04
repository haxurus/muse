# Muse worker pool

Muse can coordinate five independent Discord music workers inside each guild.

## Per-guild configuration

Every guild owns its own pool configuration. A change in one Discord server does not affect the same workers in another server.

The pool has two quota levels:

- guild quota: maximum concurrent logical players in the guild;
- group quota: maximum concurrent logical players that may use workers in that group.

A logical player remains assigned while it is connected or while it still owns a resumable queue.

## Groups

Workers may be partitioned into groups such as:

```text
Main
  muse-01
  muse-02
  muse-03

Events
  muse-04
  muse-05
```

The partition can be 3+2, 4+1, 2+2+1, or any other combination supported by the configured worker count.

Within one guild:

- a worker may belong to at most one group;
- a voice channel may be explicitly mapped to at most one group;
- when groups exist, exactly one group is the default;
- unmapped voice channels use the default group.

Groups are independent between guilds.

## Automatic assignment

When a pool-managed command is used in a voice channel, the worker contacts the orchestrator over its private control network.

For a new `/play` request the orchestrator:

1. checks whether that voice channel already owns a player;
2. checks for a short in-flight reservation;
3. resolves the explicit voice-channel group, or the default group;
4. enforces the guild quota;
5. enforces the group quota;
6. removes workers already occupied by another logical player in that guild;
7. prefers the bot on which the user invoked the command when it is eligible and free;
8. otherwise reserves the first eligible free worker for 45 seconds.

The reservation prevents two simultaneous requests from allocating the same worker before Discord voice join completes.

Once the worker connects, the reservation is reconciled with the real player state.

## Existing-player commands

Commands that act on an existing player are routed to the worker already owning the voice channel.

Examples include:

- pause;
- resume;
- skip;
- queue;
- volume;
- seek;
- loop;
- disconnect;
- queue manipulation commands.

If the user invokes one of those commands on a different music bot, Muse tells the user which bot owns the voice channel instead of creating conflicting player state.

## Temporary disconnects

A worker remembers the last voice channel while it still has a current queue entry.

This means an auto-disconnected or manually disconnected resumable queue remains logically attached to the same worker and voice channel.

Once no resumable player state remains, the worker becomes available for a new assignment in that guild.

## Persistence

Pool configuration is stored by the orchestrator in:

```text
/data/pool-config.json
```

Production maps that path to:

```text
/srv/docker/muse/data/orchestrator/pool-config.json
```

Writes use an atomic temporary-file + rename sequence.

The file is included in the production backup and rollback flow together with the five worker SQLite databases.

## Security boundary

Workers authenticate assignment requests with their own existing control token.

A worker may request assignments only for a guild it is itself a member of.

The pool API is reachable only over internal Docker control networks. It is not exposed through Nginx Proxy Manager or the dashboard edge.
