import {createServer, IncomingHttpHeaders, IncomingMessage, request, Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it, vi} from 'vitest';
import DashboardAuth, {dashboardCookieNames} from '../src/dashboard/auth.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import type DiscordOAuthClient from '../src/dashboard/discord-oauth.js';
import {createEdgeHandler, forwardedFor, stripHopByHop} from '../src/dashboard/edge-proxy.js';
import OrchestratorClient, {orchestratorError} from '../src/dashboard/orchestrator-client.js';
import DashboardServer from '../src/dashboard/server.js';
import SessionStore, {STATE_TTL_MS} from '../src/dashboard/session-store.js';

const PUBLIC_URL = 'https://music.example.test';
const GUILD_ID = '111111111111111111';

const makeConfig = (publicUrl = PUBLIC_URL): DashboardConfig => ({
  host: '127.0.0.1',
  port: 0,
  publicUrl: new URL(publicUrl),
  oauthRedirectUri: new URL('/auth/discord/callback', publicUrl).toString(),
  discordClientId: '123456789012345678',
  discordClientSecret: 'not-a-real-secret',
  orchestratorUrl: 'http://orchestrator:3100',
  orchestratorToken: 'not-a-real-token',
  sessionTtlMs: 8 * 60 * 60 * 1000,
});

const user = {id: '222222222222222222', username: 'admin', global_name: null, avatar: null};

const upstreamHttpError = (statusCode: number, body = '', headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Response code ${statusCode}`), {
    name: 'HTTPError',
    response: {statusCode, headers, body},
  });

const fakeDiscord = () => ({
  authorizationUrl: vi.fn((state: string) => `https://discord.com/oauth2/authorize?state=${encodeURIComponent(state)}`),
  exchangeCode: vi.fn(async () => ({
    access_token: 'discord-access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'identify guilds',
  })),
  currentUser: vi.fn(async () => user),
  currentUserGuilds: vi.fn(async () => [{id: GUILD_ID, name: 'Guild', icon: null, owner: true, permissions: '0'}]),
  revoke: vi.fn(async () => undefined),
});

const fakeOrchestrator = () => ({
  guilds: vi.fn(async () => ({guilds: [{id: GUILD_ID, name: 'Guild', availableWorkers: 2}]})),
  guildWorkers: vi.fn(async () => ({guildId: GUILD_ID, groups: [], workers: []})),
  createGuildGroup: vi.fn(async () => ({id: 'group-1'})),
  updateGuildGroup: vi.fn(async () => ({id: 'group-1'})),
  deleteGuildGroup: vi.fn(async () => ({deleted: true})),
  updateGuildSettings: vi.fn(async () => ({updated: ['muse-01'], failed: []})),
});

type HttpResult = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

const call = async (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResult> => new Promise((resolve, reject) => {
  const outgoing = request({host: '127.0.0.1', port, method, path, headers}, response => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => {
      resolve({status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8')});
    });
    response.on('error', reject);
  });
  outgoing.on('error', reject);
  outgoing.end(body);
});

const cookiePair = (setCookie: string): string => setCookie.split(';')[0];

const servers: Array<{close: () => Promise<void>}> = [];

const startDashboard = async (publicUrl = PUBLIC_URL) => {
  const config = makeConfig(publicUrl);
  const store = new SessionStore(config.sessionTtlMs);
  const discord = fakeDiscord();
  const orchestrator = fakeOrchestrator();
  const auth = new DashboardAuth(config, {
    store,
    discord: discord as unknown as DiscordOAuthClient,
    isUserBlocked: vi.fn(async () => false),
  });
  const server = new DashboardServer(config, {auth, orchestrator: orchestrator as unknown as OrchestratorClient});
  await server.start();
  servers.push(server);

  const names = dashboardCookieNames(config.publicUrl.protocol === 'https:');
  const session = store.createSession(user, 'discord-access-token', 3600);
  const mutationHeaders = (overrides: Record<string, string> = {}) => ({
    cookie: `${names.session}=${session.id}`,
    origin: config.publicUrl.origin,
    'x-csrf-token': session.csrfToken,
    'content-type': 'application/json',
    ...overrides,
  });

  return {config, store, discord, orchestrator, server, port: server.port!, session, names, mutationHeaders};
};

const listen = async (server: Server): Promise<number> => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  });
});

