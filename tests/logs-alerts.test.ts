import {createServer, type IncomingMessage, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ChannelType} from 'discord.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

// vi.mock factories are hoisted above every declaration, so the mocked modules are named inline.
vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: vi.fn(async (guildId: string) => ({guildId})),
}));

vi.mock('../src/control/guild-settings.js', () => ({
  sanitizeGuildSettingsPatch: vi.fn((patch: unknown) => patch),
  updateGuildSettings: vi.fn(async (guildId: string) => ({guildId})),
}));

import DashboardAuth, {dashboardCookieNames} from '../src/dashboard/auth.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import type DiscordOAuthClient from '../src/dashboard/discord-oauth.js';
import DashboardServer from '../src/dashboard/server.js';
import SessionStore from '../src/dashboard/session-store.js';
import {HttpError} from '../src/control/http.js';
import WorkerControlServer from '../src/control/worker-server.js';
import {
  STATUS_DOWN_COLOR,
  STATUS_ONLINE_COLOR,
  buildWorkerAlertEmbed,
  parseStatusAnnounceRequest,
  postStatusMessage,
} from '../src/status/announce.js';
import {PlatformSettingsStore} from '../src/orchestrator/platform-store.js';
import {PlanStore} from '../src/orchestrator/plan-store.js';
import SuperConsole from '../src/orchestrator/super-console.js';
import {AuditStore, BlockStore, SYSTEM_ACTOR} from '../src/orchestrator/super-store.js';
import {WorkerHealthTracker} from '../src/orchestrator/worker-health.js';
import WorkerClient from '../src/orchestrator/worker-client.js';
import {
  LogBuffer,
  installLogCapture,
  logBuffer,
  parseLogLimit,
  redactLogText,
  sanitizeLogEntries,
} from '../src/utils/log-buffer.js';

const token = 'c'.repeat(32);
const GUILD = '111111111111111111';
const CHANNEL = '987654321098765432';
const ROLE = '555555555555555551';
const BOT = '666666666666666666';
const ACTOR = {userId: '123456789012345678', username: 'Admin'};
// Assembled from parts so no token-shaped literal is committed (secret scanning).
const DISCORD_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabCde', 'abcdefghijklmnopqrstuvwxyz0123'].join('.');

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  logBuffer.clear();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** The error thrown by a validation helper, or undefined when nothing was thrown. */
const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }

  return undefined;
};

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-logs-alerts-'));
  cleanups.push(() => {
    rmSync(directory, {recursive: true, force: true});
  });
  return directory;
};

describe('log redaction', () => {
  it('hides Discord tokens, bearer tokens and authorization values', () => {
    expect(redactLogText(`login ${DISCORD_TOKEN} done`)).not.toContain(DISCORD_TOKEN);
    expect(redactLogText('Authorization: Bearer s3cret-value-123')).toBe('Authorization: [redacted]');
    expect(redactLogText('retry with Bearer abc123secret')).toBe('retry with Bearer [redacted]');
  });

  it('hides token, secret, password, cookie and key values, including JSON fields', () => {
    expect(redactLogText('password=hunter2 secret: s3cr3t')).toBe('password=[redacted] secret: [redacted]');
    expect(redactLogText('{"apiKey":"abc123","name":"x"}')).toBe('{"apiKey":"[redacted]","name":"x"}');
    expect(redactLogText('Cookie: session=abc; other=1')).toBe('Cookie: [redacted]');
  });

  it('drops URL query strings and leaves ordinary text alone', () => {
    expect(redactLogText('GET https://example.com/cb?code=abc&state=xyz failed')).toBe('GET https://example.com/cb?[redacted] failed');
    expect(redactLogText('Playback started in guild 111 (2 songs)')).toBe('Playback started in guild 111 (2 songs)');
  });

  it('is idempotent', () => {
    const once = redactLogText(`${DISCORD_TOKEN} password=x https://a.test/x?y=1`);
    expect(redactLogText(once)).toBe(once);
  });
});

