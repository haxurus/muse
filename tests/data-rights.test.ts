import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {request} from 'node:http';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Client} from 'discord.js';
import DashboardAuth, {dashboardCookieNames} from '../src/dashboard/auth.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import type DiscordOAuthClient from '../src/dashboard/discord-oauth.js';
import FixedWindowRateLimiter from '../src/dashboard/rate-limit.js';
import OrchestratorClient from '../src/dashboard/orchestrator-client.js';
import DashboardServer from '../src/dashboard/server.js';
import SessionStore from '../src/dashboard/session-store.js';
import OrchestratorServer from '../src/orchestrator/server.js';
import {deleteFavoritesOfUser, exportGuildData} from '../src/control/user-data.js';
import {
  RETENTION_MS,
  planRetention,
  sweepRetention,
} from '../src/services/data-retention.js';

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations)),
  guildDeparture: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    upsert: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({count: 0})),
  },
  setting: {
    findUnique: vi.fn(async (): Promise<unknown> => null),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    deleteMany: vi.fn(async () => ({count: 0})),
  },
  favoriteQuery: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    deleteMany: vi.fn(async () => ({count: 0})),
  },
}));

vi.mock('../src/utils/db.js', () => ({prisma: prismaMock}));

const GUILD_ID = '111111111111111111';
const USER_ID = '222222222222222222';
const MEMBER_ID = '555555555555555555';
const NOT_IN_MUSE_ID = '333333333333333333';
const FOREIGN_ID = '444444444444444444';
const PUBLIC_URL = 'https://music.example.test';

const directories: string[] = [];
const tempDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-data-rights-'));
  directories.push(directory);
  return directory;
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('server data export and member deletion (orchestrator)', () => {
  const orchestratorWith = (workers: unknown[]) => {
    const server = new OrchestratorServer({
      host: '127.0.0.1',
      port: 0,
      apiToken: 'a'.repeat(32),
      groupsFile: path.join(tempDirectory(), 'groups.json'),
      workers: [],
    });
    (server as unknown as {workers: unknown[]}).workers = workers;
    return server as unknown as Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;
  };

  const bots = () => {
    const present = {
      id: 'muse-01',
      status: vi.fn(async () => ({guilds: [{id: GUILD_ID, name: 'Guild'}]})),
      guildExport: vi.fn(async () => ({
        workerId: 'muse-01',
        guildId: GUILD_ID,
        settings: {guildId: GUILD_ID, defaultVolume: 80},
        favorites: [{name: 'Chill', query: 'lofi', authorId: USER_ID, createdAt: '2026-01-01T00:00:00.000Z'}],
      })),
      deleteGuildUserData: vi.fn(async () => ({workerId: 'muse-01', guildId: GUILD_ID, userId: MEMBER_ID, favorites: 2})),
      deleteUserData: vi.fn(async () => ({workerId: 'muse-01', userId: USER_ID, favorites: 2})),
    };
    const absent = {
      id: 'muse-02',
      status: vi.fn(async () => ({guilds: []})),
      guildExport: vi.fn(),
      deleteGuildUserData: vi.fn(),
      deleteUserData: vi.fn(async () => ({workerId: 'muse-02', userId: USER_ID, favorites: 0})),
    };
    const unreachable = {
      id: 'muse-03',
      status: vi.fn(async () => ({guilds: [{id: GUILD_ID, name: 'Guild'}]})),
      guildExport: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
      deleteGuildUserData: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
      deleteUserData: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    };
    return {present, absent, unreachable};
  };

  it('exports only the bots present in the server and lists the unreachable ones', async () => {
    const {present, absent, unreachable} = bots();
    const server = orchestratorWith([present, absent, unreachable]);

    const result = await server.guildExport(GUILD_ID);

    expect(absent.guildExport).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      guildId: GUILD_ID,
      workers: [{workerId: 'muse-01', favorites: [{name: 'Chill', authorId: USER_ID}]}],
      unavailableWorkers: ['muse-03'],
      groups: [],
      plan: {tier: 'FREE', billing: null, expiresAt: null},
      branding: {},
    });
    // Plan notes and coupons never reach the export.
    expect(JSON.stringify(result)).not.toMatch(/note|couponCode/u);
  });

  it('rejects a malformed guild id before contacting any bot', async () => {
    const {present} = bots();
    const server = orchestratorWith([present]);

    await expect(server.guildExport('not-a-guild')).rejects.toMatchObject({statusCode: 400});
    expect(present.status).not.toHaveBeenCalled();
  });

  it('removes one member\'s favorites only on the bots present in the server', async () => {
    const {present, absent, unreachable} = bots();
    const server = orchestratorWith([present, absent, unreachable]);

    const result = await server.deleteGuildUserData(GUILD_ID, MEMBER_ID);

    expect(absent.deleteGuildUserData).not.toHaveBeenCalled();
    expect(present.deleteGuildUserData).toHaveBeenCalledWith(GUILD_ID, MEMBER_ID);
    expect(result).toEqual({
      guildId: GUILD_ID,
      userId: MEMBER_ID,
      favorites: 2,
      workers: [{workerId: 'muse-01', favorites: 2}],
      failed: ['muse-03'],
    });
  });

  it('removes the signed-in user\'s favorites on every bot, including bots not in the server', async () => {
    const {present, absent, unreachable} = bots();
    const server = orchestratorWith([present, absent, unreachable]);

    const result = await server.deleteUserData(USER_ID);

    expect(present.deleteUserData).toHaveBeenCalledWith(USER_ID);
    expect(absent.deleteUserData).toHaveBeenCalledWith(USER_ID);
    expect(unreachable.deleteUserData).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({
      userId: USER_ID,
      favorites: 2,
      workers: [{workerId: 'muse-01', favorites: 2}, {workerId: 'muse-02', favorites: 0}],
      failed: ['muse-03'],
    });
  });
});

