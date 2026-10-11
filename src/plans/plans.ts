/**
 * Subscription plans, mirrored on Sentinel (same tiers, names, prices, billing periods and
 * coupon rules). Single source of truth for the workers (limits at play time), the
 * orchestrator (plan assignment, expiry, coupons) and, through the API, the dashboard.
 */

export const PLAN_TIERS = ['FREE', 'TIER1', 'TIER2', 'TIER3'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const BILLING_PERIODS = ['MONTHLY', 'YEARLY', 'GIFT'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export type PlanLimits = {
  /** Muse bots usable in one server, i.e. voice channels playing at the same time. */
  bots: number;
  /** Bot groups saved for one server in the dashboard. */
  groups: number;
  /** Tracks imported from one playlist or album. */
  playlistTracks: number;
  /** Favorites saved with /favorites in one server. */
  favorites: number;
  /** 24/7: the bots may stay in an empty voice channel and never leave after the queue ends. */
  alwaysOn: boolean;
};

export type PlanDefinition = {
  tier: PlanTier;
  name: string;
  level: number;
  monthlyCents: number;
  yearlyCents: number;
  limits: PlanLimits;
  prioritySupport: boolean;
  customBranding: boolean;
};

const PRO_LIMITS: PlanLimits = {
  bots: 5,
  groups: 10,
  playlistTracks: 500,
  favorites: 200,
  alwaysOn: true,
};

export const PLANS: Readonly<Record<PlanTier, PlanDefinition>> = {
  FREE: {
    tier: 'FREE', name: 'Free', level: 0, monthlyCents: 0, yearlyCents: 0,
    limits: {bots: 1, groups: 0, playlistTracks: 50, favorites: 10, alwaysOn: false},
    prioritySupport: false, customBranding: false,
  },
  TIER1: {
    tier: 'TIER1', name: 'Plus', level: 1, monthlyCents: 200, yearlyCents: 2000,
    limits: {bots: 2, groups: 2, playlistTracks: 200, favorites: 50, alwaysOn: false},
    prioritySupport: true, customBranding: false,
  },
  TIER2: {
    tier: 'TIER2', name: 'Pro', level: 2, monthlyCents: 500, yearlyCents: 5000,
    limits: PRO_LIMITS,
    prioritySupport: true, customBranding: false,
  },
  TIER3: {
    tier: 'TIER3', name: 'Brand', level: 3, monthlyCents: 1000, yearlyCents: 9000,
    limits: PRO_LIMITS,
    prioritySupport: true, customBranding: true,
  },
};

/** Without 24/7 the bots leave an empty channel, and leave at most this long after the queue ends. */
export const MAX_IDLE_SECONDS_WITHOUT_ALWAYS_ON = 600;

/** The plan that unlocks 24/7. */
export const ALWAYS_ON_TIER: PlanTier = 'TIER2';

export const isPlanTier = (value: unknown): value is PlanTier =>
  typeof value === 'string' && (PLAN_TIERS as readonly string[]).includes(value);

export const isBillingPeriod = (value: unknown): value is BillingPeriod =>
  typeof value === 'string' && (BILLING_PERIODS as readonly string[]).includes(value);

export const tierLevel = (tier: PlanTier): number => PLANS[tier].level;

export const tierAllows = (tier: PlanTier, required: PlanTier): boolean => tierLevel(tier) >= tierLevel(required);

export const planLimits = (tier: PlanTier): PlanLimits => PLANS[tier].limits;

/** The plan in force: an expired plan behaves as Free until it is renewed. */
export const effectiveTier = (
  plan: {tier?: string | null; expiresAt?: string | null},
  now: Date = new Date(),
): PlanTier => {
  const tier = isPlanTier(plan.tier) ? plan.tier : 'FREE';
  if (tier === 'FREE' || !plan.expiresAt) {
    return tier;
  }

  const expires = new Date(plan.expiresAt).getTime();
  return Number.isNaN(expires) || expires > now.getTime() ? tier : 'FREE';
};

/** Settings a server may store under a plan; `null` when the patch fits. */
export type PlanSettingsProblem =
  | {error: 'PLAN_LIMIT'; limit: 'playlistTracks'; max: number}
  | {error: 'PLAN_REQUIRED'; required: PlanTier; setting: 'leaveIfNoListeners' | 'secondsToWaitAfterQueueEmpties'};

export const planSettingsProblem = (
  limits: PlanLimits,
  patch: {playlistLimit?: number; leaveIfNoListeners?: boolean; secondsToWaitAfterQueueEmpties?: number},
): PlanSettingsProblem | null => {
  if (patch.playlistLimit !== undefined && patch.playlistLimit > limits.playlistTracks) {
    return {error: 'PLAN_LIMIT', limit: 'playlistTracks', max: limits.playlistTracks};
  }

  if (limits.alwaysOn) {
    return null;
  }

  if (patch.leaveIfNoListeners === false) {
    return {error: 'PLAN_REQUIRED', required: ALWAYS_ON_TIER, setting: 'leaveIfNoListeners'};
  }

  const wait = patch.secondsToWaitAfterQueueEmpties;
  if (wait !== undefined && (wait === 0 || wait > MAX_IDLE_SECONDS_WITHOUT_ALWAYS_ON)) {
    return {error: 'PLAN_REQUIRED', required: ALWAYS_ON_TIER, setting: 'secondsToWaitAfterQueueEmpties'};
  }

  return null;
};

/**
 * Settings as they apply at play time: stored values are never rewritten on a downgrade,
 * they are clamped to the plan in force instead (Sentinel: "the configuration is not deleted").
 */
export const planAdjustedSettings = <T extends {playlistLimit: number; leaveIfNoListeners: boolean; secondsToWaitAfterQueueEmpties: number}>(
  settings: T,
  limits: PlanLimits,
): T => {
  const playlistLimit = Math.min(settings.playlistLimit, limits.playlistTracks);
  if (limits.alwaysOn) {
    return {...settings, playlistLimit};
  }

  const wait = settings.secondsToWaitAfterQueueEmpties;
  return {
    ...settings,
    playlistLimit,
    leaveIfNoListeners: true,
    secondsToWaitAfterQueueEmpties: wait === 0 || wait > MAX_IDLE_SECONDS_WITHOUT_ALWAYS_ON ? MAX_IDLE_SECONDS_WITHOUT_ALWAYS_ON : wait,
  };
};

/* ---------- Coupons (identical rules to Sentinel) ---------- */

export const COUPON_BILLINGS = ['ANY', 'MONTHLY', 'YEARLY'] as const;
export type CouponBilling = (typeof COUPON_BILLINGS)[number];

export type CouponLike = {
  code: string;
  percentOff: number | null;
  amountOffCents: number | null;
  tiers: string[];
  billing: string;
  maxRedemptions: number | null;
  redemptions: number;
  validFrom: string | null;
  validUntil: string | null;
  active: boolean;
};

export const normalizeCouponCode = (value: string): string => value.trim().toUpperCase();

export type CouponProblem =
  | 'COUPON_INACTIVE'
  | 'COUPON_NOT_STARTED'
  | 'COUPON_EXPIRED'
  | 'COUPON_EXHAUSTED'
  | 'COUPON_FREE_PLAN'
  | 'COUPON_WRONG_TIER'
  | 'COUPON_WRONG_BILLING';

/** Why a coupon cannot be applied to a plan, or null when it can. */
export const couponProblem = (
  coupon: CouponLike,
  tier: PlanTier,
  billing: BillingPeriod | null,
  now: Date = new Date(),
): CouponProblem | null => {
  if (!coupon.active) {
    return 'COUPON_INACTIVE';
  }

  if (coupon.validFrom && new Date(coupon.validFrom).getTime() > now.getTime()) {
    return 'COUPON_NOT_STARTED';
  }

  if (coupon.validUntil && new Date(coupon.validUntil).getTime() < now.getTime()) {
    return 'COUPON_EXPIRED';
  }

  if (coupon.maxRedemptions !== null && coupon.redemptions >= coupon.maxRedemptions) {
    return 'COUPON_EXHAUSTED';
  }

  if (tier === 'FREE') {
    return 'COUPON_FREE_PLAN';
  }

  if (coupon.tiers.length > 0 && !coupon.tiers.includes(tier)) {
    return 'COUPON_WRONG_TIER';
  }

  if (coupon.billing !== 'ANY' && coupon.billing !== billing) {
    return 'COUPON_WRONG_BILLING';
  }

  return null;
};

/** Live public coupons are shown as promotions on the pricing page. */
export const couponIsLive = (coupon: CouponLike, now: Date = new Date()): boolean =>
  coupon.active
  && !(coupon.validFrom && new Date(coupon.validFrom).getTime() > now.getTime())
  && !(coupon.validUntil && new Date(coupon.validUntil).getTime() < now.getTime())
  && !(coupon.maxRedemptions !== null && coupon.redemptions >= coupon.maxRedemptions);

export const basePriceCents = (tier: PlanTier, billing: BillingPeriod | null): number => {
  if (billing === 'YEARLY') {
    return PLANS[tier].yearlyCents;
  }

  return billing === 'MONTHLY' ? PLANS[tier].monthlyCents : 0;
};

/** Price after a coupon, never below zero. */
export const discountedPriceCents = (
  priceCents: number,
  coupon: Pick<CouponLike, 'percentOff' | 'amountOffCents'> | null,
): number => {
  if (!coupon) {
    return priceCents;
  }

  let price = priceCents;
  if (coupon.percentOff) {
    price = Math.round(price * (100 - coupon.percentOff) / 100);
  }

  if (coupon.amountOffCents) {
    price -= coupon.amountOffCents;
  }

  return Math.max(0, price);
};