describe('log buffer', () => {
  it('keeps the newest 1000 lines, oldest first, and truncates long messages to 2000 characters', () => {
    const buffer = new LogBuffer();
    for (let index = 0; index < 1005; index += 1) {
      buffer.record('info', `line ${index}`);
    }

    expect(buffer.size).toBe(1000);
    const entries = buffer.recent(1000);
    expect(entries).toHaveLength(1000);
    expect(entries[0].message).toBe('line 5');
    expect(entries[entries.length - 1].message).toBe('line 1004');

    buffer.record('error', 'x'.repeat(5000));
    const [last] = buffer.recent(1);
    expect(last).toMatchObject({level: 'error'});
    expect(last.message).toHaveLength(2000);
  });

  it('returns at most the requested number of lines and keeps a response size budget', () => {
    const buffer = new LogBuffer();
    for (let index = 0; index < 600; index += 1) {
      buffer.record('info', `${index} ${'y'.repeat(2000)}`);
    }

    expect(buffer.recent(3).map(entry => entry.message.slice(0, 4))).toEqual(['597 ', '598 ', '599 ']);
    const budgeted = buffer.recent(1000);
    expect(budgeted.length).toBeLessThan(600);
    expect(budgeted[budgeted.length - 1].message.slice(0, 4)).toBe('599 ');
  });

  it('prints as before, keeps a redacted copy and never wraps a console twice', () => {
    const printed: unknown[][] = [];
    const target = {
      debug: (...args: unknown[]) => printed.push(['debug', ...args]),
      info: (...args: unknown[]) => printed.push(['info', ...args]),
      log: (...args: unknown[]) => printed.push(['log', ...args]),
      warn: (...args: unknown[]) => printed.push(['warn', ...args]),
      error: (...args: unknown[]) => printed.push(['error', ...args]),
    } as unknown as Console;
    const buffer = new LogBuffer();

    installLogCapture(target, buffer);
    installLogCapture(target, buffer);
    target.log('hello', 'token=abc123');
    target.warn('careful');

    expect(printed).toEqual([['log', 'hello', 'token=abc123'], ['warn', 'careful']]);
    expect(buffer.recent()).toEqual([
      {at: expect.any(String), level: 'info', message: 'hello token=[redacted]'},
      {at: expect.any(String), level: 'warn', message: 'careful'},
    ]);
  });

  it('parses ?limit= with 200 as the default and 1 to 1000 as the range', () => {
    expect(parseLogLimit('/v1/logs')).toBe(200);
    expect(parseLogLimit('/v1/logs?limit=1')).toBe(1);
    expect(parseLogLimit('/v1/logs?limit=1000')).toBe(1000);
    for (const url of ['/v1/logs?limit=0', '/v1/logs?limit=1001', '/v1/logs?limit=ten', '/v1/logs?limit=-5']) {
      expect(thrownBy(() => parseLogLimit(url))).toMatchObject({statusCode: 400, code: 'INVALID_LIMIT'});
    }
  });

  it('re-validates entries from another process and drops malformed ones', () => {
    const at = new Date().toISOString();
    expect(sanitizeLogEntries([
      {at, level: 'warn', message: 'Bearer abc.def'},
      {at, level: 'loud', message: 'bad level'},
      'not an object',
      {at, level: 'info', message: 42},
      {at: 'yesterday', level: 'info', message: 'bad time'},
    ])).toEqual([{at, level: 'warn', message: 'Bearer [redacted]'}]);
    expect(sanitizeLogEntries({entries: 'nope'})).toEqual([]);
  });
});

describe('worker logs route', () => {
  const servers: WorkerControlServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  const startWorker = async (): Promise<number> => {
    const config = {WORKER_ID: 'muse-01', CONTROL_HOST: '127.0.0.1', CONTROL_PORT: 0, CONTROL_TOKEN: token};
    const client = {isReady: () => true, guilds: {cache: new Map()}, user: null};
    const server = new WorkerControlServer(config as never, client as never, {snapshot: () => []} as never);
    await server.start();
    servers.push(server);
    return ((server as unknown as {server: Server}).server.address() as AddressInfo).port;
  };

  it('serves the newest redacted lines to a caller with the control token only', async () => {
    logBuffer.record('info', 'first');
    logBuffer.record('warn', 'second token=abc');
    logBuffer.record('error', 'third');
    const port = await startWorker();
    const auth = {authorization: `Bearer ${token}`};

    const answer = await fetch(`http://127.0.0.1:${port}/v1/logs?limit=2`, {headers: auth});
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      workerId: 'muse-01',
      entries: [
        {at: expect.any(String), level: 'warn', message: 'second token=[redacted]'},
        {at: expect.any(String), level: 'error', message: 'third'},
      ],
    });

    expect((await fetch(`http://127.0.0.1:${port}/v1/logs`)).status).toBe(401);
    const invalid = await fetch(`http://127.0.0.1:${port}/v1/logs?limit=0`, {headers: auth});
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({error: 'limit must be a whole number from 1 to 1000', code: 'INVALID_LIMIT'});
  });
});

