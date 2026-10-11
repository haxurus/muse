import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  PLANS,
  PLAN_TIERS,
  basePriceCents,
  couponProblem,
  discountedPriceCents,
  effectiveTier,
  planAdjustedSettings,
  planSettingsProblem,
  tierAllows,
  type CouponLike,
} from '../src/plans/plans.js';
import {assertSettingsWithinPlan, entitlements, sanitizeEntitlements} from '../src/plans/entitlements.js';
import {planBotRefusal, pricingUrl} from '../src/plans/messages.js';
import {PlanStore} from '../src/orchestrator/plan-store.js';
import PlanService, {type SettledStatus} from '../src/orchestrator/plan-service.js';
import {SYSTEM_ACTOR, AuditStore, type AuditEntryInput} from '../src/orchestrator/super-store.js';
import type WorkerClient from '../src/orchestrator/worker-client.js';

const actor = {userId: '123456789012345678', username: 'Admin'};
const guildA = '111111111111111111';
const guildB = '222222222222222222';
const NOW = new Date('2026-10-11T12:00:00.000Z');

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  entitlements.set({guilds: []});
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const tempFile = (name: string): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-plans-'));
  cleanups.push(() => {
    rmSync(directory, {recursive: true, force: true});
  });
  return path.join(directory, name);
};

const coupon = (overrides: Partial<CouponLike> = {}): CouponLike => ({
  code: 'BETA50', percentOff: 50, amountOffCents: null, tiers: [], billing: 'ANY', maxRedemptions: null,
  redemptions: 0, validFrom: null, validUntil: null, active: true, ...overrides,
});

