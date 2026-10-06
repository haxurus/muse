import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {Collection} from 'discord.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: vi.fn(async (guildId: string) => ({guildId})),
}));

vi.mock('../src/control/guild-settings.js', () => ({
  sanitizeGuildSettingsPatch: vi.fn((patch: unknown) => patch),
  updateGuildSettings: vi.fn(async (guildId: string) => ({guildId})),
}));

import WorkerControlServer from '../src/control/worker-server.js';
import {MAX_BLOCKLIST_ENTRIES, blocklist, sanitizeBlocklist} from '../src/control/blocklist.js';
import {HttpError} from '../src/control/http.js';

const token = 'c'.repeat(32);
const guildA = '111111111111111111';
const guildB = '222222222222222222';
const guildC = '333333333333333333';
const userA = '444444444444444444';

const snowflake = (index: number): string => `1${String(index).padStart(17, '0')}`;

type FakeGuild = {
  id: string;
  name: string;
  memberCount: number;
  ownerId: string;
  iconURL: () => string | null;
  leave: ReturnType<typeof vi.fn>;
};

const servers: WorkerControlServer[] = [];

afterEach(async () => {
  blocklist.set({guildIds: [], userIds: []});
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

const startWorker = async (guildIds: string[] = [guildA, guildB]) => {
  const cache = new Collection<string, FakeGuild>();
  for (const id of guildIds) {
    const guild: FakeGuild = {
      id,
      name: `Guild ${id.slice(0, 3)}`,
      memberCount: 42,
      ownerId: '555555555555555555',
      iconURL: () => id === guildA ? `https://cdn.discordapp.com/icons/${id}/hash.png` : null,
      leave: vi.fn(async () => {
        cache.delete(id);
        return guild;
      }),
    };
    cache.set(id, guild);
  }

  const client = {
    isReady: () => true,
    user: {
      id: '666666666666666666',
      username: 'muse-one',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/666666666666666666/a.png',
    },
    guilds: {cache},
  };
  const playerManager = {
    snapshot: () => [{guildId: guildA, connected: true, channelId: '777777777777777777', status: 'PLAYING'}],
  };
  const config = {WORKER_ID: 'muse-01', CONTROL_HOST: '127.0.0.1', CONTROL_PORT: 0, CONTROL_TOKEN: token};
  const server = new WorkerControlServer(config as never, client as never, playerManager as never);
  await server.start();
  servers.push(server);
  const {port} = (server as unknown as {server: Server}).server.address() as AddressInfo;
  const guilds = new Map([...cache.entries()]);

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(auth ? {authorization: `Bearer ${token}`} : {}),
        ...(body === undefined ? {} : {'content-type': 'application/json'}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, body: await response.json() as Record<string, unknown>};
  };

  return {call, cache, guilds};
};

describe('worker blocklist validation', () => {
  it('deduplicates valid ids', () => {
    expect(sanitizeBlocklist({guildIds: [guildA, guildA], userIds: [userA]})).toEqual({guildIds: [guildA], userIds: [userA]});
  });

  it.each([
    ['a non-object body', []],
    ['missing lists', {}],
    ['a non-snowflake guild id', {guildIds: ['../x'], userIds: []}],
    ['a numeric user id', {guildIds: [], userIds: [444_444_444_444_444_444]}],
    ['too many ids', {guildIds: Array.from({length: MAX_BLOCKLIST_ENTRIES + 1}, (_, index) => snowflake(index)), userIds: []}],
  ])('rejects %s', (_label, body) => {
    expect(() => sanitizeBlocklist(body)).toThrowError(HttpError);
  });
});

describe('worker super-console control API', () => {
  it('requires the control token', async () => {
    const {call} = await startWorker();
    expect((await call('PUT', '/v1/blocklist', {guildIds: [], userIds: []}, false)).status).toBe(401);
    expect((await call('POST', `/v1/guilds/${guildA}/leave`, undefined, false)).status).toBe(401);
  });

  it('reports guild details, active players and the bot avatar in /v1/status', async () => {
    const {call} = await startWorker();
    const {status, body} = await call('GET', '/v1/status');
    expect(status).toBe(200);
    expect(body.bot).toEqual({
      id: '666666666666666666',
      username: 'muse-one',
      avatarUrl: 'https://cdn.discordapp.com/avatars/666666666666666666/a.png',
    });
    expect(body.guilds).toEqual([
      {id: guildA, name: 'Guild 111', iconUrl: `https://cdn.discordapp.com/icons/${guildA}/hash.png`, memberCount: 42, ownerId: '555555555555555555', playerActive: true},
      {id: guildB, name: 'Guild 222', iconUrl: null, memberCount: 42, ownerId: '555555555555555555', playerActive: false},
    ]);
    expect(body.players).toHaveLength(1);
  });

  it('leaves a guild on request and 404s when it is not a member', async () => {
    const {call, guilds} = await startWorker();
    expect(await call('POST', `/v1/guilds/${guildA}/leave`)).toEqual({
      status: 200,
      body: {workerId: 'muse-01', guildId: guildA, left: true},
    });
    expect(guilds.get(guildA)!.leave).toHaveBeenCalledOnce();

    expect(await call('POST', `/v1/guilds/${guildC}/leave`)).toEqual({
      status: 404,
      body: {error: 'worker is not a member of that guild', code: 'NOT_IN_GUILD'},
    });
    expect((await call('POST', '/v1/guilds/not-a-guild/leave')).status).toBe(400);
  });

  it('replaces the blocklist and immediately leaves blocked guilds', async () => {
    const {call, guilds, cache} = await startWorker();
    const result = await call('PUT', '/v1/blocklist', {guildIds: [guildB, guildC, guildB], userIds: [userA]});
    expect(result).toEqual({status: 200, body: {workerId: 'muse-01', left: [guildB], failed: []}});
    expect(guilds.get(guildB)!.leave).toHaveBeenCalledOnce();
    expect(guilds.get(guildA)!.leave).not.toHaveBeenCalled();
    expect(cache.has(guildB)).toBe(false);
    expect(blocklist.isGuildBlocked(guildC)).toBe(true);
    expect(blocklist.isUserBlocked(userA)).toBe(true);

    // A full replacement drops entries that are no longer present.
    await call('PUT', '/v1/blocklist', {guildIds: [], userIds: []});
    expect(blocklist.isUserBlocked(userA)).toBe(false);
    expect(blocklist.isGuildBlocked(guildC)).toBe(false);
  });

  it('reports guilds it failed to leave without failing the push', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const {call, guilds} = await startWorker();
    guilds.get(guildA)!.leave.mockRejectedValueOnce(new Error('Discord unavailable'));
    const result = await call('PUT', '/v1/blocklist', {guildIds: [guildA, guildB], userIds: []});
    expect(result).toEqual({status: 200, body: {workerId: 'muse-01', left: [guildB], failed: [guildA]}});
    expect(blocklist.isGuildBlocked(guildA)).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(guildA));
  });

  it('rejects invalid blocklists without changing the current one', async () => {
    const {call} = await startWorker();
    blocklist.set({guildIds: [], userIds: [userA]});
    expect(await call('PUT', '/v1/blocklist', {guildIds: ['nope'], userIds: []})).toEqual({
      status: 400,
      body: {error: 'guildIds must contain only Discord ids', code: 'INVALID_BLOCKLIST'},
    });
    expect(blocklist.isUserBlocked(userA)).toBe(true);
  });

  it('accepts full-size lists larger than the default JSON body limit', async () => {
    const {call} = await startWorker([]);
    const ids = Array.from({length: MAX_BLOCKLIST_ENTRIES}, (_, index) => snowflake(index));
    const result = await call('PUT', '/v1/blocklist', {guildIds: ids, userIds: ids});
    expect(result.status).toBe(200);
    expect(blocklist.get().userIds).toHaveLength(MAX_BLOCKLIST_ENTRIES);
  });
});
