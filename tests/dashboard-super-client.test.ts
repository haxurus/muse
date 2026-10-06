import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {DashboardConfig} from '../src/dashboard/config.js';
import OrchestratorClient, {actorName} from '../src/dashboard/orchestrator-client.js';

const gotMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('got', () => ({default: gotMock}));

const config: DashboardConfig = {
  host: '127.0.0.1',
  port: 3000,
  publicUrl: new URL('https://music.example.test'),
  oauthRedirectUri: 'https://music.example.test/auth/discord/callback',
  discordClientId: '123456789012345678',
  discordClientSecret: 'not-a-real-secret',
  orchestratorUrl: 'http://orchestrator:3100',
  orchestratorToken: 'not-a-real-token',
  sessionTtlMs: 8 * 60 * 60 * 1000,
};

const actor = {userId: '333333333333333333', username: 'haxurus'};

const jsonResult = (value: unknown) => ({json: async () => value});

type RequestOptions = {headers: Record<string, string>; json?: unknown};

const optionsOf = (mock: typeof gotMock.get, index = 0): RequestOptions =>
  mock.mock.calls[index][1] as RequestOptions;

beforeEach(() => {
  for (const mock of Object.values(gotMock)) {
    mock.mockReset();
  }
});

describe('orchestrator super-admin client', () => {
  it('forwards the bearer token and the actor headers on every super call', async () => {
    const client = new OrchestratorClient(config);
    gotMock.get.mockReturnValue(jsonResult({workers: [], guilds: [], blocks: [], audit: []}));
    gotMock.post.mockReturnValue(jsonResult({left: [], failed: []}));
    gotMock.put.mockReturnValue(jsonResult({block: {}, pushed: [], failed: []}));
    gotMock.delete.mockReturnValue({text: async () => ''});

    await client.superOverview(actor);
    await client.superLeaveGuild('111111111111111111', {workerIds: ['muse-01']}, actor);
    await client.superPutBlock('USER', '555555555555555555', {reason: 'spam'}, actor);
    await expect(client.superDeleteBlock('GUILD', '111111111111111111', actor)).resolves.toEqual({ok: true});

    expect(gotMock.get.mock.calls[0][0]).toBe('http://orchestrator:3100/v1/super/overview');
    expect(gotMock.post.mock.calls[0][0]).toBe('http://orchestrator:3100/v1/super/guilds/111111111111111111/leave');
    expect(gotMock.put.mock.calls[0][0]).toBe('http://orchestrator:3100/v1/super/blocks/USER/555555555555555555');
    expect(gotMock.delete.mock.calls[0][0]).toBe('http://orchestrator:3100/v1/super/blocks/GUILD/111111111111111111');
    expect(optionsOf(gotMock.post).json).toEqual({workerIds: ['muse-01']});
    expect(optionsOf(gotMock.put).json).toEqual({reason: 'spam'});

    for (const mock of [gotMock.get, gotMock.post, gotMock.put, gotMock.delete]) {
      expect(optionsOf(mock).headers).toEqual({
        authorization: 'Bearer not-a-real-token',
        'x-muse-actor-id': actor.userId,
        'x-muse-actor-name': 'haxurus',
      });
    }
  });

  it('sends header-safe actor names of at most 64 characters', () => {
    expect(actorName('haxurus_.01')).toBe('haxurus_.01');
    expect(actorName('a'.repeat(100))).toHaveLength(64);
    expect(actorName('bad\r\nname')).toBe('badname');
    expect(actorName('caffè')).toBe('caff%C3%A8');
    expect(decodeURIComponent(actorName('caffè'))).toBe('caffè');
    expect(actorName(`${'a'.repeat(62)}è`)).toBe('a'.repeat(62));
    expect(actorName('\u0000')).toBe('unknown');
  });

  it('reads the user block status and rejects malformed answers', async () => {
    const client = new OrchestratorClient(config);
    gotMock.get
      .mockReturnValueOnce(jsonResult({blocked: true}))
      .mockReturnValueOnce(jsonResult({blocked: false}))
      .mockReturnValueOnce(jsonResult({}));

    await expect(client.isUserBlocked('555555555555555555')).resolves.toBe(true);
    await expect(client.isUserBlocked('555555555555555555')).resolves.toBe(false);
    await expect(client.isUserBlocked('555555555555555555')).rejects.toMatchObject({statusCode: 502});
    expect(gotMock.get.mock.calls[0][0]).toBe('http://orchestrator:3100/v1/blocks/users/555555555555555555');
  });

  it('maps orchestrator failures on the block check to errors', async () => {
    gotMock.get.mockReturnValueOnce({
      json: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), {name: 'RequestError'});
      },
    });

    await expect(new OrchestratorClient(config).isUserBlocked('555555555555555555'))
      .rejects.toMatchObject({statusCode: 502, message: 'orchestrator unavailable'});
  });
});
