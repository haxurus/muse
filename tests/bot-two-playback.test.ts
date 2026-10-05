import {ChannelType} from 'discord.js';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {afterEach, describe, expect, it, vi} from 'vitest';
import PlaybackWorker from '../src/playback/worker.js';
import {handlePlaybackProxy, sendPlayback} from '../src/playback/transport.js';
import {handlePlaybackInteraction} from '../src/playback/controller.js';
import {isPlaybackWorkerEnabled, parsePlaybackRequest} from '../src/playback/protocol.js';

vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: async () => ({defaultQueuePageSize: 5}),
}));

const ids = {
  requestId: '123456789012345678',
  guildId: '223456789012345678',
  userId: '323456789012345678',
  voiceChannelId: '423456789012345678',
  textChannelId: '523456789012345678',
};

const request = parsePlaybackRequest({...ids, action: 'queue', page: 1});
const workerResult = {
  workerId: 'muse-02' as const,
  requestId: ids.requestId,
  guildId: ids.guildId,
  channelId: ids.voiceChannelId,
  state: 'PLAYING' as const,
  message: 'ok',
};

const orchestratorConfig = {
  host: '127.0.0.1',
  port: 3100,
  groupsFile: '/state/groups.json',
  apiToken: 'admin-key',
  workers: [
    {id: 'muse-01', baseUrl: 'http://muse-01:3101', token: 'worker-01-key'},
    {id: 'muse-02', baseUrl: 'http://muse-02:3101', token: 'worker-02-key'},
  ],
};

const incoming = (token: string) => Object.assign(Readable.from([JSON.stringify(request)]), {
  url: '/v1/playback',
  method: 'POST',
  headers: {authorization: `Bearer ${token}`},
});

const outgoing = () => ({writeHead: vi.fn(), end: vi.fn()});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('bot-two playback activation', () => {
  it('enables muse-02 independently from muse-01 and later workers', () => {
    vi.stubEnv('MUSE_BOT_TWO_PLAYBACK', 'true');

    expect(isPlaybackWorkerEnabled('muse-02')).toBe(true);
    for (const id of ['muse-01', 'muse-03', 'muse-04', 'muse-05', '']) {
      expect(isPlaybackWorkerEnabled(id)).toBe(false);
    }
  });

  it('routes the muse-02 control credential only to muse-02', async () => {
    vi.stubEnv('MUSE_BOT_TWO_PLAYBACK', 'true');
    const fetcher = vi.fn(async () => new Response(JSON.stringify(workerResult), {status: 200}));
    vi.stubGlobal('fetch', fetcher);

    const response = outgoing();
    await expect(
      handlePlaybackProxy(incoming('worker-02-key') as never, response as never, orchestratorConfig),
    ).resolves.toBe(true);

    expect(fetcher).toHaveBeenCalledWith(
      'http://muse-02:3101/v1/playback',
      expect.objectContaining({redirect: 'error'}),
    );
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(options.body).not.toContain('worker-02-key');
    expect(options.body).not.toContain('admin-key');
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(workerResult));
  });

  it('does not accept worker 01 credentials when only bot 02 is enabled', async () => {
    vi.stubEnv('MUSE_BOT_TWO_PLAYBACK', 'true');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await expect(
      handlePlaybackProxy(incoming('worker-01-key') as never, outgoing() as never, orchestratorConfig),
    ).rejects.toMatchObject({statusCode: 401});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a worker-01 response when muse-02 is the expected destination', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({...workerResult, workerId: 'muse-01'}))));

    await expect(
      sendPlayback('http://orchestrator:3100/v1/playback', 'worker-02-key', request, 'muse-02'),
    ).rejects.toMatchObject({statusCode: 504});
  });
});

describe('bot-two worker and Discord controller', () => {
  const harness = () => {
    const permissions = {has: vi.fn(() => true)};
    const member = {user: {bot: false, id: ids.userId}, voice: {channelId: ids.voiceChannelId}};
    const voice = {
      id: ids.voiceChannelId,
      guildId: ids.guildId,
      type: ChannelType.GuildVoice,
      permissionsFor: () => permissions,
    };
    const text = {
      id: ids.textChannelId,
      guildId: ids.guildId,
      type: ChannelType.GuildText,
      permissionsFor: () => permissions,
    };
    const guild = {
      id: ids.guildId,
      members: {me: {}, fetch: vi.fn(async () => member)},
      channels: {fetch: vi.fn(async (id: string) => id === voice.id ? voice : text)},
    };
    const client = {isReady: vi.fn(() => true), guilds: {cache: new Map([[ids.guildId, guild]])}};
    const player = {
      voiceConnection: {joinConfig: {channelId: ids.voiceChannelId}},
      status: 1,
      getQueue: () => [],
      getCurrent: () => ({title: 'Current song'}),
    };

    return {client, player};
  };

  it('reports muse-02 as the worker identity', async () => {
    const h = harness();
    const worker = new PlaybackWorker(
      h.client as never,
      {get: () => h.player} as never,
      {} as never,
      'muse-02',
    );

    await expect(worker.execute(request)).resolves.toMatchObject({
      workerId: 'muse-02',
      guildId: ids.guildId,
    });
  });

  it('keeps Discord interaction credentials inside muse-02', async () => {
    vi.stubEnv('MUSE_BOT_TWO_PLAYBACK', 'true');
    const fetcher = vi.fn(async (_url: unknown, options: RequestInit) => {
      expect(options.body).not.toContain('private-interaction-token');
      return new Response(JSON.stringify(workerResult), {status: 200});
    });
    vi.stubGlobal('fetch', fetcher);

    const interaction = {
      token: 'private-interaction-token',
      id: ids.requestId,
      guildId: ids.guildId,
      channelId: ids.textChannelId,
      user: {id: ids.userId},
      guild: {voiceStates: {cache: new Map([[ids.userId, {channelId: ids.voiceChannelId}]])}},
      commandName: 'queue',
      isButton: () => false,
      isChatInputCommand: () => true,
      options: {getInteger: () => null},
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };

    await expect(
      handlePlaybackInteraction(
        interaction as never,
        {WORKER_ID: 'muse-02', CONTROL_TOKEN: 'worker-02-key'} as never,
      ),
    ).resolves.toBe(true);

    expect(fetcher).toHaveBeenCalledWith(
      'http://orchestrator:3100/v1/playback',
      expect.objectContaining({redirect: 'error'}),
    );
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'ok',
      allowedMentions: {parse: []},
    });
  });
});


describe('bot-two deployment overlay', () => {
  it('activates only the orchestrator and muse-02', async () => {
    const compose = await readFile(
      new URL('../deploy/docker-compose.bot-two-playback.yml', import.meta.url),
      'utf8',
    );

    expect(compose).toContain('MUSE_BOT_TWO_PLAYBACK: "true"');
    expect(compose).toContain('muse-02:');
    expect(compose).not.toContain('muse-03:');
    expect(compose).not.toContain('muse-04:');
    expect(compose).not.toContain('muse-05:');
  });
});
