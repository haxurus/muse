import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {DashboardConfig} from '../src/dashboard/config.js';
import DiscordOAuthClient, {hasRequiredScopes} from '../src/dashboard/discord-oauth.js';
import OrchestratorClient from '../src/dashboard/orchestrator-client.js';

const gotMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
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

const guildPage = (start: number, count: number) => Array.from({length: count}, (_, index) => ({
  id: String(start + index),
  name: `Guild ${start + index}`,
  icon: null,
  owner: false,
  permissions: '0',
}));

const jsonResult = (value: unknown) => ({json: async () => value});

const httpError = (statusCode: number, body: string) =>
  Object.assign(new Error(`Response code ${statusCode}`), {
    name: 'HTTPError',
    response: {statusCode, headers: {}, body},
  });

beforeEach(() => {
  gotMock.get.mockReset();
  gotMock.post.mockReset();
  gotMock.patch.mockReset();
  gotMock.delete.mockReset();
});

describe('Discord guild pagination', () => {
  it('follows the after cursor until a short page is returned', async () => {
    gotMock.get
      .mockReturnValueOnce(jsonResult(guildPage(1, 200)))
      .mockReturnValueOnce(jsonResult(guildPage(201, 50)));

    const guilds = await new DiscordOAuthClient(config).currentUserGuilds('token');

    expect(guilds).toHaveLength(250);
    expect(gotMock.get).toHaveBeenCalledTimes(2);

    const first = new URL(String(gotMock.get.mock.calls[0][0]));
    const second = new URL(String(gotMock.get.mock.calls[1][0]));
    expect(first.pathname).toBe('/api/v10/users/@me/guilds');
    expect(first.searchParams.get('limit')).toBe('200');
    expect(first.searchParams.has('after')).toBe(false);
    expect(second.searchParams.get('after')).toBe('200');
  });

  it('stops after a bounded number of pages', async () => {
    let next = 1;
    gotMock.get.mockImplementation(() => {
      const page = guildPage(next, 200);
      next += 200;
      return jsonResult(page);
    });

    const guilds = await new DiscordOAuthClient(config).currentUserGuilds('token');

    expect(gotMock.get).toHaveBeenCalledTimes(10);
    expect(guilds).toHaveLength(2000);
  });

  it('requires both identify and guilds scopes', () => {
    expect(hasRequiredScopes('identify guilds')).toBe(true);
    expect(hasRequiredScopes('guilds identify email')).toBe(true);
    expect(hasRequiredScopes('identify')).toBe(false);
    expect(hasRequiredScopes(undefined)).toBe(false);
  });
});

describe('orchestrator client error mapping', () => {
  it('forwards a 409 with the orchestrator message', async () => {
    gotMock.post.mockReturnValueOnce({
      json: async () => {
        throw httpError(409, JSON.stringify({error: 'group name already exists'}));
      },
    });

    await expect(new OrchestratorClient(config).createGuildGroup('1', {name: 'A', workerIds: ['muse-01']}))
      .rejects.toMatchObject({statusCode: 409, message: 'group name already exists'});
  });

  it('maps orchestrator 5xx responses to 502', async () => {
    gotMock.get.mockReturnValueOnce({
      json: async () => {
        throw httpError(503, JSON.stringify({error: 'internal detail'}));
      },
    });

    await expect(new OrchestratorClient(config).guilds())
      .rejects.toMatchObject({statusCode: 502, message: 'orchestrator unavailable'});
  });
});