describe('worker data helpers', () => {
  beforeEach(() => {
    prismaMock.setting.findUnique.mockResolvedValue(null);
    prismaMock.favoriteQuery.findMany.mockResolvedValue([]);
  });

  it('exports settings without creating a row when the guild has none', async () => {
    prismaMock.favoriteQuery.findMany.mockResolvedValueOnce([
      {name: 'Chill', query: 'lofi', authorId: USER_ID, createdAt: new Date('2026-01-02T03:04:05.000Z')},
    ]);

    const data = await exportGuildData(GUILD_ID);

    expect(data).toEqual({
      settings: null,
      favorites: [{name: 'Chill', query: 'lofi', authorId: USER_ID, createdAt: '2026-01-02T03:04:05.000Z'}],
    });
    expect(prismaMock.setting.findUnique).toHaveBeenCalledWith({where: {guildId: GUILD_ID}});
    expect(prismaMock.favoriteQuery.findMany).toHaveBeenCalledWith(expect.objectContaining({where: {guildId: GUILD_ID}}));
  });

  it('deletes a user\'s favorites in one guild, or in every guild when no guild is given', async () => {
    prismaMock.favoriteQuery.deleteMany.mockResolvedValueOnce({count: 2});
    expect(await deleteFavoritesOfUser(USER_ID, GUILD_ID)).toBe(2);
    expect(prismaMock.favoriteQuery.deleteMany).toHaveBeenLastCalledWith({where: {authorId: USER_ID, guildId: GUILD_ID}});

    prismaMock.favoriteQuery.deleteMany.mockResolvedValueOnce({count: 5});
    expect(await deleteFavoritesOfUser(USER_ID)).toBe(5);
    expect(prismaMock.favoriteQuery.deleteMany).toHaveBeenLastCalledWith({where: {authorId: USER_ID}});
  });
});

