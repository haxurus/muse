import {mkdtempSync, rmSync} from 'node:fs';
import {request, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import InstallGate, {InstallGrantStore} from '../src/orchestrator/install-gate.js';
import type {SettledStatus} from '../src/orchestrator/plan-service.js';
import {installRejectedMessage, requestInstallCheck} from '../src/control/install-check.js';
import {buildInstallRejectedEmbed, parseStatusAnnounceRequest} from '../src/status/announce.js';
import type {InstallSubject} from '../src/control/types.js';
import DashboardAuth from '../src/dashboard/auth.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import type DiscordOAuthClient from '../src/dashboard/discord-oauth.js';
import type OrchestratorClient from '../src/dashboard/orchestrator-client.js';
import DashboardServer from '../src/dashboard/server.js';
import SessionStore from '../src/dashboard/session-store.js';
import OrchestratorServer from '../src/orchestrator/server.js';

const guildA = '111111111111111111';
const guildB = '222222222222222222';
const SUPER_ADMIN = '333333333333333333';
const STRANGER = '444444444444444444';
const actor = {userId: SUPER_ADMIN, username: 'Admin'};
const contacts = {email: 'muse@example.test', discord: 'haxurus', url: null};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const tempDir = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-access-'));
  cleanups.push(() => {
    rmSync(directory, {recursive: true, force: true});
  });
  return directory;
};

const status = (workerId: string, guildIds: string[]): SettledStatus => ({
  workerId,
  ok: true,
  value: {
    workerId,
    discordReady: true,
    bot: {id: `90000000000000000${workerId.slice(-1)}`, username: `Muse ${workerId.slice(-1)}`},
    guilds: guildIds.map(id => ({id, name: id})),
    players: [],
    uptimeSeconds: 1,
  },
});

const makeGate = (statuses: SettledStatus[], filePath = path.join(tempDir(), 'install-grants.json')) => {
  const announceRejected = vi.fn(async () => undefined);
  const record = vi.fn();
  const gate = new InstallGate(new InstallGrantStore(filePath), {
    statuses: async () => statuses,
    superAdminUserId: SUPER_ADMIN,
    contacts: () => contacts,
    announceRejected,
    record,
  });
  return {gate, announceRejected, record, filePath};
};

const install = (guildId: string, installerId: string | null = null) => ({guildId, guildName: 'Test server', memberCount: 12, installerId});

/** A minimal readable request body for readJsonBody. */
const jsonBody = (body: unknown) => ({
  async * [Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify(body));
  },
});

describe('install gate', () => {
  it('keeps the servers the bots were in at the first start and refuses new ones', async () => {
    const {gate, announceRejected, filePath} = makeGate([status('muse-01', [guildA])]);
    await gate.seedOnce();
    expect(gate.grants()).toEqual([expect.objectContaining({guildId: guildA, source: 'LEGACY'})]);
    expect(await gate.check('muse-02', install(guildA))).toMatchObject({approved: true, source: 'LEGACY'});

    const refused = await gate.check('muse-01', install(guildB, STRANGER));
    expect(refused).toEqual({approved: false, source: null, contacts});
    expect(announceRejected).toHaveBeenCalledWith({...install(guildB, STRANGER), workerId: 'muse-01', botName: 'Muse 1'});
    // Durable: a restart keeps the grants and does not seed again.
    expect(new InstallGrantStore(filePath).seededAt()).not.toBeNull();
  });

  it('authorizes the super admin, servers that already have a bot and servers granted from the console', async () => {
    const {gate, record} = makeGate([status('muse-01', [guildA]), status('muse-02', [])]);
    await gate.seedOnce();

    expect(await gate.check('muse-02', install(guildB, SUPER_ADMIN))).toMatchObject({approved: true, source: 'OWNER'});
    expect(gate.grants().find(grant => grant.guildId === guildB)?.source).toBe('OWNER');

    const fresh = makeGate([status('muse-01', [guildA]), status('muse-02', [])]);
    // A server where another Muse bot already is may add more bots.
    expect(await fresh.gate.check('muse-02', install(guildA))).toMatchObject({approved: true});

    const guildC = '555555555555555555';
    expect(() => gate.revoke(guildC, actor)).toThrow(/not authorized/);
    const body = Object.assign(jsonBody({note: ' richiesta via email '}), {headers: {}});
    expect(await gate.authorize(guildC, body as never, actor)).toMatchObject({guildId: guildC, source: 'MANUAL', note: 'richiesta via email'});
    expect(await gate.check('muse-01', install(guildC, STRANGER))).toMatchObject({approved: true, source: 'MANUAL'});
    expect(gate.revoke(guildC, actor)).toEqual({guildId: guildC, revoked: true});
    expect(record).toHaveBeenCalledWith(expect.objectContaining({action: 'install.grant'}));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({action: 'install.revoke'}));
  });

  it('rejects malformed checks', async () => {
    const {gate} = makeGate([status('muse-01', [])]);
    await expect(gate.check('muse-01', {guildId: 'x'})).rejects.toMatchObject({statusCode: 400});
  });
});

