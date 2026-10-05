import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import GuildGroupStore from '../src/orchestrator/guild-group-store.js';
import OrchestratorServer from '../src/orchestrator/server.js';
import WorkerClient, {MAX_WORKER_RESPONSE_BYTES} from '../src/orchestrator/worker-client.js';
import {assertTokenStrength, loadOrchestratorConfig, loadWorkerDefinitions, resolveContainedPath} from '../src/orchestrator/config.js';
import {isSnowflake} from '../src/control/snowflake.js';

const workerIds = new Set(['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05']);
const guildId = '123456789012345678';
const directories: string[] = [];
const tempDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-orchestrator-hardening-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('shared snowflake validation (LOW-3)', () => {
  it('accepts fixture and real-world IDs and rejects malformed ones', () => {
    for (const id of ['123456789012345678', '999999999999999999', '1234567890', '1234567890123456789012']) {
      expect(isSnowflake(id)).toBe(true);
    }

    for (const id of ['0123456789012', '123456789', '12345678901234567890123', '../state', '12345678901234567a', 123_456_789_012_345_680]) {
      expect(isSnowflake(id)).toBe(false);
    }
  });
});

describe('durable guild group store (MEDIUM-3)', () => {
  it('keeps memory unchanged when persisting fails', () => {
    const directory = tempDirectory();
    const filePath = path.join(directory, 'groups.json');
    const store = new GuildGroupStore(filePath, workerIds);
    store.create(guildId, {name: 'Main', workerIds: ['muse-01']});
    // Block the main temp file so the next write fails.
    mkdirSync(path.join(directory, `.groups.json.${process.pid}.tmp`));

    expect(() => store.create(guildId, {name: 'Extra', workerIds: ['muse-02']})).toThrow();
    expect(store.list(guildId).map(group => group.name)).toEqual(['Main']);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).guilds[guildId]).toHaveLength(1);
  });

  it('writes the previous good state to a .bak file and recovers from it', () => {
    const directory = tempDirectory();
    const filePath = path.join(directory, 'groups.json');
    const store = new GuildGroupStore(filePath, workerIds);
    store.create(guildId, {name: 'Main', workerIds: ['muse-01']});
    store.create(guildId, {name: 'Extra', workerIds: ['muse-02']});
    expect(JSON.parse(readFileSync(`${filePath}.bak`, 'utf8')).guilds[guildId]).toHaveLength(1);

    writeFileSync(filePath, '{"version": 1, "guilds": ');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recovered = new GuildGroupStore(filePath, workerIds);
    expect(recovered.list(guildId).map(group => group.name)).toEqual(['Main']);
    expect(warn).toHaveBeenCalledOnce();

    recovered.create(guildId, {name: 'Again', workerIds: ['muse-03']});
    expect(new GuildGroupStore(filePath, workerIds).list(guildId)).toHaveLength(2);
  });

  it.each([
    ['unparsable JSON', '{not json'],
    ['an unsupported version', JSON.stringify({version: 2, guilds: {}})],
    ['an invalid guild id', JSON.stringify({version: 1, guilds: {'../x': []}})],
    ['a malformed group', JSON.stringify({version: 1, guilds: {[guildId]: [{id: 'x', name: '', workerIds: []}]}})],
  ])('fails clearly on %s without a valid backup', (_label, content) => {
    const directory = tempDirectory();
    const filePath = path.join(directory, 'groups.json');
    writeFileSync(filePath, content);
    expect(() => new GuildGroupStore(filePath, workerIds)).toThrow(/invalid schema.*no valid backup/);
  });
});

