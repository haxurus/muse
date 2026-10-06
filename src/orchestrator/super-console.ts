import type {IncomingMessage} from 'node:http';
import {HttpError, readJsonBody} from '../control/http.js';
import {assertGuildId, isSnowflake} from '../control/snowflake.js';
import type {WorkerBlocklistResult, WorkerStatus} from '../control/types.js';
import type WorkerClient from './worker-client.js';
import {isPlainObject, isPrintable} from './durable-file.js';
import {
  MAX_ACTOR_NAME_LENGTH,
  isBlockKind,
  normalizeReason,
  type Actor,
  type AuditEntry,
  type AuditOutcome,
  type AuditStore,
  type BlockKind,
  type BlockStore,
} from './super-store.js';

export const ACTOR_ID_HEADER = 'x-muse-actor-id';
export const ACTOR_NAME_HEADER = 'x-muse-actor-name';
export const OVERVIEW_AUDIT_LIMIT = 200;
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

export type WorkerFailure = {
  workerId: string;
  error: string;
};

type Settled<T> = {workerId: string; ok: true; value: T} | {workerId: string; ok: false; error: string};

export type SuperRouteResult = {
  statusCode: number;
  body: unknown;
};

type PushResult = {
  pushed: string[];
  failed: WorkerFailure[];
  results: Array<Settled<WorkerBlocklistResult>>;
};

const errorLabel = (error: unknown): string => error instanceof Error ? error.name : 'Error';

const settle = async <T>(workerId: string, promise: Promise<T>): Promise<Settled<T>> => {
  try {
    return {workerId, ok: true, value: await promise};
  } catch (error: unknown) {
    return {workerId, ok: false, error: errorLabel(error)};
  }
};

const outcomeOf = (succeeded: number, failed: number): AuditOutcome => {
  if (failed === 0) {
    return 'ok';
  }

  return succeeded === 0 ? 'failed' : 'partial';
};

const failuresOf = <T>(results: Array<Settled<T>>): WorkerFailure[] => results
  .flatMap(result => result.ok ? [] : [{workerId: result.workerId, error: result.error}]);

/**
 * The dashboard backend asserts which Discord user performed a mutation. `x-muse-actor-id` is a
 * required snowflake; `x-muse-actor-name` is optional plain printable ASCII, or percent-encoded UTF-8
 * (encodeURIComponent) when the name has non-ASCII characters; undecodable values are used as sent.
 */
export const parseActor = (request: IncomingMessage): Actor => {
  const userId = request.headers[ACTOR_ID_HEADER];
  if (!isSnowflake(userId)) {
    throw new HttpError(400, `${ACTOR_ID_HEADER} header must be a Discord user id`, 'INVALID_ACTOR');
  }

  const rawName = request.headers[ACTOR_NAME_HEADER];
  if (rawName === undefined) {
    return {userId, username: 'unknown'};
  }

  if (typeof rawName !== 'string') {
    throw new HttpError(400, `${ACTOR_NAME_HEADER} header must be sent once`, 'INVALID_ACTOR');
  }

  let username: string;
  try {
    username = decodeURIComponent(rawName).trim();
  } catch {
    // Not percent-encoded (for example a plain ASCII name containing '%'): use it as sent.
    username = rawName.trim();
  }

  if (username.length === 0) {
    return {userId, username: 'unknown'};
  }

  if (!isPrintable(username, 1, MAX_ACTOR_NAME_LENGTH)) {
    throw new HttpError(400, `${ACTOR_NAME_HEADER} header must contain 1-${MAX_ACTOR_NAME_LENGTH} printable characters`, 'INVALID_ACTOR');
  }

  return {userId, username};
};

const objectBody = (input: unknown): Record<string, unknown> => {
  if (!isPlainObject(input)) {
    throw new HttpError(400, 'request body must be an object', 'INVALID_BODY');
  }

  return input;
};

/** Super-console routes, durable block/audit state and the blocklist reconcile loop. */
export default class SuperConsole {
  private pushQueue: Promise<unknown> = Promise.resolve();
  private reconcileTimer?: NodeJS.Timeout;
  private reconciling = false;
  private lastReconcileFailures = '';

  constructor(
    private readonly workers: WorkerClient[],
    private readonly blocks: BlockStore,
    private readonly audit: AuditStore,
  ) {}