const rawServers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(async server => server.close()));
  await Promise.all(rawServers.splice(0).map(async server => new Promise<void>(resolve => {
    server.close(() => {
      resolve();
    });
  })));
});

describe('dashboard mutation checks', () => {
  const settingsBody = JSON.stringify({workerIds: ['muse-01'], settings: {defaultVolume: 50}});

  it('rejects a missing CSRF token before refreshing Discord permissions', async () => {
    const dashboard = await startDashboard();
    const headers = dashboard.mutationHeaders();
    delete (headers as Record<string, string>)['x-csrf-token'];

    const result = await call(dashboard.port, 'PATCH', `/api/guilds/${GUILD_ID}`, headers, settingsBody);

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({error: 'invalid CSRF token'});
    expect(dashboard.discord.currentUserGuilds).not.toHaveBeenCalled();
    expect(dashboard.orchestrator.updateGuildSettings).not.toHaveBeenCalled();
  });

  it('rejects a foreign Origin before refreshing Discord permissions', async () => {
    const dashboard = await startDashboard();
    const result = await call(
      dashboard.port,
      'PATCH',
      `/api/guilds/${GUILD_ID}`,
      dashboard.mutationHeaders({origin: 'https://evil.example.test'}),
      settingsBody,
    );

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({error: 'invalid request origin'});
    expect(dashboard.discord.currentUserGuilds).not.toHaveBeenCalled();
  });

  it('applies the mutation budget before refreshing Discord permissions', async () => {
    const dashboard = await startDashboard();
    dashboard.session.mutationWindowStartedAt = Date.now();
    dashboard.session.mutationCount = 30;

    const result = await call(dashboard.port, 'PATCH', `/api/guilds/${GUILD_ID}`, dashboard.mutationHeaders(), settingsBody);

    expect(result.status).toBe(429);
    expect(dashboard.discord.currentUserGuilds).not.toHaveBeenCalled();
  });

  it('refreshes Discord permissions and writes a token-free audit line for valid mutations', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'PATCH', `/api/guilds/${GUILD_ID}`, dashboard.mutationHeaders(), settingsBody);

    expect(result.status).toBe(200);
    expect(dashboard.discord.currentUserGuilds).toHaveBeenCalledTimes(1);
    expect(dashboard.orchestrator.updateGuildSettings).toHaveBeenCalledWith(GUILD_ID, {
      workerIds: ['muse-01'],
      settings: {defaultVolume: 50},
    });

    const auditLines = log.mock.calls
      .map(args => String(args[0]))
      .filter(line => line.includes('dashboard_mutation'));
    expect(auditLines).toHaveLength(1);
    expect(JSON.parse(auditLines[0])).toMatchObject({
      userId: user.id,
      guildId: GUILD_ID,
      action: 'settings.update',
      workerCount: 1,
      workerIds: ['muse-01'],
      outcome: 'ok',
    });
    expect(auditLines[0]).not.toContain('discord-access-token');
    expect(auditLines[0]).not.toContain(dashboard.session.csrfToken);
    expect(auditLines[0]).not.toContain(dashboard.session.id);
  });

  it('returns 429 with Retry-After when Discord rate limits the permission refresh', async () => {
    const dashboard = await startDashboard();
    dashboard.discord.currentUserGuilds.mockRejectedValueOnce(upstreamHttpError(429, '', {'retry-after': '2.5'}));

    const result = await call(dashboard.port, 'PATCH', `/api/guilds/${GUILD_ID}`, dashboard.mutationHeaders(), settingsBody);

    expect(result.status).toBe(429);
    expect(result.headers['retry-after']).toBe('3');
    expect(dashboard.store.get(dashboard.session.id)).toBeDefined();
  });

  it('deletes the session when Discord rejects the access token', async () => {
    const dashboard = await startDashboard();
    dashboard.discord.currentUserGuilds.mockRejectedValueOnce(upstreamHttpError(401));

    const result = await call(dashboard.port, 'PATCH', `/api/guilds/${GUILD_ID}`, dashboard.mutationHeaders(), settingsBody);

    expect(result.status).toBe(401);
    expect(dashboard.store.get(dashboard.session.id)).toBeUndefined();
  });

  it('forwards orchestrator 4xx statuses with a sanitized message', async () => {
    const dashboard = await startDashboard();
    dashboard.orchestrator.deleteGuildGroup.mockRejectedValueOnce(
      orchestratorError(upstreamHttpError(404, JSON.stringify({error: 'group not found'}))),
    );

    const result = await call(dashboard.port, 'DELETE', `/api/guilds/${GUILD_ID}/groups/group-1`, dashboard.mutationHeaders());

    expect(result.status).toBe(404);
    expect(JSON.parse(result.body)).toEqual({error: 'group not found'});
  });
});