describe('plan catalog (same tiers and prices as Sentinel)', () => {
  it('has the four Sentinel tiers, names and prices in euro cents', () => {
    expect(PLAN_TIERS).toEqual(['FREE', 'TIER1', 'TIER2', 'TIER3']);
    expect(PLAN_TIERS.map(tier => [PLANS[tier].name, PLANS[tier].monthlyCents, PLANS[tier].yearlyCents])).toEqual([
      ['Free', 0, 0], ['Plus', 200, 2000], ['Pro', 500, 5000], ['Brand', 1000, 9000],
    ]);
  });

  it('has the agreed music limits, never decreasing with the level', () => {
    expect(PLAN_TIERS.map(tier => PLANS[tier].limits)).toEqual([
      {bots: 1, groups: 0, playlistTracks: 50, favorites: 10, alwaysOn: false},
      {bots: 2, groups: 2, playlistTracks: 200, favorites: 50, alwaysOn: false},
      {bots: 5, groups: 10, playlistTracks: 500, favorites: 200, alwaysOn: true},
      {bots: 5, groups: 10, playlistTracks: 500, favorites: 200, alwaysOn: true},
    ]);
    for (const [index, tier] of PLAN_TIERS.entries()) {
      expect(PLANS[tier].level).toBe(index);
      if (index > 0) {
        const previous = PLANS[PLAN_TIERS[index - 1]].limits;
        for (const key of ['bots', 'groups', 'playlistTracks', 'favorites'] as const) {
          expect(PLANS[tier].limits[key]).toBeGreaterThanOrEqual(previous[key]);
        }
      }
    }

    expect(PLAN_TIERS.filter(tier => PLANS[tier].customBranding)).toEqual(['TIER3']);
    expect(PLAN_TIERS.filter(tier => PLANS[tier].prioritySupport)).toEqual(['TIER1', 'TIER2', 'TIER3']);
    expect(tierAllows('TIER3', 'TIER2')).toBe(true);
    expect(tierAllows('TIER1', 'TIER2')).toBe(false);
  });

  it('treats an expired or unknown plan as Free', () => {
    expect(effectiveTier({tier: 'TIER2', expiresAt: '2026-10-12T00:00:00.000Z'}, NOW)).toBe('TIER2');
    expect(effectiveTier({tier: 'TIER2', expiresAt: '2026-10-11T11:59:59.000Z'}, NOW)).toBe('FREE');
    expect(effectiveTier({tier: 'TIER3', expiresAt: null}, NOW)).toBe('TIER3');
    expect(effectiveTier({tier: 'GOLD', expiresAt: null}, NOW)).toBe('FREE');
  });

  it('checks settings against the plan and clamps stored values at play time', () => {
    const free = PLANS.FREE.limits;
    expect(planSettingsProblem(free, {playlistLimit: 50})).toBeNull();
    expect(planSettingsProblem(free, {playlistLimit: 51})).toEqual({error: 'PLAN_LIMIT', limit: 'playlistTracks', max: 50});
    expect(planSettingsProblem(free, {leaveIfNoListeners: false})).toMatchObject({error: 'PLAN_REQUIRED', required: 'TIER2'});
    expect(planSettingsProblem(free, {secondsToWaitAfterQueueEmpties: 0})).toMatchObject({error: 'PLAN_REQUIRED'});
    expect(planSettingsProblem(free, {secondsToWaitAfterQueueEmpties: 601})).toMatchObject({error: 'PLAN_REQUIRED'});
    expect(planSettingsProblem(free, {secondsToWaitAfterQueueEmpties: 600})).toBeNull();
    expect(planSettingsProblem(PLANS.TIER2.limits, {leaveIfNoListeners: false, secondsToWaitAfterQueueEmpties: 0})).toBeNull();

    const stored = {playlistLimit: 400, leaveIfNoListeners: false, secondsToWaitAfterQueueEmpties: 0, locale: 'en'};
    expect(planAdjustedSettings(stored, free)).toEqual({playlistLimit: 50, leaveIfNoListeners: true, secondsToWaitAfterQueueEmpties: 600, locale: 'en'});
    expect(planAdjustedSettings(stored, PLANS.TIER2.limits)).toEqual(stored);
  });

  it('applies the Sentinel coupon rules and price math', () => {
    expect(couponProblem(coupon(), 'TIER1', 'MONTHLY', NOW)).toBeNull();
    expect(couponProblem(coupon({active: false}), 'TIER1', 'MONTHLY', NOW)).toBe('COUPON_INACTIVE');
    expect(couponProblem(coupon({validFrom: '2026-10-12T00:00:00.000Z'}), 'TIER1', 'MONTHLY', NOW)).toBe('COUPON_NOT_STARTED');
    expect(couponProblem(coupon({validUntil: '2026-10-10T00:00:00.000Z'}), 'TIER1', 'MONTHLY', NOW)).toBe('COUPON_EXPIRED');
    expect(couponProblem(coupon({maxRedemptions: 2, redemptions: 2}), 'TIER1', 'MONTHLY', NOW)).toBe('COUPON_EXHAUSTED');
    expect(couponProblem(coupon(), 'FREE', null, NOW)).toBe('COUPON_FREE_PLAN');
    expect(couponProblem(coupon({tiers: ['TIER2']}), 'TIER1', 'MONTHLY', NOW)).toBe('COUPON_WRONG_TIER');
    expect(couponProblem(coupon({billing: 'YEARLY'}), 'TIER1', 'MONTHLY', NOW)).toBe('COUPON_WRONG_BILLING');

    expect(basePriceCents('TIER2', 'YEARLY')).toBe(5000);
    expect(basePriceCents('TIER2', 'GIFT')).toBe(0);
    expect(discountedPriceCents(2000, {percentOff: 50, amountOffCents: null})).toBe(1000);
    expect(discountedPriceCents(200, {percentOff: null, amountOffCents: 500})).toBe(0);
  });
});

