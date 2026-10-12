import {HttpError} from '../control/http.js';
import type {WorkerBrandingResult, WorkerStatus} from '../control/types.js';
import type {GuildEntitlement} from '../plans/entitlements.js';
import {
  COUPON_BILLINGS,
  PLANS,
  PLAN_TIERS,
  couponIsLive,
  couponProblem,
  effectiveTier,
  isBillingPeriod,
  isPlanTier,
  normalizeCouponCode,
  type CouponBilling,
  type PlanTier,
} from '../plans/plans.js';
import {sanitizeBrandingProfile, type BotBranding} from '../plans/branding.js';
import {isPlainObject, isPrintable} from './durable-file.js';
import {
  COUPON_CODE,
  MAX_COUPON_DESCRIPTION_LENGTH,
  MAX_PLAN_NOTE_LENGTH,
  type Coupon,
  type GuildPlan,
  type PlanStore,
} from './plan-store.js';
import {SYSTEM_ACTOR, type Actor, type AuditEntryInput} from './super-store.js';
import type WorkerClient from './worker-client.js';

/** Expired plans are swept back to Free this often (Sentinel: every 10 minutes). */
export const PLAN_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export type SettledStatus = {workerId: string; ok: true; value: WorkerStatus} | {workerId: string; ok: false; error: string};

const FREE_PLAN = (now: Date): GuildPlan => ({
  tier: 'FREE', billing: null, expiresAt: null, couponCode: null, note: null, updatedAt: now.toISOString(),
});

const errorLabel = (error: unknown): string => error instanceof Error ? error.name : 'Error';

const objectBody = (input: unknown): Record<string, unknown> => {
  if (!isPlainObject(input)) {
    throw new HttpError(400, 'request body must be an object', 'INVALID_BODY');
  }

  return input;
};

/** Optional ISO 8601 date: undefined when absent, null when cleared. */
const optionalDate = (value: unknown, field: string, code: string): string | null | undefined => {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${field} must be an ISO 8601 date or null`, code);
  }

  return new Date(value).toISOString();
};

const optionalText = (value: unknown, field: string, max: number, code: string): string | null | undefined => {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} must be a string or null`, code);
  }

  const text = value.trim();
  if (text === '') {
    return null;
  }

  if (!isPrintable(text, 1, max)) {
    throw new HttpError(400, `${field} must have at most ${max} printable characters`, code);
  }

  return text;
};

const optionalInteger = (value: unknown, field: string, min: number, max: number): number | null | undefined => {
  if (value === undefined || value === null) {
    return value;
  }

  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new HttpError(400, `${field} must be an integer between ${min} and ${max}, or null`, 'INVALID_COUPON');
  }

  return value as number;
};

const optionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new HttpError(400, `${field} must be a boolean`, 'INVALID_COUPON');
  }

  return value;
};

/** Public promotion shape (pricing page): never the redemption counters or the author. */
export type Promotion = Pick<Coupon, 'code' | 'description' | 'percentOff' | 'amountOffCents' | 'tiers' | 'billing' | 'validUntil'>;

/**
 * Server plans, coupons and their effect on the workers, mirrored on Sentinel's plan service:
 * plans are assigned by hand from the super console (no online payments), coupons are only
 * counted, an expired plan behaves as Free at once and is swept back to Free every 10 minutes.
 * Limits reach the workers as entitlements pushed with the blocklist reconcile loop.
 */