describe('orchestrator client for worker logs', () => {
  it('asks a bot for its logs with the bot control token and the limit', async () => {
    const seen: Array<{url?: string; authorization?: string}> = [];
    const server = createServer((request, response) => {
      seen.push({url: request.url, authorization: request.headers.authorization});
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({workerId: 'muse-01', entries: []}));
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    cleanups.push(async () => new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
    }));

    const {port} = server.address() as AddressInfo;
    const client = new WorkerClient({id: 'muse-01', baseUrl: `http://127.0.0.1:${port}`, token});
    expect(await client.logs(25)).toEqual({workerId: 'muse-01', entries: []});
    expect(seen).toEqual([{url: '/v1/logs?limit=25', authorization: `Bearer ${token}`}]);
  });
});

/** A bot as the super console sees it: only the methods the logs route uses. */
const logBot = (id: string, logs: (limit: number) => Promise<unknown>) => ({id, logs: vi.fn(logs)});

const makeConsole = (workers: unknown[]) => {
  const directory = temporaryDirectory();
  const platform = new PlatformSettingsStore(path.join(directory, 'platform-settings.json'));
  const audit = new AuditStore(path.join(directory, 'super-audit.json'));
  const superConsole = new SuperConsole(
    workers as WorkerClient[],
    new BlockStore(path.join(directory, 'blocks.json')),
    audit,
    platform,
    new PlanStore(path.join(directory, 'plans.json')),
  );
  return {superConsole, platform, audit};
};

const logsRoute = async (superConsole: SuperConsole, workerId: string, query = '') => superConsole.route(
  {method: 'GET', url: `/v1/super/workers/${workerId}/logs${query}`} as unknown as IncomingMessage,
  ['v1', 'super', 'workers', workerId, 'logs'],
);

describe('orchestrator worker logs', () => {
  it('returns the orchestrator own buffer under the orchestrator id, redacted', async () => {
    logBuffer.record('error', 'boom password=hunter2');
    const {superConsole} = makeConsole([]);
    const result = await logsRoute(superConsole, 'orchestrator');
    expect(result).toEqual({
      statusCode: 200,
      body: {workerId: 'orchestrator', entries: [{at: expect.any(String), level: 'error', message: 'boom password=[redacted]'}]},
    });
  });

  it('proxies a bot\'s logs with the requested limit, re-redacting its lines', async () => {
    const bot = logBot('muse-01', async () => ({
      workerId: 'muse-01',
      entries: [
        {at: '2026-10-19T10:00:00.000Z', level: 'info', message: 'ready'},
        {at: '2026-10-19T10:00:01.000Z', level: 'warn', message: 'Authorization: Bearer abc.def.ghi'},
      ],
    }));
    const {superConsole} = makeConsole([bot]);
    const result = await logsRoute(superConsole, 'muse-01', '?limit=50');
    expect(bot.logs).toHaveBeenCalledWith(50);
    expect(result?.body).toEqual({
      workerId: 'muse-01',
      entries: [
        {at: '2026-10-19T10:00:00.000Z', level: 'info', message: 'ready'},
        {at: '2026-10-19T10:00:01.000Z', level: 'warn', message: 'Authorization: [redacted]'},
      ],
    });
  });

  it('answers 404 WORKER_NOT_FOUND for an unknown bot and 503 WORKER_UNAVAILABLE for one that does not answer', async () => {
    const bot = logBot('muse-01', async () => {
      throw Object.assign(new Error('timeout'), {name: 'TimeoutError'});
    });
    const {superConsole} = makeConsole([bot]);
    await expect(logsRoute(superConsole, 'muse-09')).rejects.toMatchObject({statusCode: 404, code: 'WORKER_NOT_FOUND'});
    await expect(logsRoute(superConsole, 'muse-01')).rejects.toBeInstanceOf(HttpError);
    await expect(logsRoute(superConsole, 'muse-01')).rejects.toMatchObject({statusCode: 503, code: 'WORKER_UNAVAILABLE'});
    await expect(logsRoute(superConsole, 'muse-01', '?limit=5000')).rejects.toMatchObject({statusCode: 400, code: 'INVALID_LIMIT'});
  });
});

