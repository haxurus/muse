import {readFile} from 'node:fs/promises';
import {IncomingHttpHeaders, request} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';
import DashboardAuth from '../src/dashboard/auth.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import type DiscordOAuthClient from '../src/dashboard/discord-oauth.js';
import {DICTIONARIES, LOCALES} from '../src/dashboard/i18n.js';
import type OrchestratorClient from '../src/dashboard/orchestrator-client.js';
import {FAQ_KEYS, homeStructuredData, robotsTxt, sitemapXml} from '../src/dashboard/seo.js';
import DashboardServer from '../src/dashboard/server.js';
import SessionStore from '../src/dashboard/session-store.js';

const PUBLIC_URL = 'https://music.example.test';

const config: DashboardConfig = {
  host: '127.0.0.1',
  port: 0,
  publicUrl: new URL(PUBLIC_URL),
  oauthRedirectUri: new URL('/auth/discord/callback', PUBLIC_URL).toString(),
  discordClientId: '123456789012345678',
  discordClientSecret: 'not-a-real-secret',
  orchestratorUrl: 'http://orchestrator:3100',
  orchestratorToken: 'not-a-real-token',
  sessionTtlMs: 8 * 60 * 60 * 1000,
  superAdminUserId: '333333333333333333',
};

type HttpResult = {status: number; headers: IncomingHttpHeaders; body: Buffer; text: string};

const get = async (port: number, path: string): Promise<HttpResult> => new Promise((resolve, reject) => {
  const outgoing = request({host: '127.0.0.1', port, method: 'GET', path}, response => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => {
      const body = Buffer.concat(chunks);
      resolve({status: response.statusCode ?? 0, headers: response.headers, body, text: body.toString('utf8')});
    });
    response.on('error', reject);
  });
  outgoing.on('error', reject);
  outgoing.end();
});

const servers: DashboardServer[] = [];

const startDashboard = async (): Promise<number> => {
  const auth = new DashboardAuth(config, {
    store: new SessionStore(config.sessionTtlMs),
    discord: {} as DiscordOAuthClient,
    isUserBlocked: async () => false,
  });
  const server = new DashboardServer(config, {auth, orchestrator: {} as OrchestratorClient});
  await server.start();
  servers.push(server);
  return server.port!;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => server.close()));
});

const jsonLd = (html: string): {'@graph': Array<Record<string, any>>} => {
  const match = /<script type="application\/ld\+json">([^<]*)<\/script>/u.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as {'@graph': Array<Record<string, any>>};
};

describe('home page search and social metadata', () => {
  it('has keyword titles and descriptions within search result limits in every language', () => {
    for (const locale of LOCALES) {
      const {meta} = DICTIONARIES[locale];
      expect(meta.homeTitle.length, locale).toBeLessThanOrEqual(60);
      expect(meta.homeDescription.length, locale).toBeGreaterThanOrEqual(110);
      expect(meta.homeDescription.length, locale).toBeLessThanOrEqual(160);
      for (const keyword of ['Discord', 'YouTube', 'Spotify', 'SoundCloud']) {
        expect(`${meta.homeTitle} ${meta.homeDescription}`, `${locale} ${keyword}`).toContain(keyword);
      }
    }

    expect(DICTIONARIES.en.meta.homeTitle).toMatch(/Discord Music Bot/u);
  });

  it('serves Open Graph, Twitter and JSON-LD metadata on both home pages', async () => {
    const port = await startDashboard();
    for (const locale of LOCALES) {
      const {text} = await get(port, `/${locale}`);
      const {meta} = DICTIONARIES[locale];
      expect(text).toContain(`<meta property="og:url" content="${PUBLIC_URL}/${locale}">`);
      expect(text).toContain(`<meta property="og:image" content="${PUBLIC_URL}/assets/og-image.png">`);
      expect(text).toContain(`<meta property="og:locale" content="${meta.ogLocale}">`);
      expect(text).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(text).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');

      const graph = jsonLd(text)['@graph'];
      expect(graph.map(node => node['@type'])).toEqual(['WebSite', 'SoftwareApplication', 'FAQPage']);
      expect(graph[1]).toMatchObject({name: 'Muse', url: `${PUBLIC_URL}/${locale}`, operatingSystem: 'Discord', inLanguage: locale});

      // The structured FAQ is exactly the visible one.
      const faq = graph[2].mainEntity as Array<{name: string; acceptedAnswer: {text: string}}>;
      expect(faq.map(entry => entry.name)).toEqual(FAQ_KEYS.map(key => DICTIONARIES[locale].faq[key].question));
      for (const key of FAQ_KEYS) {
        expect(text).toContain(`<h3>${DICTIONARIES[locale].faq[key].question}</h3>`);
      }
    }
  });

  it('never lets dictionary text close the JSON-LD script', () => {
    for (const locale of LOCALES) {
      expect(homeStructuredData(locale, PUBLIC_URL)).not.toContain('<');
    }
  });
});

describe('crawler files', () => {
  it('lists every home page with hreflang alternates in the sitemap and points robots.txt at it', async () => {
    const port = await startDashboard();
    const sitemap = await get(port, '/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(sitemap.text).toBe(sitemapXml(PUBLIC_URL));
    // Home and pricing page in every language.
    expect(sitemap.text.match(/<url>/gu)).toHaveLength(LOCALES.length * 2);
    for (const locale of LOCALES) {
      expect(sitemap.text).toContain(`<loc>${PUBLIC_URL}/${locale}/pricing</loc>`);
      expect(sitemap.text).toContain(`<loc>${PUBLIC_URL}/${locale}</loc>`);
      expect(sitemap.text).toContain(`hreflang="${locale}" href="${PUBLIC_URL}/${locale}"`);
    }

    expect(sitemap.text).toContain(`hreflang="x-default" href="${PUBLIC_URL}/"`);

    const robots = await get(port, '/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.text).toBe(robotsTxt(PUBLIC_URL));
    expect(robots.text).toContain(`Sitemap: ${PUBLIC_URL}/sitemap.xml`);
    expect(robots.text).toContain('Disallow: /api/');
    // The home pages stay crawlable.
    expect(robots.text).not.toMatch(/^Disallow: \/(?:it|en)?$/mu);
  });

  it('serves the icons and the social preview image from the dashboard folder', async () => {
    const port = await startDashboard();
    for (const [path, file, type] of [
      ['/favicon.ico', 'favicon.ico', 'image/x-icon'],
      ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
      ['/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
      ['/assets/og-image.png', 'og-image.png', 'image/png'],
    ]) {
      const result = await get(port, path);
      expect(result.status, path).toBe(200);
      expect(result.headers['content-type'], path).toBe(type);
      expect(result.body.equals(await readFile(new URL(`../dashboard/${file}`, import.meta.url))), path).toBe(true);
    }

    // 1200x630 PNG, the size declared in the Open Graph tags.
    const png = await readFile(new URL('../dashboard/og-image.png', import.meta.url));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });
});
