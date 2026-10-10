import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

// The worker announce helpers pulled in by the config client read guild settings through
// Prisma/Config; the orchestrator tests never post, so stub that path out.
vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: vi.fn(async (guildId: string) => ({guildId, locale: 'en'})),
}));
import OrchestratorServer from '../src/orchestrator/server.js';
import {PlatformSettingsStore} from '../src/orchestrator/platform-store.js';
import {loadOrchestratorConfig} from '../src/orchestrator/config.js';
import {fetchWorkerPlatformConfig} from '../src/status/startup-announcer.js';

const apiToken = 'a'.repeat(32);
const actorId = '123456789012345678';
const guildId = '111111111111111111';
const otherGuildId = '222222222222222222';
const channelId = '987654321098765432';
const otherChannelId = '876543210987654321';
const roleA = '555555555555555551';
const roleB = '555555555555555552';

type Recorded = {method: string; url: string; authorization?: string; body: unknown};

type FakeWorker = {
  id: string;
  token: string;
  baseUrl: string;
  requests: Recorded[];
  down: boolean;
  /** Body answered to POST /v1/status-channel/announce. */
  announce: unknown;
  /** Guilds this fake bot is a member of. */
  guilds: string[];
  server: Server;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const tempDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-status-channel-'));
  cleanups.push(() => {
    rmSync(directory, {recursive: true, force: true});
  });
  return directory;
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(body));
};

const guildMeta = (workerId: string, metaGuildId: string) => ({
  workerId,
  guildId: metaGuildId,
  channels: [
    {id: channelId, name: 'bot-log', type: 'text', parentName: 'Staff', position: 0, canPost: true},
    {id: otherChannelId, name: 'news', type: 'announcement', parentName: null, position: 1, canPost: workerId === 'muse-01'},
  ],
  roles: [
    {id: roleA, name: 'Admin', color: 0, mentionable: true, position: 2},
    {id: roleB, name: 'Staff', color: 16_711_680, mentionable: false, position: 1},
  ],
});

const META_PATH = /^\/v1\/guilds\/(\d+)\/meta$/u;

const startFakeWorker = async (id: string, announce: unknown = {workerId: id, ok: true}): Promise<FakeWorker> => {
  const worker = {id, token: `${id}-`.padEnd(32, 't'), requests: [] as Recorded[], down: false, announce, guilds: [guildId]} as FakeWorker;
  worker.server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      worker.requests.push({method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization, body});
      if (worker.down || request.headers.authorization !== `Bearer ${worker.token}`) {
        json(response, worker.down ? 503 : 401, {error: 'unavailable'});
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/status') {
        json(response, 200, {
          workerId: id,
          discordReady: true,
          bot: {id: '900000000000000001', username: id},
          guilds: worker.guilds.map(memberGuildId => ({id: memberGuildId, name: `Guild ${memberGuildId}`})),
          players: [],
          uptimeSeconds: 1,
        });
        return;
      }

      const meta = META_PATH.exec(request.url ?? '');
      if (request.method === 'GET' && meta) {
        if (worker.guilds.includes(meta[1])) {
          json(response, 200, guildMeta(id, meta[1]));
        } else {
          json(response, 404, {error: 'worker is not a member of that guild', code: 'NOT_IN_GUILD'});
        }

        return;
      }

      if (request.method === 'PUT' && request.url === '/v1/blocklist') {
        json(response, 200, {workerId: id, left: [], failed: []});
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/status-channel/announce') {
        json(response, 200, worker.announce);
        return;
      }

      json(response, 404, {error: 'not found'});
    })();
  });
  await new Promise<void>(resolve => {
    worker.server.listen(0, '127.0.0.1', resolve);
  });
  worker.baseUrl = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  cleanups.push(async () => new Promise<void>(resolve => {
    worker.server.close(() => {
      resolve();
    });
  }));
  return worker;
};

