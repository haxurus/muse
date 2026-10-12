import {PLANS, PLAN_TIERS, type PlanDefinition, type PlanTier} from '../plans/plans.js';
import {DICTIONARIES, escapeHtml, localizedPath, type Locale, type Messages} from './i18n.js';

/**
 * Server-rendered parts of the public pricing page (`/it/pricing`, `/en/pricing`), mirrored on
 * Sentinel's PricingView: plan cards with a monthly/yearly toggle, live public promotions, a full
 * comparison table, the contacts and the FAQ, plus JSON-LD. The plans come from the shared catalog;
 * contacts and promotions from the orchestrator (`GET /v1/public/info`).
 */

export type PublicContacts = {email: string | null; discord: string | null; url: string | null};

export type PublicPromotion = {
  code: string;
  description: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  tiers: string[];
  billing: string;
  validUntil: string | null;
};

export type PublicInfo = {
  waitlistOpen: boolean;
  contacts: PublicContacts;
  promotions: PublicPromotion[];
};

const GITHUB_ISSUES = 'https://github.com/haxurus/muse/issues';
const INTL: Record<Locale, string> = {it: 'it-IT', en: 'en-IE'};

const text = (locale: Locale): Messages['pricing'] => DICTIONARIES[locale].pricing;

const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/gu, (match, name: string) => (name in values ? String(values[name]) : match));

/** EUR without decimals for whole euros (Sentinel formatPrice). */
export const formatPrice = (cents: number, locale: Locale): string => new Intl.NumberFormat(INTL[locale], {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  maximumFractionDigits: 2,
}).format(cents / 100);

const formatDay = (value: string, locale: Locale): string =>
  new Intl.DateTimeFormat(INTL[locale], {dateStyle: 'long'}).format(new Date(value));

export const tierLabel = (tier: PlanTier, locale: Locale): string => {
  const strings = text(locale);
  return {FREE: strings.tierLabelFree, TIER1: strings.tierLabelTier1, TIER2: strings.tierLabelTier2, TIER3: strings.tierLabelTier3}[tier];
};

const description = (tier: PlanTier, locale: Locale): string => {
  const strings = text(locale);
  return {FREE: strings.descFree, TIER1: strings.descTier1, TIER2: strings.descTier2, TIER3: strings.descTier3}[tier];
};

const featureList = (plan: PlanDefinition, locale: Locale): string[] => {
  const strings = text(locale);
  const number = (value: number) => new Intl.NumberFormat(INTL[locale]).format(value);
  const {limits} = plan;
  return [
    limits.bots === 1 ? strings.featureBot : fill(strings.featureBots, {count: limits.bots}),
    limits.groups === 0 ? strings.featureNoGroups : fill(strings.featureGroups, {count: limits.groups}),
    fill(strings.featurePlaylist, {count: number(limits.playlistTracks)}),
    fill(strings.featureFavorites, {count: number(limits.favorites)}),
    ...(limits.alwaysOn ? [strings.featureAlwaysOn] : []),
    ...(plan.prioritySupport ? [strings.featureSupport] : []),
    ...(plan.customBranding ? [strings.featureBranding] : []),
  ];
};

const priceBlock = (plan: PlanDefinition, locale: Locale): string => {
  const strings = text(locale);
  if (plan.tier === 'FREE') {
    return `<p class="plan-card-price"><strong>${escapeHtml(formatPrice(0, locale))}</strong></p>
          <p class="plan-card-sub">${escapeHtml(strings.freeForever)}</p>`;
  }

  const saving = (plan.monthlyCents * 12) - plan.yearlyCents;
  return `<p class="plan-card-price" data-billing-show="monthly"><strong>${escapeHtml(formatPrice(plan.monthlyCents, locale))}</strong><span>${escapeHtml(strings.perMonth)}</span></p>
          <p class="plan-card-price" data-billing-show="yearly"><strong>${escapeHtml(formatPrice(plan.yearlyCents, locale))}</strong><span>${escapeHtml(strings.perYear)}</span></p>
          <p class="plan-card-sub" data-billing-show="yearly">${saving > 0 ? escapeHtml(fill(strings.save, {amount: formatPrice(saving, locale)})) : '&nbsp;'}</p>
          <p class="plan-card-sub" data-billing-show="monthly">&nbsp;</p>`;
};