describe('orchestrator config hardening (LOW-4, LOW-5)', () => {
  it('normalizes paths before checking mount prefixes', () => {
    expect(resolveContainedPath('/run/secrets/control_token_01', '/run/secrets/')).toBe('/run/secrets/control_token_01');
    expect(resolveContainedPath('/run/secrets//./control_token_01', '/run/secrets/')).toBe('/run/secrets/control_token_01');
    for (const value of ['/run/secrets/../../etc/passwd', 'run/secrets/x', '/run/secrets/', '/run/secretsx/y', '']) {
      expect(resolveContainedPath(value, '/run/secrets/')).toBeUndefined();
    }
  });

  it('rejects traversal in configured token and state paths', () => {
    vi.stubEnv('MUSE_ORCHESTRATOR_TOKEN_FILE', '/run/secrets/../etc/token');
    expect(() => loadOrchestratorConfig()).toThrow(/mounted secret/);
    vi.stubEnv('MUSE_ORCHESTRATOR_TOKEN_FILE', '/run/secrets/orchestrator_api_token');
    vi.stubEnv('MUSE_ORCHESTRATOR_GROUPS_FILE', '/state/../etc/groups.json');
    expect(() => loadOrchestratorConfig()).toThrow(/under \/state/);

    const workersFile = path.join(tempDirectory(), 'workers.json');
    writeFileSync(workersFile, JSON.stringify([{id: 'muse-01', baseUrl: 'http://muse-01:3101', tokenFile: '/run/secrets/../../etc/passwd'}]));
    vi.stubEnv('MUSE_WORKERS_FILE', workersFile);
    expect(() => loadWorkerDefinitions()).toThrow(/must be mounted under \/run\/secrets/);
  });

  it('requires tokens of at least 32 characters without echoing them', () => {
    expect(() => assertTokenStrength('short-secret-value', 'orchestrator API token')).toThrow(/at least 32 characters/);
    expect(() => assertTokenStrength('short-secret-value', 'orchestrator API token')).not.toThrow(/short-secret-value/);
    expect(assertTokenStrength('a'.repeat(32), 'orchestrator API token')).toBe('a'.repeat(32));
  });
});

describe('orchestrator guild routes (LOW-3, L6)', () => {
  const makeServer = () => {
    const server = new OrchestratorServer({
      host: '127.0.0.1', port: 0, apiToken: 'a'.repeat(32),
      groupsFile: path.join(tempDirectory(), 'groups.json'),
      workers: [],
    });
    const present = {
      id: 'muse-01',
      status: vi.fn(async () => ({guilds: [{id: guildId, name: 'Guild'}]})),
      updateGuildSettings: vi.fn(async () => ({guildId})),
    };
    const absent = {
      id: 'muse-02',
      status: vi.fn(async () => ({guilds: []})),
      updateGuildSettings: vi.fn(async () => ({guildId})),
    };
    (server as unknown as {workers: unknown[]}).workers = [present, absent];
    return {server: server as unknown as Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>, present, absent};
  };

  it('validates the guild id before contacting workers', async () => {
    const {server, present} = makeServer();
    await expect(server.guildWorkers('not-a-guild')).rejects.toMatchObject({statusCode: 400});
    await expect(server.updateGuildWorkers('../x', {settings: {defaultVolume: 50}})).rejects.toMatchObject({statusCode: 400});
    expect(present.status).not.toHaveBeenCalled();
  });

  it('never patches requested workers that are not in the guild', async () => {
    const {server, present, absent} = makeServer();
    const result = await server.updateGuildWorkers(guildId, {workerIds: ['muse-01', 'muse-02'], settings: {defaultVolume: 50}});
    expect(present.updateGuildSettings).toHaveBeenCalledOnce();
    expect(absent.updateGuildSettings).not.toHaveBeenCalled();
    expect(result.requestedWorkers).toEqual(['muse-01']);
    expect(result.failed).toEqual([{workerId: 'muse-02', ok: false, error: 'WorkerNotInGuild'}]);

    await expect(server.updateGuildWorkers(guildId, {workerIds: ['muse-02'], settings: {defaultVolume: 50}}))
      .rejects.toMatchObject({statusCode: 404});
    expect(absent.updateGuildSettings).not.toHaveBeenCalled();
  });
});

describe('worker client response limits (LOW-2)', () => {
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    return server;
  };

  const close = async (server: Server) => new Promise<void>(resolve => {
    server.close(() => {
      resolve();
    });
  });

  it('does not follow redirects', async () => {
    const hits: string[] = [];
    const server = await listen((request, response) => {
      hits.push(request.url ?? '');
      if (request.url === '/v1/status') {
        response.writeHead(302, {location: '/elsewhere'});
        response.end();
        return;
      }

      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({guilds: []}));
    });
    try {
      const {port} = server.address() as AddressInfo;
      const client = new WorkerClient({id: 'muse-01', baseUrl: `http://127.0.0.1:${port}`, token: 'a'.repeat(32)});
      await expect(client.status()).rejects.toThrow();
      expect(hits).toEqual(['/v1/status']);
    } finally {
      await close(server);
    }
  });

  it('rejects oversized responses', async () => {
    const server = await listen((_request, response) => {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(`{"guilds":[],"padding":"${'x'.repeat(MAX_WORKER_RESPONSE_BYTES + 1024)}"}`);
    });
    try {
      const {port} = server.address() as AddressInfo;
      const client = new WorkerClient({id: 'muse-01', baseUrl: `http://127.0.0.1:${port}`, token: 'a'.repeat(32)});
      await expect(client.status()).rejects.toThrow();
    } finally {
      await close(server);
    }
  });
});