const startOrchestrator = async (workers: FakeWorker[], directory = tempDirectory()) => {
  const server = new OrchestratorServer({
    host: '127.0.0.1',
    port: 0,
    apiToken,
    groupsFile: path.join(directory, 'groups.json'),
    blocksFile: path.join(directory, 'blocks.json'),
    auditFile: path.join(directory, 'super-audit.json'),
    platformFile: path.join(directory, 'platform-settings.json'),
    workers: workers.map(worker => ({id: worker.id, baseUrl: worker.baseUrl, token: worker.token})),
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await server.start();
  cleanups.push(async () => server.close());

  const {port} = (server as unknown as {server: Server}).server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const call = async (method: string, url: string, options: {body?: unknown; headers?: Record<string, string>; token?: string | null} = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(options.token === null ? {} : {authorization: `Bearer ${options.token ?? apiToken}`}),
        ...(options.body === undefined ? {} : {'content-type': 'application/json'}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return {status: response.status, body: await response.json() as Record<string, any>};
  };

  return {server, call, directory, baseUrl};
};

const actor = (name = 'Admin'): Record<string, string> => ({'x-muse-actor-id': actorId, 'x-muse-actor-name': name});

const announces = (worker: FakeWorker) => worker.requests.filter(request => request.url === '/v1/status-channel/announce');

describe('platform settings store', () => {
  it('starts disabled, persists the status channel and survives a reload', () => {
    const filePath = path.join(tempDirectory(), 'platform-settings.json');
    const store = new PlatformSettingsStore(filePath);
    expect(store.statusChannel()).toEqual({statusGuildId: null, statusChannelId: null, mentionRoleIds: [], updatedAt: null, updatedBy: null});

    const saved = store.setStatusChannel(guildId, channelId, [roleA, roleB], {userId: actorId, username: 'Admin'});
    expect(saved).toEqual({
      statusGuildId: guildId,
      statusChannelId: channelId,
      mentionRoleIds: [roleA, roleB],
      updatedAt: expect.any(String),
      updatedBy: {userId: actorId, username: 'Admin'},
    });
    expect(new PlatformSettingsStore(filePath).statusChannel()).toEqual(saved);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({version: 1, statusChannel: saved});

    // Disabling clears the server too.
    store.setStatusChannel(guildId, null, [], {userId: actorId, username: 'Admin'});
    expect(new PlatformSettingsStore(filePath).statusChannel()).toMatchObject({statusGuildId: null, statusChannelId: null, mentionRoleIds: []});
  });

  it('reads a file without server or role mentions as legacy values and rejects invalid ones', () => {
    const filePath = path.join(tempDirectory(), 'platform-settings.json');
    writeFileSync(filePath, JSON.stringify({version: 1, statusChannel: {statusChannelId: channelId, updatedAt: null, updatedBy: null}}));
    expect(new PlatformSettingsStore(filePath).statusChannel()).toEqual({statusGuildId: null, statusChannelId: channelId, mentionRoleIds: [], updatedAt: null, updatedBy: null});

    const badGuild = path.join(tempDirectory(), 'platform-settings.json');
    writeFileSync(badGuild, JSON.stringify({version: 1, statusChannel: {statusGuildId: 'nope', statusChannelId: channelId, updatedAt: null, updatedBy: null}}));
    expect(() => new PlatformSettingsStore(badGuild)).toThrow(/invalid schema/);

    for (const mentionRoleIds of [['nope'], [roleA, roleA], Array.from({length: 11}, (_, index) => `5555555555555555${String(index).padStart(2, '0')}`)]) {
      const other = path.join(tempDirectory(), 'platform-settings.json');
      writeFileSync(other, JSON.stringify({version: 1, statusChannel: {statusChannelId: channelId, mentionRoleIds, updatedAt: null, updatedBy: null}}));
      expect(() => new PlatformSettingsStore(other)).toThrow(/invalid schema/);
    }
  });

  it('recovers from the backup and refuses an invalid file without one', () => {
    const filePath = path.join(tempDirectory(), 'platform-settings.json');
    const store = new PlatformSettingsStore(filePath);
    store.setStatusChannel(guildId, channelId, [], {userId: actorId, username: 'Admin'});
    store.setStatusChannel(guildId, otherChannelId, [], {userId: actorId, username: 'Admin'});
    writeFileSync(filePath, JSON.stringify({version: 1, statusChannel: {statusChannelId: 'nope', updatedAt: null, updatedBy: null}}));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(new PlatformSettingsStore(filePath).statusChannel().statusChannelId).toBe(channelId);

    const other = path.join(tempDirectory(), 'platform-settings.json');
    writeFileSync(other, '{"version": 2}');
    expect(() => new PlatformSettingsStore(other)).toThrow(/invalid schema/);
  });

  it('is stored under /state, distinct from the other state files', () => {
    vi.stubEnv('MUSE_ORCHESTRATOR_TOKEN_FILE', '/run/secrets/orchestrator_api_token');
    vi.stubEnv('MUSE_ORCHESTRATOR_PLATFORM_FILE', '/tmp/platform-settings.json');
    expect(() => loadOrchestratorConfig()).toThrow(/MUSE_ORCHESTRATOR_PLATFORM_FILE must be stored under \/state/);

    vi.stubEnv('MUSE_ORCHESTRATOR_PLATFORM_FILE', '/state/super-audit.json');
    expect(() => loadOrchestratorConfig()).toThrow(/must be distinct/);
  });
});

describe('super console status channel API', () => {
  it('requires the orchestrator API token', async () => {
    const one = await startFakeWorker('muse-01');
    const {call} = await startOrchestrator([one]);
    for (const [method, url] of [
      ['GET', '/v1/super/status-channel'],
      ['GET', `/v1/super/guilds/${guildId}/meta`],
      ['PUT', '/v1/super/status-channel'],
      ['POST', '/v1/super/status-channel/test'],
    ]) {
      expect((await call(method, url, {token: null, headers: actor(), ...(method === 'GET' ? {} : {body: {guildId, channelId}})})).status).toBe(401);
      expect((await call(method, url, {token: one.token, headers: actor(), ...(method === 'GET' ? {} : {body: {guildId, channelId}})})).status).toBe(401);
    }

    expect(announces(one)).toEqual([]);
  });

  it('starts disabled and reports the setting in the overview', async () => {
    const one = await startFakeWorker('muse-01');
    const {call} = await startOrchestrator([one]);
    const disabled = {statusGuildId: null, statusChannelId: null, mentionRoleIds: [], updatedAt: null, updatedBy: null};
    expect(await call('GET', '/v1/super/status-channel')).toEqual({status: 200, body: disabled});
    expect((await call('GET', '/v1/super/overview')).body.statusChannel).toEqual(disabled);
  });

  it.each([
    ['a missing channelId', {guildId}, 400, 'INVALID_CHANNEL_ID'],
    ['a malformed channelId', {guildId, channelId: '12ab'}, 400, 'INVALID_CHANNEL_ID'],
    ['a numeric channelId', {guildId, channelId: 987_654_321_098_765}, 400, 'INVALID_CHANNEL_ID'],
    ['a missing guildId', {channelId}, 400, 'INVALID_GUILD_ID'],
    ['a malformed guildId', {guildId: 'guild', channelId}, 400, 'INVALID_GUILD_ID'],
    ['an array body', [channelId], 400, 'INVALID_BODY'],
    ['role ids that are not an array', {guildId, channelId, mentionRoleIds: roleA}, 400, 'INVALID_ROLE_IDS'],
    ['a malformed role id', {guildId, channelId, mentionRoleIds: [roleA, '@everyone']}, 400, 'INVALID_ROLE_IDS'],
    ['a numeric role id', {guildId, channelId, mentionRoleIds: [555_555_555_555_555]}, 400, 'INVALID_ROLE_IDS'],
    ['more than 10 roles', {guildId, channelId, mentionRoleIds: Array.from({length: 11}, (_, index) => `5555555555555555${String(index).padStart(2, '0')}`)}, 400, 'INVALID_ROLE_IDS'],
    ['a channel of another server', {guildId, channelId: '333333333333333333'}, 400, 'INVALID_STATUS_CHANNEL'],
    ['a role of another server', {guildId, channelId, mentionRoleIds: ['444444444444444444']}, 400, 'INVALID_STATUS_ROLES'],
    ['a server without bots', {guildId: otherGuildId, channelId}, 404, 'NOT_IN_GUILD'],
  ])('rejects %s without saving or auditing', async (_label, body, status, code) => {
    const one = await startFakeWorker('muse-01');
    const {call, directory} = await startOrchestrator([one]);
    const result = await call('PUT', '/v1/super/status-channel', {headers: actor(), body});
    expect(result.status).toBe(status);
    expect(result.body.code).toBe(code);
    expect(() => readFileSync(path.join(directory, 'platform-settings.json'))).toThrow();
    expect((await call('GET', '/v1/super/overview')).body.audit).toEqual([]);
  });

  it('requires the actor on mutations', async () => {
    const one = await startFakeWorker('muse-01');
    const {call} = await startOrchestrator([one]);
    expect((await call('PUT', '/v1/super/status-channel', {body: {guildId, channelId}})).body.code).toBe('INVALID_ACTOR');
    expect((await call('POST', '/v1/super/status-channel/test')).body.code).toBe('INVALID_ACTOR');
  });

  it('saves, clears and audits the status channel durably', async () => {
    const one = await startFakeWorker('muse-01');
    const {call, directory} = await startOrchestrator([one]);

    const saved = await call('PUT', '/v1/super/status-channel', {headers: actor(encodeURIComponent('Alessio 🎧')), body: {guildId, channelId}});
    expect(saved).toEqual({status: 200, body: {
      statusGuildId: guildId,
      statusChannelId: channelId,
      mentionRoleIds: [],
      updatedAt: expect.any(String),
      updatedBy: {userId: actorId, username: 'Alessio 🎧'},
    }});
    expect(await call('GET', '/v1/super/status-channel')).toEqual({status: 200, body: saved.body});
    expect((await call('GET', '/v1/super/overview')).body.statusChannel).toEqual(saved.body);
    expect(JSON.parse(readFileSync(path.join(directory, 'platform-settings.json'), 'utf8')).statusChannel).toEqual(saved.body);

    const cleared = await call('PUT', '/v1/super/status-channel', {headers: actor(), body: {channelId: null}});
    expect(cleared.body).toMatchObject({statusGuildId: null, statusChannelId: null, updatedBy: {userId: actorId, username: 'Admin'}});

    const {body} = await call('GET', '/v1/super/overview');
    expect(body.audit).toEqual([
      expect.objectContaining({
        action: 'status_channel.clear',
        subjectType: 'CHANNEL',
        subjectId: channelId,
        details: {previousGuildId: guildId, previousChannelId: channelId, statusGuildId: null, statusChannelId: null, mentionRoleCount: 0},
        outcome: 'ok',
      }),
      expect.objectContaining({
        action: 'status_channel.set',
        subjectType: 'CHANNEL',
        subjectId: channelId,
        actor: {userId: actorId, username: 'Alessio 🎧'},
        details: {previousGuildId: null, previousChannelId: null, statusGuildId: guildId, statusChannelId: channelId, mentionRoleCount: 0},
        outcome: 'ok',
      }),
    ]);
    // Saving never contacts the workers.
    expect(announces(one)).toEqual([]);
  });

  it('stores deduplicated role mentions, keeps them within the same server and clears them with []', async () => {
    const one = await startFakeWorker('muse-01');
    one.guilds = [guildId, otherGuildId];
    const {call} = await startOrchestrator([one]);

    const saved = await call('PUT', '/v1/super/status-channel', {headers: actor(), body: {guildId, channelId, mentionRoleIds: [roleA, roleB, roleA]}});
    expect(saved.status).toBe(200);
    expect(saved.body.mentionRoleIds).toEqual([roleA, roleB]);
    expect((await call('GET', '/v1/super/overview')).body.audit[0].details).toEqual({
      previousGuildId: null,
      previousChannelId: null,
      statusGuildId: guildId,
      statusChannelId: channelId,
      mentionRoleCount: 2,
    });

    // Omitted: the roles are kept for another channel of the same server...
    const moved = await call('PUT', '/v1/super/status-channel', {headers: actor(), body: {guildId, channelId: otherChannelId}});
    expect(moved.body).toMatchObject({statusGuildId: guildId, statusChannelId: otherChannelId, mentionRoleIds: [roleA, roleB]});
    // ...but never carried over to another server, whose roles are different.
    const elsewhere = await call('PUT', '/v1/super/status-channel', {headers: actor(), body: {guildId: otherGuildId, channelId}});
    expect(elsewhere.body).toMatchObject({statusGuildId: otherGuildId, statusChannelId: channelId, mentionRoleIds: []});

    await call('PUT', '/v1/super/status-channel', {headers: actor(), body: {guildId, channelId, mentionRoleIds: [roleA]}});
    const cleared = await call('PUT', '/v1/super/status-channel', {headers: actor(), body: {guildId, channelId, mentionRoleIds: []}});
    expect(cleared.body).toMatchObject({statusChannelId: channelId, mentionRoleIds: []});
    expect((await call('GET', '/v1/super/overview')).body.audit[0].details.mentionRoleCount).toBe(0);
  });

  it('keeps the setting across an orchestrator restart', async () => {
    const one = await startFakeWorker('muse-01');
    const first = await startOrchestrator([one]);
    await first.call('PUT', '/v1/super/status-channel', {headers: actor(), body: {guildId, channelId, mentionRoleIds: [roleA]}});
    await first.server.close();

    const second = await startOrchestrator([one], first.directory);
    expect((await second.call('GET', '/v1/super/status-channel')).body).toMatchObject({statusGuildId: guildId, statusChannelId: channelId, mentionRoleIds: [roleA]});
  });
});

describe('super console guild meta', () => {
  it('merges the channels and roles of the bots in the server, with who can post where', async () => {
    const one = await startFakeWorker('muse-01');
    const two = await startFakeWorker('muse-02');
    const three = await startFakeWorker('muse-03');
    three.guilds = [otherGuildId];
    const {call} = await startOrchestrator([one, two, three]);

    const result = await call('GET', `/v1/super/guilds/${guildId}/meta`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      guildId,
      workerIds: ['muse-01', 'muse-02'],
      sourceWorkerId: 'muse-01',
      channels: [
        {id: channelId, name: 'bot-log', type: 'text', parentName: 'Staff', position: 0, postableBy: ['muse-01', 'muse-02']},
        {id: otherChannelId, name: 'news', type: 'announcement', parentName: null, position: 1, postableBy: ['muse-01']},
      ],
      roles: guildMeta('muse-01', guildId).roles,
      failed: [],
    });
    // Only the bots that are members of the server are asked.
    expect(three.requests.some(request => request.url.endsWith('/meta'))).toBe(false);
  });

  it('answers 404 NOT_IN_GUILD when no reachable bot is in the server, and 400 for a bad id', async () => {
    const one = await startFakeWorker('muse-01');
    const {call} = await startOrchestrator([one]);
    expect(await call('GET', `/v1/super/guilds/${otherGuildId}/meta`)).toEqual({
      status: 404,
      body: {error: 'no reachable bot is a member of that guild', code: 'NOT_IN_GUILD'},
    });
    expect((await call('GET', '/v1/super/guilds/nope/meta')).status).toBe(400);
  });
});

describe('super console status channel test', () => {
  it('returns 400 STATUS_CHANNEL_NOT_SET when no channel is configured', async () => {
    const one = await startFakeWorker('muse-01');
    const {call} = await startOrchestrator([one]);
    expect(await call('POST', '/v1/super/status-channel/test', {headers: actor()})).toEqual({
      status: 400,
      body: {error: 'no status channel is configured', code: 'STATUS_CHANNEL_NOT_SET'},
    });
    expect(announces(one)).toEqual([]);
  });

  it('asks every worker to post and reports per-bot results, including unreachable ones', async () => {
    const one = await startFakeWorker('muse-01');
    const two = await startFakeWorker('muse-02', {workerId: 'muse-02', ok: false, error: 'MISSING_PERMISSIONS'});
    const three = await startFakeWorker('muse-03');
    three.down = true;
    const four = await startFakeWorker('muse-04', {workerId: 'muse-04', ok: false, error: 'SOMETHING_ELSE', detail: 'x'});
    const {call} = await startOrchestrator([one, two, three, four]);
    await call('PUT', '/v1/super/status-channel', {headers: actor(), body: {guildId, channelId, mentionRoleIds: [roleA, roleB]}});

    const result = await call('POST', '/v1/super/status-channel/test', {headers: actor()});
    expect(result).toEqual({status: 200, body: {
      statusGuildId: guildId,
      statusChannelId: channelId,
      results: [
        {workerId: 'muse-01', ok: true},
        {workerId: 'muse-02', ok: false, error: 'MISSING_PERMISSIONS'},
        {workerId: 'muse-03', ok: false, error: 'UNREACHABLE'},
        {workerId: 'muse-04', ok: false, error: 'DISCORD_ERROR'},
      ],
    }});

    for (const worker of [one, two, three, four]) {
      expect(announces(worker)).toEqual([{
        method: 'POST',
        url: '/v1/status-channel/announce',
        authorization: `Bearer ${worker.token}`,
        body: {guildId, channelId, test: true, mentionRoleIds: [roleA, roleB]},
      }]);
    }

    const {body} = await call('GET', '/v1/super/overview');
    expect(body.audit[0]).toMatchObject({
      action: 'status_channel.test',
      subjectType: 'CHANNEL',
      subjectId: channelId,
      outcome: 'partial',
      details: {mentionRoleCount: 2, results: result.body.results},
    });
    expect(JSON.stringify(body.audit)).not.toContain(one.token);
  });

  it('audits ok when every bot posted and failed when none did', async () => {
    const one = await startFakeWorker('muse-01');
    const two = await startFakeWorker('muse-02');
    const {call} = await startOrchestrator([one, two]);
    await call('PUT', '/v1/super/status-channel', {headers: actor(), body: {guildId, channelId}});

    await call('POST', '/v1/super/status-channel/test', {headers: actor()});
    expect((await call('GET', '/v1/super/overview')).body.audit[0]).toMatchObject({action: 'status_channel.test', outcome: 'ok'});

    one.down = true;
    two.announce = {workerId: 'muse-02', ok: false, error: 'CHANNEL_NOT_FOUND'};
    const failed = await call('POST', '/v1/super/status-channel/test', {headers: actor()});
    expect(failed.body.results).toEqual([
      {workerId: 'muse-01', ok: false, error: 'UNREACHABLE'},
      {workerId: 'muse-02', ok: false, error: 'CHANNEL_NOT_FOUND'},
    ]);
    expect((await call('GET', '/v1/super/overview')).body.audit[0]).toMatchObject({action: 'status_channel.test', outcome: 'failed'});
  });
});

describe('worker config route', () => {
  it('answers a worker authenticated with its own control token', async () => {
    const one = await startFakeWorker('muse-01');
    const two = await startFakeWorker('muse-02');
    const {call, baseUrl} = await startOrchestrator([one, two]);
    expect(await call('GET', '/v1/worker/config', {token: one.token})).toEqual({status: 200, body: {statusGuildId: null, statusChannelId: null, mentionRoleIds: []}});

    await call('PUT', '/v1/super/status-channel', {headers: actor(), body: {guildId, channelId, mentionRoleIds: [roleA, roleB]}});
    const configured = {statusGuildId: guildId, statusChannelId: channelId, mentionRoleIds: [roleA, roleB]};
    expect(await call('GET', '/v1/worker/config', {token: two.token})).toEqual({status: 200, body: configured});

    // The worker-side client reads the same route.
    await expect(fetchWorkerPlatformConfig(one.token, `${baseUrl}/v1/worker/config`)).resolves.toEqual(configured);
    await expect(fetchWorkerPlatformConfig('x'.repeat(32), `${baseUrl}/v1/worker/config`)).rejects.toThrow(/401/);
  });

  it('refuses the admin token, unknown tokens and other methods', async () => {
    const one = await startFakeWorker('muse-01');
    const {call} = await startOrchestrator([one]);
    expect(await call('GET', '/v1/worker/config')).toEqual({
      status: 403,
      body: {error: 'this route requires a worker control token', code: 'WORKER_TOKEN_REQUIRED'},
    });
    expect((await call('GET', '/v1/worker/config', {token: 'u'.repeat(32)})).status).toBe(401);
    expect((await call('GET', '/v1/worker/config', {token: null})).status).toBe(401);
    expect((await call('PUT', '/v1/worker/config', {token: one.token, body: {statusChannelId: channelId}})).status).toBe(405);
    // A worker token never reaches the admin API.
    expect((await call('GET', '/v1/super/status-channel', {token: one.token})).status).toBe(401);
  });
});