/** A bot for the reconcile loop: `healthy` decides whether its status call answers with Discord ready. */
const alertBot = (id: string, healthy: boolean) => {
  const bot = {
    id,
    healthy,
    status: vi.fn(async () => {
      if (!bot.healthy) {
        throw Object.assign(new Error('unreachable'), {name: 'RequestError'});
      }

      return {
        workerId: id,
        discordReady: true,
        bot: {id: BOT, username: `Bot ${id}`, avatarUrl: null},
        guilds: [{id: GUILD, name: 'Guild'}],
        players: [],
        uptimeSeconds: 60,
      };
    }),
    pushBlocklist: vi.fn(async () => ({workerId: id, left: [], failed: []})),
    pushEntitlements: vi.fn(async () => ({workerId: id})),
    announceStatus: vi.fn(async () => ({workerId: id, ok: true})),
  };
  return bot;
};

describe('worker health tracker', () => {
  it('reports a healthy bot down after two failed checks and recovered when it answers again', () => {
    const tracker = new WorkerHealthTracker();
    expect(tracker.observe([{workerId: 'muse-01', healthy: false}], 't0')).toEqual([]);
    expect(tracker.observe([{workerId: 'muse-01', healthy: true}], 't1')).toEqual([]);
    expect(tracker.observe([{workerId: 'muse-01', healthy: false}], 't2')).toEqual([]);
    expect(tracker.observe([{workerId: 'muse-01', healthy: false}], 't3')).toEqual([{type: 'down', workerId: 'muse-01', since: 't2'}]);
    expect(tracker.downSince('muse-01')).toBe('t2');
    expect(tracker.observe([{workerId: 'muse-01', healthy: false}], 't4')).toEqual([]);
    expect(tracker.observe([{workerId: 'muse-01', healthy: true}], 't5')).toEqual([{type: 'recovered', workerId: 'muse-01', since: 't2'}]);
    expect(tracker.downSince('muse-01')).toBeNull();
  });

  it('never alerts for a bot that was not healthy since start, nor for a single failed check', () => {
    const tracker = new WorkerHealthTracker();
    expect(tracker.observe([{workerId: 'muse-02', healthy: false}, {workerId: 'muse-03', healthy: true}], 't0')).toEqual([]);
    expect(tracker.observe([{workerId: 'muse-02', healthy: false}, {workerId: 'muse-03', healthy: false}], 't1')).toEqual([]);
    expect(tracker.downSince('muse-02')).toBeNull();
    expect(tracker.observe([{workerId: 'muse-03', healthy: false}], 't2')).toEqual([]);
    expect(tracker.observe([{workerId: 'muse-03', healthy: true}], 't3')).toEqual([]);
  });
});

