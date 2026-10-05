import {Readable} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {handlePlaybackProxy, sendPlayback} from '../src/playback/transport.js';
import {handlePlaybackInteraction} from '../src/playback/controller.js';
import {parsePlaybackRequest} from '../src/playback/protocol.js';

const request = parsePlaybackRequest({
  requestId: '123456789012345678', guildId: '223456789012345678', userId: '323456789012345678',
  voiceChannelId: '423456789012345678', textChannelId: '523456789012345678', action: 'play', query: 'song',
});
const result = {workerId: 'muse-01', requestId: request.requestId, guildId: request.guildId, channelId: request.voiceChannelId, state: 'PLAYING', message: 'ok'};
const config = {
  host: '127.0.0.1', port: 3100, groupsFile: '/state/groups.json', apiToken: 'admin-key',
  workers: [
    {id: 'muse-01', baseUrl: 'http://muse-01:3101', token: 'worker-01-key'},
    {id: 'muse-02', baseUrl: 'http://muse-02:3101', token: 'worker-02-key'},
  ],
};
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const incoming = (token: string, method = 'POST') => Object.assign(Readable.from([JSON.stringify(request)]), {
  url: '/v1/playback', method, headers: {authorization: `Bearer ${token}`},
});
const outgoing = () => ({writeHead: vi.fn(), end: vi.fn()});

describe('bot-one private transport', () => {
  it.each(['admin-key', 'worker-02-key', 'wrong'])('rejects the wrong controller credential: %s', async token => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming(token) as never, outgoing() as never, config)).rejects.toMatchObject({statusCode: 401});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('forwards only to worker 01 and does not send an admin or Discord token', async () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    const fetcher = vi.fn(async () => new Response(JSON.stringify(result), {status: 200}));
    vi.stubGlobal('fetch', fetcher);
    const response = outgoing();
    await expect(handlePlaybackProxy(incoming('worker-01-key') as never, response as never, config)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith('http://muse-01:3101/v1/playback', expect.objectContaining({redirect: 'error'}));
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual(request);
    expect(options.body).not.toContain('admin-key');
    expect(options.body).not.toContain('worker-01-key');
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(result));
  });
  it('does nothing when pilot mode is disabled', async () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'false');
    await expect(handlePlaybackProxy(incoming('worker-01-key') as never, outgoing() as never, config)).resolves.toBe(false);
  });
  it('does not retry or execute a local fallback after an uncertain timeout', async () => {
    const fetcher = vi.fn(async () => { throw new Error('sensitive network detail'); });
    vi.stubGlobal('fetch', fetcher);
    await expect(sendPlayback('http://orchestrator:3100/v1/playback', 'key', request)).rejects.toThrow(/No local fallback/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a response belonging to another guild', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({...result, guildId: '923456789012345678'}))));
    await expect(sendPlayback('http://orchestrator:3100/v1/playback', 'key', request)).rejects.toMatchObject({statusCode: 504});
  });
  it('bounds the response body before parsing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(8193))));
    await expect(sendPlayback('http://orchestrator:3100/v1/playback', 'key', request)).rejects.toMatchObject({statusCode: 504});
  });
});

describe('bot-one Discord controller', () => {
  it('acknowledges Discord before network work and does not forward interaction credentials', async () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    const events: string[] = [];
    const fetcher = vi.fn(async (_url: unknown, options: RequestInit) => {
      events.push('fetch');
      expect(options.body).not.toContain('private-interaction-token');
      return new Response(JSON.stringify(result));
    });
    vi.stubGlobal('fetch', fetcher);
    const interaction = {
      token: 'private-interaction-token', id: request.requestId, guildId: request.guildId, channelId: request.textChannelId,
      user: {id: request.userId}, guild: {voiceStates: {cache: new Map([[request.userId, {channelId: request.voiceChannelId}]])}},
      commandName: 'play', isButton: () => false, isChatInputCommand: () => true,
      options: {getString: () => 'song', getBoolean: () => null},
      deferReply: vi.fn(async () => { events.push('defer'); }), editReply: vi.fn(async () => undefined),
    };
    await expect(handlePlaybackInteraction(interaction as never, {WORKER_ID: 'muse-01', CONTROL_TOKEN: 'worker-01-key'} as never)).resolves.toBe(true);
    expect(events).toEqual(['defer', 'fetch']);
    expect(interaction.editReply).toHaveBeenCalledWith({content: 'ok', allowedMentions: {parse: []}});
  });
  it('leaves workers 02-05 entirely on their existing command path', async () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    for (const id of ['muse-02', 'muse-03', 'muse-04', 'muse-05']) {
      await expect(handlePlaybackInteraction({} as never, {WORKER_ID: id} as never)).resolves.toBe(false);
    }
  });
});
