import {IncomingHttpHeaders, request} from 'node:http';
import {afterEach, describe, expect, it, vi} from 'vitest';
import DashboardAuth, {dashboardCookieNames} from '../src/dashboard/auth.js';
import {loadDashboardConfig, parseSuperAdminUserId} from '../src/dashboard/config.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import type DiscordOAuthClient from '../src/dashboard/discord-oauth.js';
import OrchestratorClient, {orchestratorError} from '../src/dashboard/orchestrator-client.js';
import DashboardServer, {DASHBOARD_PATH, NEW_SERVER_ANCHOR, botInviteUrl} from '../src/dashboard/server.js';
import SessionStore from '../src/dashboard/session-store.js';

const PUBLIC_URL = 'https://music.example.test';
const GUILD_ID = '111111111111111111';
const SUPER_ADMIN_ID = '333333333333333333';
const BOT_ID = '444444444444444444';
const BLOCKED_USER_ID = '555555555555555555';
const STATUS_CHANNEL_ID = '666666666666666666';

const makeConfig = (superAdminUserId: string | null): DashboardConfig => ({
  host: '127.0.0.1',
  port: 0,
  publicUrl: new URL(PUBLIC_URL),
  oauthRedirectUri: new URL('/auth/discord/callback', PUBLIC_URL).toString(),
  discordClientId: '123456789012345678',
  discordClientSecret: 'not-a-real-secret',
  orchestratorUrl: 'http://orchestrator:3100',
  orchestratorToken: 'not-a-real-token',
  sessionTtlMs: 8 * 60 * 60 * 1000,
  ...(superAdminUserId === null ? {} : {superAdminUserId}),
});

const regularUser = {id: '222222222222222222', username: 'admin', global_name: null, avatar: null};
const superUser = {id: SUPER_ADMIN_ID, username: 'haxurus', global_name: 'Haxurus', avatar: null};

const fakeDiscord = (loginUser = regularUser) => ({
  authorizationUrl: vi.fn((state: string) => `https://discord.com/oauth2/authorize?state=${encodeURIComponent(state)}`),
  exchangeCode: vi.fn(async () => ({
    access_token: 'discord-access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'identify guilds',
  })),
  currentUser: vi.fn(async () => loginUser),
  currentUserGuilds: vi.fn(async () => [{id: GUILD_ID, name: 'Guild', icon: null, owner: true, permissions: '0'}]),
  revoke: vi.fn(async () => undefined),
});

const fakeOrchestrator = () => ({
  guilds: vi.fn(async () => ({guilds: [{id: GUILD_ID, name: 'Guild', availableWorkers: 2}]})),
  guildWorkers: vi.fn(async () => ({guildId: GUILD_ID, groups: [], workers: []})),
  workers: vi.fn(async () => ({
    workers: [
      {workerId: 'muse-01', ok: true, value: {discordReady: true, bot: {id: BOT_ID, username: 'Muse One'}}},
      {workerId: 'muse-02', ok: false, error: 'RequestError'},
    ],
  })),
  isUserBlocked: vi.fn(async () => false),
  superOverview: vi.fn(async () => ({workers: [], guilds: [], blocks: [], audit: []})),
  superLeaveGuild: vi.fn(async () => ({left: ['muse-01'], failed: []})),
  superPutBlock: vi.fn(async () => ({block: {kind: 'USER', subjectId: BLOCKED_USER_ID}, pushed: ['muse-01'], failed: []})),
  superDeleteBlock: vi.fn(async () => ({ok: true})),
  superStatusChannel: vi.fn(async () => ({statusChannelId: null, updatedAt: null, updatedBy: null})),
  superSetStatusChannel: vi.fn(async (body: {channelId: string | null; mentionRoleIds?: string[]}) => ({statusChannelId: body.channelId, mentionRoleIds: body.mentionRoleIds ?? [], updatedAt: '2026-10-06T10:00:00.000Z', updatedBy: {userId: SUPER_ADMIN_ID, username: 'haxurus'}})),
  superTestStatusChannel: vi.fn(async () => ({statusChannelId: STATUS_CHANNEL_ID, results: [{workerId: 'muse-01', ok: true}]})),
});

type HttpResult = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
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
      const buffer = Buffer.concat(chunks);
      resolve({status: response.statusCode ?? 0, headers: response.headers, body: buffer, text: buffer.toString('utf8')});
    });
    response.on('error', reject);
  });
  outgoing.on('error', reject);
  outgoing.end(body);
});

const cookiePair = (setCookie: string): string => setCookie.split(';')[0];

const servers: DashboardServer[] = [];