describe('health alerts', () => {
  it('alerts the status channel once when a healthy bot goes down, then once when it is back', async () => {
    // Order matters: the first healthy bot of the status server posts the alert.
    const never = alertBot('muse-03', false);
    const two = alertBot('muse-02', true);
    const one = alertBot('muse-01', true);
    const {superConsole, platform, audit} = makeConsole([never, two, one]);
    platform.setStatusChannel(GUILD, CHANNEL, [ROLE], ACTOR);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await superConsole.reconcile();
    expect(audit.list()).toEqual([]);

    one.healthy = false;
    await superConsole.reconcile();
    expect(two.announceStatus).not.toHaveBeenCalled();

    await superConsole.reconcile();
    expect(two.announceStatus).toHaveBeenCalledTimes(1);
    expect(two.announceStatus.mock.calls[0][0]).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
      test: false,
      mentionRoleIds: [ROLE],
      kind: 'worker-down',
      worker: {workerId: 'muse-01', botName: 'Bot muse-01', since: expect.any(String)},
    });
    expect(audit.list()).toEqual([expect.objectContaining({
      action: 'worker.down',
      subjectType: 'WORKER',
      subjectId: 'muse-01',
      actor: SYSTEM_ACTOR,
      outcome: 'ok',
      details: expect.objectContaining({notified: true, postedBy: 'muse-02'}),
    })]);

    await superConsole.reconcile();
    expect(two.announceStatus).toHaveBeenCalledTimes(1);
    const during = await superConsole.overview();
    expect(during.workers.find(worker => worker.id === 'muse-01')?.downSince).toEqual(expect.any(String));
    expect(during.workers.find(worker => worker.id === 'muse-02')?.downSince).toBeNull();

    one.healthy = true;
    await superConsole.reconcile();
    expect(two.announceStatus).toHaveBeenCalledTimes(2);
    expect(two.announceStatus.mock.calls[1][0]).toMatchObject({kind: 'worker-recovered', test: false, worker: {workerId: 'muse-01'}});
    expect(audit.list()[0]).toMatchObject({
      action: 'worker.recovered',
      subjectId: 'muse-01',
      details: {notified: true, postedBy: 'muse-02', downtimeSeconds: expect.any(Number)},
    });

    // The bot that was never healthy stayed silent for the whole run.
    expect(never.announceStatus).not.toHaveBeenCalled();
    expect(audit.list().map(entry => entry.subjectId)).not.toContain('muse-03');
    expect((await superConsole.overview()).workers.find(worker => worker.id === 'muse-01')?.downSince).toBeNull();
  });

  it('only audits when no status channel is configured, and records a failed post as failed', async () => {
    const two = alertBot('muse-02', true);
    const one = alertBot('muse-01', true);
    const {superConsole, platform, audit} = makeConsole([two, one]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await superConsole.reconcile();
    one.healthy = false;
    await superConsole.reconcile();
    await superConsole.reconcile();
    expect(two.announceStatus).not.toHaveBeenCalled();
    expect(audit.list()).toEqual([expect.objectContaining({
      action: 'worker.down',
      subjectId: 'muse-01',
      outcome: 'ok',
      details: expect.objectContaining({notified: false, reason: 'NO_STATUS_CHANNEL'}),
    })]);

    platform.setStatusChannel(GUILD, CHANNEL, [], ACTOR);
    two.announceStatus.mockResolvedValueOnce({workerId: 'muse-02', ok: false, error: 'MISSING_PERMISSIONS'});
    one.healthy = true;
    await superConsole.reconcile();
    expect(audit.list()[0]).toMatchObject({
      action: 'worker.recovered',
      outcome: 'failed',
      details: {notified: false, error: 'MISSING_PERMISSIONS', postedBy: 'muse-02'},
    });
  });
});

describe('worker alert messages', () => {
  const since = '2026-10-19T10:00:00.000Z';

  it('validates the alert fields of an announce request', () => {
    const valid = {
      guildId: GUILD,
      channelId: CHANNEL,
      test: false,
      mentionRoleIds: [ROLE],
      kind: 'worker-down',
      worker: {workerId: 'muse-01', botName: 'Muse One', since},
    };
    expect(parseStatusAnnounceRequest(valid)).toEqual(valid);
    for (const bad of [
      {...valid, kind: 'worker-sleeping'},
      {...valid, test: true},
      {...valid, worker: undefined},
      {...valid, worker: {...valid.worker, workerId: 'MUSE 1'}},
      {...valid, worker: {...valid.worker, since: 'soon'}},
    ]) {
      expect(thrownBy(() => parseStatusAnnounceRequest(bad))).toMatchObject({statusCode: 400, code: 'INVALID_BODY'});
    }
  });

  it('colors and words the alerts, and only the down alert pings the configured roles', async () => {
    const worker = {workerId: 'muse-01', botName: 'Muse One', since};
    const down = buildWorkerAlertEmbed({kind: 'worker-down', worker, locale: 'en', now: new Date(since), footer: 'music.example.test'}).toJSON();
    expect(down).toMatchObject({color: STATUS_DOWN_COLOR, title: 'Bot offline'});
    expect(down.fields?.[1]).toMatchObject({name: 'Down since', value: `<t:${Math.floor(Date.parse(since) / 1000)}:t>`});

    const recovered = buildWorkerAlertEmbed({kind: 'worker-recovered', worker, locale: 'it', now: new Date(since), footer: 'music.example.test'}).toJSON();
    expect(recovered).toMatchObject({color: STATUS_ONLINE_COLOR, title: 'Bot di nuovo online'});

    const send = vi.fn(async () => ({id: 'message'}));
    const channel = {
      id: CHANNEL,
      type: ChannelType.GuildText,
      guild: {id: GUILD, members: {me: {id: BOT}}},
      permissionsFor: () => ({has: () => true}),
      send,
    };
    const client = {
      isReady: () => true,
      user: {id: BOT, username: 'Muse Two', tag: 'Muse Two#0001'},
      guilds: {cache: new Map([[GUILD, {id: GUILD}]])},
      channels: {fetch: vi.fn(async () => channel)},
    };
    const base = {guildId: GUILD, channelId: CHANNEL, test: false, mentionRoleIds: [ROLE], workerId: 'muse-02'};

    expect(await postStatusMessage(client as never, {...base, kind: 'worker-down', worker}, async () => 'en')).toEqual({ok: true});
    expect(send.mock.calls[0][0]).toMatchObject({content: `<@&${ROLE}>`, allowedMentions: {parse: [], roles: [ROLE]}});

    expect(await postStatusMessage(client as never, {...base, kind: 'worker-recovered', worker}, async () => 'en')).toEqual({ok: true});
    expect(send.mock.calls[1][0]).not.toHaveProperty('content');
    expect(send.mock.calls[1][0]).toMatchObject({allowedMentions: {parse: [], roles: []}});
  });
});