describe('orchestrator error mapping', () => {
  it('keeps 400/404/409 statuses with the orchestrator message', () => {
    for (const status of [400, 404, 409]) {
      const error = orchestratorError(upstreamHttpError(status, JSON.stringify({error: 'bad worker'})));
      expect(error.statusCode).toBe(status);
      expect(error.message).toBe('bad worker');
    }
  });

  it('uses a generic message for long, non-JSON, or control-character messages', () => {
    expect(orchestratorError(upstreamHttpError(400, JSON.stringify({error: 'x'.repeat(201)}))).message)
      .toBe('orchestrator rejected the request');
    expect(orchestratorError(upstreamHttpError(409, '<html>conflict</html>')).message)
      .toBe('orchestrator rejected the request');
    expect(orchestratorError(upstreamHttpError(400, JSON.stringify({error: 'line\nbreak'}))).message)
      .toBe('orchestrator rejected the request');
  });

  it('maps 5xx, authentication failures, and network errors to 502', () => {
    expect(orchestratorError(upstreamHttpError(500, JSON.stringify({error: 'boom'}))).statusCode).toBe(502);
    expect(orchestratorError(upstreamHttpError(401)).statusCode).toBe(502);

    const network = orchestratorError(Object.assign(new Error('connect ECONNREFUSED'), {name: 'RequestError'}));
    expect(network.statusCode).toBe(502);
    expect(network.message).toBe('orchestrator unavailable');
    expect(network.details).toEqual({causeName: 'RequestError', causeStatus: undefined});
  });
});