export default class PlanService {
  private pushQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workers: WorkerClient[],
    private readonly store: PlanStore,
    private readonly record: (entry: AuditEntryInput) => void,
    private readonly statuses: () => Promise<SettledStatus[]>,
  ) {}

  /** Stored plan (Free when none was ever assigned). */
  plan(guildId: string, now: Date = new Date()): GuildPlan {
    return this.store.plan(guildId) ?? FREE_PLAN(now);
  }

  effectiveTier(guildId: string, now: Date = new Date()): PlanTier {
    return effectiveTier(this.plan(guildId, now), now);
  }

  /** Brand profiles of a guild by worker id. */
  branding(guildId: string): Record<string, BotBranding> {
    return this.store.branding(guildId);
  }

  coupons(): Coupon[] {
    return this.store.coupons();
  }

  plans(): Record<string, GuildPlan> {
    return this.store.plans();
  }

  /** Up to 10 public coupons that can be redeemed now. */
  promotions(now: Date = new Date()): Promotion[] {
    return this.store.coupons()
      .filter(coupon => coupon.public && couponIsLive(coupon, now))
      .slice(0, 10)
      .map(({code, description, percentOff, amountOffCents, tiers, billing, validUntil}) => ({
        code, description, percentOff, amountOffCents, tiers, billing, validUntil,
      }));
  }

  catalog() {
    return PLAN_TIERS.map(tier => PLANS[tier]);
  }

  /**
   * Members of every guild in configuration order. The first `bots` members of a guild are the
   * bots its plan includes; the others refuse commands there.
   */
  entitlementsByWorker(statuses: SettledStatus[], now: Date = new Date()): Map<string, GuildEntitlement[]> {
    const members = new Map<string, Array<{workerId: string; botId: string | null}>>();
    for (const worker of this.workers) {
      const status = statuses.find(result => result.workerId === worker.id);
      if (!status?.ok) {
        continue;
      }

      for (const guild of status.value.guilds) {
        members.set(guild.id, [...(members.get(guild.id) ?? []), {workerId: worker.id, botId: status.value.bot?.id ?? null}]);
      }
    }

    const byWorker = new Map<string, GuildEntitlement[]>(this.workers.map(worker => [worker.id, []]));
    for (const [guildId, guildMembers] of members) {
      const tier = this.effectiveTier(guildId, now);
      const included = guildMembers.slice(0, PLANS[tier].limits.bots);
      const allowedBotIds = included.flatMap(member => member.botId === null ? [] : [member.botId]);
      for (const member of guildMembers) {
        byWorker.get(member.workerId)?.push({guildId, tier, allowed: included.includes(member), allowedBotIds});
      }
    }

    return byWorker;
  }

  /** Workers of `guildId` that its plan includes, in configuration order. */
  allowedWorkerIds(guildId: string, statuses: SettledStatus[], now: Date = new Date()): string[] {
    return [...this.entitlementsByWorker(statuses, now)]
      .filter(([, entries]) => entries.some(entry => entry.guildId === guildId && entry.allowed))
      .map(([workerId]) => workerId);
  }

  /** Push every reachable worker its guilds' entitlements; runs one push at a time. */
  async pushEntitlements(): Promise<{pushed: string[]; failed: Array<{workerId: string; error: string}>}> {
    const run = this.pushQueue.then(async () => this.pushEntitlementsNow());
    this.pushQueue = run.catch(() => undefined);
    return run;
  }

  /** Plan, limits and usage of a guild for its dashboard (no internal note, no coupon). */
  guildUsage(guildId: string, statuses: SettledStatus[], groups: number, now: Date = new Date()) {
    const stored = this.plan(guildId, now);
    const tier = effectiveTier(stored, now);
    const present = statuses.filter(result => result.ok && result.value.guilds.some(guild => guild.id === guildId)).length;
    return {
      tier: stored.tier,
      effectiveTier: tier,
      billing: stored.billing,
      expiresAt: stored.expiresAt,
      plan: PLANS[tier],
      usage: {bots: present, groups},
      allowedWorkerIds: this.allowedWorkerIds(guildId, statuses, now),
      branding: this.store.branding(guildId),
    };
  }

  /**
   * `PUT /v1/guilds/:guildId/branding` (Sentinel: Brand plan): one bot's nickname and/or banner
   * in one guild. Body `{workerId, nickname?, banner?}`; `null` restores Discord's default.
   */
  async updateBranding(guildId: string, input: unknown, statuses: SettledStatus[], now: Date = new Date()): Promise<BotBranding & {workerId: string}> {
    const body = objectBody(input);
    const tier = this.effectiveTier(guildId, now);
    if (!PLANS[tier].customBranding) {
      throw new HttpError(403, `this server's ${PLANS[tier].name} plan does not include a custom bot name and banner`, 'PLAN_REQUIRED');
    }

    const {workerId} = body;
    const worker = this.workers.find(candidate => candidate.id === workerId);
    const present = statuses.some(result => result.workerId === workerId && result.ok && result.value.guilds.some(guild => guild.id === guildId));
    if (typeof workerId !== 'string' || !worker || !present) {
      throw new HttpError(404, 'that bot is not in this server', 'WORKER_NOT_IN_GUILD');
    }

    const profile = sanitizeBrandingProfile({nick: body.nickname, banner: body.banner});
    let result: WorkerBrandingResult;
    try {
      result = await worker.setBranding(guildId, profile);
    } catch (error: unknown) {
      throw new HttpError(503, `bot ${workerId} is unavailable (${errorLabel(error)})`, 'WORKER_UNAVAILABLE');
    }

    if (!result.ok) {
      throw result.error === 'MISSING_PERMISSION'
        ? new HttpError(422, 'the bot lacks the Change Nickname permission in this server', 'BRANDING_MISSING_PERMISSION')
        : new HttpError(422, 'Discord rejected the bot profile change', 'BRANDING_FAILED');
    }

    const previous = this.store.branding(guildId)[workerId] ?? {nickname: null, bannerSet: false};
    const next: BotBranding = {
      nickname: profile.nick === undefined ? previous.nickname : profile.nick,
      bannerSet: profile.banner === undefined ? previous.bannerSet : profile.banner !== null,
    };
    this.store.setBotBranding(guildId, workerId, next.nickname === null && !next.bannerSet ? null : next);
    return {workerId, ...next};
  }

  /** `PUT /v1/super/guilds/:guildId/plan` (Sentinel: changeGuildPlan). */
  async changeGuildPlan(guildId: string, input: unknown, actor: Actor, knownGuildIds: Set<string>, now: Date = new Date()) {
    const body = objectBody(input);
    if (!isPlanTier(body.tier)) {
      throw new HttpError(400, `tier must be one of: ${PLAN_TIERS.join(', ')}`, 'INVALID_PLAN');
    }

    const {tier} = body;
    if (body.billing !== undefined && body.billing !== null && !isBillingPeriod(body.billing)) {
      throw new HttpError(400, 'billing must be MONTHLY, YEARLY, GIFT or null', 'INVALID_PLAN');
    }

    if (!knownGuildIds.has(guildId)) {
      throw new HttpError(404, 'no bot is a member of that guild', 'GUILD_NOT_FOUND');
    }

    const free = tier === 'FREE';
    const expiresAt = optionalDate(body.expiresAt, 'expiresAt', 'INVALID_PLAN') ?? null;
    if (!free && expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime()) {
      throw new HttpError(400, 'a paid plan cannot expire in the past', 'EXPIRY_IN_PAST');
    }

    const previous = this.plan(guildId, now);
    const billing = free || !isBillingPeriod(body.billing) ? null : body.billing;
    const requestedCode = optionalText(body.couponCode, 'couponCode', 32, 'INVALID_PLAN');
    const couponCode = free || !requestedCode ? null : normalizeCouponCode(requestedCode);

    // A coupon is validated and redeemed only when it changes: one redemption per server.
    let redeem: string | undefined;
    if (couponCode !== null && couponCode !== previous.couponCode) {
      const coupon = this.store.coupon(couponCode);
      if (!coupon) {
        throw new HttpError(404, 'coupon not found', 'COUPON_NOT_FOUND');
      }

      const problem = couponProblem(coupon, tier, billing, now);
      if (problem) {
        throw new HttpError(400, `coupon cannot be applied (${problem})`, problem);
      }

      redeem = coupon.code;
    }

    const note = body.note === undefined ? previous.note : optionalText(body.note, 'note', MAX_PLAN_NOTE_LENGTH, 'INVALID_PLAN') ?? null;
    const plan: GuildPlan = {
      tier,
      billing,
      expiresAt: free ? null : expiresAt,
      couponCode,
      note,
      updatedAt: now.toISOString(),
    };
    this.store.setPlan(guildId, plan, redeem);
    if (!PLANS[effectiveTier(plan, now)].customBranding) {
      await this.resetBranding(guildId, actor);
    }

    this.record({
      actor,
      action: 'plan.update',
      subjectType: 'GUILD',
      subjectId: guildId,
      details: {previousTier: previous.tier, tier, billing, expiresAt: plan.expiresAt, couponCode, couponRedeemed: redeem !== undefined},
      outcome: 'ok',
    });
    await this.pushAfterChange();

    return {
      ok: true,
      previousTier: previous.tier,
      tier,
      effectiveTier: effectiveTier(plan, now),
      couponRedeemed: redeem !== undefined,
      plan,
    };
  }

  /** Expired paid plans go back to Free (expiry and note are kept); returns the swept guilds. */
  async sweepExpired(now: Date = new Date()): Promise<string[]> {
    const expired = Object.entries(this.store.plans())
      .filter(([, plan]) => plan.tier !== 'FREE' && plan.expiresAt !== null && new Date(plan.expiresAt).getTime() <= now.getTime());

    for (const [guildId, plan] of expired) {
      this.store.setPlan(guildId, {...plan, tier: 'FREE', billing: null, couponCode: null, updatedAt: now.toISOString()});
      this.record({
        actor: SYSTEM_ACTOR,
        action: 'plan.expired',
        subjectType: 'GUILD',
        subjectId: guildId,
        details: {previousTier: plan.tier, expiredAt: plan.expiresAt},
        outcome: 'ok',
      });
    }

    await Promise.all(expired.map(async ([guildId]) => this.resetBranding(guildId, SYSTEM_ACTOR)));

    if (expired.length > 0) {
      await this.pushAfterChange();
    }

    return expired.map(([guildId]) => guildId);
  }

  /** `POST /v1/super/coupons`. */
  createCoupon(input: unknown, actor: Actor, now: Date = new Date()): Coupon {
    const body = objectBody(input);
    if (typeof body.code !== 'string' || !COUPON_CODE.test(normalizeCouponCode(body.code))) {
      throw new HttpError(400, 'code must have 3-32 letters, digits, "_" or "-"', 'INVALID_COUPON');
    }

    const timestamp = now.toISOString();
    const coupon = this.couponFrom({
      code: normalizeCouponCode(body.code),
      description: null,
      percentOff: null,
      amountOffCents: null,
      tiers: [],
      billing: 'ANY',
      maxRedemptions: null,
      redemptions: 0,
      validFrom: null,
      validUntil: null,
      active: true,
      public: false,
      createdBy: {...actor},
      createdAt: timestamp,
      updatedAt: timestamp,
    }, body);
    const created = this.store.createCoupon(coupon);
    this.record({actor, action: 'coupon.create', subjectType: 'COUPON', subjectId: created.code, details: this.couponDetails(created), outcome: 'ok'});
    return created;
  }

  /** `PUT /v1/super/coupons/:code`: partial update (the code and counters never change). */
  updateCoupon(code: string, input: unknown, actor: Actor, now: Date = new Date()): Coupon {
    const existing = this.store.coupon(code);
    if (!existing) {
      throw new HttpError(404, 'coupon not found', 'COUPON_NOT_FOUND');
    }

    const updated = this.store.replaceCoupon(this.couponFrom({...existing, updatedAt: now.toISOString()}, objectBody(input)));
    this.record({actor, action: 'coupon.update', subjectType: 'COUPON', subjectId: updated.code, details: this.couponDetails(updated), outcome: 'ok'});
    return updated;
  }

  deleteCoupon(code: string, actor: Actor): Coupon {
    const deleted = this.store.deleteCoupon(code);
    this.record({actor, action: 'coupon.delete', subjectType: 'COUPON', subjectId: deleted.code, details: {redemptions: deleted.redemptions}, outcome: 'ok'});
    return deleted;
  }

  // eslint-disable-next-line complexity
  private couponFrom(base: Coupon, body: Record<string, unknown>): Coupon {
    const next: Coupon = {...base, tiers: [...base.tiers]};
    const description = optionalText(body.description, 'description', MAX_COUPON_DESCRIPTION_LENGTH, 'INVALID_COUPON');
    if (description !== undefined) {
      next.description = description;
    }

    const percentOff = optionalInteger(body.percentOff, 'percentOff', 1, 100);
    const amountOffCents = optionalInteger(body.amountOffCents, 'amountOffCents', 1, 100_000);
    if (percentOff !== undefined || amountOffCents !== undefined) {
      next.percentOff = percentOff ?? null;
      next.amountOffCents = amountOffCents ?? null;
    }

    if ((next.percentOff === null) === (next.amountOffCents === null)) {
      throw new HttpError(400, 'exactly one of percentOff and amountOffCents must be set', 'INVALID_COUPON');
    }

    if (body.tiers !== undefined) {
      if (!Array.isArray(body.tiers) || !body.tiers.every(tier => isPlanTier(tier) && tier !== 'FREE')) {
        throw new HttpError(400, 'tiers must list paid plans (TIER1, TIER2, TIER3)', 'INVALID_COUPON');
      }

      next.tiers = [...new Set(body.tiers as PlanTier[])];
    }

    if (body.billing !== undefined) {
      if (!(COUPON_BILLINGS as readonly unknown[]).includes(body.billing)) {
        throw new HttpError(400, 'billing must be ANY, MONTHLY or YEARLY', 'INVALID_COUPON');
      }

      next.billing = body.billing as CouponBilling;
    }

    const maxRedemptions = optionalInteger(body.maxRedemptions, 'maxRedemptions', 1, 100_000);
    if (maxRedemptions !== undefined || body.maxRedemptions === null) {
      next.maxRedemptions = maxRedemptions ?? null;
    }

    for (const field of ['validFrom', 'validUntil'] as const) {
      const value = optionalDate(body[field], field, 'INVALID_COUPON');
      if (value !== undefined || body[field] === null) {
        next[field] = value ?? null;
      }
    }

    if (next.validFrom && next.validUntil && next.validFrom > next.validUntil) {
      throw new HttpError(400, 'validFrom must not be after validUntil', 'INVALID_COUPON');
    }

    next.active = optionalBoolean(body.active, 'active') ?? next.active;
    next.public = optionalBoolean(body.public, 'public') ?? next.public;
    return next;
  }

  private couponDetails(coupon: Coupon): Record<string, unknown> {
    return {
      percentOff: coupon.percentOff,
      amountOffCents: coupon.amountOffCents,
      tiers: coupon.tiers,
      billing: coupon.billing,
      maxRedemptions: coupon.maxRedemptions,
      active: coupon.active,
      public: coupon.public,
    };
  }

  /**
   * Without the Brand plan every bot gets Discord's default name and banner back (Sentinel resets
   * on downgrade). The stored profiles are forgotten even when a bot cannot be reached.
   */
  private async resetBranding(guildId: string, actor: Actor): Promise<void> {
    const workerIds = Object.keys(this.store.branding(guildId));
    if (workerIds.length === 0) {
      return;
    }

    const failed: string[] = [];
    await Promise.all(workerIds.map(async workerId => {
      const worker = this.workers.find(candidate => candidate.id === workerId);
      if (!worker) {
        return;
      }

      try {
        const result = await worker.setBranding(guildId, {nick: null, banner: null});
        if (!result.ok) {
          failed.push(workerId);
        }
      } catch {
        failed.push(workerId);
      }
    }));

    this.store.clearBranding(guildId);
    this.record({
      actor,
      action: 'branding.reset',
      subjectType: 'GUILD',
      subjectId: guildId,
      details: {workerIds, failed},
      outcome: failed.length === 0 ? 'ok' : (failed.length === workerIds.length ? 'failed' : 'partial'),
    });
  }

  /** A plan change applies right away; a failed push is retried by the next reconcile pass. */
  private async pushAfterChange(): Promise<void> {
    try {
      const {failed} = await this.pushEntitlements();
      if (failed.length > 0) {
        console.warn(`Plan entitlements not pushed to: ${failed.map(failure => `${failure.workerId} (${failure.error})`).join(', ')}`);
      }
    } catch (error: unknown) {
      console.warn(`Plan entitlements push failed: ${errorLabel(error)}`);
    }
  }

  private async pushEntitlementsNow() {
    const statuses = await this.statuses();
    const byWorker = this.entitlementsByWorker(statuses);
    const results = await Promise.all(this.workers.map(async worker => {
      const status = statuses.find(result => result.workerId === worker.id);
      if (!status?.ok) {
        return {workerId: worker.id, ok: false as const, error: status?.ok === false ? status.error : 'WorkerUnreachable'};
      }

      try {
        await worker.pushEntitlements({guilds: byWorker.get(worker.id) ?? []});
        return {workerId: worker.id, ok: true as const};
      } catch (error: unknown) {
        return {workerId: worker.id, ok: false as const, error: errorLabel(error)};
      }
    }));

    return {
      pushed: results.filter(result => result.ok).map(result => result.workerId),
      failed: results.flatMap(result => result.ok ? [] : [{workerId: result.workerId, error: result.error}]),
    };
  }
}
