import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {Collection} from 'discord.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const settingsMocks = vi.hoisted(() => ({
  updateGuildSettings: vi.fn(async (guildId: string, patch: Record<string, unknown>) => ({guildId, ...patch})),
}));

vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: vi.fn(async (guildId: string) => ({guildId})),
}));

vi.mock('../src/control/guild-settings.js', () => ({
  sanitizeGuildSettingsPatch: vi.fn((patch: unknown) => patch),
  updateGuildSettings: settingsMocks.updateGuildSettings,
}));

import WorkerControlServer from '../src/control/worker-server.js';
import {entitlements} from '../src/plans/entitlements.js';

const token = 'c'.repeat(32);
const guildId = '111111111111111111';
const servers: WorkerControlServer[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  settingsMocks.updateGuildSettings.mockClear();
  entitlements.set({guilds: []});
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

const startWorker = async () => {
  const config = {WORKER_ID: 'muse-01', CONTROL_HOST: '127.0.0.1', CONTROL_PORT: 0, CONTROL_TOKEN: token};
  const client = {isReady: () => true, guilds: {cache: new Collection([[guildId, {id: guildId}]])}};
  const server = new WorkerControlServer(config as never, client as never, {snapshot: () => []} as never);
  await server.start();
  servers.push(server);
  const {port} = (server as unknown as {server: Server}).server.address() as AddressInfo;

  return async (method: string, url: string, body?: unknown, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {...(auth ? {authorization: `Bearer ${token}`} : {}), 'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, body: await response.json() as Record<string, unknown>};
  };
};

describe('worker plan entitlements', () => {
  it('accepts a push from the orchestrator and applies it to settings changes', async () => {
    const call = await startWorker();
    expect((await call('PUT', '/v1/entitlements', {guilds: []}, false)).status).toBe(401);
    expect(await call('PUT', '/v1/entitlements', {guilds: 'x'})).toMatchObject({status: 400, body: {code: 'INVALID_ENTITLEMENTS'}});

    // Free by default: above the plan is refused before anything is written.
    expect(await call('PATCH', `/v1/guilds/${guildId}/settings`, {playlistLimit: 200})).toMatchObject({status: 403, body: {code: 'PLAN_LIMIT'}});
    expect(await call('PATCH', `/v1/guilds/${guildId}/settings`, {leaveIfNoListeners: false})).toMatchObject({status: 403, body: {code: 'PLAN_REQUIRED'}});
    expect(settingsMocks.updateGuildSettings).not.toHaveBeenCalled();

    expect(await call('PUT', '/v1/entitlements', {guilds: [{guildId, tier: 'TIER2', allowed: true, allowedBotIds: ['900000000000000001']}]}))
      .toEqual({status: 200, body: {workerId: 'muse-01', guilds: 1}});
    expect(entitlements.get(guildId).tier).toBe('TIER2');
    expect((await call('PATCH', `/v1/guilds/${guildId}/settings`, {playlistLimit: 500, leaveIfNoListeners: false})).status).toBe(200);
    expect(settingsMocks.updateGuildSettings).toHaveBeenCalledWith(guildId, {playlistLimit: 500, leaveIfNoListeners: false});
  });
});