describe('dashboard worker logs route', () => {
  const SUPER_ADMIN_ID = '333333333333333333';
  const regularUser = {id: '222222222222222222', username: 'admin', global_name: null, avatar: null};
  const superUser = {id: SUPER_ADMIN_ID, username: 'haxurus', global_name: 'Haxurus', avatar: null};
  const config: DashboardConfig = {
    host: '127.0.0.1',
    port: 0,
    publicUrl: new URL('https://music.example.test'),
    oauthRedirectUri: 'https://music.example.test/auth/discord/callback',
    discordClientId: '123456789012345678',
    discordClientSecret: 'not-a-real-secret',
    orchestratorUrl: 'http://orchestrator:3100',
    orchestratorToken: 'not-a-real-token',
    sessionTtlMs: 8 * 60 * 60 * 1000,
    superAdminUserId: SUPER_ADMIN_ID,
  };

  const startDashboard = async () => {
    const store = new SessionStore(config.sessionTtlMs);
    const auth = new DashboardAuth(config, {
      store,
      discord: {} as unknown as DiscordOAuthClient,
      isUserBlocked: async () => false,
    });
    const orchestrator = {
      superWorkerLogs: vi.fn(async (workerId: string) => ({workerId, entries: []})),
    };
    const server = new DashboardServer(config, {auth, orchestrator: orchestrator as never});
    await server.start();
    cleanups.push(async () => server.close());
    const names = dashboardCookieNames(true);
    const cookieFor = (session: {id: string}) => `${names.session}=${session.id}`;
    return {
      port: server.port!,
      orchestrator,
      superCookie: cookieFor(store.createSession(superUser, 'discord-access-token', 3600)),
      userCookie: cookieFor(store.createSession(regularUser, 'discord-access-token', 3600)),
    };
  };

  it('requires a session and the super admin, and validates the log source and limit', async () => {
    const {port, orchestrator, superCookie, userCookie} = await startDashboard();
    const get = async (pathname: string, cookie?: string) => fetch(`http://127.0.0.1:${port}${pathname}`, {
      headers: cookie === undefined ? {} : {cookie},
    });

    expect((await get('/api/super/workers/muse-01/logs?limit=5')).status).toBe(401);

    const regular = await get('/api/super/workers/muse-01/logs?limit=5', userCookie);
    expect(regular.status).toBe(403);
    expect(await regular.json()).toMatchObject({code: 'SUPER_ADMIN_REQUIRED'});
    expect(orchestrator.superWorkerLogs).not.toHaveBeenCalled();

    const bot = await get('/api/super/workers/muse-01/logs?limit=5', superCookie);
    expect(bot.status).toBe(200);
    expect(orchestrator.superWorkerLogs).toHaveBeenLastCalledWith('muse-01', 5);

    const orchestratorLogs = await get('/api/super/workers/orchestrator/logs', superCookie);
    expect(orchestratorLogs.status).toBe(200);
    expect(orchestrator.superWorkerLogs).toHaveBeenLastCalledWith('orchestrator', 200);

    expect((await get('/api/super/workers/bogus/logs', superCookie)).status).toBe(400);
    expect((await get('/api/super/workers/muse-01/logs?limit=0', superCookie)).status).toBe(400);
  });
});