  // eslint-disable-next-line complexity
  async route(request: IncomingMessage, segments: string[]): Promise<SuperRouteResult | undefined> {
    if (segments[0] !== 'v1') {
      return undefined;
    }

    if (request.method === 'GET' && segments.length === 3 && segments[1] === 'super' && segments[2] === 'overview') {
      return {statusCode: 200, body: await this.overview()};
    }

    if (request.method === 'POST'
      && segments.length === 5
      && segments[1] === 'super'
      && segments[2] === 'guilds'
      && segments[4] === 'leave') {
      const actor = parseActor(request);
      assertGuildId(segments[3]);
      return {statusCode: 200, body: await this.leaveGuild(segments[3], await readJsonBody(request), actor)};
    }

    if ((request.method === 'PUT' || request.method === 'DELETE')
      && segments.length === 5
      && segments[1] === 'super'
      && segments[2] === 'blocks') {
      const actor = parseActor(request);
      const kind = segments[3];
      if (!isBlockKind(kind)) {
        throw new HttpError(400, 'block kind must be GUILD or USER', 'INVALID_BLOCK_KIND');
      }

      const subjectId = segments[4];
      if (!isSnowflake(subjectId)) {
        throw new HttpError(400, 'subject id must be a Discord id', 'INVALID_SUBJECT_ID');
      }

      return request.method === 'PUT'
        ? {statusCode: 200, body: await this.upsertBlock(kind, subjectId, await readJsonBody(request), actor)}
        : {statusCode: 200, body: await this.deleteBlock(kind, subjectId, actor)};
    }

    if (request.method === 'GET'
      && segments.length === 4
      && segments[1] === 'blocks'
      && segments[2] === 'users') {
      if (!isSnowflake(segments[3])) {
        throw new HttpError(400, 'user id must be a Discord id', 'INVALID_SUBJECT_ID');
      }

      return {statusCode: 200, body: {blocked: this.blocks.isBlocked('USER', segments[3])}};
    }

    return undefined;
  }