describe('worker entitlements', () => {
  it('defaults to Free and allowed until the orchestrator describes a guild', () => {
    expect(entitlements.get(guildA)).toEqual({tier: 'FREE', limits: PLANS.FREE.limits, allowed: true, allowedBotIds: []});
    entitlements.set(sanitizeEntitlements({guilds: [{guildId: guildA, tier: 'TIER2', allowed: false, allowedBotIds: ['900000000000000001', '900000000000000001']}]}));
    expect(entitlements.get(guildA)).toEqual({tier: 'TIER2', limits: PLANS.TIER2.limits, allowed: false, allowedBotIds: ['900000000000000001']});
    expect(entitlements.get(guildB).tier).toBe('FREE');
  });

  it.each([
    [[]],
    [{guilds: 'x'}],
    [{guilds: [{guildId: 'nope', tier: 'FREE', allowed: true, allowedBotIds: []}]}],
    [{guilds: [{guildId: guildA, tier: 'GOLD', allowed: true, allowedBotIds: []}]}],
    [{guilds: [{guildId: guildA, tier: 'FREE', allowed: 'yes', allowedBotIds: []}]}],
  ])('rejects a malformed push %#', body => {
    expect(() => sanitizeEntitlements(body)).toThrow(expect.objectContaining({statusCode: 400, code: 'INVALID_ENTITLEMENTS'}));
  });

  it('refuses dashboard settings beyond the plan with 403 codes', () => {
    expect(() => assertSettingsWithinPlan(guildA, {playlistLimit: 200})).toThrow(expect.objectContaining({statusCode: 403, code: 'PLAN_LIMIT'}));
    expect(() => assertSettingsWithinPlan(guildA, {leaveIfNoListeners: false})).toThrow(expect.objectContaining({statusCode: 403, code: 'PLAN_REQUIRED'}));
    entitlements.set({guilds: [{guildId: guildA, tier: 'TIER2', allowed: true, allowedBotIds: []}]});
    expect(() => assertSettingsWithinPlan(guildA, {playlistLimit: 500, leaveIfNoListeners: false})).not.toThrow();
  });

  it('names the included bots and links the pricing page in the refusal', () => {
    vi.stubEnv('MUSE_DASHBOARD_PUBLIC_URL', 'https://music.example.test/');
    expect(pricingUrl('it')).toBe('https://music.example.test/it/pricing');
    entitlements.set({guilds: [{guildId: guildA, tier: 'TIER1', allowed: false, allowedBotIds: ['900000000000000001', '900000000000000002']}]});
    expect(planBotRefusal(guildA, 'en')).toBe('This server\'s Plus plan includes 2 Muse bot(s): use <@900000000000000001>, <@900000000000000002>. See the plans: https://music.example.test/en/pricing');
    expect(planBotRefusal(guildA, 'it')).toContain('Il piano Plus di questo server include 2 bot Muse');

    vi.stubEnv('MUSE_DASHBOARD_PUBLIC_URL', '');
    entitlements.set({guilds: [{guildId: guildA, tier: 'FREE', allowed: false, allowedBotIds: []}]});
    expect(planBotRefusal(guildA, 'en')).toBe('This server\'s Free plan includes 1 Muse bot(s), and this one is not among them.');
  });
});

describe('plan store', () => {
  it('persists plans and coupons and counts a redemption in the same write', () => {
    const filePath = tempFile('plans.json');
    const store = new PlanStore(filePath);
    const timestamp = NOW.toISOString();
    store.createCoupon({
      code: 'BETA50', description: null, percentOff: 50, amountOffCents: null, tiers: [], billing: 'ANY', maxRedemptions: null,
      redemptions: 0, validFrom: null, validUntil: null, active: true, public: true, createdBy: actor, createdAt: timestamp, updatedAt: timestamp,
    });
    store.setPlan(guildA, {tier: 'TIER2', billing: 'MONTHLY', expiresAt: null, couponCode: 'BETA50', note: 'paid', updatedAt: timestamp}, 'BETA50');

    const reloaded = new PlanStore(filePath);
    expect(reloaded.plan(guildA)).toMatchObject({tier: 'TIER2', couponCode: 'BETA50', note: 'paid'});
    expect(reloaded.coupon('beta50')?.redemptions).toBe(1);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1);
    expect(() => reloaded.createCoupon(reloaded.coupon('BETA50')!)).toThrow(expect.objectContaining({code: 'COUPON_EXISTS'}));
  });

  it('refuses an invalid file without a backup', () => {
    const filePath = tempFile('plans.json');
    writeFileSync(filePath, JSON.stringify({version: 1, guilds: {[guildA]: {tier: 'GOLD'}}, coupons: []}));
    expect(() => new PlanStore(filePath)).toThrow(/invalid schema/);
  });
});

