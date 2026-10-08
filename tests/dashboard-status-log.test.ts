import {request} from 'node:http';
import {afterEach, describe, expect, it, vi} from 'vitest';
import DashboardAuth, {dashboardCookieNames} from '../src/dashboard/auth.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import type DiscordOAuthClient from '../src/dashboard/discord-oauth.js';
import type OrchestratorClient from '../src/dashboard/orchestrator-client.js';
import DashboardServer from '../src/dashboard/server.js';
import SessionStore from '../src/dashboard/session-store.js';

const PUBLIC_URL = 'https://music.example.test';
const GUILD_ID = '111111111111111111';
const OTHER_GUILD_ID = '999999999999999999';
const CHANNEL_ID = '666666666666666666';
const ROLE_ID = '777777777777777771';

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

const regularUser = {id: '222222222222222222', username: 'admin', global_name: null, avatar: null};

/** Manage Guild (0x20) on GUILD_ID; no management permission on OTHER_GUILD_ID. */
const discordGuilds = [
  {id: GUILD_ID, name: 'Guild', icon: null, owner: false, permissions: '32'},
  {id: OTHER_GUILD_ID, name: 'Other', icon: null, owner: false, permissions: '0'},
];

const meta = {
  guildId: GUILD_ID,
  workerIds: ['muse-01', 'muse-02'],
  sourceWorkerId: 'muse-01',
  channels: [{id: CHANNEL_ID, name: 'bot-log', type: 'text', parentName: 'Logs', position: 0, postableBy: ['muse-01']}],
  roles: [{id: ROLE_ID, name: 'Staff', color: 3_947_580, mentionable: true, position: 3}],
  failed: [],
};

const fakeOrchestrator = () => ({
  guilds: vi.fn(async () => ({guilds: [{id: GUILD_ID, name: 'Guild', availableWorkers: 2}, {id: OTHER_GUILD_ID, name: 'Other', availableWorkers: 1}]})),
  guildWorkers: vi.fn(async () => ({guildId: GUILD_ID, groups: [], workers: []})),
  isUserBlocked: vi.fn(async () => false),
  guildMeta: vi.fn(async (_guildId: string) => meta),
  testGuildStatusChannel: vi.fn(async (guildId: string, _body: {workerIds?: string[]}) => ({
    guildId,
    results: [{workerId: 'muse-01', ok: true}, {workerId: 'muse-02', ok: false, error: 'MISSING_PERMISSIONS'}],
  })),
  updateGuildSettings: vi.fn(async (guildId: string, _body: unknown) => ({guildId, requestedWorkers: ['muse-01', 'muse-02'], updated: [], failed: []})),
});

type HttpResult = {status: number; text: string};

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
      resolve({status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8')});
    });
    response.on('error', reject);
  });
  outgoing.on('error', reject);
  outgoing.end(body);
});

const servers: DashboardServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async server => server.close()));
});

const startDashboard = async () => {
  const store = new SessionStore(config.sessionTtlMs);
  const discord = {
    authorizationUrl: vi.fn(() => 'https://discord.com/oauth2/authorize'),
    exchangeCode: vi.fn(),
    currentUser: vi.fn(async () => regularUser),
    currentUserGuilds: vi.fn(async () => discordGuilds),
    revoke: vi.fn(async () => undefined),
  };
  const orchestrator = fakeOrchestrator();
  const auth = new DashboardAuth(config, {store, discord: discord as unknown as DiscordOAuthClient, isUserBlocked: async () => false});
  const server = new DashboardServer(config, {auth, orchestrator: orchestrator as unknown as OrchestratorClient});
  await server.start();
  servers.push(server);

  const names = dashboardCookieNames(true);
  const session = store.createSession(regularUser, 'discord-access-token', 3600);
  const cookie = `${names.session}=${session.id}`;
  return {
    port: server.port!,
    orchestrator,
    session,
    cookie,
    headers: (overrides: Record<string, string> = {}) => ({
      cookie,
      origin: config.publicUrl.origin,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
      ...overrides,
    }),
  };
};

const auditLines = (log: {mock: {calls: unknown[][]}}) => log.mock.calls
  .map(args => String(args[0]))
  .filter(line => line.includes('dashboard_mutation'))
  .map(line => JSON.parse(line) as Record<string, unknown>);

describe('guild meta route', () => {
  it('requires a session and the guild management permission', async () => {
    const dashboard = await startDashboard();
    expect((await call(dashboard.port, 'GET', `/api/guilds/${GUILD_ID}/meta`)).status).toBe(401);
    const foreign = await call(dashboard.port, 'GET', `/api/guilds/${OTHER_GUILD_ID}/meta`, {cookie: dashboard.cookie});
    expect(foreign.status).toBe(403);
    expect((await call(dashboard.port, 'GET', '/api/guilds/123456789012345678/meta', {cookie: dashboard.cookie})).status).toBe(403);
    expect(dashboard.orchestrator.guildMeta).not.toHaveBeenCalled();
  });

  it('proxies the orchestrator meta read-only, without CSRF and without audit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    const result = await call(dashboard.port, 'GET', `/api/guilds/${GUILD_ID}/meta`, {cookie: dashboard.cookie});
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual(meta);
    expect(dashboard.orchestrator.guildMeta).toHaveBeenCalledWith(GUILD_ID);
    expect(auditLines(log)).toEqual([]);
    // Only GET is routed.
    expect((await call(dashboard.port, 'POST', `/api/guilds/${GUILD_ID}/meta`, dashboard.headers(), '{}')).status).toBe(404);
  });
});

