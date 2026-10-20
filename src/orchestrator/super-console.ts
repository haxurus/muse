import type {IncomingMessage} from 'node:http';
import {HttpError, readJsonBody} from '../control/http.js';
import {assertGuildId, isSnowflake} from '../control/snowflake.js';
import {
  type InstallSubject,
  isStatusAnnounceError,
  type StatusAnnounceError,
  type StatusAnnounceRequest,
  type WorkerAlertKind,
  type WorkerAlertSubject,
  type WorkerBlocklistResult,
  type WorkerLogs,
  type WorkerStatus,
  type WorkerStatusAnnounceResult,
} from '../control/types.js';
import {logBuffer, parseLogLimit, sanitizeLogEntries} from '../utils/log-buffer.js';
import type WorkerClient from './worker-client.js';
import {isPlainObject, isPrintable} from './durable-file.js';
import {isContactDiscord, isContactEmail, isHttpsUrl, type PlatformSettingsStore} from './platform-store.js';
import {WorkerHealthTracker, type WorkerHealthTransition} from './worker-health.js';
import {mergeGuildMeta, type MergedGuildMeta} from './guild-meta.js';
import PlanService, {PLAN_SWEEP_INTERVAL_MS} from './plan-service.js';
import type {PlanStore} from './plan-store.js';
import {parseMentionRoleIds} from '../control/mention-roles.js';
import {
  MAX_ACTOR_NAME_LENGTH,
  SYSTEM_ACTOR,
  isBlockKind,
  normalizeReason,
  type Actor,
  type AuditEntry,
  type AuditEntryInput,
  type AuditOutcome,
  type AuditStore,
  type BlockKind,
  type BlockStore,
} from './super-store.js';

export const ACTOR_ID_HEADER = 'x-muse-actor-id';
export const ACTOR_NAME_HEADER = 'x-muse-actor-name';
export const OVERVIEW_AUDIT_LIMIT = 200;
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
/** Log source of the orchestrator's own buffer in `GET /v1/super/workers/:workerId/logs`. */
export const ORCHESTRATOR_LOGS_ID = 'orchestrator';

export type WorkerFailure = {
  workerId: string;
  error: string;
};

type Settled<T> = {workerId: string; ok: true; value: T} | {workerId: string; ok: false; error: string};

export type SuperRouteResult = {
  statusCode: number;
  body: unknown;
};

/** Per-worker result of a status channel test; `UNREACHABLE` when the worker did not answer. */
export type StatusTestResult = {workerId: string; ok: true} | {workerId: string; ok: false; error: StatusAnnounceError | 'UNREACHABLE'};

type PushResult = {
  pushed: string[];
  failed: WorkerFailure[];
  results: Array<Settled<WorkerBlocklistResult>>;
};

/** What became of one health alert: not sent (and why), posted by a bot, or failed. */
type AlertDelivery =
  | {status: 'skipped'; reason: string}
  | {status: 'posted'; postedBy: string}
  | {status: 'failed'; error: string; postedBy: string | null};

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

const statusTestResult = (result: Settled<WorkerStatusAnnounceResult>): StatusTestResult => {
  if (!result.ok) {
    return {workerId: result.workerId, ok: false, error: 'UNREACHABLE'};
  }

  // Worker answers are validated, not trusted: anything unexpected is reported as DISCORD_ERROR.
  const answer: unknown = result.value;
  if (isPlainObject(answer) && answer.ok === true) {
    return {workerId: result.workerId, ok: true};
  }

  const error = isPlainObject(answer) ? answer.error : undefined;
  return {workerId: result.workerId, ok: false, error: isStatusAnnounceError(error) ? error : 'DISCORD_ERROR'};
};

