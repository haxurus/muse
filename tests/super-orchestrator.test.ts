import {createServer, type IncomingMessage, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import OrchestratorServer from '../src/orchestrator/server.js';
import type SuperConsole from '../src/orchestrator/super-console.js';

const apiToken = 'a'.repeat(32);
const actorId = '123456789012345678';
const guildA = '111111111111111111';
const guildB = '222222222222222222';
const userX = '444444444444444444';

type Recorded = {method: string; url: string; authorization?: string; body: unknown};

type FakeWorker = {
  id: string;
  token: string;
  baseUrl: string;
  requests: Recorded[];
  guilds: Array<{id: string; name: string; iconUrl?: string | null; memberCount?: number; ownerId?: string}>;
  down: boolean;
  pushDelayMs: number;
  server: Server;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const json = (response: import('node:http').ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(body));
};

const startFakeWorker = async (id: string, guilds: FakeWorker['guilds']): Promise<FakeWorker> => {
  const worker = {id, token: `${id}-`.padEnd(32, 't'), guilds, requests: [] as Recorded[], down: false, pushDelayMs: 0} as FakeWorker;
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
          bot: {id: `9${id.slice(-2).padStart(17, '0')}`, username: id, avatarUrl: `https://cdn.discordapp.com/avatars/${id}.png`},
          guilds: worker.guilds,
          players: worker.guilds.length > 0 ? [{guildId: worker.guilds[0].id, connected: true, channelId: null, status: 'PLAYING'}] : [],
          uptimeSeconds: 120,
        });
        return;
      }

      const leave = /^\/v1\/guilds\/(\d+)\/leave$/u.exec(request.url ?? '');
      if (request.method === 'POST' && leave) {
        const index = worker.guilds.findIndex(guild => guild.id === leave[1]);
        if (index < 0) {
          json(response, 404, {error: 'worker is not a member of that guild', code: 'NOT_IN_GUILD'});
          return;
        }

        worker.guilds.splice(index, 1);
        json(response, 200, {workerId: id, guildId: leave[1], left: true});
        return;
      }

      if (request.method === 'PUT' && request.url === '/v1/blocklist') {
        if (worker.pushDelayMs > 0) {
          await new Promise(resolve => {
            setTimeout(resolve, worker.pushDelayMs);
          });
        }

        const {guildIds} = body as {guildIds: string[]};
        const left = worker.guilds.filter(guild => guildIds.includes(guild.id)).map(guild => guild.id);
        worker.guilds = worker.guilds.filter(guild => !guildIds.includes(guild.id));
        json(response, 200, {workerId: id, left, failed: []});
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

const startOrchestrator = async (workers: FakeWorker[], reconcileMs = 60_000) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-super-orchestrator-'));
  cleanups.push(() => {
    rmSync(directory, {recursive: true, force: true});
  });
  const server = new OrchestratorServer({
    host: '127.0.0.1',
    port: 0,
    apiToken,
    groupsFile: path.join(directory, 'groups.json'),
    blocksFile: path.join(directory, 'blocks.json'),
    auditFile: path.join(directory, 'super-audit.json'),
    blocklistReconcileIntervalMs: reconcileMs,
    workers: workers.map(worker => ({id: worker.id, baseUrl: worker.baseUrl, token: worker.token})),
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await server.start();
  cleanups.push(async () => server.close());
  const internals = server as unknown as {server: Server; superConsole: SuperConsole};
  // Wait for the startup reconcile push, then forget its requests.
  await internals.superConsole.pushBlocklist();
  for (const worker of workers) {
    worker.requests.splice(0);
  }

  const {port} = internals.server.address() as AddressInfo;
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

  return {server, call, directory, superConsole: internals.superConsole};
};

const actor = (name?: string): Record<string, string> => ({
  'x-muse-actor-id': actorId,
  ...(name === undefined ? {} : {'x-muse-actor-name': name}),
});

const pushes = (worker: FakeWorker) => worker.requests.filter(request => request.method === 'PUT' && request.url === '/v1/blocklist');

const fleet = async () => {
  const one = await startFakeWorker('muse-01', [{id: guildA, name: 'Alpha', iconUrl: null, memberCount: 10, ownerId: actorId}, {id: guildB, name: 'Beta'}]);
  const two = await startFakeWorker('muse-02', [{id: guildA, name: 'Alpha', iconUrl: 'https://cdn.discordapp.com/icons/a.png', memberCount: 10, ownerId: actorId}]);
  const down = await startFakeWorker('muse-03', []);
  down.down = true;
  return {one, two, down, workers: [one, two, down]};
};

describe('super console authentication and actor identity', () => {
  it('requires the orchestrator token on every super route', async () => {
    const {workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    for (const [method, url] of [
      ['GET', '/v1/super/overview'],
      ['POST', `/v1/super/guilds/${guildA}/leave`],
      ['PUT', `/v1/super/blocks/USER/${userX}`],
      ['DELETE', `/v1/super/blocks/USER/${userX}`],
      ['GET', `/v1/blocks/users/${userX}`],
    ]) {
      expect((await call(method, url, {token: null, headers: actor()})).status).toBe(401);
      expect((await call(method, url, {token: workers[0].token, headers: actor()})).status).toBe(401);
    }
  });

  it.each([
    ['a missing actor id', {}],
    ['a non-snowflake actor id', {'x-muse-actor-id': 'admin'}],
    ['a control character in the actor name', {'x-muse-actor-id': actorId, 'x-muse-actor-name': 'a%07b'}],
    ['an actor name over 64 characters', {'x-muse-actor-id': actorId, 'x-muse-actor-name': 'x'.repeat(65)}],
  ])('rejects mutations with %s', async (_label, headers) => {
    const {workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    for (const [method, url] of [
      ['POST', `/v1/super/guilds/${guildA}/leave`],
      ['PUT', `/v1/super/blocks/USER/${userX}`],
      ['DELETE', `/v1/super/blocks/USER/${userX}`],
    ]) {
      const result = await call(method, url, {headers});
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('INVALID_ACTOR');
    }

    expect(workers.flatMap(worker => worker.requests)).toEqual([]);
  });

  it('decodes a percent-encoded actor name, keeps plain ones and defaults a missing one to unknown', async () => {
    const {workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    await call('PUT', `/v1/super/blocks/USER/${userX}`, {headers: actor(encodeURIComponent('Alessio 🎧'))});
    await call('DELETE', `/v1/super/blocks/USER/${userX}`, {headers: actor()});

    // Plain ASCII names that are not valid percent-encoding are kept as sent.
    await call('PUT', `/v1/super/blocks/USER/${userX}`, {headers: actor('100% admin')});

    const {body} = await call('GET', '/v1/super/overview');
    expect(body.audit.map((entry: {actor: unknown}) => entry.actor)).toEqual([
      {userId: actorId, username: '100% admin'},
      {userId: actorId, username: 'unknown'},
      {userId: actorId, username: 'Alessio 🎧'},
    ]);
  });
});

describe('super console overview', () => {
  it('merges guilds across workers and reports unreachable workers without failing', async () => {
    const {workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    const {status, body} = await call('GET', '/v1/super/overview');
    expect(status).toBe(200);
    expect(body.workers).toEqual([
      {id: 'muse-01', reachable: true, ready: true, bot: {id: '900000000000000001', username: 'muse-01', avatarUrl: 'https://cdn.discordapp.com/avatars/muse-01.png'}, guildCount: 2, activePlayers: 1, uptimeSeconds: 120},
      {id: 'muse-02', reachable: true, ready: true, bot: {id: '900000000000000002', username: 'muse-02', avatarUrl: 'https://cdn.discordapp.com/avatars/muse-02.png'}, guildCount: 1, activePlayers: 1, uptimeSeconds: 120},
      {id: 'muse-03', reachable: false, ready: false, bot: null, guildCount: 0, activePlayers: 0, uptimeSeconds: null, error: expect.any(String)},
    ]);
    expect(body.guilds).toEqual([
      {id: guildA, name: 'Alpha', iconUrl: 'https://cdn.discordapp.com/icons/a.png', memberCount: 10, ownerId: actorId, workerIds: ['muse-01', 'muse-02'], blocked: false},
      {id: guildB, name: 'Beta', iconUrl: null, memberCount: null, ownerId: null, workerIds: ['muse-01'], blocked: false},
    ]);
    expect(body.blocks).toEqual([]);
    expect(body.audit).toEqual([]);
  });
});

describe('super console blocks', () => {
  it('refuses to block the acting user', async () => {
    const {workers} = await fleet();
    const {call, directory} = await startOrchestrator(workers);
    const result = await call('PUT', `/v1/super/blocks/USER/${actorId}`, {headers: actor('Me'), body: {reason: 'oops'}});
    expect(result).toEqual({status: 400, body: {error: 'you cannot block yourself', code: 'CANNOT_BLOCK_SELF'}});
    expect(workers.flatMap(pushes)).toEqual([]);
    expect(() => readFileSync(path.join(directory, 'blocks.json'))).toThrow();

    // Blocking a guild with the same id is a different subject.
    expect((await call('PUT', `/v1/super/blocks/GUILD/${actorId}`, {headers: actor('Me')})).status).toBe(200);
  });

  it.each([
    ['a lowercase kind', `/v1/super/blocks/guild/${guildA}`, 'INVALID_BLOCK_KIND'],
    ['an unknown kind', `/v1/super/blocks/CHANNEL/${guildA}`, 'INVALID_BLOCK_KIND'],
    ['a malformed subject id', '/v1/super/blocks/USER/abc', 'INVALID_SUBJECT_ID'],
  ])('rejects %s', async (_label, url, code) => {
    const {workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    const result = await call('PUT', url, {headers: actor()});
    expect(result.status).toBe(400);
    expect(result.body.code).toBe(code);
  });

  it('rejects invalid reasons', async () => {
    const {workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    const result = await call('PUT', `/v1/super/blocks/USER/${userX}`, {headers: actor(), body: {reason: 'x'.repeat(501)}});
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_REASON');
  });

  it('persists a guild block, pushes it to every worker and audits a partial push', async () => {
    const {one, two, down, workers} = await fleet();
    const {call, directory} = await startOrchestrator(workers);
    const result = await call('PUT', `/v1/super/blocks/GUILD/${guildA}`, {headers: actor('Admin'), body: {reason: '  raid  '}});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      block: {kind: 'GUILD', subjectId: guildA, reason: 'raid', createdBy: {userId: actorId, username: 'Admin'}, createdAt: expect.any(String)},
      created: true,
      pushed: ['muse-01', 'muse-02'],
      failed: [{workerId: 'muse-03', error: expect.any(String)}],
    });

    for (const worker of [one, two, down]) {
      expect(pushes(worker)).toEqual([expect.objectContaining({
        authorization: `Bearer ${worker.token}`,
        body: {guildIds: [guildA], userIds: []},
      })]);
    }

    expect(JSON.parse(readFileSync(path.join(directory, 'blocks.json'), 'utf8')).blocks).toHaveLength(1);

    const {body} = await call('GET', '/v1/super/overview');
    expect(body.guilds.map((guild: {id: string}) => guild.id)).toEqual([guildB]);
    expect(body.blocks).toEqual([result.body.block]);
    expect(body.audit).toEqual([{
      id: expect.any(String),
      at: expect.any(String),
      actor: {userId: actorId, username: 'Admin'},
      action: 'block.upsert',
      subjectType: 'GUILD',
      subjectId: guildA,
      details: {
        created: true,
        reason: 'raid',
        pushed: ['muse-01', 'muse-02'],
        failed: [{workerId: 'muse-03', error: expect.any(String)}],
        leftWorkerIds: ['muse-01', 'muse-02'],
      },
      outcome: 'partial',
    }]);
    const audit = readFileSync(path.join(directory, 'super-audit.json'), 'utf8');
    for (const worker of workers) {
      expect(audit).not.toContain(worker.token);
    }

    expect(audit).not.toContain(apiToken);
  });

  it('reports user blocks to the dashboard and removes them', async () => {
    const {one, two} = await fleet();
    const {call} = await startOrchestrator([one, two]);
    expect(await call('GET', `/v1/blocks/users/${userX}`)).toEqual({status: 200, body: {blocked: false}});
    expect((await call('GET', '/v1/blocks/users/nope')).status).toBe(400);

    const upsert = await call('PUT', `/v1/super/blocks/USER/${userX}`, {headers: actor()});
    expect(upsert.body).toMatchObject({created: true, pushed: ['muse-01', 'muse-02'], failed: []});
    expect(await call('GET', `/v1/blocks/users/${userX}`)).toEqual({status: 200, body: {blocked: true}});
    expect(pushes(one).at(-1)!.body).toEqual({guildIds: [], userIds: [userX]});

    const again = await call('PUT', `/v1/super/blocks/USER/${userX}`, {headers: actor(), body: {reason: 'updated'}});
    expect(again.body).toMatchObject({created: false, block: {reason: 'updated', createdAt: upsert.body.block.createdAt}});

    const removed = await call('DELETE', `/v1/super/blocks/USER/${userX}`, {headers: actor()});
    expect(removed).toEqual({status: 200, body: {block: again.body.block, pushed: ['muse-01', 'muse-02'], failed: []}});
    expect(pushes(two).at(-1)!.body).toEqual({guildIds: [], userIds: []});
    expect(await call('GET', `/v1/blocks/users/${userX}`)).toEqual({status: 200, body: {blocked: false}});

    expect(await call('DELETE', `/v1/super/blocks/USER/${userX}`, {headers: actor()})).toEqual({
      status: 404,
      body: {error: 'block not found', code: 'BLOCK_NOT_FOUND'},
    });

    const {body} = await call('GET', '/v1/super/overview');
    expect(body.audit.map((entry: {action: string; outcome: string}) => `${entry.action}:${entry.outcome}`))
      .toEqual(['block.delete:ok', 'block.upsert:ok', 'block.upsert:ok']);
  });
});

describe('super console guild leave', () => {
  it('makes every present worker leave by default', async () => {
    const {one, two, workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    const result = await call('POST', `/v1/super/guilds/${guildA}/leave`, {headers: actor('Admin')});
    expect(result).toEqual({status: 200, body: {guildId: guildA, left: ['muse-01', 'muse-02'], failed: []}});
    expect(one.guilds.map(guild => guild.id)).toEqual([guildB]);
    expect(two.guilds).toEqual([]);

    const {body} = await call('GET', '/v1/super/overview');
    expect(body.audit[0]).toMatchObject({
      action: 'guild.leave',
      subjectType: 'GUILD',
      subjectId: guildA,
      outcome: 'ok',
      details: {requestedWorkerIds: null, left: ['muse-01', 'muse-02'], failed: []},
    });
  });

  it('honours an explicit worker list and reports absent or unreachable workers', async () => {
    const {one, two, workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    const result = await call('POST', `/v1/super/guilds/${guildB}/leave`, {
      headers: actor(),
      body: {workerIds: ['muse-03', 'muse-02', 'muse-01']},
    });
    expect(result).toEqual({status: 200, body: {
      guildId: guildB,
      left: ['muse-01'],
      failed: [{workerId: 'muse-02', error: 'WorkerNotInGuild'}, {workerId: 'muse-03', error: 'WorkerUnreachable'}],
    }});
    expect(one.guilds.map(guild => guild.id)).toEqual([guildA]);
    expect(two.requests.some(request => request.url.endsWith('/leave'))).toBe(false);

    const {body} = await call('GET', '/v1/super/overview');
    expect(body.audit[0]).toMatchObject({action: 'guild.leave', outcome: 'partial'});
  });

  it('audits a leave where nothing succeeded as failed', async () => {
    const {two, workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    const result = await call('POST', `/v1/super/guilds/${guildB}/leave`, {headers: actor(), body: {workerIds: [two.id]}});
    expect(result.body).toEqual({guildId: guildB, left: [], failed: [{workerId: 'muse-02', error: 'WorkerNotInGuild'}]});
    expect((await call('GET', '/v1/super/overview')).body.audit[0]).toMatchObject({outcome: 'failed'});
  });

  it('validates the guild id and worker ids, and 404s when no worker is in the guild', async () => {
    const {workers} = await fleet();
    const {call} = await startOrchestrator(workers);
    expect((await call('POST', '/v1/super/guilds/../leave', {headers: actor()})).status).toBe(404);
    expect((await call('POST', '/v1/super/guilds/abc/leave', {headers: actor()})).status).toBe(400);

    const unknown = await call('POST', `/v1/super/guilds/${guildA}/leave`, {headers: actor(), body: {workerIds: ['muse-09']}});
    expect(unknown).toEqual({status: 400, body: {error: 'unknown workers: muse-09', code: 'UNKNOWN_WORKERS'}});
    expect((await call('POST', `/v1/super/guilds/${guildA}/leave`, {headers: actor(), body: {workerIds: []}})).body.code).toBe('INVALID_WORKER_IDS');

    const missing = await call('POST', '/v1/super/guilds/999999999999999999/leave', {headers: actor()});
    expect(missing).toEqual({status: 404, body: {error: 'no reachable worker is a member of that guild', code: 'GUILD_NOT_FOUND'}});
    expect((await call('GET', '/v1/super/overview')).body.audit).toEqual([]);
  });
});

describe('blocklist reconcile', () => {
  it('pushes the stored blocklist on start, survives a restart and does not overlap', async () => {
    const {one, two} = await fleet();
    const first = await startOrchestrator([one, two]);
    await first.call('PUT', `/v1/super/blocks/USER/${userX}`, {headers: actor()});
    await first.server.close();

    // A new orchestrator on the same state pushes the persisted list at startup.
    one.requests.splice(0);
    const second = new OrchestratorServer({
      host: '127.0.0.1',
      port: 0,
      apiToken,
      groupsFile: path.join(first.directory, 'groups.json'),
      blocksFile: path.join(first.directory, 'blocks.json'),
      auditFile: path.join(first.directory, 'super-audit.json'),
      workers: [one, two].map(worker => ({id: worker.id, baseUrl: worker.baseUrl, token: worker.token})),
    });
    await second.start();
    cleanups.push(async () => second.close());
    const superConsole = (second as unknown as {superConsole: SuperConsole}).superConsole;
    await superConsole.pushBlocklist();
    expect(pushes(one)[0].body).toEqual({guildIds: [], userIds: [userX]});

    // Overlapping reconcile passes collapse into one.
    one.requests.splice(0);
    one.pushDelayMs = 100;
    await Promise.all([superConsole.reconcile(), superConsole.reconcile(), superConsole.reconcile()]);
    expect(pushes(one)).toHaveLength(1);
  });

  it('re-pushes periodically and stops on close', async () => {
    const {one} = await fleet();
    const {server} = await startOrchestrator([one], 40);
    await vi.waitFor(() => {
      expect(pushes(one).length).toBeGreaterThanOrEqual(2);
    }, {timeout: 2000, interval: 20});

    await server.close();
    const count = pushes(one).length;
    await new Promise(resolve => {
      setTimeout(resolve, 150);
    });
    expect(pushes(one).length).toBeLessThanOrEqual(count + 1);
  });

  it('logs reconcile failures once per change', async () => {
    const {one, down} = await fleet();
    const {superConsole} = await startOrchestrator([one, down]);
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    await superConsole.reconcile();
    await superConsole.reconcile();
    expect(warn.mock.calls.filter(call => String(call[0]).includes('Blocklist reconcile failed for: muse-03'))).toHaveLength(0);
    // The startup pass already logged this failure set; repeating it stays quiet until it changes.
    down.down = false;
    await superConsole.reconcile();
    expect(vi.mocked(console.log)).toHaveBeenCalledWith('Blocklist reconcile succeeded for all workers');
  });
});
