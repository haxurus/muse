import {HttpError} from '../control/http.js';
import {isSnowflake} from '../control/snowflake.js';
import {
  MAX_IDLE_SECONDS_WITHOUT_ALWAYS_ON,
  PLANS,
  isPlanTier,
  planLimits,
  planSettingsProblem,
  type PlanLimits,
  type PlanTier,
} from './plans.js';

/** Upper bound of the guild list one worker accepts in a push. */
export const MAX_ENTITLEMENT_GUILDS = 10_000;

/** Large enough for MAX_ENTITLEMENT_GUILDS entries with five bot ids each. */
export const MAX_ENTITLEMENTS_BODY_BYTES = 2 * 1024 * 1024;

/** What one worker may do in one guild, pushed by the orchestrator (`PUT /v1/entitlements`). */
export type GuildEntitlement = {
  guildId: string;
  /** Effective plan (an expired plan is already Free). */
  tier: PlanTier;
  /** Whether this bot is one of the plan's bots in the guild. */
  allowed: boolean;
  /** Discord user ids of the bots the plan includes in the guild (mentioned in refusals). */
  allowedBotIds: string[];
};

export type EntitlementsPush = {
  guilds: GuildEntitlement[];
};

const sanitizeEntitlement = (value: unknown): GuildEntitlement => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'every entitlement must be an object', 'INVALID_ENTITLEMENTS');
  }

  const {guildId, tier, allowed, allowedBotIds} = value as Record<string, unknown>;
  if (!isSnowflake(guildId) || !isPlanTier(tier) || typeof allowed !== 'boolean'
    || !Array.isArray(allowedBotIds) || allowedBotIds.length > 32 || !allowedBotIds.every(id => isSnowflake(id))) {
    throw new HttpError(400, 'invalid entitlement', 'INVALID_ENTITLEMENTS');
  }

  return {guildId, tier, allowed, allowedBotIds: [...new Set(allowedBotIds as string[])]};
};

export const sanitizeEntitlements = (input: unknown): EntitlementsPush => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'entitlements body must be an object', 'INVALID_ENTITLEMENTS');
  }

  const {guilds} = input as Record<string, unknown>;
  if (!Array.isArray(guilds) || guilds.length > MAX_ENTITLEMENT_GUILDS) {
    throw new HttpError(400, `guilds must be an array of at most ${MAX_ENTITLEMENT_GUILDS} entries`, 'INVALID_ENTITLEMENTS');
  }

  return {guilds: guilds.map(sanitizeEntitlement)};
};

export type GuildPlanState = {
  tier: PlanTier;
  limits: PlanLimits;
  allowed: boolean;
  allowedBotIds: string[];
};

let byGuild = new Map<string, GuildEntitlement>();

/**
 * Process-wide plans of the guilds this worker is in, pushed by the orchestrator at start, every
 * reconcile period and after every plan change. A guild the orchestrator has not described yet
 * (just joined, or before the first push) gets the Free limits and is not refused: the next push
 * at most a minute later settles it.
 */
export const entitlements = {
  set(next: EntitlementsPush): void {
    byGuild = new Map(next.guilds.map(entry => [entry.guildId, entry]));
  },

  size(): number {
    return byGuild.size;
  },

  get(guildId: string): GuildPlanState {
    const entry = byGuild.get(guildId);
    const tier = entry?.tier ?? 'FREE';
    return {
      tier,
      limits: planLimits(tier),
      allowed: entry?.allowed ?? true,
      allowedBotIds: entry?.allowedBotIds ?? [],
    };
  },

  planName(guildId: string): string {
    return PLANS[this.get(guildId).tier].name;
  },
};

/** `403 PLAN_LIMIT` / `403 PLAN_REQUIRED` when a settings patch goes beyond the guild's plan. */
export const assertSettingsWithinPlan = (
  guildId: string,
  patch: Parameters<typeof planSettingsProblem>[1],
): void => {
  const problem = planSettingsProblem(entitlements.get(guildId).limits, patch);
  if (problem?.error === 'PLAN_LIMIT') {
    throw new HttpError(403, `playlistLimit is above this server's plan limit of ${problem.max} tracks`, 'PLAN_LIMIT');
  }

  if (problem?.error === 'PLAN_REQUIRED') {
    throw new HttpError(403, `${problem.setting} beyond ${MAX_IDLE_SECONDS_WITHOUT_ALWAYS_ON} seconds or 24/7 requires the ${PLANS[problem.required].name} plan`, 'PLAN_REQUIRED');
  }
};
