import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import OrchestratorServer from '../src/orchestrator/server.js';
import {mergeGuildMeta, statusTestResult, workerErrorCode} from '../src/orchestrator/guild-status.js';

const apiToken = 'a'.repeat(32);
const guildId = '111111111111111111';
const otherGuildId = '222222222222222222';
const channelA = '444444444444444441';
const channelB = '444444444444444442';
const roleA = '555555555555555551';

type Recorded = {method: string; url: string; authorization?: string; body: unknown};

type FakeWorker = {
  id: string;
  token: string;
  baseUrl: string;
  requests: Recorded[];
  down: boolean;
  ready: boolean;
  guilds: string[];
  /** Answer to GET /v1/guilds/:guildId/meta (status, body). */
  meta: [number, unknown];
  /** Answer to POST /v1/guilds/:guildId/status-channel/test. */
  test: unknown;
  /** Answer to PATCH /v1/guilds/:guildId/settings (status, body). */
  settings: [number, unknown];
  server: Server;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const tempDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-guild-status-'));
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

const channel = (id: string, name: string, canPost: boolean) => ({id, name, type: 'text', parentName: 'Logs', position: 0, canPost});

const metaOf = (workerId: string, canPost: Record<string, boolean>) => ({
  workerId,
  guildId,
  channels: [channel(channelA, 'bot-log', canPost[channelA] ?? true), channel(channelB, 'news', canPost[channelB] ?? true)],
  roles: [{id: roleA, name: 'Staff', color: 0, mentionable: true, position: 3}],
});

const startFakeWorker = async (id: string, options: Partial<Pick<FakeWorker, 'ready' | 'guilds' | 'meta' | 'test' | 'settings'>> = {}): Promise<FakeWorker> => {
  const worker = {
    id,
    token: `${id}-`.padEnd(32, 't'),
    requests: [] as Recorded[],
    down: false,
    ready: true,
    guilds: [guildId],
    meta: [200, metaOf(id, {})],
    test: {workerId: id, ok: true},
    settings: [200, {guildId}],
    ...options,
  } as FakeWorker;
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
          discordReady: worker.ready,
          bot: {id: '900000000000000001', username: id},
          guilds: worker.guilds.map(guild => ({id: guild, name: `Guild ${guild.slice(0, 3)}`})),
          players: [],
          uptimeSeconds: 1,
        });
        return;
      }

      if (request.method === 'PUT' && request.url === '/v1/blocklist') {
        json(response, 200, {workerId: id, left: [], failed: []});
        return;
      }

      if (request.method === 'GET' && request.url === `/v1/guilds/${guildId}/meta`) {
        json(response, worker.meta[0], worker.meta[1]);
        return;
      }

      if (request.method === 'POST' && request.url === `/v1/guilds/${guildId}/status-channel/test`) {
        json(response, 200, worker.test);
        return;
      }

      if (request.method === 'PATCH' && request.url === `/v1/guilds/${guildId}/settings`) {
        json(response, worker.settings[0], worker.settings[1]);
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

const startOrchestrator = async (workers: FakeWorker[]) => {
  const directory = tempDirectory();
  const server = new OrchestratorServer({
    host: '127.0.0.1',
    port: 0,
    apiToken,
    groupsFile: path.join(directory, 'groups.json'),
    blocksFile: path.join(directory, 'blocks.json'),
    auditFile: path.join(directory, 'super-audit.json'),
    workers: workers.map(worker => ({id: worker.id, baseUrl: worker.baseUrl, token: worker.token})),
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await server.start();
  cleanups.push(async () => server.close());

  const {port} = (server as unknown as {server: Server}).server.address() as AddressInfo;
  const call = async (method: string, url: string, options: {body?: unknown; headers?: Record<string, string>; token?: string | null} = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
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

  return {server, call, directory};
};

const requestsTo = (worker: FakeWorker, suffix: string) => worker.requests.filter(request => request.url.endsWith(suffix));

describe('orchestrator guild meta', () => {
  it('returns one bot view plus, per channel, the bots that can post there', async () => {
    // muse-01 is not ready: the channels and roles come from muse-02, the first ready bot.
    const one = await startFakeWorker('muse-01', {ready: false, meta: [200, metaOf('muse-01', {[channelB]: false})]});
    const two = await startFakeWorker('muse-02', {meta: [200, metaOf('muse-02', {[channelA]: false})]});
    const three = await startFakeWorker('muse-03', {guilds: [otherGuildId]});
    const four = await startFakeWorker('muse-04');
    four.down = true;
    const {call} = await startOrchestrator([one, two, three, four]);

    const result = await call('GET', `/v1/guilds/${guildId}/meta`);
    expect(result).toEqual({status: 200, body: {
      guildId,
      workerIds: ['muse-01', 'muse-02'],
      sourceWorkerId: 'muse-02',
      channels: [
        {id: channelA, name: 'bot-log', type: 'text', parentName: 'Logs', position: 0, postableBy: ['muse-01']},
        {id: channelB, name: 'news', type: 'text', parentName: 'Logs', position: 0, postableBy: ['muse-02']},
      ],
      roles: [{id: roleA, name: 'Staff', color: 0, mentionable: true, position: 3}],
      failed: [],
    }});

    // Bots outside the guild or down are never asked.
    expect(requestsTo(three, '/meta')).toEqual([]);
    expect(requestsTo(four, '/meta')).toEqual([]);
    expect(requestsTo(two, '/meta')).toEqual([{method: 'GET', url: `/v1/guilds/${guildId}/meta`, authorization: `Bearer ${two.token}`, body: undefined}]);
  });

  it('reports bots that did not answer and drops malformed entries', async () => {
    const one = await startFakeWorker('muse-01', {meta: [503, {error: 'worker is not connected to Discord', code: 'NOT_READY'}]});
    const two = await startFakeWorker('muse-02', {meta: [200, {
      ...metaOf('muse-02', {}),
      channels: [channel(channelA, 'bot-log', true), {id: 'nope', name: 'x', type: 'text', parentName: null, position: 0, canPost: true}],
      roles: [{id: roleA, name: 'Staff', color: 0, mentionable: true, position: 3}, {id: roleA, name: 42}],
    }]});
    const {call} = await startOrchestrator([one, two]);

    const {body} = await call('GET', `/v1/guilds/${guildId}/meta`);
    expect(body.sourceWorkerId).toBe('muse-02');
    expect(body.channels).toEqual([{id: channelA, name: 'bot-log', type: 'text', parentName: 'Logs', position: 0, postableBy: ['muse-02']}]);
    expect(body.roles).toHaveLength(1);
    expect(body.failed).toEqual([{workerId: 'muse-01', error: expect.any(String)}]);
  });

  it('answers 404 without bots in the guild and 503 when none could list its channels', async () => {
    const one = await startFakeWorker('muse-01', {guilds: [otherGuildId]});
    const {call} = await startOrchestrator([one]);
    expect(await call('GET', `/v1/guilds/${guildId}/meta`)).toEqual({status: 404, body: {error: 'no workers are available in that guild', code: 'NOT_IN_GUILD'}});
    expect((await call('GET', '/v1/guilds/nope/meta')).status).toBe(400);

    const two = await startFakeWorker('muse-02', {meta: [500, {error: 'internal server error'}]});
    const second = await startOrchestrator([two]);
    expect(await second.call('GET', `/v1/guilds/${guildId}/meta`)).toEqual({
      status: 503,
      body: {error: 'no bot in that guild could list its channels', code: 'META_UNAVAILABLE'},
    });
  });

  it('requires the orchestrator API token', async () => {
    const one = await startFakeWorker('muse-01');
    const {call} = await startOrchestrator([one]);
    expect((await call('GET', `/v1/guilds/${guildId}/meta`, {token: null})).status).toBe(401);
    expect((await call('GET', `/v1/guilds/${guildId}/meta`, {token: one.token})).status).toBe(401);
    expect(requestsTo(one, '/meta')).toEqual([]);
  });
});

describe('orchestrator status channel test fan-out', () => {
  const testPath = `/v1/guilds/${guildId}/status-channel/test`;

  it('asks every bot present in the guild and reports per-bot results', async () => {
    const one = await startFakeWorker('muse-01');
    const two = await startFakeWorker('muse-02', {test: {workerId: 'muse-02', ok: false, error: 'MISSING_PERMISSIONS'}});
    const three = await startFakeWorker('muse-03', {test: {workerId: 'muse-03', ok: false, error: 'SOMETHING_ELSE'}});
    const four = await startFakeWorker('muse-04', {guilds: [otherGuildId]});
    const five = await startFakeWorker('muse-05', {test: {workerId: 'muse-05', ok: false, error: 'NOT_CONFIGURED'}});
    const {call} = await startOrchestrator([one, two, three, four, five]);

    expect(await call('POST', testPath)).toEqual({status: 200, body: {
      guildId,
      results: [
        {workerId: 'muse-01', ok: true},
        {workerId: 'muse-02', ok: false, error: 'MISSING_PERMISSIONS'},
        {workerId: 'muse-03', ok: false, error: 'DISCORD_ERROR'},
        {workerId: 'muse-05', ok: false, error: 'NOT_CONFIGURED'},
      ],
    }});
    expect(requestsTo(four, '/test')).toEqual([]);
    expect(requestsTo(one, '/test')).toEqual([{method: 'POST', url: testPath, authorization: `Bearer ${one.token}`, body: undefined}]);
  });

  it('limits the test to the requested bots and reports missing ones as UNREACHABLE', async () => {
    const one = await startFakeWorker('muse-01');
    const two = await startFakeWorker('muse-02');
    const three = await startFakeWorker('muse-03');
    three.down = true;
    const {call} = await startOrchestrator([one, two, three]);

    expect((await call('POST', testPath, {body: {workerIds: ['muse-03', 'muse-01']}})).body).toEqual({
      guildId,
      results: [{workerId: 'muse-01', ok: true}, {workerId: 'muse-03', ok: false, error: 'UNREACHABLE'}],
    });
    expect(requestsTo(two, '/test')).toEqual([]);

    expect((await call('POST', testPath, {body: {workerIds: ['muse-09']}})).body).toEqual({error: 'unknown workers: muse-09', code: 'UNKNOWN_WORKERS'});
    expect((await call('POST', testPath, {body: {workerIds: []}})).body.code).toBe('INVALID_WORKER_IDS');
    expect((await call('POST', testPath, {body: [guildId]})).body.code).toBe('INVALID_BODY');
  });

  it('reports an unexpected test answer as DISCORD_ERROR and 404 without bots in the guild', async () => {
    const one = await startFakeWorker('muse-01', {test: 'not json'});
    const {call} = await startOrchestrator([one]);
    expect((await call('POST', testPath)).body.results).toEqual([{workerId: 'muse-01', ok: false, error: 'DISCORD_ERROR'}]);

    one.guilds = [otherGuildId];
    expect(await call('POST', testPath)).toEqual({status: 404, body: {error: 'no matching workers are available in that guild', code: 'NOT_IN_GUILD'}});
    expect((await call('POST', testPath, {token: one.token})).status).toBe(401);
  });
});

describe('status settings fan-out', () => {
  it('rejects malformed status settings before contacting the bots', async () => {
    const one = await startFakeWorker('muse-01');
    const {call} = await startOrchestrator([one]);
    const settingsPath = `/v1/guilds/${guildId}/workers/settings`;
    expect((await call('PATCH', settingsPath, {body: {settings: {statusChannelId: 'general'}}})).body).toEqual({
      error: 'statusChannelId must be a Discord channel id or null',
      code: 'INVALID_STATUS_CHANNEL',
    });
    expect((await call('PATCH', settingsPath, {body: {settings: {statusMentionRoleIds: ['@everyone']}}})).body.code).toBe('INVALID_STATUS_ROLES');
    expect(requestsTo(one, '/settings')).toEqual([]);
  });

  it('sends the status settings to the selected bots and reports a bot that refused them', async () => {
    const one = await startFakeWorker('muse-01', {settings: [200, {guildId, statusChannelId: channelA, statusMentionRoleIds: [roleA]}]});
    const two = await startFakeWorker('muse-02', {settings: [400, {error: 'statusChannelId must be a text or announcement channel of this server', code: 'INVALID_STATUS_CHANNEL'}]});
    const {call} = await startOrchestrator([one, two]);

    const result = await call('PATCH', `/v1/guilds/${guildId}/workers/settings`, {body: {
      workerIds: ['muse-01', 'muse-02'],
      settings: {statusChannelId: channelA, statusMentionRoleIds: [roleA, roleA]},
    }});
    expect(result.status).toBe(200);
    expect(result.body.updated).toEqual([{workerId: 'muse-01', ok: true, value: {guildId, statusChannelId: channelA, statusMentionRoleIds: [roleA]}}]);
    expect(result.body.failed).toEqual([expect.objectContaining({workerId: 'muse-02', ok: false})]);
    for (const worker of [one, two]) {
      expect(requestsTo(worker, '/settings')[0].body).toEqual({statusChannelId: channelA, statusMentionRoleIds: [roleA]});
    }
  });
});

describe('guild status helpers', () => {
  it('merges meta answers from the first ready bot that answered', () => {
    const meta = (id: string, canPost: boolean) => ({workerId: id, ok: true as const, value: metaOf(id, {[channelA]: canPost})});
    const merged = mergeGuildMeta(guildId, [
      {ready: true, result: {workerId: 'muse-01', ok: false, error: 'RequestError'}},
      {ready: false, result: meta('muse-02', true)},
      {ready: true, result: meta('muse-03', false)},
      {ready: true, result: {workerId: 'muse-04', ok: true, value: {channels: 'nope'}}},
    ]);
    expect(merged.sourceWorkerId).toBe('muse-03');
    expect(merged.workerIds).toEqual(['muse-01', 'muse-02', 'muse-03', 'muse-04']);
    expect(merged.channels[0]).toEqual({id: channelA, name: 'bot-log', type: 'text', parentName: 'Logs', position: 0, postableBy: ['muse-02']});
    expect(merged.channels[1].postableBy).toEqual(['muse-02', 'muse-03']);
    expect(merged.failed).toEqual([{workerId: 'muse-01', error: 'RequestError'}, {workerId: 'muse-04', error: 'InvalidResponse'}]);
    expect(() => mergeGuildMeta(guildId, [])).toThrow('no bot in that guild could list its channels');
  });

  it('validates worker test answers', () => {
    expect(statusTestResult({workerId: 'muse-01', ok: true, value: {ok: true, extra: 1}})).toEqual({workerId: 'muse-01', ok: true});
    expect(statusTestResult({workerId: 'muse-01', ok: true, value: {ok: false, error: 'NOT_CONFIGURED'}})).toEqual({workerId: 'muse-01', ok: false, error: 'NOT_CONFIGURED'});
    expect(statusTestResult({workerId: 'muse-01', ok: true, value: {ok: false, error: '<script>'}})).toEqual({workerId: 'muse-01', ok: false, error: 'DISCORD_ERROR'});
    expect(statusTestResult({workerId: 'muse-01', ok: false, error: 'TimeoutError'})).toEqual({workerId: 'muse-01', ok: false, error: 'UNREACHABLE'});
  });

  it('extracts the code of a worker 4xx answer only', () => {
    const failure = (statusCode: number, body: unknown) => Object.assign(new Error('failed'), {response: {statusCode, body}});
    expect(workerErrorCode(failure(400, JSON.stringify({error: 'x', code: 'INVALID_STATUS_ROLES'})))).toBe('INVALID_STATUS_ROLES');
    expect(workerErrorCode(failure(400, Buffer.from(JSON.stringify({code: 'INVALID_STATUS_CHANNEL'}))))).toBe('INVALID_STATUS_CHANNEL');
    expect(workerErrorCode(failure(500, JSON.stringify({code: 'INVALID_STATUS_ROLES'})))).toBeUndefined();
    expect(workerErrorCode(failure(400, JSON.stringify({code: 'lower case'})))).toBeUndefined();
    expect(workerErrorCode(failure(400, 'not json'))).toBeUndefined();
    expect(workerErrorCode(new Error('no response'))).toBeUndefined();
  });
});

describe('platform-wide status channel removal', () => {
  it('no longer serves the super console status channel or the worker config routes', async () => {
    const one = await startFakeWorker('muse-01');
    const {call, directory} = await startOrchestrator([one]);
    const actor = {'x-muse-actor-id': '123456789012345678', 'x-muse-actor-name': 'Admin'};
    expect((await call('GET', '/v1/super/status-channel', {headers: actor})).status).toBe(404);
    expect((await call('PUT', '/v1/super/status-channel', {headers: actor, body: {channelId: channelA}})).status).toBe(404);
    expect((await call('POST', '/v1/super/status-channel/test', {headers: actor})).status).toBe(404);
    expect((await call('GET', '/v1/worker/config')).status).toBe(404);
    // A worker token never reaches anything without the API token.
    expect((await call('GET', '/v1/worker/config', {token: one.token})).status).toBe(401);
    expect((await call('GET', '/v1/super/overview', {headers: actor})).body).not.toHaveProperty('statusChannel');
    expect(requestsTo(one, '/v1/status-channel/announce')).toEqual([]);
    expect(existsSync(path.join(directory, 'platform-settings.json'))).toBe(false);
  });
});