type StartOptions = {
  superAdminUserId?: string | null;
  loginUser?: typeof regularUser;
  isUserBlocked?: (userId: string) => Promise<boolean>;
};

const startDashboard = async (options: StartOptions = {}) => {
  const config = makeConfig(options.superAdminUserId === undefined ? SUPER_ADMIN_ID : options.superAdminUserId);
  const store = new SessionStore(config.sessionTtlMs);
  const discord = fakeDiscord(options.loginUser);
  const orchestrator = fakeOrchestrator();
  const blockCheck: (userId: string) => Promise<boolean> = options.isUserBlocked ?? (async () => false);
  const isUserBlocked = vi.fn(blockCheck);
  const auth = new DashboardAuth(config, {store, discord: discord as unknown as DiscordOAuthClient, isUserBlocked});
  const server = new DashboardServer(config, {auth, orchestrator: orchestrator as unknown as OrchestratorClient});
  await server.start();
  servers.push(server);

  const names = dashboardCookieNames(true);
  const superSession = store.createSession(superUser, 'discord-access-token', 3600);
  const userSession = store.createSession(regularUser, 'discord-access-token', 3600);
  const headersFor = (session: typeof superSession, overrides: Record<string, string> = {}) => ({
    cookie: `${names.session}=${session.id}`,
    origin: config.publicUrl.origin,
    'x-csrf-token': session.csrfToken,
    'content-type': 'application/json',
    ...overrides,
  });

  return {
    config,
    store,
    discord,
    orchestrator,
    isUserBlocked,
    port: server.port!,
    names,
    superSession,
    userSession,
    superHeaders: (overrides: Record<string, string> = {}) => headersFor(superSession, overrides),
    userHeaders: (overrides: Record<string, string> = {}) => headersFor(userSession, overrides),
  };
};