/** Audit details of one health alert: who posted it, or why it was not posted. */
const deliveryDetails = (delivery: AlertDelivery): Record<string, unknown> => {
  if (delivery.status === 'posted') {
    return {notified: true, postedBy: delivery.postedBy};
  }

  if (delivery.status === 'skipped') {
    return {notified: false, reason: delivery.reason};
  }

  return {notified: false, error: delivery.error, ...(delivery.postedBy === null ? {} : {postedBy: delivery.postedBy})};
};

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
  /** Server plans and coupons; shares this console's audit log and worker statuses. */
  readonly plans: PlanService;
  private pushQueue: Promise<unknown> = Promise.resolve();
  private reconcileTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private reconciling = false;
  private lastReconcileFailures = '';
  private lastEntitlementFailures = '';
  private readonly health = new WorkerHealthTracker();
  /** Last username seen per bot, named in the alerts about a bot that is down. */
  private readonly botNames = new Map<string, string>();

  constructor(
    private readonly workers: WorkerClient[],
    private readonly blocks: BlockStore,
    private readonly audit: AuditStore,
    private readonly platform: PlatformSettingsStore,
    planStore: PlanStore,
  ) {
    this.plans = new PlanService(workers, planStore, entry => {
      this.record(entry);
    }, async () => this.statuses());
  }

  /** Audit entries from other orchestrator parts (install gate); a failed write is only logged. */
  appendAudit(entry: AuditEntryInput): void {
    this.record(entry);
  }

  /** "Installation refused" in the status channel (when set), audited with the system actor. Never throws. */
  async announceInstallRejected(install: InstallSubject): Promise<void> {
    try {
      const delivery = await this.deliverStatusNotice({kind: 'install-rejected', install}, await this.statuses());
      this.record({
        actor: SYSTEM_ACTOR,
        action: 'install.rejected',
        subjectType: 'GUILD',
        subjectId: install.guildId,
        details: {guildName: install.guildName, memberCount: install.memberCount, installerId: install.installerId, workerId: install.workerId, ...deliveryDetails(delivery)},
        outcome: delivery.status === 'failed' ? 'failed' : 'ok',
      });
    } catch (error: unknown) {
      console.error(`Install rejection notice failed: ${errorLabel(error)}`);
    }
  }

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
      && segments.length === 5
      && segments[1] === 'super'
      && segments[2] === 'guilds'
      && segments[4] === 'meta') {
      assertGuildId(segments[3]);
      return {statusCode: 200, body: await this.guildMeta(segments[3])};
    }

    if (request.method === 'PUT'
      && segments.length === 5
      && segments[1] === 'super'
      && segments[2] === 'guilds'
      && segments[4] === 'plan') {
      const actor = parseActor(request);
      assertGuildId(segments[3]);
      const knownGuildIds = new Set((await this.statuses()).flatMap(result => result.ok ? result.value.guilds.map(guild => guild.id) : []));
      return {statusCode: 200, body: await this.plans.changeGuildPlan(segments[3], await readJsonBody(request), actor, knownGuildIds)};
    }

    if (request.method === 'PUT' && segments.length === 3 && segments[1] === 'super' && segments[2] === 'config') {
      const actor = parseActor(request);
      return {statusCode: 200, body: this.setInstanceConfig(await readJsonBody(request), actor)};
    }

    if (request.method === 'GET' && segments.length === 3 && segments[1] === 'public' && segments[2] === 'info') {
      return {statusCode: 200, body: this.publicInfo()};
    }

    if (segments.length >= 3 && segments.length <= 4 && segments[1] === 'super' && segments[2] === 'coupons') {
      return this.couponRoute(request, segments[3]);
    }

    if (segments.length >= 3 && segments[1] === 'super' && segments[2] === 'status-channel') {
      return this.statusChannelRoute(request, segments.slice(3));
    }

    if (request.method === 'GET'
      && segments.length === 5
      && segments[1] === 'super'
      && segments[2] === 'workers'
      && segments[4] === 'logs') {
      return {statusCode: 200, body: await this.workerLogs(segments[3], request.url)};
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

  /**
   * Push the blocklist and the plan entitlements now and then every `intervalMs` (workers lose
   * both when they restart), and sweep expired plans back to Free at start and every 10 minutes.
   */
  startReconcile(intervalMs = DEFAULT_RECONCILE_INTERVAL_MS, sweepIntervalMs = PLAN_SWEEP_INTERVAL_MS): void {
    this.stopReconcile();
    void this.sweepPlans();
    void this.reconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, intervalMs);
    this.reconcileTimer.unref();
    this.sweepTimer = setInterval(() => {
      void this.sweepPlans();
    }, sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stopReconcile(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }

    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** One expiry sweep; failures are only logged. */
  async sweepPlans(): Promise<void> {
    try {
      const expired = await this.plans.sweepExpired();
      if (expired.length > 0) {
        console.log(`Plans expired back to Free: ${expired.join(', ')}`);
      }
    } catch (error: unknown) {
      console.error(`Plan expiry sweep failed: ${errorLabel(error)}`);
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
    }

    await this.observeWorkerHealth();

    try {
      const {failed} = await this.plans.pushEntitlements();
      const summary = failed.map(failure => `${failure.workerId} (${failure.error})`).join(', ');
      if (summary !== this.lastEntitlementFailures) {
        if (summary) {
          console.warn(`Plan entitlements reconcile failed for: ${summary}`);
        } else {
          console.log('Plan entitlements reconcile succeeded for all workers');
        }

        this.lastEntitlementFailures = summary;
      }
    } catch (error: unknown) {
      console.error(`Plan entitlements reconcile failed: ${errorLabel(error)}`);
    } finally {
      this.reconciling = false;
    }
  }

  async overview() {
    const statuses = await this.statuses();
    const blockedGuilds = new Set(this.blocks.blocklist().guildIds);

    const workers = statuses.map(result => {
      // Set while a "bot offline" alert is outstanding (as of the last reconcile pass).
      const downSince = this.health.downSince(result.workerId);
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
          downSince,
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
        downSince,
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
      plan: ReturnType<SuperConsole['overviewPlan']>;
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
          plan: this.overviewPlan(guild.id),
        });
      }
    }

    return {
      workers,
      guilds: [...guilds.values()].sort((left, right) => left.name.localeCompare(right.name)),
      blocks: this.blocks.list(),
      audit: this.audit.list(OVERVIEW_AUDIT_LIMIT),
      statusChannel: this.platform.statusChannel(),
      coupons: this.plans.coupons(),
      planCatalog: this.plans.catalog(),
      config: this.platform.instance(),
    };
  }

  /**
   * `GET /v1/public/info`: what the public pricing and beta pages show (Sentinel /api/public/info):
   * whether the waitlist is open, the public contacts and the live public coupons.
   */
  publicInfo() {
    const {waitlistOpen, contactEmail, contactDiscord, contactUrl} = this.platform.instance();
    return {
      waitlistOpen,
      contacts: {email: contactEmail, discord: contactDiscord, url: contactUrl},
      promotions: this.plans.promotions(),
    };
  }

  /** `PUT /v1/super/config`: waitlist switch and public contacts; an empty string clears a contact. */
  setInstanceConfig(input: unknown, actor: Actor) {
    const body = objectBody(input);
    const patch: Parameters<PlatformSettingsStore['setInstance']>[0] = {};
    if (body.waitlistOpen !== undefined) {
      if (typeof body.waitlistOpen !== 'boolean') {
        throw new HttpError(400, 'waitlistOpen must be a boolean', 'INVALID_CONFIG');
      }

      patch.waitlistOpen = body.waitlistOpen;
    }

    const contact = (field: 'contactEmail' | 'contactDiscord' | 'contactUrl', isValid: (value: unknown) => boolean, rule: string) => {
      const value = body[field];
      if (value === undefined) {
        return;
      }

      const text = typeof value === 'string' ? value.trim() : value;
      if (text === '' || text === null) {
        patch[field] = null;
        return;
      }

      if (!isValid(text)) {
        throw new HttpError(400, `${field} must be ${rule}, or empty`, 'INVALID_CONFIG');
      }

      patch[field] = text as string;
    };

    contact('contactEmail', isContactEmail, 'an email address of at most 200 characters');
    contact('contactDiscord', isContactDiscord, 'a Discord username or an https link of at most 200 characters');
    contact('contactUrl', isHttpsUrl, 'an https URL of at most 500 characters');
    if (Object.keys(patch).length === 0) {
      throw new HttpError(400, 'nothing to change', 'INVALID_CONFIG');
    }

    const config = this.platform.setInstance(patch, actor);
    this.record({actor, action: 'instance.config', subjectType: 'INSTANCE', subjectId: 'config', details: {...patch}, outcome: 'ok'});
    return config;
  }

  /**
   * `GET /v1/super/workers/:workerId/logs`: the orchestrator's own buffer, or one bot's buffer fetched from
   * it. An unknown id is `404 WORKER_NOT_FOUND`; a bot that does not answer is `503 WORKER_UNAVAILABLE`.
   */
  async workerLogs(workerId: string, url: string | undefined): Promise<WorkerLogs> {
    const limit = parseLogLimit(url);
    if (workerId === ORCHESTRATOR_LOGS_ID) {
      return {workerId, entries: logBuffer.recent(limit)};
    }

    const worker = this.workers.find(candidate => candidate.id === workerId);
    if (!worker) {
      throw new HttpError(404, 'unknown worker', 'WORKER_NOT_FOUND');
    }

    let answer: unknown;
    try {
      answer = await worker.logs(limit);
    } catch {
      throw new HttpError(503, 'worker is unavailable', 'WORKER_UNAVAILABLE');
    }

    // The bot's answer is validated and redacted again before it reaches the super console.
    return {workerId, entries: sanitizeLogEntries(isPlainObject(answer) ? answer.entries : undefined).slice(-limit)};
  }

  /** Full plan of a guild for the super console (with the internal note and coupon). */
  overviewPlan(guildId: string) {
    const plan = this.plans.plan(guildId);
    return {...plan, effectiveTier: this.plans.effectiveTier(guildId)};
  }

  /** `POST /v1/super/coupons`, `PUT|DELETE /v1/super/coupons/:code`. */
  async couponRoute(request: IncomingMessage, code: string | undefined): Promise<SuperRouteResult | undefined> {
    if (code === undefined && request.method === 'POST') {
      const actor = parseActor(request);
      return {statusCode: 201, body: {coupon: this.plans.createCoupon(await readJsonBody(request), actor)}};
    }

    if (code !== undefined && request.method === 'PUT') {
      const actor = parseActor(request);
      return {statusCode: 200, body: {coupon: this.plans.updateCoupon(code, await readJsonBody(request), actor)}};
    }

    if (code !== undefined && request.method === 'DELETE') {
      const actor = parseActor(request);
      return {statusCode: 200, body: {coupon: this.plans.deleteCoupon(code, actor)}};
    }

    return undefined;
  }

  /** `GET|PUT /v1/super/status-channel` and `POST /v1/super/status-channel/test`. */
  async statusChannelRoute(request: IncomingMessage, rest: string[]): Promise<SuperRouteResult | undefined> {
    if (rest.length === 0 && request.method === 'GET') {
      return {statusCode: 200, body: this.platform.statusChannel()};
    }

    if (rest.length === 0 && request.method === 'PUT') {
      const actor = parseActor(request);
      return {statusCode: 200, body: await this.setStatusChannel(await readJsonBody(request), actor)};
    }

    if (rest.length === 1 && rest[0] === 'test' && request.method === 'POST') {
      const actor = parseActor(request);
      return {statusCode: 200, body: await this.testStatusChannel(actor)};
    }

    return undefined;
  }

  /** Channel and role pickers of the status channel card: one bot's view plus which bots can post where. */
  async guildMeta(guildId: string): Promise<MergedGuildMeta> {
    const statuses = await this.statuses();
    const present = this.workers.flatMap(worker => {
      const status = statuses.find(result => result.workerId === worker.id);
      return status?.ok && status.value.guilds.some(guild => guild.id === guildId)
        ? [{worker, ready: status.value.discordReady}]
        : [];
    });
    if (present.length === 0) {
      throw new HttpError(404, 'no reachable bot is a member of that guild', 'NOT_IN_GUILD');
    }

    const answers = await Promise.all(present.map(async ({worker, ready}) => ({
      ready,
      result: await settle<unknown>(worker.id, worker.guildMeta(guildId)),
    })));
    return mergeGuildMeta(guildId, answers);
  }

  /**
   * Save the server, channel and mentioned roles (`channelId: null` disables the messages). The channel
   * and roles are checked against what the bots in that server currently see, so only real choices are stored.
   */
  async setStatusChannel(input: unknown, actor: Actor) {
    const body = objectBody(input);
    const {guildId, channelId} = body;
    if (channelId !== null && !isSnowflake(channelId)) {
      throw new HttpError(400, 'channelId must be a Discord channel id or null', 'INVALID_CHANNEL_ID');
    }

    if (channelId !== null && !isSnowflake(guildId)) {
      throw new HttpError(400, 'guildId must be the Discord server id of the channel', 'INVALID_GUILD_ID');
    }

    const current = this.platform.statusChannel();
    const statusGuildId = channelId === null || !isSnowflake(guildId) ? null : guildId;
    // Omitted means "keep the current roles" (only within the same server); [] removes every mention.
    const keptRoleIds = statusGuildId === current.statusGuildId ? current.mentionRoleIds : [];
    const mentionRoleIds = body.mentionRoleIds === undefined ? keptRoleIds : parseMentionRoleIds(body.mentionRoleIds);
    if (channelId !== null && statusGuildId !== null) {
      const meta = await this.guildMeta(statusGuildId);
      if (!meta.channels.some(channel => channel.id === channelId)) {
        throw new HttpError(400, 'channelId must be a text or announcement channel of that server', 'INVALID_STATUS_CHANNEL');
      }

      if (!mentionRoleIds.every(roleId => meta.roles.some(role => role.id === roleId))) {
        throw new HttpError(400, 'mentionRoleIds must be roles of that server (not @everyone, not managed roles)', 'INVALID_STATUS_ROLES');
      }
    }

    const previousChannelId = current.statusChannelId;
    const action = channelId === null ? 'status_channel.clear' : 'status_channel.set';
    const subjectId = channelId ?? previousChannelId ?? 'none';
    const setting = this.persist(
      {actor, action, subjectType: 'CHANNEL', subjectId},
      () => this.platform.setStatusChannel(statusGuildId, channelId, mentionRoleIds, actor),
    );

    this.record({
      actor,
      action,
      subjectType: 'CHANNEL',
      subjectId,
      details: {
        previousGuildId: current.statusGuildId,
        previousChannelId,
        statusGuildId,
        statusChannelId: channelId,
        mentionRoleCount: mentionRoleIds.length,
      },
      outcome: 'ok',
    });

    return setting;
  }

  /** Every worker posts a test message in the configured channel; unreachable workers are reported, never fatal. */
  async testStatusChannel(actor: Actor) {
    const {statusGuildId, statusChannelId, mentionRoleIds} = this.platform.statusChannel();
    if (statusChannelId === null) {
      throw new HttpError(400, 'no status channel is configured', 'STATUS_CHANNEL_NOT_SET');
    }

    const settled = await Promise.all(this.workers.map(async worker => settle(worker.id, worker.announceStatus({guildId: statusGuildId, channelId: statusChannelId, test: true, mentionRoleIds}))));
    const results = settled.map(result => statusTestResult(result));
    const succeeded = results.filter(result => result.ok).length;

    this.record({
      actor,
      action: 'status_channel.test',
      subjectType: 'CHANNEL',
      subjectId: statusChannelId,
      details: {mentionRoleCount: mentionRoleIds.length, results},
      outcome: outcomeOf(succeeded, results.length - succeeded),
    });

    return {statusGuildId, statusChannelId, results};
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

  /**
   * One health check of every bot (healthy = reachable and Discord ready), then the alerts it makes due.
   * Runs inside the reconcile loop; failures are logged, never thrown, so the loop keeps going.
   */
  private async observeWorkerHealth(): Promise<void> {
    try {
      const statuses = await this.statuses();
      for (const result of statuses) {
        if (result.ok && result.value.bot) {
          this.botNames.set(result.workerId, result.value.bot.username);
        }
      }

      const transitions = this.health.observe(statuses.map(result => ({
        workerId: result.workerId,
        healthy: result.ok && result.value.discordReady,
      })), new Date().toISOString());
      await Promise.all(transitions.map(async transition => this.announceWorkerTransition(transition, statuses)));
    } catch (error: unknown) {
      console.error(`Worker health check failed: ${errorLabel(error)}`);
    }
  }

  /** Sends one alert (when a status channel is set) and audits it with the system actor. Never throws. */
  private async announceWorkerTransition(transition: WorkerHealthTransition, statuses: Array<Settled<WorkerStatus>>): Promise<void> {
    const down = transition.type === 'down';
    const worker: WorkerAlertSubject = {
      workerId: transition.workerId,
      botName: this.botNames.get(transition.workerId) ?? transition.workerId,
      since: transition.since,
    };
    const delivery = await this.deliverWorkerAlert(down ? 'worker-down' : 'worker-recovered', worker, statuses);
    const downtimeSeconds = Math.max(0, Math.round((Date.now() - Date.parse(transition.since)) / 1000));
    this.record({
      actor: SYSTEM_ACTOR,
      action: down ? 'worker.down' : 'worker.recovered',
      subjectType: 'WORKER',
      subjectId: transition.workerId,
      details: {since: transition.since, ...(down ? {} : {downtimeSeconds}), ...deliveryDetails(delivery)},
      outcome: delivery.status === 'failed' ? 'failed' : 'ok',
    });
  }

  /** Posts one alert through a healthy bot that is a member of the status server. */
  private async deliverWorkerAlert(kind: WorkerAlertKind, worker: WorkerAlertSubject, statuses: Array<Settled<WorkerStatus>>): Promise<AlertDelivery> {
    return this.deliverStatusNotice({kind, worker}, statuses);
  }

  /** Posts one alert or notice through a healthy bot that is a member of the status server. */
  private async deliverStatusNotice(notice: Pick<StatusAnnounceRequest, 'kind' | 'worker' | 'install'>, statuses: Array<Settled<WorkerStatus>>): Promise<AlertDelivery> {
    const {statusGuildId, statusChannelId, mentionRoleIds} = this.platform.statusChannel();
    if (statusChannelId === null) {
      return {status: 'skipped', reason: 'NO_STATUS_CHANNEL'};
    }

    if (statusGuildId === null) {
      return {status: 'skipped', reason: 'NO_STATUS_GUILD'};
    }

    const poster = this.workers.find(candidate => statuses.some(result => result.workerId === candidate.id
      && result.ok
      && result.value.discordReady
      && result.value.guilds.some(guild => guild.id === statusGuildId)));
    if (!poster) {
      return {status: 'failed', error: 'NO_HEALTHY_POSTER', postedBy: null};
    }

    const answer = statusTestResult(await settle(poster.id, poster.announceStatus({
      guildId: statusGuildId,
      channelId: statusChannelId,
      test: false,
      mentionRoleIds,
      ...notice,
    })));
    return answer.ok
      ? {status: 'posted', postedBy: poster.id}
      : {status: 'failed', error: answer.error, postedBy: poster.id};
  }

  /** Audit entries are written after the action; a failed audit write never fails the action. */
  private record(entry: AuditEntryInput): void {
    try {
      this.audit.append(entry);
    } catch (error: unknown) {
      console.error(`Failed to write super-console audit entry (${entry.action} ${entry.subjectType}:${entry.subjectId}): ${errorLabel(error)}`);
    }
  }
}