describe('dashboard OAuth state and cookies', () => {
  it('uses __Host-/__Secure- cookie names in https mode', async () => {
    const dashboard = await startDashboard(PUBLIC_URL);
    const begin = await call(dashboard.port, 'GET', '/auth/discord');
    const stateCookie = (begin.headers['set-cookie'] ?? [])[0];

    expect(begin.status).toBe(302);
    expect(stateCookie).toMatch(/^__Secure-muse_oauth_state=/u);
    expect(stateCookie).toContain('Path=/auth/discord/callback');
    expect(stateCookie).toContain('Secure');

    const state = new URL(begin.headers.location!).searchParams.get('state')!;
    const callback = await call(
      dashboard.port,
      'GET',
      `/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
      {cookie: cookiePair(stateCookie)},
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`${PUBLIC_URL}/dashboard`);
    const sessionCookie = (callback.headers['set-cookie'] ?? []).find(value => value.startsWith('__Host-muse_session='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('Path=/;');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).not.toMatch(/domain=/iu);
  });

  it('keeps plain cookie names without Secure in http development mode', async () => {
    const dashboard = await startDashboard('http://localhost:3000');
    const begin = await call(dashboard.port, 'GET', '/auth/discord');
    const stateCookie = (begin.headers['set-cookie'] ?? [])[0];

    expect(stateCookie).toMatch(/^muse_oauth_state=/u);
    expect(stateCookie).not.toContain('Secure');

    const state = new URL(begin.headers.location!).searchParams.get('state')!;
    const callback = await call(
      dashboard.port,
      'GET',
      `/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
      {cookie: cookiePair(stateCookie)},
    );

    const sessionCookie = (callback.headers['set-cookie'] ?? []).find(value => value.startsWith('muse_session='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).not.toContain('Secure');
  });

  it('redirects to a friendly failure page for replayed, mismatched, or cancelled logins', async () => {
    const dashboard = await startDashboard();
    const begin = await call(dashboard.port, 'GET', '/auth/discord');
    const stateCookie = cookiePair((begin.headers['set-cookie'] ?? [])[0]);
    const state = new URL(begin.headers.location!).searchParams.get('state')!;
    const callbackPath = `/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`;

    expect((await call(dashboard.port, 'GET', callbackPath, {cookie: stateCookie})).headers.location).toBe(`${PUBLIC_URL}/dashboard`);

    const replay = await call(dashboard.port, 'GET', callbackPath, {cookie: stateCookie});
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe(`${PUBLIC_URL}/dashboard?login=failed`);

    const mismatch = await call(dashboard.port, 'GET', callbackPath, {cookie: '__Secure-muse_oauth_state=other'});
    expect(mismatch.headers.location).toBe(`${PUBLIC_URL}/dashboard?login=failed`);

    const cancelled = await call(dashboard.port, 'GET', '/auth/discord/callback?error=access_denied');
    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.location).toBe(`${PUBLIC_URL}/dashboard?login=failed`);
    expect(dashboard.discord.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('rejects tokens missing the identify or guilds scope', async () => {
    const dashboard = await startDashboard();
    dashboard.discord.exchangeCode.mockResolvedValueOnce({
      access_token: 'discord-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'identify',
    });

    const begin = await call(dashboard.port, 'GET', '/auth/discord');
    const stateCookie = cookiePair((begin.headers['set-cookie'] ?? [])[0]);
    const state = new URL(begin.headers.location!).searchParams.get('state')!;
    const callback = await call(
      dashboard.port,
      'GET',
      `/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
      {cookie: stateCookie},
    );

    expect(callback.headers.location).toBe(`${PUBLIC_URL}/dashboard?login=failed`);
    expect(dashboard.discord.revoke).toHaveBeenCalledWith('discord-access-token');
    expect(dashboard.discord.currentUser).not.toHaveBeenCalled();
  });

  it('deletes the previous session on re-login', async () => {
    const dashboard = await startDashboard();
    const begin = await call(dashboard.port, 'GET', '/auth/discord');
    const stateCookie = cookiePair((begin.headers['set-cookie'] ?? [])[0]);
    const state = new URL(begin.headers.location!).searchParams.get('state')!;

    await call(
      dashboard.port,
      'GET',
      `/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
      {cookie: `${stateCookie}; ${dashboard.names.session}=${dashboard.session.id}`},
    );

    expect(dashboard.store.get(dashboard.session.id)).toBeUndefined();
  });
});

describe('dashboard session store', () => {
  it('issues signed OAuth states that expire and cannot be forged', () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = new SessionStore(60_000);

    const expired = store.issueOAuthState();
    vi.setSystemTime(Date.now() + STATE_TTL_MS + 1);
    expect(store.consumeOAuthState(expired)).toBe(false);

    const valid = store.issueOAuthState();
    const [expires, nonce] = valid.split('.');
    expect(store.consumeOAuthState(`${expires}.${nonce}.${'0'.repeat(64)}`)).toBe(false);
    expect(store.consumeOAuthState(`${(Date.now() + 1_000_000_000).toString(36)}.${nonce}.${valid.split('.')[2]}`)).toBe(false);
    expect(store.consumeOAuthState('garbage')).toBe(false);

    expect(store.consumeOAuthState(valid)).toBe(true);
    expect(store.consumeOAuthState(valid)).toBe(false);

    // A different process key never accepts this process's states.
    expect(new SessionStore(60_000).consumeOAuthState(store.issueOAuthState())).toBe(false);
    store.close();
  });

  it('never refuses to issue OAuth states under load', () => {
    const store = new SessionStore(60_000);
    for (let index = 0; index < 5000; index++) {
      store.issueOAuthState();
    }

    expect(store.consumeOAuthState(store.issueOAuthState())).toBe(true);
    store.close();
  });

  it('caps total sessions by evicting the oldest', () => {
    const store = new SessionStore(60_000, {maxSessions: 3});
    const sessions = [1, 2, 3, 4].map(index => store.createSession({id: String(index), username: `user${index}`}, 'token', 3600));

    expect(store.size).toBe(3);
    expect(store.get(sessions[0].id)).toBeUndefined();
    expect(store.get(sessions[3].id)).toBeDefined();
    store.close();
  });

  it('caps sessions per user by evicting that user\'s oldest session', () => {
    const store = new SessionStore(60_000, {maxSessionsPerUser: 2});
    const other = store.createSession({id: 'other', username: 'other'}, 'token', 3600);
    const first = store.createSession(user, 'token', 3600);
    const second = store.createSession(user, 'token', 3600);
    const third = store.createSession(user, 'token', 3600);

    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toBeDefined();
    expect(store.get(third.id)).toBeDefined();
    expect(store.get(other.id)).toBeDefined();
    store.close();
  });
});

describe('dashboard edge proxy', () => {
  it('strips hop-by-hop headers including those named in Connection', () => {
    const headers = stripHopByHop({
      connection: 'keep-alive, X-Internal-Secret',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
      'proxy-authorization': 'Basic abc',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      te: 'trailers',
      'x-internal-secret': 'leak',
      cookie: 'a=b',
      accept: 'application/json',
    });

    expect(headers).toEqual({cookie: 'a=b', accept: 'application/json'});
  });

  it('derives X-Forwarded-For from the proxy header or the socket address', () => {
    const fromProxy = {headers: {'x-forwarded-for': '203.0.113.7, 172.18.0.2'}, socket: {remoteAddress: '172.18.0.2'}};
    const fromSocket = {headers: {}, socket: {remoteAddress: '172.18.0.3'}};
    const bogus = {headers: {'x-forwarded-for': 'not an ip<script>'}, socket: {remoteAddress: '172.18.0.4'}};

    expect(forwardedFor(fromProxy as unknown as IncomingMessage)).toBe('203.0.113.7, 172.18.0.2');
    expect(forwardedFor(fromSocket as unknown as IncomingMessage)).toBe('172.18.0.3');
    expect(forwardedFor(bogus as unknown as IncomingMessage)).toBe('172.18.0.4');
  });

  it('proxies requests without hop-by-hop headers and survives upstream failures', async () => {
    let received: IncomingHttpHeaders = {};
    const upstream = createServer((incoming, outgoing) => {
      received = incoming.headers;
      if (incoming.url === '/broken') {
        outgoing.writeHead(200, {'content-type': 'text/plain'});
        outgoing.write('partial');
        setTimeout(() => {
          outgoing.destroy();
        }, 50);
        return;
      }

      outgoing.writeHead(200, {'content-type': 'application/json', connection: 'x-upstream-private', 'x-upstream-private': '1'});
      outgoing.end('{"ok":true}');
    });
    rawServers.push(upstream);
    const upstreamPort = await listen(upstream);

    const edge = createServer(createEdgeHandler(new URL(`http://127.0.0.1:${upstreamPort}/`), 2000));
    rawServers.push(edge);
    const edgePort = await listen(edge);

    const ok = await call(edgePort, 'GET', '/api/session', {
      connection: 'x-secret',
      'x-secret': 'leak',
      'proxy-connection': 'keep-alive',
      'x-forwarded-for': '203.0.113.9',
    });

    expect(ok.status).toBe(200);
    expect(ok.body).toBe('{"ok":true}');
    expect(ok.headers['x-upstream-private']).toBeUndefined();
    expect(received['x-secret']).toBeUndefined();
    expect(received['proxy-connection']).toBeUndefined();
    expect(received['x-forwarded-for']).toBe('203.0.113.9');
    expect(received.host).toBe(`127.0.0.1:${upstreamPort}`);

    await expect(call(edgePort, 'GET', '/broken')).rejects.toThrow();

    // The edge process is still serving after a mid-response upstream failure.
    expect((await call(edgePort, 'GET', '/edge-health')).status).toBe(200);
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const placeholder = createServer();
    const closedPort = await listen(placeholder);
    await new Promise<void>(resolve => {
      placeholder.close(() => {
        resolve();
      });
    });

    const edge = createServer(createEdgeHandler(new URL(`http://127.0.0.1:${closedPort}/`), 2000));
    rawServers.push(edge);
    const edgePort = await listen(edge);

    const result = await call(edgePort, 'GET', '/');
    expect(result.status).toBe(502);
    expect(JSON.parse(result.body)).toEqual({error: 'dashboard unavailable'});
  });
});