  /** Push the blocklist now and then every `intervalMs`; workers lose it when they restart. */
  startReconcile(intervalMs = DEFAULT_RECONCILE_INTERVAL_MS): void {
    this.stopReconcile();
    void this.reconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, intervalMs);
    this.reconcileTimer.unref();
  }

  stopReconcile(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  /** One reconcile pass; skipped while the previous pass is still running. */
  async reconcile(): Promise<void> {
    if (this.reconciling) {
      return;
    }

    this.reconciling = true;
    try {
      const {failed} = await this.pushBlocklist();
      const summary = failed.map(failure => `${failure.workerId} (${failure.error})`).join(', ');
      // Only log changes, so a worker that stays down does not log every minute.
      if (summary !== this.lastReconcileFailures) {
        if (summary) {
          console.warn(`Blocklist reconcile failed for: ${summary}`);
        } else {
          console.log('Blocklist reconcile succeeded for all workers');
        }

        this.lastReconcileFailures = summary;
      }
    } catch (error: unknown) {
      console.error(`Blocklist reconcile failed: ${errorLabel(error)}`);
    } finally {
      this.reconciling = false;
    }
  }

  async overview() {
    const statuses = await this.statuses();
    const blockedGuilds = new Set(this.blocks.blocklist().guildIds);

    const workers = statuses.map(result => {
      if (!result.ok) {
        return {
          id: result.workerId,
          reachable: false,
          ready: false,
          bot: null,
          guildCount: 0,
          activePlayers: 0,
          uptimeSeconds: null,
          error: result.error,
        };
      }

      const status = result.value;
      return {
        id: result.workerId,
        reachable: true,
        ready: status.discordReady,
        bot: status.bot
          ? {id: status.bot.id, username: status.bot.username, avatarUrl: status.bot.avatarUrl ?? null}
          : null,
        guildCount: status.guilds.length,
        activePlayers: status.players.filter(player => player.connected).length,
        uptimeSeconds: status.uptimeSeconds,
      };
    });

    type OverviewGuild = {
      id: string;
      name: string;
      iconUrl: string | null;
      memberCount: number | null;
      ownerId: string | null;
      workerIds: string[];
      blocked: boolean;
    };
    const guilds = new Map<string, OverviewGuild>();
    for (const result of statuses) {
      if (!result.ok) {
        continue;
      }

      for (const guild of result.value.guilds) {
        const existing = guilds.get(guild.id);
        guilds.set(guild.id, {
          id: guild.id,
          name: existing?.name ?? guild.name,
          iconUrl: existing?.iconUrl ?? guild.iconUrl ?? null,
          memberCount: existing?.memberCount ?? guild.memberCount ?? null,
          ownerId: existing?.ownerId ?? guild.ownerId ?? null,
          workerIds: [...(existing?.workerIds ?? []), result.workerId].sort(),
          blocked: blockedGuilds.has(guild.id),
        });
      }
    }

    return {
      workers,
      guilds: [...guilds.values()].sort((left, right) => left.name.localeCompare(right.name)),
      blocks: this.blocks.list(),
      audit: this.audit.list(OVERVIEW_AUDIT_LIMIT),
    };
  }

  async leaveGuild(guildId: string, input: unknown, actor: Actor) {
    assertGuildId(guildId);
    const requested = this.requestedWorkerIds(objectBody(input).workerIds);
    const statuses = await this.statuses();
    const present = new Set(statuses
      .filter(result => result.ok && result.value.guilds.some(guild => guild.id === guildId))
      .map(result => result.workerId));
    const unreachable = new Set(statuses.filter(result => !result.ok).map(result => result.workerId));

    const targets = requested ?? this.workers.map(worker => worker.id).filter(id => present.has(id));
    if (requested === undefined && targets.length === 0) {
      throw new HttpError(404, 'no reachable worker is a member of that guild', 'GUILD_NOT_FOUND');
    }

    const failed: WorkerFailure[] = targets
      .filter(id => !present.has(id))
      .map(id => ({workerId: id, error: unreachable.has(id) ? 'WorkerUnreachable' : 'WorkerNotInGuild'}));
    const results = await Promise.all(this.workers
      .filter(worker => targets.includes(worker.id) && present.has(worker.id))
      .map(async worker => settle(worker.id, worker.leaveGuild(guildId))));
    const left = results.filter(result => result.ok).map(result => result.workerId);
    failed.push(...failuresOf(results));

    this.record({
      actor,
      action: 'guild.leave',
      subjectType: 'GUILD',
      subjectId: guildId,
      details: {requestedWorkerIds: requested ?? null, left, failed},
      outcome: outcomeOf(left.length, failed.length),
    });

    return {guildId, left, failed};
  }

  async upsertBlock(kind: BlockKind, subjectId: string, input: unknown, actor: Actor) {
    if (kind === 'USER' && subjectId === actor.userId) {
      throw new HttpError(400, 'you cannot block yourself', 'CANNOT_BLOCK_SELF');
    }

    const reason = normalizeReason(objectBody(input).reason);
    const {block, created} = this.persist(
      {actor, action: 'block.upsert', subjectType: kind, subjectId},
      () => this.blocks.upsert(kind, subjectId, reason, actor),
    );
    const {pushed, failed, results} = await this.pushBlocklist();

    this.record({
      actor,
      action: 'block.upsert',
      subjectType: kind,
      subjectId,
      details: {
        created,
        reason: reason ?? null,
        pushed,
        failed,
        ...(kind === 'GUILD' ? {leftWorkerIds: this.workersThatLeft(results, subjectId)} : {}),
      },
      outcome: failed.length === 0 ? 'ok' : 'partial',
    });

    return {block, created, pushed, failed};
  }

  async deleteBlock(kind: BlockKind, subjectId: string, actor: Actor) {
    const block = this.persist(
      {actor, action: 'block.delete', subjectType: kind, subjectId},
      () => this.blocks.remove(kind, subjectId),
    );
    const {pushed, failed} = await this.pushBlocklist();

    this.record({
      actor,
      action: 'block.delete',
      subjectType: kind,
      subjectId,
      details: {pushed, failed},
      outcome: failed.length === 0 ? 'ok' : 'partial',
    });

    return {block, pushed, failed};
  }

  /** Push the current blocklist to every worker; calls are serialized so a stale list never lands last. */
  async pushBlocklist(): Promise<PushResult> {
    const run = this.pushQueue.then(async () => this.pushBlocklistNow());
    this.pushQueue = run.catch(() => undefined);
    return run;
  }

  private async pushBlocklistNow(): Promise<PushResult> {
    const blocklist = this.blocks.blocklist();
    const results = await Promise.all(this.workers.map(async worker => settle(worker.id, worker.pushBlocklist(blocklist))));
    return {
      pushed: results.filter(result => result.ok).map(result => result.workerId),
      failed: failuresOf(results),
      results,
    };
  }

  private workersThatLeft(results: Array<Settled<WorkerBlocklistResult>>, guildId: string): string[] {
    return results
      .filter(result => result.ok && Array.isArray(result.value.left) && result.value.left.includes(guildId))
      .map(result => result.workerId);
  }

  /** Run a store mutation; unexpected (non-HTTP) failures are audited as failed before rethrowing. */
  private persist<T>(context: Pick<AuditEntry, 'actor' | 'action' | 'subjectType' | 'subjectId'>, mutate: () => T): T {
    try {
      return mutate();
    } catch (error: unknown) {
      if (!(error instanceof HttpError)) {
        this.record({...context, details: {error: errorLabel(error)}, outcome: 'failed'});
      }

      throw error;
    }
  }

  private requestedWorkerIds(value: unknown): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (!Array.isArray(value) || value.length === 0 || value.some(workerId => typeof workerId !== 'string')) {
      throw new HttpError(400, 'workerIds must be a non-empty string array', 'INVALID_WORKER_IDS');
    }

    const requested = [...new Set(value as string[])];
    const unknownIds = requested.filter(id => !this.workers.some(worker => worker.id === id));
    if (unknownIds.length > 0) {
      throw new HttpError(400, `unknown workers: ${unknownIds.join(', ')}`, 'UNKNOWN_WORKERS');
    }

    return requested.sort();
  }

  private async statuses(): Promise<Array<Settled<WorkerStatus>>> {
    return Promise.all(this.workers.map(async worker => settle(worker.id, worker.status())));
  }

  /** Audit entries are written after the action; a failed audit write never fails the action. */
  private record(entry: Omit<AuditEntry, 'id' | 'at'>): void {
    try {
      this.audit.append(entry);
    } catch (error: unknown) {
      console.error(`Failed to write super-console audit entry (${entry.action} ${entry.subjectType}:${entry.subjectId}): ${errorLabel(error)}`);
    }
  }
}
