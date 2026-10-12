import {HttpError} from '../control/http.js';
import {isSnowflake} from '../control/snowflake.js';
import {
  COUPON_BILLINGS,
  isBillingPeriod,
  isPlanTier,
  normalizeCouponCode,
  type BillingPeriod,
  type CouponBilling,
  type PlanTier,
} from '../plans/plans.js';
import {commitWithBackup, isPlainObject, isPrintable, loadWithBackup} from './durable-file.js';
import {isValidActor, type Actor} from './super-store.js';

/** A server's plan as assigned in the super console (Sentinel: GuildSettings.plan*). */
export type GuildPlan = {
  tier: PlanTier;
  billing: BillingPeriod | null;
  /** ISO 8601; null means no expiry. Kept after an expiry, like Sentinel. */
  expiresAt: string | null;
  couponCode: string | null;
  /** Internal note, never shown outside the super console. */
  note: string | null;
  updatedAt: string;
};

export type Coupon = {
  code: string;
  description: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  /** Empty means every paid plan. */
  tiers: PlanTier[];
  billing: CouponBilling;
  maxRedemptions: number | null;
  redemptions: number;
  validFrom: string | null;
  validUntil: string | null;
  active: boolean;
  /** Shown as a promotion on the pricing page. */
  public: boolean;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
};

type PlanFile = {
  version: 1;
  guilds: Record<string, GuildPlan>;
  coupons: Coupon[];
};

export const COUPON_CODE = /^[A-Z\d_-]{3,32}$/u;
export const MAX_PLAN_NOTE_LENGTH = 500;
export const MAX_COUPON_DESCRIPTION_LENGTH = 200;
export const MAX_COUPONS = 500;

const isIsoDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isNullableIsoDate = (value: unknown): value is string | null => value === null || isIsoDate(value);
const isNullableInteger = (value: unknown, min: number, max: number): value is number | null =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max);

const isValidGuildPlan = (value: unknown): value is GuildPlan => isPlainObject(value)
  && isPlanTier(value.tier)
  && (value.billing === null || isBillingPeriod(value.billing))
  && isNullableIsoDate(value.expiresAt)
  && (value.couponCode === null || (typeof value.couponCode === 'string' && COUPON_CODE.test(value.couponCode)))
  && (value.note === null || (typeof value.note === 'string' && isPrintable(value.note, 1, MAX_PLAN_NOTE_LENGTH)))
  && isIsoDate(value.updatedAt);

const isValidCoupon = (value: unknown): value is Coupon => isPlainObject(value)
  && typeof value.code === 'string' && COUPON_CODE.test(value.code)
  && (value.description === null || (typeof value.description === 'string' && isPrintable(value.description, 1, MAX_COUPON_DESCRIPTION_LENGTH)))
  && isNullableInteger(value.percentOff, 1, 100)
  && isNullableInteger(value.amountOffCents, 1, 100_000)
  && (value.percentOff === null) !== (value.amountOffCents === null)
  && Array.isArray(value.tiers) && value.tiers.every(tier => isPlanTier(tier) && tier !== 'FREE')
  && (COUPON_BILLINGS as readonly unknown[]).includes(value.billing)
  && isNullableInteger(value.maxRedemptions, 1, 100_000)
  && Number.isSafeInteger(value.redemptions) && (value.redemptions as number) >= 0
  && isNullableIsoDate(value.validFrom)
  && isNullableIsoDate(value.validUntil)
  && typeof value.active === 'boolean'
  && typeof value.public === 'boolean'
  && isValidActor(value.createdBy)
  && isIsoDate(value.createdAt)
  && isIsoDate(value.updatedAt);

const isValidPlanFile = (value: unknown): value is PlanFile => {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.guilds) || !Array.isArray(value.coupons)) {
    return false;
  }

  const {guilds, coupons} = value as {guilds: Record<string, unknown>; coupons: unknown[]};
  return Object.entries(guilds).every(([guildId, plan]) => isSnowflake(guildId) && isValidGuildPlan(plan))
    && coupons.length <= MAX_COUPONS
    && coupons.every(coupon => isValidCoupon(coupon))
    && new Set((coupons as Coupon[]).map(coupon => coupon.code)).size === coupons.length;
};

