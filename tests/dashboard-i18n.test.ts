import {readFile} from 'node:fs/promises';
import {IncomingHttpHeaders, request} from 'node:http';
import {afterEach, describe, expect, it, vi} from 'vitest';
import DashboardAuth, {dashboardCookieNames} from '../src/dashboard/auth.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import type DiscordOAuthClient from '../src/dashboard/discord-oauth.js';
import {
  DICTIONARIES,
  LOCALES,
  MESSAGES,
  escapeHtml,
  languageSwitcher,
  preferredLocale,
  renderPage,
  renderTemplate,
} from '../src/dashboard/i18n.js';
import type OrchestratorClient from '../src/dashboard/orchestrator-client.js';
import DashboardServer, {NEW_SERVER_ANCHOR} from '../src/dashboard/server.js';
import SessionStore from '../src/dashboard/session-store.js';

const PUBLIC_URL = 'https://music.example.test';
const GUILD_ID = '111111111111111111';
const SUPER_ADMIN_ID = '333333333333333333';
const CSP = 'default-src \'self\'; font-src \'self\'; img-src \'self\' https://cdn.discordapp.com data:; style-src \'self\'; script-src \'self\'; connect-src \'self\'; object-src \'none\'; frame-src \'none\'; frame-ancestors \'none\'; base-uri \'none\'; form-action \'self\'';

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
  superAdminUserId: SUPER_ADMIN_ID,
};

const regularUser = {id: '222222222222222222', username: 'admin', global_name: null, avatar: null};
const superUser = {id: SUPER_ADMIN_ID, username: 'haxurus', global_name: 'Haxurus', avatar: null};

type HttpResult = {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
};

