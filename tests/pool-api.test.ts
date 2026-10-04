import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {request, type Server} from 'node:http';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import OrchestratorServer from '../src/orchestrator/server.js';
import type {OrchestratorConfig} from '../src/orchestrator/config.js';

vi.mock('../src/pool/runtime.js', () => ({poolSecret: () => 'a'.repeat(64)}));
const GUILD = '123456789012345678';
const OTHER_GUILD = '223456789012345678';
const ADMIN = 'b'.repeat(64);
const PLAYBACK = 'a'.repeat(64);
let directory: string;
let service: OrchestratorServer;
let port: number;

const call = async (method: string, route: string, token?: string, body?: unknown) => new Promise<{status: number; data: any}>((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = request({hostname: '127.0.0.1', port, method, path: route,
    headers: {...(token ? {authorization: `Bearer ${token}`} : {}),
      ...(payload ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)} : {})}}, res => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => {
      try { resolve({status: res.statusCode!, data: JSON.parse(raw)}); } catch (error) { reject(error); }
    });
  });
  req.setTimeout(5000, () => req.destroy(new Error('test request timed out')));
  req.on('error', reject);
  req.end(payload);
});

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'muse-pool-api-'));
  vi.stubEnv('MUSE_POOL_ENABLED', 'true');
  const config: OrchestratorConfig = {
    host: '127.0.0.1', port: 0, apiToken: ADMIN,
    groupsFile: path.join(directory, 'groups.json'),
    workers: [{id: 'muse-01', baseUrl: 'http://muse-01:3101', token: 'c'.repeat(64)}],
  };
  service = new OrchestratorServer(config);
  await service.start();
  const address = (service as unknown as {server: Server}).server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  port = address.port;
});
afterEach(async () => {
  await service?.close();
  vi.unstubAllEnvs();
  await rm(directory, {recursive: true, force: true});
});

describe('pool HTTP authorization boundaries', () => {
  it('requires the playback credential and rejects the administrative credential for audio', async () => {
    expect((await call('POST', '/v1/pool/commands', undefined, {})).status).toBe(401);
    expect((await call('POST', '/v1/pool/commands', ADMIN, {})).status).toBe(401);
    expect((await call('POST', '/v1/pool/commands', PLAYBACK, {action: 'shell'})).status).toBe(400);
  });
  it('does not let the controller list guilds or edit groups, routing or settings', async () => {
    for (const [method, route] of [
      ['GET', '/v1/guilds'],
      ['GET', '/v1/workers'],
      ['POST', `/v1/guilds/${GUILD}/groups`],
      ['PATCH', `/v1/guilds/${GUILD}/routing`],
      ['PATCH', `/v1/guilds/${GUILD}/workers/settings`],
    ]) {
      expect((await call(method, route, PLAYBACK, method === 'GET' ? undefined : {})).status).toBe(401);
    }
  });
  it('persists guild-specific routing and prevents deleting referenced groups', async () => {
    const created = await call('POST', `/v1/guilds/${GUILD}/groups`, ADMIN,
      {name: 'Primary', workerIds: ['muse-01']});
    expect(created.status).toBe(201);
    const groupId = created.data.group.id;
    expect((await call('PATCH', `/v1/guilds/${GUILD}/routing`, ADMIN, {defaultGroupId: groupId})).status).toBe(200);
    expect((await call('GET', `/v1/guilds/${OTHER_GUILD}/routing`, ADMIN)).data.routing.defaultGroupId).toBeNull();
    expect((await call('PATCH', `/v1/guilds/${OTHER_GUILD}/routing`, ADMIN, {defaultGroupId: groupId})).status).toBe(400);
    expect((await call('DELETE', `/v1/guilds/${GUILD}/groups/${groupId}`, ADMIN)).status).toBe(409);
    await call('PATCH', `/v1/guilds/${GUILD}/routing`, ADMIN, {defaultGroupId: null});
    expect((await call('DELETE', `/v1/guilds/${GUILD}/groups/${groupId}`, ADMIN)).status).toBe(200);
  });
});