const copyPlan = (plan: GuildPlan): GuildPlan => ({...plan});
const copyCoupon = (coupon: Coupon): Coupon => ({...coupon, tiers: [...coupon.tiers], createdBy: {...coupon.createdBy}});

/**
 * Durable server plans and coupons (`/state/plans.json`). Single-process store like the other
 * orchestrator stores: exactly one orchestrator per state volume.
 */
export class PlanStore {
  private data: PlanFile;

  constructor(private readonly filePath: string) {
    this.data = loadWithBackup<PlanFile>(filePath, isValidPlanFile, () => ({version: 1, guilds: {}, coupons: []}), 'Plan store');
  }

  plan(guildId: string): GuildPlan | undefined {
    const plan = this.data.guilds[guildId];
    return plan === undefined ? undefined : copyPlan(plan);
  }

  plans(): Record<string, GuildPlan> {
    return Object.fromEntries(Object.entries(this.data.guilds).map(([guildId, plan]) => [guildId, copyPlan(plan)]));
  }

  /** Store a plan and, in the same write, count one redemption of `redeemCode`. */
  setPlan(guildId: string, plan: GuildPlan, redeemCode?: string): GuildPlan {
    const coupons = redeemCode === undefined
      ? this.data.coupons
      : this.data.coupons.map(coupon => coupon.code === redeemCode ? {...coupon, redemptions: coupon.redemptions + 1} : coupon);
    this.commit({...this.data, guilds: {...this.data.guilds, [guildId]: copyPlan(plan)}, coupons});
    return copyPlan(plan);
  }

  /** Newest first. */
  coupons(): Coupon[] {
    return this.data.coupons.map(copyCoupon).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  coupon(code: string): Coupon | undefined {
    const coupon = this.data.coupons.find(candidate => candidate.code === normalizeCouponCode(code));
    return coupon === undefined ? undefined : copyCoupon(coupon);
  }

  createCoupon(coupon: Coupon): Coupon {
    if (this.data.coupons.some(candidate => candidate.code === coupon.code)) {
      throw new HttpError(409, 'a coupon with that code already exists', 'COUPON_EXISTS');
    }

    if (this.data.coupons.length >= MAX_COUPONS) {
      throw new HttpError(409, `at most ${MAX_COUPONS} coupons are supported`, 'COUPONS_FULL');
    }

    this.commit({...this.data, coupons: [...this.data.coupons, copyCoupon(coupon)]});
    return copyCoupon(coupon);
  }

  replaceCoupon(coupon: Coupon): Coupon {
    if (!this.data.coupons.some(candidate => candidate.code === coupon.code)) {
      throw new HttpError(404, 'coupon not found', 'COUPON_NOT_FOUND');
    }

    this.commit({...this.data, coupons: this.data.coupons.map(candidate => candidate.code === coupon.code ? copyCoupon(coupon) : candidate)});
    return copyCoupon(coupon);
  }

  deleteCoupon(code: string): Coupon {
    const existing = this.data.coupons.find(candidate => candidate.code === normalizeCouponCode(code));
    if (!existing) {
      throw new HttpError(404, 'coupon not found', 'COUPON_NOT_FOUND');
    }

    this.commit({...this.data, coupons: this.data.coupons.filter(candidate => candidate !== existing)});
    return copyCoupon(existing);
  }

  private commit(next: PlanFile): void {
    if (!isValidPlanFile(next)) {
      throw new HttpError(400, 'invalid plan data', 'INVALID_PLAN');
    }

    // The in-memory state always equals the last good file, so it is the backup copy.
    commitWithBackup(this.filePath, this.data, next);
    this.data = next;
  }
}
