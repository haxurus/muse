import {DICTIONARIES, LOCALES, localizedPath, type Locale} from './i18n.js';

/**
 * Search engine and social metadata of the public home pages: JSON-LD structured data,
 * robots.txt and sitemap.xml. Everything is generated once at startup from the public
 * origin and the same dictionaries as the visible page, so search results never
 * describe something the page does not say.
 */

/** Question/answer pairs of the home page FAQ section, in display order. */
export const FAQ_KEYS = ['voice', 'sources', 'play', 'permissions', 'openSource', 'language'] as const;

/** Social preview image (1200x630) and its size, referenced by Open Graph and JSON-LD. */
export const SOCIAL_IMAGE_PATH = '/assets/og-image.png';

const ISO_LANGUAGE: Record<Locale, string> = {en: 'en', it: 'it'};

/**
 * JSON for an inline `<script type="application/ld+json">`: `<` is escaped so no
 * dictionary text can close the script element.
 */
const inlineJson = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c');

/** WebSite, SoftwareApplication and FAQPage graph of the home page in one language. */
export const homeStructuredData = (locale: Locale, origin: string): string => {
  const messages = DICTIONARIES[locale];
  const url = `${origin}${localizedPath(locale)}`;
  return inlineJson({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        name: 'Muse',
        url: `${origin}/`,
        inLanguage: LOCALES.map(target => ISO_LANGUAGE[target]),
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#app`,
        name: 'Muse',
        url,
        description: messages.meta.homeDescription,
        applicationCategory: 'MultimediaApplication',
        applicationSubCategory: 'Discord music bot',
        operatingSystem: 'Discord',
        image: `${origin}${SOCIAL_IMAGE_PATH}`,
        inLanguage: ISO_LANGUAGE[locale],
        isAccessibleForFree: true,
        license: 'https://opensource.org/licenses/MIT',
        offers: {'@type': 'Offer', price: '0', priceCurrency: 'USD'},
        featureList: messages.seo.featureList,
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        inLanguage: ISO_LANGUAGE[locale],
        mainEntity: FAQ_KEYS.map(key => ({
          '@type': 'Question',
          name: messages.faq[key].question,
          acceptedAnswer: {'@type': 'Answer', text: messages.faq[key].answer},
        })),
      },
    ],
  });
};

/** Every indexable page: the home page in each language. */
const indexablePaths = (): string[] => LOCALES.map(locale => localizedPath(locale));

export const robotsTxt = (origin: string): string => [
  'User-agent: *',
  'Allow: /',
  // API, sign-in and invite redirects are never useful in search results.
  'Disallow: /api/',
  'Disallow: /auth/',
  'Disallow: /add',
  'Disallow: /invite/',
  '',
  `Sitemap: ${origin}/sitemap.xml`,
  '',
].join('\n');

/** Sitemap with hreflang alternates for every language and x-default ("/" redirects by language). */
export const sitemapXml = (origin: string): string => {
  const alternates = [
    ...LOCALES.map(locale => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${origin}${localizedPath(locale)}"/>`),
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${origin}/"/>`,
  ].join('\n');
  const urls = indexablePaths().map(path => `  <url>\n    <loc>${origin}${path}</loc>\n${alternates}\n  </url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
};