type FakeWorker = {id: string; pushEntitlements: ReturnType<typeof vi.fn>};

const makeService = (statuses: SettledStatus[]) => {
  const workers: FakeWorker[] = ['muse-01', 'muse-02', 'muse-03'].map(id => ({id, pushEntitlements: vi.fn(async () => ({ok: true}))}));
  const audit = new AuditStore(tempFile('super-audit.json'));
  const records: AuditEntryInput[] = [];
  const service = new PlanService(workers as unknown as WorkerClient[], new PlanStore(tempFile('plans.json')), entry => {
    records.push(entry);
    audit.append(entry);
  }, async () => statuses);
  return {service, workers, records, audit};
};

const status = (workerId: string, guildIds: string[], botNumber: number): SettledStatus => ({
  workerId,
  ok: true,
  value: {
    workerId,
    discordReady: true,
    bot: {id: `90000000000000000${botNumber}`, username: workerId},
    guilds: guildIds.map(id => ({id, name: id})),
    players: [],
    uptimeSeconds: 1,
  },
});

describe('plan service', () => {
  const statuses = [status('muse-01', [guildA], 1), status('muse-02', [guildA, guildB], 2), status('muse-03', [guildA], 3)];

  it('includes the first bots of each guild in configuration order', async () => {
    const {service} = makeService(statuses);
    expect(service.allowedWorkerIds(guildA, statuses, NOW)).toEqual(['muse-01']);
    expect(service.allowedWorkerIds(guildB, statuses, NOW)).toEqual(['muse-02']);

    await service.changeGuildPlan(guildA, {tier: 'TIER1', billing: 'MONTHLY'}, actor, new Set([guildA, guildB]), NOW);
    const byWorker = service.entitlementsByWorker(statuses, NOW);
    expect(byWorker.get('muse-03')).toEqual([{guildId: guildA, tier: 'TIER1', allowed: false, allowedBotIds: ['900000000000000001', '900000000000000002']}]);
    expect(byWorker.get('muse-02')).toEqual([
      {guildId: guildA, tier: 'TIER1', allowed: true, allowedBotIds: ['900000000000000001', '900000000000000002']},
      {guildId: guildB, tier: 'FREE', allowed: true, allowedBotIds: ['900000000000000002']},
    ]);
  });

  it('assigns a plan, redeems a coupon once, audits and pushes the entitlements', async () => {
    const {service, workers, records} = makeService(statuses);
    service.createCoupon({code: 'beta50', percentOff: 50, tiers: ['TIER2'], public: true}, actor, NOW);

    const result = await service.changeGuildPlan(guildA, {tier: 'TIER2', billing: 'YEARLY', expiresAt: '2027-10-11T21:59:59.000Z', couponCode: 'beta50', note: ' bonifico '}, actor, new Set([guildA]), NOW);
    expect(result).toMatchObject({ok: true, previousTier: 'FREE', tier: 'TIER2', effectiveTier: 'TIER2', couponRedeemed: true, plan: {note: 'bonifico', couponCode: 'BETA50'}});
    await service.changeGuildPlan(guildA, {tier: 'TIER2', billing: 'YEARLY', couponCode: 'BETA50'}, actor, new Set([guildA]), NOW);
    expect(service.coupons()[0].redemptions).toBe(1);
    expect(service.plan(guildA).note).toBe('bonifico');
    expect(records.filter(entry => entry.action === 'plan.update')).toHaveLength(2);
    expect(workers[0].pushEntitlements).toHaveBeenCalled();
    expect(service.promotions(NOW)).toEqual([{code: 'BETA50', description: null, percentOff: 50, amountOffCents: null, tiers: ['TIER2'], billing: 'ANY', validUntil: null}]);
  });

  it.each([
    [{tier: 'GOLD'}, 400, 'INVALID_PLAN'],
    [{tier: 'TIER1', billing: 'WEEKLY'}, 400, 'INVALID_PLAN'],
    [{tier: 'TIER1', expiresAt: '2026-10-01T00:00:00.000Z'}, 400, 'EXPIRY_IN_PAST'],
    [{tier: 'TIER1', couponCode: 'NOPE'}, 404, 'COUPON_NOT_FOUND'],
    [{tier: 'TIER1', note: 'x'.repeat(501)}, 400, 'INVALID_PLAN'],
  ])('rejects %j', async (body, statusCode, code) => {
    const {service} = makeService(statuses);
    await expect(service.changeGuildPlan(guildA, body, actor, new Set([guildA]), NOW)).rejects.toMatchObject({statusCode, code});
  });

  it('refuses unknown guilds and coupons that do not fit the plan', async () => {
    const {service} = makeService(statuses);
    await expect(service.changeGuildPlan(guildA, {tier: 'TIER1'}, actor, new Set(), NOW)).rejects.toMatchObject({statusCode: 404, code: 'GUILD_NOT_FOUND'});
    service.createCoupon({code: 'YEAR', amountOffCents: 500, billing: 'YEARLY'}, actor, NOW);
    await expect(service.changeGuildPlan(guildA, {tier: 'TIER1', billing: 'MONTHLY', couponCode: 'YEAR'}, actor, new Set([guildA]), NOW))
      .rejects.toMatchObject({statusCode: 400, code: 'COUPON_WRONG_BILLING'});
  });

  it('sweeps expired plans back to Free with a system audit entry, keeping expiry and note', async () => {
    const {service, records, audit} = makeService(statuses);
    await service.changeGuildPlan(guildA, {tier: 'TIER3', billing: 'GIFT', expiresAt: '2026-10-11T13:00:00.000Z', note: 'prova'}, actor, new Set([guildA]), NOW);

    expect(await service.sweepExpired(NOW)).toEqual([]);
    const later = new Date('2026-10-11T13:00:01.000Z');
    expect(service.effectiveTier(guildA, later)).toBe('FREE');
    expect(await service.sweepExpired(later)).toEqual([guildA]);
    expect(service.plan(guildA, later)).toMatchObject({tier: 'FREE', billing: null, couponCode: null, expiresAt: '2026-10-11T13:00:00.000Z', note: 'prova'});
    expect(records.at(-1)).toMatchObject({actor: SYSTEM_ACTOR, action: 'plan.expired', subjectId: guildA, details: {previousTier: 'TIER3'}});
    expect(audit.list(1)[0].actor).toEqual(SYSTEM_ACTOR);
  });

  it.each([
    [{code: 'x', percentOff: 10}],
    [{code: 'OK1'}],
    [{code: 'OK1', percentOff: 10, amountOffCents: 100}],
    [{code: 'OK1', percentOff: 101}],
    [{code: 'OK1', percentOff: 10, tiers: ['FREE']}],
    [{code: 'OK1', percentOff: 10, billing: 'GIFT'}],
    [{code: 'OK1', percentOff: 10, validFrom: '2026-12-01T00:00:00.000Z', validUntil: '2026-11-01T00:00:00.000Z'}],
  ])('rejects the coupon %j', body => {
    const {service} = makeService(statuses);
    expect(() => service.createCoupon(body, actor, NOW)).toThrow(expect.objectContaining({statusCode: 400, code: 'INVALID_COUPON'}));
  });

  it('updates and deletes coupons with audit entries', () => {
    const {service, records} = makeService(statuses);
    service.createCoupon({code: 'SPRING', percentOff: 20}, actor, NOW);
    expect(service.updateCoupon('spring', {amountOffCents: 300, percentOff: null, active: false}, actor, NOW)).toMatchObject({code: 'SPRING', percentOff: null, amountOffCents: 300, active: false});
    service.deleteCoupon('SPRING', actor);
    expect(service.coupons()).toEqual([]);
    expect(records.map(entry => entry.action)).toEqual(['coupon.create', 'coupon.update', 'coupon.delete']);
  });
});
