import {mkdtempSync, rmSync} from 'node:fs';
import {IncomingHttpHeaders, request, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import DashboardAuth from '../src/dashboard/auth.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import type DiscordOAuthClient from '../src/dashboard/discord-oauth.js';
import {LOCALES} from '../src/dashboard/i18n.js';
import type OrchestratorClient from '../src/dashboard/orchestrator-client.js';
import {sanitizePublicInfo} from '../src/dashboard/orchestrator-client.js';
import {
  comparisonTable,
  contactList,
  formatPrice,
  planCards,
  pricingStructuredData,
  promotionBanners,
  type PublicInfo,
} from '../src/dashboard/pricing.js';
import DashboardServer from '../src/dashboard/server.js';
import SessionStore from '../src/dashboard/session-store.js';
import OrchestratorServer from '../src/orchestrator/server.js';
import {PLANS} from '../src/plans/plans.js';

const PUBLIC_URL = 'https://music.example.test';
const apiToken = 'a'.repeat(32);
const actorHeaders = {'x-muse-actor-id': '123456789012345678', 'x-muse-actor-name': 'Admin'};

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

const info: PublicInfo = {
  waitlistOpen: true,
  contacts: {email: 'muse@example.test', discord: 'haxurus', url: 'https://example.test/contact'},
  promotions: [{code: 'BETA50', description: 'Lancio <beta>', percentOff: 50, amountOffCents: null, tiers: ['TIER1'], billing: 'YEARLY', validUntil: '2026-12-31T22:59:59.000Z'}],
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const get = async (port: number, urlPath: string): Promise<{status: number; headers: IncomingHttpHeaders; text: string}> => new Promise((resolve, reject) => {
  const outgoing = request({host: '127.0.0.1', port, method: 'GET', path: urlPath}, response => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => {
      resolve({status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8')});
    });
    response.on('error', reject);
  });
  outgoing.on('error', reject);
  outgoing.end();
});

const startDashboard = async (publicInfo: () => Promise<PublicInfo>) => {
  const auth = new DashboardAuth(config, {store: new SessionStore(config.sessionTtlMs), discord: {} as DiscordOAuthClient, isUserBlocked: async () => false});
  const orchestrator = {publicInfo: vi.fn(publicInfo)};
  const server = new DashboardServer(config, {auth, orchestrator: orchestrator as unknown as OrchestratorClient});
  await server.start();
  cleanups.push(async () => server.close());
  return {port: server.port!, orchestrator};
};

describe('pricing markup', () => {
  it('renders the four Sentinel plans with both billing periods and the featured Pro card', () => {
    const html = planCards('en');
    expect(html.match(/<article class="plan-card/gu)).toHaveLength(4);
    expect(html.match(/plan-featured/gu)).toHaveLength(1);
    expect(html).toContain('<h2>Pro</h2>');
    for (const plan of [PLANS.TIER1, PLANS.TIER2, PLANS.TIER3]) {
      expect(html).toContain(formatPrice(plan.monthlyCents, 'en'));
      expect(html).toContain(formatPrice(plan.yearlyCents, 'en'));
    }

    expect(html).toContain(`save ${formatPrice(400, 'en')}`);
    expect(html).toContain('Custom bot name and banner');
    expect(html.match(/href="#contact"/gu)).toHaveLength(3);
  });

  it('compares every limit of every plan', () => {
    const html = comparisonTable('it');
    expect(html).toContain('Livello 3 · Brand');
    expect(html).toContain('Bot in vocale insieme');
    expect(html.match(/<tr>/gu)).toHaveLength(9);
  });

  it('escapes promotions and contacts and always lists GitHub', () => {
    const banners = promotionBanners(info.promotions, 'it');
    expect(banners).toContain('-50%');
    expect(banners).toContain('Lancio &lt;beta&gt;');
    expect(banners).toContain('codice: BETA50');

    const contacts = contactList(info.contacts, 'en');
    expect(contacts).toContain('href="mailto:muse@example.test"');
    expect(contacts).toContain('<span class="mono">haxurus</span>');
    expect(contacts).toContain('href="https://example.test/contact"');
    expect(contacts).toContain('https://github.com/haxurus/muse/issues');
    expect(contactList(null, 'en').match(/<li>/gu)).toHaveLength(1);
    expect(contactList({email: null, discord: 'https://discord.gg/abc', url: null}, 'en')).toContain('href="https://discord.gg/abc"');
  });

  it('describes one offer per plan and billing period in JSON-LD', () => {
    for (const locale of LOCALES) {
      const data = pricingStructuredData(locale, PUBLIC_URL);
      expect(data).not.toContain('<');
      const graph = (JSON.parse(data) as {'@graph': Array<{offers?: unknown[]}>})['@graph'];
      expect(graph[0].offers).toHaveLength(7);
    }
  });

  it('keeps only well-formed public info from the orchestrator', () => {
    expect(sanitizePublicInfo({contacts: {email: 7}, promotions: [{code: 'bad code'}, {code: 'OK1', percentOff: 10}, 'x']})).toEqual({
      waitlistOpen: false,
      contacts: {email: null, discord: null, url: null},
      promotions: [{code: 'OK1', description: null, percentOff: 10, amountOffCents: null, tiers: [], billing: 'ANY', validUntil: null}],
    });
  });
});

describe('pricing page', () => {
  it('is indexable in both languages and caches the public info', async () => {
    const {port, orchestrator} = await startDashboard(async () => info);
    for (const locale of LOCALES) {
      const page = await get(port, `/${locale}/pricing`);
      expect(page.status).toBe(200);
      expect(page.headers['x-robots-tag']).toBeUndefined();
      expect(page.headers['content-language']).toBe(locale);
      expect(page.text).toContain(`<link rel="canonical" href="${PUBLIC_URL}/${locale}/pricing">`);
      expect(page.text).toContain('href="mailto:muse@example.test"');
      expect(page.text).toContain('BETA50');
      // No template leftovers (JSON-LD legitimately contains "}}").
      expect(page.text.replace(/<script type="application\/ld\+json">[^<]*<\/script>/u, '')).not.toMatch(/\{\{|\}\}/u);
    }

    expect(orchestrator.publicInfo).toHaveBeenCalledOnce();
    expect((await get(port, '/assets/pricing.js')).status).toBe(200);
  });

  it('still shows the plans when the orchestrator does not answer', async () => {
    const {port} = await startDashboard(async () => {
      throw new Error('down');
    });
    const page = await get(port, '/en/pricing');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Promotions and contacts cannot be loaded right now.');
    expect(page.text.match(/<article class="plan-card/gu)).toHaveLength(4);
    expect(page.text).toContain('https://github.com/haxurus/muse/issues');
  });
});

describe('orchestrator public info and contacts', () => {
  const startOrchestrator = async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-pricing-'));
    cleanups.push(() => {
      rmSync(directory, {recursive: true, force: true});
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = new OrchestratorServer({host: '127.0.0.1', port: 0, apiToken, groupsFile: path.join(directory, 'groups.json'), workers: []});
    await server.start();
    cleanups.push(async () => server.close());
    const {port} = (server as unknown as {server: Server}).server.address() as AddressInfo;
    return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: {authorization: `Bearer ${apiToken}`, 'content-type': 'application/json', ...headers},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {status: response.status, body: await response.json() as Record<string, any>};
    };
  };

  it('saves the contacts, clears them with empty strings and publishes them', async () => {
    const call = await startOrchestrator();
    expect((await call('GET', '/v1/public/info')).body).toEqual({waitlistOpen: false, contacts: {email: null, discord: null, url: null}, promotions: []});

    const saved = await call('PUT', '/v1/super/config', {contactEmail: ' muse@example.test ', contactDiscord: 'haxurus', contactUrl: 'https://example.test'}, actorHeaders);
    expect(saved).toMatchObject({status: 200, body: {contactEmail: 'muse@example.test', contactDiscord: 'haxurus', contactUrl: 'https://example.test', waitlistOpen: false}});
    expect((await call('GET', '/v1/public/info')).body.contacts).toEqual({email: 'muse@example.test', discord: 'haxurus', url: 'https://example.test'});

    await call('PUT', '/v1/super/config', {contactDiscord: ''}, actorHeaders);
    expect((await call('GET', '/v1/public/info')).body.contacts.discord).toBeNull();
    expect((await call('GET', '/v1/super/overview')).body.audit[0]).toMatchObject({action: 'instance.config', subjectType: 'INSTANCE'});
  });

  it.each([
    [{contactEmail: 'not-an-email'}],
    [{contactUrl: 'http://example.test'}],
    [{contactDiscord: 'javascript://x'}],
    [{waitlistOpen: 'yes'}],
    [{}],
  ])('rejects %j', async body => {
    const call = await startOrchestrator();
    expect(await call('PUT', '/v1/super/config', body, actorHeaders)).toMatchObject({status: 400, body: {code: 'INVALID_CONFIG'}});
  });
});