describe('guild status channel test route', () => {
  const path = `/api/guilds/${GUILD_ID}/status-channel/test`;

  it('requires a session, the exact Origin, the CSRF token and the mutation budget', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    expect((await call(dashboard.port, 'POST', path, {'content-type': 'application/json'}, '{}')).status).toBe(401);

    const missingCsrf = dashboard.headers();
    delete (missingCsrf as Record<string, string>)['x-csrf-token'];
    const noToken = await call(dashboard.port, 'POST', path, missingCsrf, '{}');
    expect(noToken.status).toBe(403);
    expect(JSON.parse(noToken.text)).toEqual({error: 'invalid CSRF token'});

    const foreign = await call(dashboard.port, 'POST', path, dashboard.headers({origin: 'https://evil.example.test'}), '{}');
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.text)).toEqual({error: 'invalid request origin'});

    dashboard.session.mutationWindowStartedAt = Date.now();
    dashboard.session.mutationCount = 30;
    expect((await call(dashboard.port, 'POST', path, dashboard.headers(), '{}')).status).toBe(429);
    expect(dashboard.orchestrator.testGuildStatusChannel).not.toHaveBeenCalled();
  });

  it('refuses a guild the user cannot manage and invalid worker lists', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    const forbidden = await call(dashboard.port, 'POST', `/api/guilds/${OTHER_GUILD_ID}/status-channel/test`, dashboard.headers(), '{}');
    expect(forbidden.status).toBe(403);

    for (const body of ['[]', JSON.stringify({workerIds: 'muse-01'}), JSON.stringify({workerIds: []}), JSON.stringify({workerIds: ['../x']})]) {
      expect((await call(dashboard.port, 'POST', path, dashboard.headers(), body)).status, body).toBe(400);
    }

    expect(dashboard.orchestrator.testGuildStatusChannel).not.toHaveBeenCalled();
  });

  it('runs the test on the selected bots and writes an audit line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'POST', path, dashboard.headers(), JSON.stringify({workerIds: ['muse-01', 'muse-02', 'muse-01']}));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({
      guildId: GUILD_ID,
      results: [{workerId: 'muse-01', ok: true}, {workerId: 'muse-02', ok: false, error: 'MISSING_PERMISSIONS'}],
    });
    expect(dashboard.orchestrator.testGuildStatusChannel).toHaveBeenCalledWith(GUILD_ID, {workerIds: ['muse-01', 'muse-02']});

    // An empty body tests every bot of the guild.
    await call(dashboard.port, 'POST', path, dashboard.headers(), '{}');
    expect(dashboard.orchestrator.testGuildStatusChannel).toHaveBeenLastCalledWith(GUILD_ID, {});

    const lines = auditLines(log);
    expect(lines).toEqual([
      expect.objectContaining({action: 'status_channel.test', userId: regularUser.id, guildId: GUILD_ID, workerIds: ['muse-01', 'muse-02'], outcome: 'ok'}),
      expect.objectContaining({action: 'status_channel.test', guildId: GUILD_ID, workerIds: null, outcome: 'ok'}),
    ]);
    expect(JSON.stringify(lines)).not.toContain(dashboard.session.csrfToken);
  });
});

describe('status settings through the guild settings route', () => {
  it('forwards the status channel and roles to every selected bot', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    const body = {workerIds: ['muse-01', 'muse-02'], settings: {statusChannelId: CHANNEL_ID, statusMentionRoleIds: [ROLE_ID]}};

    const result = await call(dashboard.port, 'PATCH', `/api/guilds/${GUILD_ID}`, dashboard.headers(), JSON.stringify(body));
    expect(result.status).toBe(200);
    expect(dashboard.orchestrator.updateGuildSettings).toHaveBeenCalledWith(GUILD_ID, body);

    const forbidden = await call(dashboard.port, 'PATCH', `/api/guilds/${OTHER_GUILD_ID}`, dashboard.headers(), JSON.stringify(body));
    expect(forbidden.status).toBe(403);
    expect(dashboard.orchestrator.updateGuildSettings).toHaveBeenCalledTimes(1);
    expect(auditLines(log)).toEqual([
      expect.objectContaining({action: 'settings.update', guildId: GUILD_ID, outcome: 'ok'}),
      expect.objectContaining({action: 'settings.update', guildId: OTHER_GUILD_ID, outcome: 'rejected_403'}),
    ]);
  });
});