const call = async (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> => new Promise((resolve, reject) => {
  const outgoing = request({host: '127.0.0.1', port, method, path, headers}, response => {
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

const cookiePair = (setCookie: string): string => setCookie.split(';')[0];

const servers: DashboardServer[] = [];

const startDashboard = async () => {
  const store = new SessionStore(config.sessionTtlMs);
  const discord = {
    authorizationUrl: vi.fn((state: string) => `https://discord.com/oauth2/authorize?state=${encodeURIComponent(state)}`),
    exchangeCode: vi.fn(async () => ({access_token: 'discord-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'identify guilds'})),
    currentUser: vi.fn(async () => regularUser),
    currentUserGuilds: vi.fn(async () => [{id: GUILD_ID, name: 'Guild', icon: null, owner: true, permissions: '0'}]),
    revoke: vi.fn(async () => undefined),
  };
  const orchestrator = {
    guilds: vi.fn(async () => ({guilds: [{id: GUILD_ID, name: 'Guild', availableWorkers: 2}]})),
    isUserBlocked: vi.fn(async () => false),
  };
  const auth = new DashboardAuth(config, {store, discord: discord as unknown as DiscordOAuthClient, isUserBlocked: async () => false});
  const server = new DashboardServer(config, {auth, orchestrator: orchestrator as unknown as OrchestratorClient});
  await server.start();
  servers.push(server);

  const names = dashboardCookieNames(true);
  const userSession = store.createSession(regularUser, 'discord-access-token', 3600);
  const superSession = store.createSession(superUser, 'discord-access-token', 3600);
  return {
    port: server.port!,
    discord,
    names,
    store,
    userSession,
    userCookie: `${names.session}=${userSession.id}`,
    superCookie: `${names.session}=${superSession.id}`,
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async server => server.close()));
});

/** Deep key paths of a JSON dictionary ("settings.fields.locale.label", ...). */
const keyPaths = (node: unknown, prefix = ''): string[] => {
  if (typeof node !== 'object' || node === null) {
    return [prefix];
  }

  return Object.entries(node).flatMap(([key, value]) => keyPaths(value, prefix ? `${prefix}.${key}` : key));
};

const leaf = (node: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((current, part) => (current as Record<string, unknown>)[part], node);

const params = (value: string, pattern: RegExp): string[] => [...value.matchAll(pattern)].map(match => match[0]).sort();

const readDictionary = async (locale: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../dashboard/i18n/${locale}.json`, import.meta.url), 'utf8')) as unknown;

describe('Accept-Language negotiation', () => {
  it('prefers the Italian or English range with the highest quality and defaults to English', () => {
    expect(preferredLocale('it-IT,it;q=0.9,en;q=0.8')).toBe('it');
    expect(preferredLocale('en-US,en;q=0.9,it;q=0.8')).toBe('en');
    expect(preferredLocale('fr-FR,fr;q=0.9,it;q=0.7,en;q=0.5')).toBe('it');
    expect(preferredLocale('en;q=0.4, it;q=0.6')).toBe('it');
    expect(preferredLocale('IT')).toBe('it');
    expect(preferredLocale('it;q=0, en;q=0.1')).toBe('en');
    expect(preferredLocale('de-DE,fr')).toBe('en');
    expect(preferredLocale('')).toBe('en');
    expect(preferredLocale(undefined)).toBe('en');
    expect(preferredLocale(['de', 'it;q=0.5'])).toBe('it');
  });
});

describe('template substitution', () => {
  it('escapes HTML in values and inserts trusted markup unescaped', () => {
    expect(escapeHtml('<a href="x">Tom & Jerry\'s</a>')).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    expect(renderTemplate('<p title="{{a}}">{{a}}</p>{{{b}}}', {a: '"><script>alert(1)</script>'}, {b: '<i>ok</i>'}))
      .toBe('<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p><i>ok</i>');
  });

  it('never rescans substituted text and rejects unknown keys', () => {
    expect(renderTemplate('{{a}}', {a: '{{b}}', b: 'nope'})).toBe('{{b}}');
    expect(() => renderTemplate('{{missing}}', {})).toThrow('Unknown template key: missing');
    expect(() => renderTemplate('{{{missing}}}', {})).toThrow('Unknown template markup: missing');
    expect(() => renderTemplate('{{toString}}', {})).toThrow();
  });

  it('renders every page template in both languages without leftovers', async () => {
    for (const file of ['home.html', 'index.html', 'development.html']) {
      const template = await readFile(new URL(`../dashboard/${file}`, import.meta.url), 'utf8');
      for (const locale of LOCALES) {
        const html = renderPage(template, locale, '', {origin: PUBLIC_URL});
        expect(html, `${file} ${locale}`).toContain(`<html lang="${locale}">`);
        expect(html, `${file} ${locale}`).not.toMatch(/\{\{|\}\}/u);
      }
    }
  });

  it('builds a switcher that links to the same page in each language', () => {
    const html = languageSwitcher('en', '/development');
    expect(html).toContain('href="/it/development" lang="it" hreflang="it" data-lang-link="it">IT</a>');
    expect(html).toContain('href="/en/development" lang="en" hreflang="en" data-lang-link="en" class="is-active" aria-current="page">EN</a>');
    expect(html).toContain('aria-label="Language"');
    expect(languageSwitcher('it', '', 'mobile')).toContain('>IT · Italiano</a>');
  });
});

describe('dictionaries', () => {
  it('have identical, non-empty key sets for the server-rendered pages', () => {
    const itKeys = Object.keys(MESSAGES.it).sort();
    expect(itKeys.length).toBeGreaterThan(100);
    expect(itKeys).toContain('hero.line1');
    expect(Object.keys(MESSAGES.en).sort()).toEqual(itKeys);
    expect(keyPaths(DICTIONARIES.en).sort()).toEqual(keyPaths(DICTIONARIES.it).sort());
    for (const locale of LOCALES) {
      for (const key of itKeys) {
        expect(MESSAGES[locale][key].trim(), `${locale} ${key}`).not.toBe('');
      }
    }
  });

  it('have identical key sets and placeholders for the dashboard app', async () => {
    const itDictionary = await readDictionary('it');
    const enDictionary = await readDictionary('en');
    const itKeys = keyPaths(itDictionary).sort();

    expect(keyPaths(enDictionary).sort()).toEqual(itKeys);
    for (const key of itKeys) {
      const itValue = leaf(itDictionary, key);
      const enValue = leaf(enDictionary, key);
      expect(typeof itValue, key).toBe('string');
      expect(typeof enValue, key).toBe('string');
      expect((enValue as string).trim(), key).not.toBe('');
      expect(params(enValue as string, /\{\w+\}/gu), key).toEqual(params(itValue as string, /\{\w+\}/gu));
    }
  });

  it('covers every data-i18n key used by the app markup', async () => {
    const markup = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
    const itKeys = new Set(keyPaths(await readDictionary('it')));
    const used = [...markup.matchAll(/data-i18n(?:-placeholder|-aria-label)?="([\w.]+)"/gu)].map(match => match[1]);

    expect(used.length).toBeGreaterThan(50);
    for (const key of used) {
      expect(itKeys.has(key), key).toBe(true);
    }
  });
});

describe('localized routes', () => {
  it('redirects / to the Accept-Language preference', async () => {
    const dashboard = await startDashboard();

    const italian = await call(dashboard.port, 'GET', '/', {'accept-language': 'it-IT,it;q=0.9,en;q=0.8'});
    expect(italian.status).toBe(302);
    expect(italian.headers.location).toBe(`${PUBLIC_URL}/it`);
    expect(italian.headers.vary).toBe('accept-language');
    expect(italian.headers['content-security-policy']).toBe(CSP);

    expect((await call(dashboard.port, 'GET', '/', {'accept-language': 'en-US'})).headers.location).toBe(`${PUBLIC_URL}/en`);
    expect((await call(dashboard.port, 'GET', '/', {'accept-language': 'de-DE'})).headers.location).toBe(`${PUBLIC_URL}/en`);
    expect((await call(dashboard.port, 'GET', '/')).headers.location).toBe(`${PUBLIC_URL}/en`);
  });

  it('serves the indexable home page in each language with hreflang alternates', async () => {
    const dashboard = await startDashboard();

    const italian = await call(dashboard.port, 'GET', '/it');
    const english = await call(dashboard.port, 'GET', '/en');

    for (const [page, locale] of [[italian, 'it'], [english, 'en']] as const) {
      expect(page.status).toBe(200);
      expect(page.headers['content-language']).toBe(locale);
      expect(page.headers['x-robots-tag']).toBeUndefined();
      expect(page.headers['content-security-policy']).toBe(CSP);
      expect(page.text).toContain(`<html lang="${locale}">`);
      expect(page.text).not.toMatch(/<meta name="robots"/u);
      expect(page.text).toContain(`<link rel="canonical" href="${PUBLIC_URL}/${locale}">`);
      expect(page.text).toContain(`<link rel="alternate" hreflang="it" href="${PUBLIC_URL}/it">`);
      expect(page.text).toContain(`<link rel="alternate" hreflang="en" href="${PUBLIC_URL}/en">`);
      expect(page.text).toContain(`<link rel="alternate" hreflang="x-default" href="${PUBLIC_URL}/">`);
      expect(page.text).toContain(`href="/add?lang=${locale}"`);
      expect(page.text).toContain(`href="/${locale}/dashboard"`);
      expect(page.text).toContain(`href="/${locale}" lang="${locale}" hreflang="${locale}" data-lang-link="${locale}" class="is-active" aria-current="page"`);
      expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>|\sstyle="|\son[a-z]+="/u);
    }

    expect(italian.text).toContain('<span>Cinque bot.</span><span>Una dashboard.</span><span>La tua musica.</span>');
    expect(italian.text).toContain('Aggiungi a Discord');
    expect(english.text).toContain('<span>Five bots.</span><span>One dashboard.</span><span>Your music.</span>');
    expect(english.text).toContain('Add to Discord');
    expect(english.text).toContain('<title>Muse · Self-hosted Discord music bots</title>');
    expect(english.text).not.toContain('Cinque bot.');
    expect(english.text).toContain('href="/it" lang="it" hreflang="it" data-lang-link="it">IT</a>');
  });

  it('serves the app and the development notice per language with noindex', async () => {
    const dashboard = await startDashboard();

    for (const locale of LOCALES) {
      for (const path of [`/${locale}/dashboard`, `/${locale}/super`, `/${locale}/server/${GUILD_ID}`, `/${locale}/development`]) {
        const page = await call(dashboard.port, 'GET', path);
        expect(page.status, path).toBe(200);
        expect(page.headers['x-robots-tag'], path).toBe('noindex, nofollow');
        expect(page.headers['content-security-policy'], path).toBe(CSP);
        expect(page.text, path).toContain(`<html lang="${locale}">`);
        expect(page.text, path).toContain('<meta name="robots" content="noindex, nofollow">');
      }
    }

    const app = await call(dashboard.port, 'GET', '/en/dashboard');
    expect(app.text).toContain('href="/auth/discord?lang=en"');
    expect(app.text).toContain('href="/en/super"');
    expect(app.text).toContain('<script src="/assets/dashboard.js" defer></script>');

    expect((await call(dashboard.port, 'GET', '/en/development')).text).toContain('Muse is still in development.');
    expect((await call(dashboard.port, 'GET', '/it/development')).text).toContain('Muse è ancora in sviluppo.');

    for (const path of ['/it/', '/fr', '/fr/dashboard', '/en/dashboard/', '/en/server/123', '/it/add', '/en/en']) {
      expect((await call(dashboard.port, 'GET', path)).status, path).toBe(404);
    }
  });

  it('redirects the old unprefixed paths, keeping the query string', async () => {
    const dashboard = await startDashboard();
    const italian = {'accept-language': 'it'};

    expect((await call(dashboard.port, 'GET', '/dashboard', italian)).headers.location).toBe(`${PUBLIC_URL}/it/dashboard`);
    expect((await call(dashboard.port, 'GET', '/dashboard?login=failed')).headers.location).toBe(`${PUBLIC_URL}/en/dashboard?login=failed`);
    expect((await call(dashboard.port, 'GET', '/super', italian)).headers.location).toBe(`${PUBLIC_URL}/it/super`);
    expect((await call(dashboard.port, 'GET', `/server/${GUILD_ID}`)).headers.location).toBe(`${PUBLIC_URL}/en/server/${GUILD_ID}`);
    expect((await call(dashboard.port, 'GET', '/development', italian)).headers.location).toBe(`${PUBLIC_URL}/it/development`);
    expect((await call(dashboard.port, 'GET', '/development?lang=en', italian)).headers.location).toBe(`${PUBLIC_URL}/en/development?lang=en`);

    const legacy = await call(dashboard.port, 'GET', '/dashboard');
    expect(legacy.status).toBe(302);
    expect(legacy.headers.vary).toBe('accept-language');
  });

  it('serves the app dictionaries as JSON from the static allowlist', async () => {
    const dashboard = await startDashboard();

    for (const locale of LOCALES) {
      const result = await call(dashboard.port, 'GET', `/assets/i18n/${locale}.json`);
      expect(result.status).toBe(200);
      expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(result.text)).toHaveProperty('settings.fields.locale.label');
    }

    expect((await call(dashboard.port, 'GET', '/assets/i18n/fr.json')).status).toBe(404);
  });
});

describe('language through the Discord login', () => {
  const login = async (port: number, beginPath: string, headers: Record<string, string> = {}) => {
    const begin = await call(port, 'GET', beginPath, headers);
    const cookies = (begin.headers['set-cookie'] ?? []).map(cookiePair).join('; ');
    const state = new URL(begin.headers.location!).searchParams.get('state')!;
    const callback = await call(port, 'GET', `/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`, {cookie: cookies});
    return {begin, callback};
  };

  it('stores ?lang= in a short-lived cookie and returns to /<lang>/dashboard', async () => {
    const dashboard = await startDashboard();

    const {begin, callback} = await login(dashboard.port, '/auth/discord?lang=it', {'accept-language': 'en'});
    const [stateCookie, langCookie] = begin.headers['set-cookie'] ?? [];

    expect(stateCookie).toMatch(/^__Secure-muse_oauth_state=/u);
    expect(langCookie).toBe('__Secure-muse_oauth_lang=it; Path=/auth/discord/callback; Max-Age=600; HttpOnly; SameSite=Lax; Secure');

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`${PUBLIC_URL}/it/dashboard`);
    const setCookies = callback.headers['set-cookie'] ?? [];
    expect(setCookies).toContain('__Secure-muse_oauth_lang=; Path=/auth/discord/callback; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
    expect(setCookies.some(value => value.startsWith('__Host-muse_session='))).toBe(true);

    const english = await login(dashboard.port, '/auth/discord?lang=en', {'accept-language': 'it'});
    expect(english.callback.headers.location).toBe(`${PUBLIC_URL}/en/dashboard`);
  });

  it('falls back to Accept-Language for a missing or invalid language', async () => {
    const dashboard = await startDashboard();

    const invalid = await login(dashboard.port, '/auth/discord?lang=fr', {'accept-language': 'it'});
    expect((invalid.begin.headers['set-cookie'] ?? [])[1]).toMatch(/^__Secure-muse_oauth_lang=it;/u);

    const begin = await call(dashboard.port, 'GET', '/auth/discord');
    const stateOnly = cookiePair((begin.headers['set-cookie'] ?? [])[0]);
    const state = new URL(begin.headers.location!).searchParams.get('state')!;
    const callback = await call(dashboard.port, 'GET', `/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`, {
      cookie: `${stateOnly}; __Secure-muse_oauth_lang=<script>`,
      'accept-language': 'it-IT',
    });
    expect(callback.headers.location).toBe(`${PUBLIC_URL}/it/dashboard`);
  });

  it('keeps the language on failed logins', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const cancelled = await call(dashboard.port, 'GET', '/auth/discord/callback?error=access_denied', {
      cookie: `${dashboard.names.lang}=it`,
    });
    expect(cancelled.headers.location).toBe(`${PUBLIC_URL}/it/dashboard?login=failed`);
  });

  it('returns to the localized dashboard after logout', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'POST', '/auth/logout?lang=it', {
      cookie: dashboard.userCookie,
      origin: PUBLIC_URL,
      'x-csrf-token': dashboard.userSession.csrfToken,
    });

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${PUBLIC_URL}/it/dashboard`);
    expect(dashboard.store.get(dashboard.userSession.id)).toBeUndefined();
  });
});

describe('localized /add and /invite redirects', () => {
  it('sends visitors to the localized development notice or invite card', async () => {
    const dashboard = await startDashboard();

    expect((await call(dashboard.port, 'GET', '/add?lang=it')).headers.location).toBe(`${PUBLIC_URL}/it/development`);
    expect((await call(dashboard.port, 'GET', '/add', {'accept-language': 'it'})).headers.location).toBe(`${PUBLIC_URL}/it/development`);
    expect((await call(dashboard.port, 'GET', '/add?lang=en', {cookie: dashboard.userCookie})).headers.location).toBe(`${PUBLIC_URL}/en/development`);
    expect((await call(dashboard.port, 'GET', '/add?lang=it', {cookie: dashboard.superCookie})).headers.location)
      .toBe(`${PUBLIC_URL}/it/dashboard#${NEW_SERVER_ANCHOR}`);
  });

  it('carries the language into the login and the development notice', async () => {
    const dashboard = await startDashboard();

    expect((await call(dashboard.port, 'GET', '/invite/muse-01?lang=it')).headers.location).toBe(`${PUBLIC_URL}/auth/discord?lang=it`);
    expect((await call(dashboard.port, 'GET', '/invite/muse-01?lang=it', {cookie: dashboard.userCookie})).headers.location)
      .toBe(`${PUBLIC_URL}/it/development`);
  });
});

describe('dashboard client', () => {
  it('builds links under the language prefix and offers the bot language setting', async () => {
    const client = await readFile(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');

    expect(client).toContain('{key: \'locale\', type: \'select\', options: [\'en\', \'it\']}');
    expect(client).toContain('fetch(`/assets/i18n/${LOCALE}.json`');
    expect(client).toContain('const DASHBOARD_PATH = `${BASE}/dashboard`;');
    expect(client).toContain('link.href = `${BASE}/server/');
    expect(client).toContain('fetch(`/auth/logout?lang=${LOCALE}`');
    expect(client).not.toMatch(/'\/(?:dashboard|super|development)'/u);

    const italian = await readDictionary('it');
    const english = await readDictionary('en');
    expect(leaf(italian, 'settings.fields.locale.label')).toBe('Lingua del bot');
    expect(leaf(english, 'settings.fields.locale.label')).toBe('Bot language');
    expect(leaf(english, 'settings.fields.locale.hint')).toContain('default: English');
    expect(leaf(italian, 'settings.localeOptions.en')).toBe('English');
    expect(leaf(italian, 'settings.localeOptions.it')).toBe('Italiano');
  });
});

describe('status channel copy', () => {
  it('has the status channel card in both languages, with every worker error code', async () => {
    const italian = await readDictionary('it');
    const english = await readDictionary('en');
    const statusKeys = (dictionary: unknown) => keyPaths(leaf(dictionary, 'super.statusChannel')).sort();
    expect(statusKeys(english)).toEqual(statusKeys(italian));

    expect(leaf(italian, 'super.statusChannel.kicker')).toBe('STATO');
    expect(leaf(english, 'super.statusChannel.kicker')).toBe('STATUS');
    expect(leaf(italian, 'super.statusChannel.title')).toBe('Canale di log dei bot');
    expect(leaf(english, 'super.statusChannel.title')).toBe('Bot status channel');
    for (const dictionary of [italian, english]) {
      for (const code of ['CHANNEL_NOT_FOUND', 'MISSING_PERMISSIONS', 'INVALID_CHANNEL', 'NOT_READY', 'UNREACHABLE', 'DISCORD_ERROR']) {
        expect(typeof leaf(dictionary, `super.statusChannel.errors.${code}`), code).toBe('string');
      }
    }

    expect(leaf(english, 'super.statusChannel.cannotPost')).toContain('Embed Links');
    expect(leaf(italian, 'super.statusChannel.cannotPost')).toContain('Incorpora link');
    expect(leaf(english, 'super.statusChannel.roleNotMentionable')).toContain('Mention @everyone, @here and All Roles');
    expect(leaf(italian, 'super.statusChannel.roleNotMentionable')).toContain('Menziona @everyone, @here e tutti i ruoli');

    const markup = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
    for (const id of ['status-guild', 'status-channel', 'status-role-add', 'status-role-list', 'status-channel-save', 'status-channel-disable', 'status-channel-test', 'status-channel-current', 'status-channel-results']) {
      expect(markup).toContain(`id="${id}"`);
    }

    // The server is chosen from the bots' servers: no free-text channel or role ids any more.
    expect(markup).not.toContain('name="channelId"');
    expect(markup).not.toContain('name="roleId"');

    const client = await readFile(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
    expect(client).toContain('\'/api/super/status-channel\'');
    expect(client).toContain('\'/api/super/status-channel/test\'');
    expect(client).toContain('`/api/super/guilds/${encodeURIComponent(guildId)}/meta`');
    expect(client).toContain('{guildId, channelId, mentionRoleIds: [...roleIds]}');
  });
});