/** One card per plan; Pro is featured like Sentinel's TIER2. */
export const planCards = (locale: Locale): string => {
  const strings = text(locale);
  return PLAN_TIERS.map(tier => {
    const plan = PLANS[tier];
    const featured = tier === 'TIER2';
    const level = tier === 'FREE' ? strings.levelFree : fill(strings.level, {level: plan.level});
    const cta = tier === 'FREE'
      ? `<a class="button button-secondary" href="/add?lang=${locale}">${escapeHtml(strings.joinBeta)}</a>`
      : `<a class="button ${featured ? 'button-primary' : 'button-secondary'}" href="#contact">${escapeHtml(strings.contactMe)}</a>`;
    const features = featureList(plan, locale).map(feature => `<li>${escapeHtml(feature)}</li>`).join('');
    return `<article class="plan-card${featured ? ' plan-featured' : ''}">
          <span class="plan-card-level mono">${escapeHtml(level)}</span>
          <h2>${escapeHtml(plan.name)}</h2>
          ${priceBlock(plan, locale)}
          <p class="plan-card-desc">${escapeHtml(description(tier, locale))}</p>
          <ul class="plan-card-features">${features}</ul>
          ${cta}
        </article>`;
  }).join('\n        ');
};

const check = (included: boolean, locale: Locale): string => {
  const strings = text(locale);
  return included
    ? `<span class="compare-yes" aria-label="${escapeHtml(strings.included)}">✓</span>`
    : `<span class="compare-no" aria-label="${escapeHtml(strings.notIncluded)}">—</span>`;
};