const login = async (port: number, extraCookie = '') => {
  const begin = await call(port, 'GET', '/auth/discord');
  const stateCookie = cookiePair((begin.headers['set-cookie'] ?? [])[0]);
  const state = new URL(begin.headers.location!).searchParams.get('state')!;
  return call(
    port,
    'GET',
    `/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
    {cookie: extraCookie ? `${stateCookie}; ${extraCookie}` : stateCookie},
  );
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(async server => server.close()));
});

describe('MUSE_SUPER_ADMIN_USER_ID', () => {
  it('accepts a Discord user ID and treats empty values as disabled', () => {
    expect(parseSuperAdminUserId(SUPER_ADMIN_ID)).toBe(SUPER_ADMIN_ID);
    expect(parseSuperAdminUserId(` ${SUPER_ADMIN_ID} `)).toBe(SUPER_ADMIN_ID);
    expect(parseSuperAdminUserId(undefined)).toBeUndefined();
    expect(parseSuperAdminUserId('')).toBeUndefined();
    expect(parseSuperAdminUserId('   ')).toBeUndefined();
  });

  it('rejects anything that is not a 17-20 digit snowflake', () => {
    for (const value of ['1234', '123456789012345678901', 'abc', '33333333333333333x', '-333333333333333333']) {
      expect(() => parseSuperAdminUserId(value)).toThrow(/MUSE_SUPER_ADMIN_USER_ID/u);
    }
  });

  it('fails dashboard startup when the configured value is invalid', () => {
    vi.stubEnv('MUSE_DASHBOARD_DISCORD_CLIENT_ID', '123456789012345678');
    vi.stubEnv('MUSE_SUPER_ADMIN_USER_ID', 'not-a-snowflake');

    expect(() => loadDashboardConfig()).toThrow(/MUSE_SUPER_ADMIN_USER_ID/u);
  });
});

describe('dashboard session super-admin flag', () => {
  it('reports superAdmin only for the configured user', async () => {
    const dashboard = await startDashboard();

    const asSuper = await call(dashboard.port, 'GET', '/api/session', {cookie: dashboard.superHeaders().cookie});
    const asUser = await call(dashboard.port, 'GET', '/api/session', {cookie: dashboard.userHeaders().cookie});

    expect(asSuper.status).toBe(200);
    expect(JSON.parse(asSuper.text)).toMatchObject({superAdmin: true});
    expect(JSON.parse(asUser.text)).toMatchObject({superAdmin: false});
  });

  it('never grants superAdmin when no super admin is configured', async () => {
    const dashboard = await startDashboard({superAdminUserId: null});

    const result = await call(dashboard.port, 'GET', '/api/session', {cookie: dashboard.superHeaders().cookie});

    expect(JSON.parse(result.text)).toMatchObject({superAdmin: false});
  });
});

describe('bot invite links', () => {
  it('starts the Discord login for anonymous visitors', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', '/invite/muse-01');

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${PUBLIC_URL}/auth/discord?lang=en`);
    expect(dashboard.orchestrator.workers).not.toHaveBeenCalled();
  });

  it('sends signed-in users who are not the super admin to the development notice', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', '/invite/muse-01', {cookie: dashboard.userHeaders().cookie});

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${PUBLIC_URL}/en/development`);
    expect(dashboard.orchestrator.workers).not.toHaveBeenCalled();
  });

  it('fails closed when no super admin is configured', async () => {
    const dashboard = await startDashboard({superAdminUserId: null});

    const result = await call(dashboard.port, 'GET', '/invite/muse-01', {cookie: dashboard.superHeaders().cookie});

    expect(result.headers.location).toBe(`${PUBLIC_URL}/en/development`);
  });

  it('redirects the super admin to the Discord bot authorization for that worker', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', '/invite/muse-01', {cookie: dashboard.superHeaders().cookie});

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(botInviteUrl(BOT_ID));
    const location = new URL(result.headers.location!);
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(location.searchParams.get('client_id')).toBe(BOT_ID);
    expect(location.searchParams.get('scope')).toBe('bot applications.commands');
    expect(location.searchParams.get('permissions')).toBe('3230720');
  });

  it('returns 404 for malformed or unknown worker ids', async () => {
    const dashboard = await startDashboard();
    const cookie = dashboard.superHeaders().cookie;

    expect((await call(dashboard.port, 'GET', '/invite/muse-1', {cookie})).status).toBe(404);
    expect((await call(dashboard.port, 'GET', '/invite/evil', {cookie})).status).toBe(404);
    expect((await call(dashboard.port, 'GET', '/invite/muse-09', {cookie})).status).toBe(404);
    expect(dashboard.orchestrator.workers).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when the worker is offline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', '/invite/muse-02', {cookie: dashboard.superHeaders().cookie});

    expect(result.status).toBe(503);
  });
});

describe('super console API', () => {
  it('requires a session (401 UNAUTHORIZED) and the super admin (403 SUPER_ADMIN_REQUIRED)', async () => {
    const dashboard = await startDashboard();

    const anonymous = await call(dashboard.port, 'GET', '/api/super/overview');
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.text)).toEqual({error: 'authentication required', code: 'UNAUTHORIZED'});

    const regular = await call(dashboard.port, 'GET', '/api/super/overview', {cookie: dashboard.userHeaders().cookie});
    expect(regular.status).toBe(403);
    expect(JSON.parse(regular.text)).toEqual({error: 'super admin required', code: 'SUPER_ADMIN_REQUIRED'});

    const anonymousMutation = await call(dashboard.port, 'PUT', `/api/super/blocks/USER/${BLOCKED_USER_ID}`, {}, '{}');
    expect(anonymousMutation.status).toBe(401);

    const regularMutation = await call(dashboard.port, 'PUT', `/api/super/blocks/USER/${BLOCKED_USER_ID}`, dashboard.userHeaders(), '{}');
    expect(regularMutation.status).toBe(403);
    expect(JSON.parse(regularMutation.text)).toMatchObject({code: 'SUPER_ADMIN_REQUIRED'});

    expect(dashboard.orchestrator.superOverview).not.toHaveBeenCalled();
    expect(dashboard.orchestrator.superPutBlock).not.toHaveBeenCalled();
  });

  it('denies everything when no super admin is configured', async () => {
    const dashboard = await startDashboard({superAdminUserId: null});

    const result = await call(dashboard.port, 'GET', '/api/super/overview', {cookie: dashboard.superHeaders().cookie});

    expect(result.status).toBe(403);
  });

  it('proxies the overview with the actor headers', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', '/api/super/overview', {cookie: dashboard.superHeaders().cookie});

    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({workers: [], guilds: [], blocks: [], audit: []});
    expect(dashboard.orchestrator.superOverview).toHaveBeenCalledWith({userId: SUPER_ADMIN_ID, username: 'haxurus'});
  });

  it('lists inviteable bots for the super admin', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', '/api/super/bots', {cookie: dashboard.superHeaders().cookie});

    expect(JSON.parse(result.text)).toEqual({
      bots: [
        {workerId: 'muse-01', ready: true, bot: {id: BOT_ID, username: 'Muse One'}},
        {workerId: 'muse-02', ready: false, bot: null},
      ],
    });
  });

  it('rejects mutations without CSRF token or with a foreign Origin', async () => {
    const dashboard = await startDashboard();
    const missingCsrf = dashboard.superHeaders();
    delete (missingCsrf as Record<string, string>)['x-csrf-token'];

    const noToken = await call(dashboard.port, 'POST', `/api/super/guilds/${GUILD_ID}/leave`, missingCsrf, '{}');
    expect(noToken.status).toBe(403);
    expect(JSON.parse(noToken.text)).toEqual({error: 'invalid CSRF token'});

    const foreign = await call(
      dashboard.port,
      'DELETE',
      `/api/super/blocks/USER/${BLOCKED_USER_ID}`,
      dashboard.superHeaders({origin: 'https://evil.example.test'}),
    );
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.text)).toEqual({error: 'invalid request origin'});

    expect(dashboard.orchestrator.superLeaveGuild).not.toHaveBeenCalled();
    expect(dashboard.orchestrator.superDeleteBlock).not.toHaveBeenCalled();
  });

  it('counts super mutations in the mutation budget', async () => {
    const dashboard = await startDashboard();
    dashboard.superSession.mutationWindowStartedAt = Date.now();
    dashboard.superSession.mutationCount = 30;

    const result = await call(dashboard.port, 'POST', `/api/super/guilds/${GUILD_ID}/leave`, dashboard.superHeaders(), '{}');

    expect(result.status).toBe(429);
    expect(dashboard.orchestrator.superLeaveGuild).not.toHaveBeenCalled();
  });

  it('forwards leave requests with the actor and writes an audit line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const result = await call(
      dashboard.port,
      'POST',
      `/api/super/guilds/${GUILD_ID}/leave`,
      dashboard.superHeaders(),
      JSON.stringify({workerIds: ['muse-01', 'muse-01', 'muse-02']}),
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({left: ['muse-01'], failed: []});
    expect(dashboard.orchestrator.superLeaveGuild).toHaveBeenCalledWith(
      GUILD_ID,
      {workerIds: ['muse-01', 'muse-02']},
      {userId: SUPER_ADMIN_ID, username: 'haxurus'},
    );

    const auditLines = log.mock.calls.map(args => String(args[0])).filter(line => line.includes('dashboard_mutation'));
    expect(auditLines).toHaveLength(1);
    expect(JSON.parse(auditLines[0])).toMatchObject({
      userId: SUPER_ADMIN_ID,
      guildId: GUILD_ID,
      action: 'super.guild.leave',
      workerIds: ['muse-01', 'muse-02'],
      outcome: 'ok',
    });
    expect(auditLines[0]).not.toContain(dashboard.superSession.csrfToken);
  });

  it('puts and deletes blocks with validated parameters', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    const actor = {userId: SUPER_ADMIN_ID, username: 'haxurus'};

    const put = await call(
      dashboard.port,
      'PUT',
      `/api/super/blocks/USER/${BLOCKED_USER_ID}`,
      dashboard.superHeaders(),
      JSON.stringify({reason: '  spam  '}),
    );
    expect(put.status).toBe(200);
    expect(dashboard.orchestrator.superPutBlock).toHaveBeenCalledWith('USER', BLOCKED_USER_ID, {reason: 'spam'}, actor);

    const putGuild = await call(dashboard.port, 'PUT', `/api/super/blocks/GUILD/${GUILD_ID}`, dashboard.superHeaders(), '{}');
    expect(putGuild.status).toBe(200);
    expect(dashboard.orchestrator.superPutBlock).toHaveBeenLastCalledWith('GUILD', GUILD_ID, {}, actor);

    const remove = await call(dashboard.port, 'DELETE', `/api/super/blocks/GUILD/${GUILD_ID}`, dashboard.superHeaders());
    expect(remove.status).toBe(200);
    expect(dashboard.orchestrator.superDeleteBlock).toHaveBeenCalledWith('GUILD', GUILD_ID, actor);

    const lines = log.mock.calls.map(args => String(args[0])).filter(line => line.includes('dashboard_mutation'));
    expect(lines.map(line => (JSON.parse(line) as {action: string}).action))
      .toEqual(['super.block.put', 'super.block.put', 'super.block.delete']);
    expect(JSON.parse(lines[0])).toMatchObject({subjectKind: 'USER', subjectId: BLOCKED_USER_ID, outcome: 'ok'});
  });

  it('rejects invalid kinds, ids, reasons and worker lists before calling the orchestrator', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    const headers = dashboard.superHeaders();

    const cases: Array<[string, string, string | undefined]> = [
      ['PUT', `/api/super/blocks/ROLE/${BLOCKED_USER_ID}`, '{}'],
      ['PUT', '/api/super/blocks/USER/1234', '{}'],
      ['PUT', `/api/super/blocks/USER/${BLOCKED_USER_ID}`, JSON.stringify({reason: 'x'.repeat(501)})],
      ['PUT', `/api/super/blocks/USER/${BLOCKED_USER_ID}`, JSON.stringify({reason: 42})],
      ['DELETE', '/api/super/blocks/GUILD/abc', undefined],
      ['POST', '/api/super/guilds/abc/leave', '{}'],
      ['POST', `/api/super/guilds/${GUILD_ID}/leave`, JSON.stringify({workerIds: ['../etc']})],
      ['POST', `/api/super/guilds/${GUILD_ID}/leave`, JSON.stringify({workerIds: 'muse-01'})],
    ];

    for (const [method, path, body] of cases) {
      const result = await call(dashboard.port, method, path, headers, body);
      expect(result.status, `${method} ${path}`).toBe(400);
    }

    expect(dashboard.orchestrator.superPutBlock).not.toHaveBeenCalled();
    expect(dashboard.orchestrator.superDeleteBlock).not.toHaveBeenCalled();
    expect(dashboard.orchestrator.superLeaveGuild).not.toHaveBeenCalled();
  });

  it('keeps orchestrator 4xx statuses for super mutations', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    dashboard.orchestrator.superDeleteBlock.mockRejectedValueOnce(orchestratorError(Object.assign(new Error('Response code 404'), {
      name: 'HTTPError',
      response: {statusCode: 404, headers: {}, body: JSON.stringify({error: 'block not found'})},
    })));

    const result = await call(dashboard.port, 'DELETE', `/api/super/blocks/USER/${BLOCKED_USER_ID}`, dashboard.superHeaders());

    expect(result.status).toBe(404);
    expect(JSON.parse(result.text)).toEqual({error: 'block not found'});
  });
});

describe('super console status channel API', () => {
  const actor = {userId: SUPER_ADMIN_ID, username: 'haxurus'};

  it('requires a session and the super admin on every route', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    const routes: Array<[string, string, string | undefined]> = [
      ['GET', '/api/super/status-channel', undefined],
      ['PUT', '/api/super/status-channel', JSON.stringify({channelId: STATUS_CHANNEL_ID})],
      ['POST', '/api/super/status-channel/test', '{}'],
    ];
    for (const [method, path, body] of routes) {
      const anonymous = await call(dashboard.port, method, path, {'content-type': 'application/json'}, body);
      expect(anonymous.status, `${method} ${path}`).toBe(401);
      expect(JSON.parse(anonymous.text)).toMatchObject({code: 'UNAUTHORIZED'});

      const regular = await call(dashboard.port, method, path, dashboard.userHeaders(), body);
      expect(regular.status, `${method} ${path}`).toBe(403);
      expect(JSON.parse(regular.text)).toMatchObject({code: 'SUPER_ADMIN_REQUIRED'});
    }

    expect(dashboard.orchestrator.superStatusChannel).not.toHaveBeenCalled();
    expect(dashboard.orchestrator.superSetStatusChannel).not.toHaveBeenCalled();
    expect(dashboard.orchestrator.superTestStatusChannel).not.toHaveBeenCalled();
  });

  it('proxies the current setting with the actor headers', async () => {
    const dashboard = await startDashboard();
    const result = await call(dashboard.port, 'GET', '/api/super/status-channel', {cookie: dashboard.superHeaders().cookie});
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({statusChannelId: null, updatedAt: null, updatedBy: null});
    expect(dashboard.orchestrator.superStatusChannel).toHaveBeenCalledWith(actor);
  });

  it('rejects mutations without CSRF token, with a foreign Origin or over budget', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    const missingCsrf = dashboard.superHeaders();
    delete (missingCsrf as Record<string, string>)['x-csrf-token'];
    const body = JSON.stringify({channelId: STATUS_CHANNEL_ID});

    const noToken = await call(dashboard.port, 'PUT', '/api/super/status-channel', missingCsrf, body);
    expect(noToken.status).toBe(403);
    expect(JSON.parse(noToken.text)).toEqual({error: 'invalid CSRF token'});

    const foreign = await call(dashboard.port, 'POST', '/api/super/status-channel/test', dashboard.superHeaders({origin: 'https://evil.example.test'}), '{}');
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.text)).toEqual({error: 'invalid request origin'});

    dashboard.superSession.mutationWindowStartedAt = Date.now();
    dashboard.superSession.mutationCount = 30;
    expect((await call(dashboard.port, 'PUT', '/api/super/status-channel', dashboard.superHeaders(), body)).status).toBe(429);
    expect((await call(dashboard.port, 'POST', '/api/super/status-channel/test', dashboard.superHeaders(), '{}')).status).toBe(429);

    expect(dashboard.orchestrator.superSetStatusChannel).not.toHaveBeenCalled();
    expect(dashboard.orchestrator.superTestStatusChannel).not.toHaveBeenCalled();
  });

  it('saves and disables the channel with the actor and writes audit lines', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const saved = await call(dashboard.port, 'PUT', '/api/super/status-channel', dashboard.superHeaders(), JSON.stringify({channelId: STATUS_CHANNEL_ID}));
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.text)).toMatchObject({statusChannelId: STATUS_CHANNEL_ID});
    expect(dashboard.orchestrator.superSetStatusChannel).toHaveBeenCalledWith({channelId: STATUS_CHANNEL_ID}, actor);

    const cleared = await call(dashboard.port, 'PUT', '/api/super/status-channel', dashboard.superHeaders(), JSON.stringify({channelId: null}));
    expect(cleared.status).toBe(200);
    expect(dashboard.orchestrator.superSetStatusChannel).toHaveBeenLastCalledWith({channelId: null}, actor);

    const roleA = '777777777777777771';
    const roleB = '777777777777777772';
    const withRoles = await call(dashboard.port, 'PUT', '/api/super/status-channel', dashboard.superHeaders(), JSON.stringify({channelId: STATUS_CHANNEL_ID, mentionRoleIds: [roleA, roleB, roleA]}));
    expect(withRoles.status).toBe(200);
    expect(dashboard.orchestrator.superSetStatusChannel).toHaveBeenLastCalledWith({channelId: STATUS_CHANNEL_ID, mentionRoleIds: [roleA, roleB]}, actor);
    await call(dashboard.port, 'PUT', '/api/super/status-channel', dashboard.superHeaders(), JSON.stringify({channelId: STATUS_CHANNEL_ID, mentionRoleIds: []}));
    expect(dashboard.orchestrator.superSetStatusChannel).toHaveBeenLastCalledWith({channelId: STATUS_CHANNEL_ID, mentionRoleIds: []}, actor);

    const lines = log.mock.calls.map(args => String(args[0])).filter(line => line.includes('dashboard_mutation'));
    expect(lines.map(line => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({action: 'super.status_channel.put', userId: SUPER_ADMIN_ID, subjectId: STATUS_CHANNEL_ID, outcome: 'ok'}),
      expect.objectContaining({action: 'super.status_channel.put', outcome: 'ok'}),
      expect.objectContaining({action: 'super.status_channel.put', outcome: 'ok'}),
      expect.objectContaining({action: 'super.status_channel.put', outcome: 'ok'}),
    ]);
    expect(lines.join(' ')).not.toContain(dashboard.superSession.csrfToken);
  });

  it('rejects invalid channel ids before calling the orchestrator', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    const tooMany = Array.from({length: 11}, (_, index) => `7777777777777777${String(index).padStart(2, '0')}`);
    for (const body of [
      '{}',
      JSON.stringify({channelId: '1234'}),
      JSON.stringify({channelId: 666_666_666_666_666}),
      '[]',
      JSON.stringify({channelId: '../x'}),
      JSON.stringify({channelId: STATUS_CHANNEL_ID, mentionRoleIds: '777777777777777771'}),
      JSON.stringify({channelId: STATUS_CHANNEL_ID, mentionRoleIds: ['@everyone']}),
      JSON.stringify({channelId: STATUS_CHANNEL_ID, mentionRoleIds: tooMany}),
    ]) {
      const result = await call(dashboard.port, 'PUT', '/api/super/status-channel', dashboard.superHeaders(), body);
      expect(result.status, body).toBe(400);
    }

    expect(dashboard.orchestrator.superSetStatusChannel).not.toHaveBeenCalled();
  });

  it('runs the test through the orchestrator and keeps its 4xx answers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'POST', '/api/super/status-channel/test', dashboard.superHeaders(), '{}');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({statusChannelId: STATUS_CHANNEL_ID, results: [{workerId: 'muse-01', ok: true}]});
    expect(dashboard.orchestrator.superTestStatusChannel).toHaveBeenCalledWith(actor);

    dashboard.orchestrator.superTestStatusChannel.mockRejectedValueOnce(orchestratorError(Object.assign(new Error('Response code 400'), {
      name: 'HTTPError',
      response: {statusCode: 400, headers: {}, body: JSON.stringify({error: 'no status channel is configured', code: 'STATUS_CHANNEL_NOT_SET'})},
    })));
    const notSet = await call(dashboard.port, 'POST', '/api/super/status-channel/test', dashboard.superHeaders(), '{}');
    expect(notSet.status).toBe(400);
    expect(JSON.parse(notSet.text)).toEqual({error: 'no status channel is configured'});

    const actions = log.mock.calls.map(args => String(args[0])).filter(line => line.includes('dashboard_mutation'))
      .map(line => JSON.parse(line) as {action: string; outcome: string});
    expect(actions).toEqual([
      expect.objectContaining({action: 'super.status_channel.test', outcome: 'ok'}),
      expect.objectContaining({action: 'super.status_channel.test', outcome: 'rejected_400'}),
    ]);
  });
});

describe('"Aggiungi a Discord" from the home page', () => {
  it('sends anonymous visitors to the development notice', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', '/add');

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${PUBLIC_URL}/en/development`);
    expect(result.headers['content-security-policy']).toBeDefined();
  });

  it('sends signed-in users who are not the super admin to the development notice', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', '/add', {cookie: dashboard.userHeaders().cookie});

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${PUBLIC_URL}/en/development`);
  });

  it('sends the super admin to the dashboard invite card', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', '/add', {cookie: dashboard.superHeaders().cookie});

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${PUBLIC_URL}/en${DASHBOARD_PATH}#${NEW_SERVER_ANCHOR}`);
    expect(NEW_SERVER_ANCHOR).toBe('nuovo-server');
  });

  it('never treats anyone as super admin when none is configured', async () => {
    const dashboard = await startDashboard({superAdminUserId: null});

    const result = await call(dashboard.port, 'GET', '/add', {cookie: dashboard.superHeaders().cookie});

    expect(result.headers.location).toBe(`${PUBLIC_URL}/en/development`);
  });

  it('only answers GET', async () => {
    const dashboard = await startDashboard();

    expect((await call(dashboard.port, 'POST', '/add', dashboard.superHeaders(), '{}')).status).toBe(404);
  });
});