describe('refused installation messages', () => {
  it('explains why, how to self-host and whom to contact', () => {
    const message = installRejectedMessage('Test server', contacts, 'it');
    expect(message).toContain('Muse non può essere aggiunto a Test server');
    expect(message).toContain('YouTube');
    expect(message).toContain('docs/DEPLOYMENT.md');
    expect(message).toContain('• Email: muse@example.test');
    expect(message).toContain('• Discord: haxurus');
    expect(message).not.toContain('• Web:');
    expect(message).toContain('https://github.com/haxurus/muse/issues');
    expect(installRejectedMessage('Server', {email: null, discord: null, url: null}, 'en')).toContain('Muse is not a public service');
  });

  it('validates and renders the status channel notice without pinging roles', () => {
    const subject: InstallSubject = {...install(guildB, STRANGER), workerId: 'muse-01', botName: 'Muse 1'};
    expect(parseStatusAnnounceRequest({guildId: guildA, channelId: guildA, test: false, mentionRoleIds: [], kind: 'install-rejected', install: subject}))
      .toMatchObject({kind: 'install-rejected', install: subject});
    expect(() => parseStatusAnnounceRequest({channelId: guildA, test: false, kind: 'install-rejected', install: {guildId: 'x'}})).toThrow();
    const embed = buildInstallRejectedEmbed({install: subject, locale: 'it', now: new Date(0), footer: 'Muse'}).toJSON();
    expect(embed.title).toBe('Installazione rifiutata');
    const approved = buildInstallRejectedEmbed({kind: 'install-approved', install: {...subject, source: 'MANUAL'}, locale: 'en', now: new Date(0), footer: 'Muse'}).toJSON();
    expect(approved.title).toBe('Muse added to a server');
    expect(approved.fields?.at(-1)).toEqual({name: 'Authorization', value: 'MANUAL'});
    expect(embed.fields?.map(field => field.value)).toEqual(['Test server\n`222222222222222222`', '12', `<@${STRANGER}>\n\`${STRANGER}\``]);
  });

  it('fails closed when the orchestrator cannot answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('down');
    }));
    expect(await requestInstallCheck('token', {...install(guildB), installerId: null}, 'http://orchestrator:3100/v1/worker/install-check'))
      .toEqual({approved: false, source: null, contacts: {email: null, discord: null, url: null}});
    vi.unstubAllGlobals();
  });
});

describe('orchestrator install routes', () => {
  const apiToken = 'a'.repeat(32);
  const workerToken = 'b'.repeat(32);

  it('answers the worker check with its control token only and lists grants for the admin API', async () => {
    vi.stubEnv('MUSE_INSTALL_GATE', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const directory = tempDir();
    const server = new OrchestratorServer({
      host: '127.0.0.1',
      port: 0,
      apiToken,
      groupsFile: path.join(directory, 'groups.json'),
      workers: [{id: 'muse-01', baseUrl: 'http://127.0.0.1:9', token: workerToken}],
    });
    await server.start();
    cleanups.push(async () => server.close());
    const {port} = (server as unknown as {server: Server}).server.address() as AddressInfo;
    const call = async (method: string, url: string, token: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-muse-actor-id': SUPER_ADMIN, 'x-muse-actor-name': 'Admin'},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {status: response.status, body: await response.json() as Record<string, any>};
    };

    expect((await call('POST', '/v1/worker/install-check', apiToken, install(guildB))).status).toBe(403);
    // The only worker is unreachable: nothing is seeded and the new server is refused.
    expect(await call('POST', '/v1/worker/install-check', workerToken, install(guildB, STRANGER))).toMatchObject({status: 200, body: {approved: false}});
    expect((await call('PUT', `/v1/super/install-grants/${guildB}`, apiToken, {note: 'ok'})).status).toBe(200);
    expect(await call('POST', '/v1/worker/install-check', workerToken, install(guildB, STRANGER))).toMatchObject({body: {approved: true, source: 'MANUAL'}});
    expect(await call('GET', '/v1/super/install-grants', apiToken)).toMatchObject({status: 200, body: {enabled: true, grants: [expect.objectContaining({guildId: guildB})]}});
    expect((await call('GET', '/v1/super/install-grants', workerToken)).status).toBe(401);
  });
});

describe('dashboard access page', () => {
  const PUBLIC_URL = 'https://music.example.test';
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
    superAdminUserId: SUPER_ADMIN,
  };

  it('explains closed access in both languages with the public contacts and noindex', async () => {
    const auth = new DashboardAuth(config, {store: new SessionStore(config.sessionTtlMs), discord: {} as DiscordOAuthClient, isUserBlocked: async () => false});
    const orchestrator = {publicInfo: vi.fn(async () => ({waitlistOpen: false, contacts, promotions: []}))};
    const server = new DashboardServer(config, {auth, orchestrator: orchestrator as unknown as OrchestratorClient});
    await server.start();
    cleanups.push(async () => server.close());

    const get = async (urlPath: string) => new Promise<{status: number; headers: Record<string, unknown>; text: string}>((resolve, reject) => {
      const outgoing = request({host: '127.0.0.1', port: server.port, method: 'GET', path: urlPath}, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8')});
        });
      });
      outgoing.on('error', reject);
      outgoing.end();
    });

    const italian = await get('/it/access');
    expect(italian.status).toBe(200);
    expect(italian.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(italian.text).toContain('Muse non è un servizio pubblico.');
    expect(italian.text).toContain('href="mailto:muse@example.test"');
    expect(italian.text).toContain('docs/DEPLOYMENT.md');
    expect(italian.text).not.toMatch(/\{\{|\}\}/u);
    expect((await get('/en/access')).text).toContain('Muse is not a public service.');
  });
});