/** "Confronto completo" table: every limit of every plan. */
export const comparisonTable = (locale: Locale): string => {
  const strings = text(locale);
  const number = (value: number) => escapeHtml(new Intl.NumberFormat(INTL[locale]).format(value));
  const plans = PLAN_TIERS.map(tier => PLANS[tier]);
  const row = (label: string, cells: string[]) =>
    `<tr><th scope="row">${escapeHtml(label)}</th>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
  const head = plans.map(plan => `<th scope="col">${escapeHtml(tierLabel(plan.tier, locale))}</th>`).join('');
  return `<table class="compare-table">
          <thead><tr><th scope="col">${escapeHtml(strings.compareFeature)}</th>${head}</tr></thead>
          <tbody>
            ${row(strings.compareCommands, plans.map(() => check(true, locale)))}
            ${row(strings.compareBots, plans.map(plan => number(plan.limits.bots)))}
            ${row(strings.compareGroups, plans.map(plan => number(plan.limits.groups)))}
            ${row(strings.comparePlaylist, plans.map(plan => number(plan.limits.playlistTracks)))}
            ${row(strings.compareFavorites, plans.map(plan => number(plan.limits.favorites)))}
            ${row(strings.compareAlwaysOn, plans.map(plan => check(plan.limits.alwaysOn, locale)))}
            ${row(strings.compareSupport, plans.map(plan => check(plan.prioritySupport, locale)))}
            ${row(strings.compareBranding, plans.map(plan => check(plan.customBranding, locale)))}
          </tbody>
        </table>`;
};

const promotionScope = (promotion: PublicPromotion, locale: Locale): string => {
  const strings = text(locale);
  const tiers = promotion.tiers.filter((tier): tier is PlanTier => (PLAN_TIERS as readonly string[]).includes(tier));
  const names = tiers.length > 0 ? tiers.map(tier => PLANS[tier].name).join(', ') : strings.everyPlan;
  if (promotion.billing === 'YEARLY') {
    return `${names} · ${strings.yearlyScope}`;
  }

  return promotion.billing === 'MONTHLY' ? `${names} · ${strings.monthlyScope}` : names;
};

/** Live public coupons as promotion banners (Sentinel: one banner per coupon). */
export const promotionBanners = (promotions: PublicPromotion[], locale: Locale): string => {
  const strings = text(locale);
  return promotions.map(promotion => {
    const amount = promotion.percentOff ? `-${promotion.percentOff}%` : `-${formatPrice(promotion.amountOffCents ?? 0, locale)}`;
    const parts = [
      `<span class="tag tag-premium">${escapeHtml(strings.promotion)}</span>`,
      `<strong>${escapeHtml(amount)}</strong>`,
      `<span>${escapeHtml(promotion.description ?? promotionScope(promotion, locale))}</span>`,
      `<span class="mono">${escapeHtml(fill(strings.promoCode, {code: promotion.code}))}</span>`,
      ...(promotion.validUntil ? [`<span>${escapeHtml(fill(strings.promoUntil, {date: formatDay(promotion.validUntil, locale)}))}</span>`] : []),
    ];
    return `<div class="promo-banner">${parts.join('')}</div>`;
  }).join('\n        ');
};

/** Contacts from the super console, plus GitHub issues (always listed, like Sentinel's ContactList). */
export const contactList = (contacts: PublicContacts | null, locale: Locale): string => {
  const strings = text(locale);
  const item = (label: string, value: string) =>
    `<li><span>${escapeHtml(label)}</span>${value}</li>`;
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`;
  const items: string[] = [];
  if (contacts?.email) {
    items.push(item(strings.contactEmail, `<a href="mailto:${escapeHtml(contacts.email)}">${escapeHtml(contacts.email)}</a>`));
  }

  if (contacts?.discord) {
    items.push(item(strings.contactDiscord, contacts.discord.startsWith('https://')
      ? link(contacts.discord, contacts.discord.replace(/^https:\/\//u, ''))
      : `<span class="mono">${escapeHtml(contacts.discord)}</span>`));
  }

  if (contacts?.url) {
    items.push(item(strings.contactWebsite, link(contacts.url, contacts.url.replace(/^https:\/\//u, ''))));
  }

  items.push(item(strings.contactGithub, link(GITHUB_ISSUES, strings.contactGithubText)));
  return `<ul class="contact-list">${items.join('')}</ul>`;
};

/** JSON for an inline `<script type="application/ld+json">`: `<` is escaped. */
const inlineJson = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c');

/** SoftwareApplication with one offer per plan and billing period, and the FAQ. */
export const pricingStructuredData = (locale: Locale, origin: string): string => {
  const strings = text(locale);
  const url = `${origin}${localizedPath(locale, '/pricing')}`;
  const euros = (cents: number) => (cents / 100).toFixed(2);
  const offers = PLAN_TIERS.flatMap(tier => {
    const plan = PLANS[tier];
    if (tier === 'FREE') {
      return [{'@type': 'Offer', name: plan.name, price: '0', priceCurrency: 'EUR', url}];
    }

    return [
      {'@type': 'Offer', name: `${plan.name} · ${strings.monthly}`, price: euros(plan.monthlyCents), priceCurrency: 'EUR', url},
      {'@type': 'Offer', name: `${plan.name} · ${strings.yearly}`, price: euros(plan.yearlyCents), priceCurrency: 'EUR', url},
    ];
  });
  return inlineJson({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: 'Muse',
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Discord',
        url,
        offers,
      },
      {
        '@type': 'FAQPage',
        inLanguage: locale,
        mainEntity: [
          [strings.faqExpiryQuestion, strings.faqExpiryAnswer],
          [strings.faqBotsQuestion, strings.faqBotsAnswer],
          [strings.faqTrialQuestion, strings.faqTrialAnswer],
        ].map(([question, answer]) => ({'@type': 'Question', name: question, acceptedAnswer: {'@type': 'Answer', text: answer}})),
      },
    ],
  });
};

/** Trusted markup for the pricing template; `info` is null when the orchestrator did not answer. */
export const pricingMarkup = (locale: Locale, origin: string, info: PublicInfo | null): Record<string, string> => ({
  planCards: planCards(locale),
  comparisonTable: comparisonTable(locale),
  promotions: info ? promotionBanners(info.promotions, locale) : '',
  pricingUnavailable: info ? '' : `<div class="notice notice-warn">${escapeHtml(text(locale).unavailable)}</div>`,
  contactList: contactList(info?.contacts ?? null, locale),
  structuredData: pricingStructuredData(locale, origin),
});