describe('dashboard logout', () => {
  it('clears the session and returns to the dashboard login view', async () => {
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'POST', '/auth/logout', dashboard.userHeaders());

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${PUBLIC_URL}/en${DASHBOARD_PATH}`);
    expect((result.headers['set-cookie'] ?? []).some(value => value.startsWith(`${dashboard.names.session}=;`))).toBe(true);
    expect(dashboard.store.get(dashboard.userSession.id)).toBeUndefined();
  });
});

describe('blocked users at login', () => {
  it('denies blocked users without creating a session and revokes the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dashboard = await startDashboard({
      loginUser: {...regularUser, id: BLOCKED_USER_ID},
      isUserBlocked: async () => true,
    });
    const sessionsBefore = dashboard.store.size;

    const callback = await login(dashboard.port);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`${PUBLIC_URL}/en/dashboard?login=blocked`);
    expect((callback.headers['set-cookie'] ?? []).some(value => value.startsWith('__Host-muse_session='))).toBe(false);
    expect(dashboard.store.size).toBe(sessionsBefore);
    expect(dashboard.isUserBlocked).toHaveBeenCalledWith(BLOCKED_USER_ID);
    expect(dashboard.discord.revoke).toHaveBeenCalledWith('discord-access-token');
    expect(warn.mock.calls.map(args => String(args[0])).join('\n')).not.toContain('discord-access-token');
  });

  it('denies the login with ?login=failed when the block list cannot be checked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dashboard = await startDashboard({
      isUserBlocked: async () => {
        throw new Error('orchestrator unavailable');
      },
    });

    const callback = await login(dashboard.port);

    expect(callback.headers.location).toBe(`${PUBLIC_URL}/en/dashboard?login=failed`);
    expect(dashboard.discord.revoke).toHaveBeenCalledTimes(1);
  });

  it('lets allowed users in and never checks the block list for the super admin', async () => {
    const allowed = await startDashboard();
    expect((await login(allowed.port)).headers.location).toBe(`${PUBLIC_URL}/en/dashboard`);
    expect(allowed.isUserBlocked).toHaveBeenCalledWith(regularUser.id);

    const superAdmin = await startDashboard({loginUser: superUser, isUserBlocked: async () => true});
    expect((await login(superAdmin.port)).headers.location).toBe(`${PUBLIC_URL}/en/dashboard`);
    expect(superAdmin.isUserBlocked).not.toHaveBeenCalled();
  });
});

describe('dashboard static pages and fonts', () => {
  it('serves self-hosted Geist fonts as font/woff2', async () => {
    const dashboard = await startDashboard();

    for (const font of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2']) {
      const result = await call(dashboard.port, 'GET', `/assets/fonts/${font}`);
      expect(result.status).toBe(200);
      expect(result.headers['content-type']).toBe('font/woff2');
      expect(result.body.subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(Number(result.headers['content-length'])).toBe(result.body.length);
    }

    const license = await call(dashboard.port, 'GET', '/assets/fonts/OFL.txt');
    expect(license.status).toBe(200);
    expect(license.text).toContain('SIL Open Font License');
  });

  it('keeps a strict CSP that allows only self-hosted fonts and scripts', async () => {
    const dashboard = await startDashboard();

    for (const path of ['/it', '/en', `/en${DASHBOARD_PATH}`, '/it/development']) {
      const page = await call(dashboard.port, 'GET', path);
      const csp = String(page.headers['content-security-policy']);

      expect(csp, path).toContain('font-src \'self\'');
      expect(csp, path).toContain('script-src \'self\'');
      expect(csp, path).toContain('style-src \'self\'');
      expect(csp, path).not.toContain('unsafe-inline');
      expect(page.headers['x-frame-options'], path).toBe('DENY');
      // No inline scripts, inline styles or inline event handlers.
      expect(page.text, path).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>|\sstyle="|\son[a-z]+="/u);
    }
  });

  it('serves the public home page at /it without noindex', async () => {
    const dashboard = await startDashboard();

    const home = await call(dashboard.port, 'GET', '/it');

    expect(home.status).toBe(200);
    expect(home.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(home.headers['x-robots-tag']).toBeUndefined();
    expect(home.headers['content-security-policy']).toContain('default-src \'self\'');
    expect(home.text).not.toMatch(/<meta name="robots"/u);
    expect(home.text).toContain('<script src="/assets/home.js" defer></script>');
    expect(home.text).toContain('href="/add?lang=it"');
    expect(home.text).toContain(`href="/it${DASHBOARD_PATH}"`);
    expect(home.text).toContain('https://github.com/haxurus/muse');
    // The home page is static: it never loads the dashboard client.
    expect(home.text).not.toContain('/assets/dashboard.js');
  });

  it('serves the home and dashboard scripts from the static allowlist', async () => {
    const dashboard = await startDashboard();

    for (const path of ['/assets/home.js', '/assets/dashboard.js']) {
      const result = await call(dashboard.port, 'GET', path);
      expect(result.status, path).toBe(200);
      expect(result.headers['content-type'], path).toBe('text/javascript; charset=utf-8');
      expect(result.headers['x-content-type-options'], path).toBe('nosniff');
    }

    const css = await call(dashboard.port, 'GET', '/assets/dashboard.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    // The HTML files are served only through their routes, never as raw assets.
    expect((await call(dashboard.port, 'GET', '/assets/home.html')).status).toBe(404);
    expect((await call(dashboard.port, 'GET', '/home.html')).status).toBe(404);
  });

  it('serves the SPA views and the development notice with noindex', async () => {
    const dashboard = await startDashboard();

    for (const path of [`/it${DASHBOARD_PATH}`, '/en/super', `/it/server/${GUILD_ID}`]) {
      const result = await call(dashboard.port, 'GET', path);
      expect(result.status, path).toBe(200);
      expect(result.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(result.headers['x-robots-tag']).toBe('noindex, nofollow');
    }

    const development = await call(dashboard.port, 'GET', '/it/development');
    expect(development.status).toBe(200);
    expect(development.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(development.text).toContain('Muse è ancora in sviluppo.');
    expect(development.text).toContain('https://github.com/haxurus/muse');
    expect(development.text).not.toMatch(/\sstyle="|<script/u);

    const app = await call(dashboard.port, 'GET', `/en${DASHBOARD_PATH}`);
    expect(app.text).toContain('<script src="/assets/dashboard.js" defer></script>');
    expect(app.text).toContain(`id="${NEW_SERVER_ANCHOR}"`);

    expect((await call(dashboard.port, 'GET', '/server/not-a-guild')).status).toBe(404);
    expect((await call(dashboard.port, 'GET', '/en/server/not-a-guild')).status).toBe(404);
    expect((await call(dashboard.port, 'GET', '/en/dashboard/extra')).status).toBe(404);
    expect((await call(dashboard.port, 'GET', '/dashboard/extra')).status).toBe(404);
    expect((await call(dashboard.port, 'GET', '/assets/../package.json')).status).toBe(404);
  });
});