describe('data retention selection', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  const old = now - RETENTION_MS - 1;
  const recent = now - RETENTION_MS;

  it('purges servers left for more than 30 days, and keeps the ones left more recently', () => {
    const plan = planRetention({
      now,
      currentGuildIds: new Set(),
      departures: new Map([['old', old], ['recent', recent]]),
      storedGuildIds: ['old', 'recent'],
    });

    expect(plan.purge).toEqual(['old']);
    expect(plan.markDeparted).toEqual([]);
    expect(plan.clearDeparture).toEqual([]);
  });

  it('never purges a server the bot is in, even with an old departure record', () => {
    const plan = planRetention({
      now,
      currentGuildIds: new Set(['back']),
      departures: new Map([['back', old]]),
      storedGuildIds: ['back'],
    });

    expect(plan.purge).toEqual([]);
    expect(plan.clearDeparture).toEqual(['back']);
  });

  it('starts the clock for stored servers without a departure record (pre-existing orphans)', () => {
    const plan = planRetention({
      now,
      currentGuildIds: new Set(['member']),
      departures: new Map(),
      storedGuildIds: ['orphan', 'orphan', 'member'],
    });

    expect(plan.markDeparted).toEqual(['orphan']);
    expect(plan.purge).toEqual([]);
  });

  it('does not mark servers that are only in the cache, or stored servers that already have a record', () => {
    const plan = planRetention({
      now,
      currentGuildIds: new Set(['cached']),
      departures: new Map([['tracked', now - 1000]]),
      storedGuildIds: ['tracked'],
    });

    expect(plan).toEqual({purge: [], markDeparted: [], clearDeparture: []});
  });

  it('deletes expired rows, records new orphans and drops returned servers in one transaction', async () => {
    prismaMock.guildDeparture.findMany.mockResolvedValueOnce([
      {guildId: 'old', leftAt: new Date(old)},
      {guildId: 'back', leftAt: new Date(now - 1000)},
    ]);
    prismaMock.setting.findMany.mockResolvedValueOnce([{guildId: 'old'}, {guildId: 'orphan'}]);
    prismaMock.favoriteQuery.findMany.mockResolvedValueOnce([{guildId: 'orphan'}]);
    const client = {guilds: {cache: new Map([['back', {}]])}} as unknown as Client;

    const plan = await sweepRetention(client, now);

    expect(plan).toEqual({purge: ['old'], markDeparted: ['orphan'], clearDeparture: ['back']});
    expect(prismaMock.guildDeparture.upsert).toHaveBeenCalledWith({
      where: {guildId: 'orphan'},
      create: {guildId: 'orphan', leftAt: new Date(now)},
      update: {},
    });
    expect(prismaMock.setting.deleteMany).toHaveBeenCalledWith({where: {guildId: {in: ['old']}}});
    expect(prismaMock.favoriteQuery.deleteMany).toHaveBeenCalledWith({where: {guildId: {in: ['old']}}});
    expect(prismaMock.guildDeparture.deleteMany).toHaveBeenCalledWith({where: {guildId: {in: ['back']}}});
    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
  });
});

describe('dashboard rate limiter', () => {
  it('allows the limit per window, then answers with a Retry-After in seconds', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({limit: 3, windowMs: 60_000, maxKeys: 10}, () => now);

    expect([limiter.consume('a'), limiter.consume('a'), limiter.consume('a')].every(decision => decision.allowed)).toBe(true);
    now = 20_000;
    expect(limiter.consume('a')).toEqual({allowed: false, retryAfterSeconds: 40});
    // Another key has its own budget.
    expect(limiter.consume('b')).toEqual({allowed: true});
    limiter.close();
  });

  it('resets the budget when the window ends', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({limit: 1, windowMs: 1000, maxKeys: 10}, () => now);

    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
    now = 1000;
    expect(limiter.consume('a').allowed).toBe(true);
    limiter.close();
  });

  it('keeps at most maxKeys windows and evicts the oldest first', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({limit: 1, windowMs: 60_000, maxKeys: 3}, () => now);

    for (let index = 0; index < 10; index++) {
      now += 1;
      limiter.consume(`key-${index}`);
    }

    expect(limiter.size).toBe(3);
    // The newest key is still inside its window and keeps its budget.
    expect(limiter.consume('key-9').allowed).toBe(false);
    // The oldest key was evicted, so it starts a new window.
    expect(limiter.consume('key-0').allowed).toBe(true);
    limiter.close();
  });

  it('prunes expired windows periodically', () => {
    vi.useFakeTimers();
    let now = 0;
    const limiter = new FixedWindowRateLimiter({limit: 1, windowMs: 60_000, maxKeys: 10}, () => now);
    limiter.consume('a');
    limiter.consume('b');
    expect(limiter.size).toBe(2);

    now = 60_000;
    vi.advanceTimersByTime(60_000);
    expect(limiter.size).toBe(0);
    limiter.close();
  });
});

