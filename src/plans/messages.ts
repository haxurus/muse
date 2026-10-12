import {UserError, t, type Locale} from '../i18n/index.js';
import {entitlements} from './entitlements.js';
import {MAX_IDLE_SECONDS_WITHOUT_ALWAYS_ON, PLANS, planSettingsProblem} from './plans.js';

/** Pricing page of the public dashboard (workers receive the whole .env), or undefined. */
export const pricingUrl = (locale: Locale, value = process.env.MUSE_DASHBOARD_PUBLIC_URL): string | undefined => {
  try {
    const {origin, protocol} = new URL(value ?? '');
    return protocol === 'https:' || protocol === 'http:' ? `${origin}/${locale}/pricing` : undefined;
  } catch {
    return undefined;
  }
};

const pricingLink = (locale: Locale): string => {
  const url = pricingUrl(locale);
  return url === undefined ? '' : t(locale, 'planPricingLink', {url});
};

/** `/config` counterpart of the dashboard check: a localized UserError when the change needs a higher plan. */
export const assertConfigWithinPlan = (guildId: string, patch: Parameters<typeof planSettingsProblem>[1]): void => {
  const {tier, limits} = entitlements.get(guildId);
  const problem = planSettingsProblem(limits, patch);
  if (problem?.error === 'PLAN_LIMIT') {
    throw new UserError('planPlaylistLimit', {plan: PLANS[tier].name, max: problem.max});
  }

  if (problem?.error === 'PLAN_REQUIRED') {
    throw new UserError('planAlwaysOnRequired', {max: MAX_IDLE_SECONDS_WITHOUT_ALWAYS_ON, required: PLANS[problem.required].name});
  }
};

/** Ephemeral refusal for a bot that the guild's plan does not include. */
export const planBotRefusal = (guildId: string, locale: Locale): string => {
  const {tier, limits, allowedBotIds} = entitlements.get(guildId);
  const vars = {plan: PLANS[tier].name, count: limits.bots, link: pricingLink(locale)};
  return allowedBotIds.length === 0
    ? t(locale, 'planBotNotIncludedNoList', vars)
    : t(locale, 'planBotNotIncluded', {...vars, bots: allowedBotIds.map(id => `<@${id}>`).join(', ')});
};