describe('dashboard data routes', () => {
  const config = (): DashboardConfig => ({
    host: '127.0.0.1',
    port: 0,
    publicUrl: new URL(PUBLIC_URL),
    oauthRedirectUri: new URL('/auth/discord/callback', PUBLIC_URL).toString(),
    discordClientId: '123456789012345678',
    discordClientSecret: 'not-a-real-secret',
    orchestratorUrl: 'http://orchestrator:3100',
    orchestratorToken: 'not-a-real-token',
    sessionTtlMs: 8 * 60 * 60 * 1000,
  });

  const user = {id: USER_ID, username: 'member', global_name: null, avatar: null};

  const call = async (port: number, method: string, path: string, headers: Record<string, string> = {}) =>
    new Promise<{status: number; headers: Record<string, string | string[] | undefined>; body: string}>((resolve, reject) => {
      const outgoing = request({host: '127.0.0.1', port, method, path, headers}, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8')});
        });
        response.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.end();
    });

  const servers: DashboardServer[] = [];

  const startDashboard = async () => {
    const dashboardConfig = config();
    const store = new SessionStore(dashboardConfig.sessionTtlMs);
    const discord = {
      authorizationUrl: vi.fn(),
      exchangeCode: vi.fn(),
      currentUser: vi.fn(async () => user),
      currentUserGuilds: vi.fn(async () => [
        {id: GUILD_ID, name: 'Guild', icon: null, owner: true, permissions: '0'},
        {id: NOT_IN_MUSE_ID, name: 'Not in Muse', icon: null, owner: true, permissions: '0'},
        {id: FOREIGN_ID, name: 'Foreign', icon: null, owner: false, permissions: '0'},
      ]),
      revoke: vi.fn(async () => undefined),
    };
    const orchestrator = {
      guilds: vi.fn(async () => ({guilds: [{id: GUILD_ID, name: 'Guild', availableWorkers: 2}]})),
      guildExport: vi.fn(async () => ({
        guildId: GUILD_ID,
        workers: [{workerId: 'muse-01', guildId: GUILD_ID, settings: null, favorites: []}],
        unavailableWorkers: [],
        groups: [],
        plan: {tier: 'FREE', billing: null, expiresAt: null},
        branding: {},
      })),
      deleteGuildUserData: vi.fn(async () => ({favorites: 1, workers: [{workerId: 'muse-01', favorites: 1}], failed: []})),
      deleteUserData: vi.fn(async () => ({favorites: 3, workers: [{workerId: 'muse-01', favorites: 3}], failed: []})),
    };
    const auth = new DashboardAuth(dashboardConfig, {
      store,
      discord: discord as unknown as DiscordOAuthClient,
      isUserBlocked: vi.fn(async () => false),
    });
    const server = new DashboardServer(dashboardConfig, {auth, orchestrator: orchestrator as unknown as OrchestratorClient});
    await server.start();
    servers.push(server);

    const names = dashboardCookieNames(false);
    const session = store.createSession(user, 'discord-access-token', 3600);
    const headers = (overrides: Record<string, string> = {}): Record<string, string> => ({
      cookie: `${names.session}=${session.id}`,
      origin: PUBLIC_URL,
      'x-csrf-token': session.csrfToken,
      ...overrides,
    });

    return {port: server.port!, orchestrator, headers};
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async server => server.close()));
  });

  it('exports a manageable server as an attachment, after the same access check as the guild view', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const result = await call(dashboard.port, 'GET', `/api/guilds/${GUILD_ID}/export`, dashboard.headers());

    expect(result.status).toBe(200);
    expect(String(result.headers['content-disposition'])).toMatch(new RegExp(`^attachment; filename="muse-${GUILD_ID}-\\d{4}-\\d{2}-\\d{2}\\.json"$`, 'u'));
    expect(JSON.parse(result.body)).toMatchObject({guild: {id: GUILD_ID, name: 'Guild'}, plan: {tier: 'FREE'}});
    expect(dashboard.orchestrator.guildExport).toHaveBeenCalledWith(GUILD_ID);
  });

  it('refuses the export of a server the user cannot manage or Muse is not in', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const foreign = await call(dashboard.port, 'GET', `/api/guilds/${FOREIGN_ID}/export`, dashboard.headers());
    expect(foreign.status).toBe(403);

    const absent = await call(dashboard.port, 'GET', `/api/guilds/${NOT_IN_MUSE_ID}/export`, dashboard.headers());
    expect(absent.status).toBe(404);

    expect(dashboard.orchestrator.guildExport).not.toHaveBeenCalled();
  });

  it('lets a server admin remove one member\'s favorites after the CSRF and access checks', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();
    const path = `/api/guilds/${GUILD_ID}/privacy/user/${MEMBER_ID}`;

    const missingCsrf = await call(dashboard.port, 'DELETE', path, dashboard.headers({'x-csrf-token': ''}));
    expect(missingCsrf.status).toBe(403);
    expect(dashboard.orchestrator.deleteGuildUserData).not.toHaveBeenCalled();

    const foreign = await call(dashboard.port, 'DELETE', `/api/guilds/${FOREIGN_ID}/privacy/user/${MEMBER_ID}`, dashboard.headers());
    expect(foreign.status).toBe(403);

    const ok = await call(dashboard.port, 'DELETE', path, dashboard.headers());
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({favorites: 1});
    expect(dashboard.orchestrator.deleteGuildUserData).toHaveBeenCalledWith(GUILD_ID, MEMBER_ID);

    const invalid = await call(dashboard.port, 'DELETE', `/api/guilds/${GUILD_ID}/privacy/user/not-an-id`, dashboard.headers());
    expect(invalid.status).toBe(400);
  });

  it('deletes the signed-in user\'s own data with session, Origin and CSRF checks', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dashboard = await startDashboard();

    const anonymous = await call(dashboard.port, 'DELETE', '/api/me/data', {origin: PUBLIC_URL});
    expect(anonymous.status).toBe(401);

    const foreignOrigin = await call(dashboard.port, 'DELETE', '/api/me/data', dashboard.headers({origin: 'https://evil.example.test'}));
    expect(foreignOrigin.status).toBe(403);
    expect(dashboard.orchestrator.deleteUserData).not.toHaveBeenCalled();

    const ok = await call(dashboard.port, 'DELETE', '/api/me/data', dashboard.headers());
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({favorites: 3, failed: []});
    expect(dashboard.orchestrator.deleteUserData).toHaveBeenCalledWith(USER_ID);
  });

  it('answers 429 with RATE_LIMITED and Retry-After after 120 API requests a minute from one address', async () => {
    const dashboard = await startDashboard();

    const statuses: number[] = [];
    for (let index = 0; index < 121; index++) {
      statuses.push((await call(dashboard.port, 'GET', '/api/session')).status);
    }

    expect(statuses.slice(0, 120).every(status => status === 401)).toBe(true);
    const limited = await call(dashboard.port, 'GET', '/api/session');
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body)).toEqual({error: 'too many requests', code: 'RATE_LIMITED'});
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('does not limit static assets', async () => {
    const dashboard = await startDashboard();

    const statuses: number[] = [];
    for (let index = 0; index < 125; index++) {
      statuses.push((await call(dashboard.port, 'GET', '/assets/dashboard.css')).status);
    }

    expect(statuses.every(status => status === 200)).toBe(true);
  });
});
