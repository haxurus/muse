import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {handlePlaybackProxy, sendPlayback} from '../src/playback/transport.js';
import {handlePlaybackInteraction} from '../src/playback/controller.js';
import {isPlaybackWorkerEnabled, isPlaybackWorkerId, parsePlaybackRequest, type PlaybackResult, type PlaybackWorkerId} from '../src/playback/protocol.js';

const workers = ['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05'] as const;
const flags = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'] as const;
const ids = {
  requestId: '123456789012345678', guildId: '223456789012345678',
  userId: '323456789012345678', voiceChannelId: '423456789012345678',
  textChannelId: '523456789012345678',
};
const request = parsePlaybackRequest({...ids, action: 'queue', page: 1});
const result = (workerId: PlaybackWorkerId = 'muse-05'): PlaybackResult => ({
  workerId, guildId: ids.guildId, requestId: ids.requestId,
  channelId: ids.voiceChannelId, state: 'PLAYING', message: 'ok',
});
const config = {
  host: '127.0.0.1', port: 3100, groupsFile: '/state/groups.json', apiToken: 'test-admin-key',
  workers: ['01', '02', '03', '04', '05'].map(number => ({
    id: `muse-${number}`, baseUrl: `http://muse-${number}:3101`, token: `test-worker-${number}-key`,
  })),
};
const incoming = (token: string, body: unknown = request, method = 'POST') => Object.assign(
  Readable.from([JSON.stringify(body)]),
  {url: '/v1/playback', method, headers: {authorization: `Bearer ${token}`}},
);
const outgoing = () => ({writeHead: vi.fn(), end: vi.fn()});
const enableAll = () => {
  for (const flag of flags) {
    vi.stubEnv(`MUSE_BOT_${flag}_PLAYBACK`, 'true');
  }
};

beforeEach(() => {
  for (const flag of flags) {
    vi.stubEnv(`MUSE_BOT_${flag}_PLAYBACK`, 'false');
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('five-worker independent activation', () => {
  it.each(Array.from({length: 32}, (_, mask) => mask))('honors every independent flag combination including all-off: %s', mask => {
    const enabled = workers.map((_workerId, index) => Math.floor(mask / (2 ** index)) % 2 === 1);
    flags.forEach((flag, index) => vi.stubEnv(`MUSE_BOT_${flag}_PLAYBACK`, String(enabled[index])));
    workers.forEach((workerId, index) => {
      expect(isPlaybackWorkerId(workerId)).toBe(true);
      expect(isPlaybackWorkerEnabled(workerId)).toBe(enabled[index]);
    });
    vi.stubEnv('MUSE_BOT_SIX_PLAYBACK', 'true');
    for (const workerId of ['muse-06', 'muse-99', 'muse-5', 'MUSE-05', '']) {
      expect(isPlaybackWorkerId(workerId)).toBe(false);
      expect(isPlaybackWorkerEnabled(workerId)).toBe(false);
    }
  });

  it.each(['1', 'TRUE', 'yes', ' true ', 'false', ''])('refuses noncanonical bot 05 opt-in value %s', value => {
    vi.stubEnv('MUSE_BOT_FIVE_PLAYBACK', value);
    expect(isPlaybackWorkerEnabled('muse-05')).toBe(false);
  });
});

describe('five-worker private routing', () => {
  it.each(workers)('routes %s only to its authenticated destination with all five enabled', async workerId => {
    enableAll();
    const worker = config.workers.find(candidate => candidate.id === workerId)!;
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify(result(workerId))));
    vi.stubGlobal('fetch', fetcher);
    const response = outgoing();
    await expect(handlePlaybackProxy(incoming(worker.token) as never, response as never, config)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(`${worker.baseUrl}/v1/playback`, expect.objectContaining({
      method: 'POST', redirect: 'error',
      headers: {'content-type': 'application/json', authorization: `Bearer ${worker.token}`},
    }));
    const body = fetcher.mock.calls[0][1].body as string;
    expect(JSON.parse(body)).toEqual(request);
    for (const credential of [...config.workers.map(candidate => candidate.token), config.apiToken]) {
      expect(body).not.toContain(credential);
    }
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(result(workerId)));
  });

  it.each(['test-admin-key', 'test-worker-01-key', 'test-worker-02-key', 'test-worker-03-key', 'test-worker-04-key', 'wrong'])('rejects credential %s with only bot 05 enabled', async token => {
    vi.stubEnv('MUSE_BOT_FIVE_PLAYBACK', 'true');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming(token) as never, outgoing() as never, config))
      .rejects.toMatchObject({statusCode: 401});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects bot 05 credentials when only the first four pilots are enabled', async () => {
    for (const flag of flags.slice(0, 4)) {
      vi.stubEnv(`MUSE_BOT_${flag}_PLAYBACK`, 'true');
    }
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming('test-worker-05-key') as never, outgoing() as never, config))
      .rejects.toMatchObject({statusCode: 401});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a credential for a worker absent from the configured registry', async () => {
    enableAll();
    const absent = {...config, workers: config.workers.filter(worker => worker.id !== 'muse-05')};
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming('test-worker-05-key') as never, outgoing() as never, absent))
      .rejects.toMatchObject({statusCode: 401});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['muse-01', 'muse-02', 'muse-03', 'muse-04'])('refuses ambiguous credentials shared with %s', async otherId => {
    enableAll();
    const conflicting = {...config, workers: config.workers.map(worker => (
      worker.id === otherId ? {...worker, token: 'test-worker-05-key'} : worker
    ))};
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming('test-worker-05-key') as never, outgoing() as never, conflicting))
      .rejects.toMatchObject({statusCode: 401});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{workerId: 'muse-01'}, {workerId: 'muse-04'}, {token: 'unexpected'}, {url: 'http://muse-01:3101/v1/playback'}])('rejects caller-supplied routing or credential fields %o', async fields => {
    enableAll();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming('test-worker-05-key', {...request, ...fields}) as never, outgoing() as never, config))
      .rejects.toMatchObject({statusCode: 400});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a non-POST mutation before forwarding', async () => {
    vi.stubEnv('MUSE_BOT_FIVE_PLAYBACK', 'true');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming('test-worker-05-key', request, 'GET') as never, outgoing() as never, config))
      .rejects.toMatchObject({statusCode: 405});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {workerId: 'muse-01'}, {workerId: 'muse-02'}, {workerId: 'muse-03'}, {workerId: 'muse-04'},
    {guildId: '923456789012345678'}, {requestId: '823456789012345678'},
  ])('rejects mismatched response identity %o', async mismatch => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({...result(), ...mismatch}))));
    await expect(sendPlayback('http://orchestrator:3100/v1/playback', 'test-worker-05-key', request, 'muse-05'))
      .rejects.toMatchObject({statusCode: 504});
  });

  it('does not retry an uncertain mutation locally or on another bot', async () => {
    enableAll();
    const fetcher = vi.fn(async () => { throw new Error('private network detail'); });
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming('test-worker-05-key') as never, outgoing() as never, config))
      .rejects.toThrow(/No local fallback or automatic replay/);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('http://muse-05:3101/v1/playback', expect.anything());
  });
});

describe('bot-five Discord controller', () => {
  it.each(['play', 'pause', 'resume', 'skip', 'next', 'stop', 'disconnect', 'queue', 'volume'])('forwards /%s without transferring Discord credentials', async commandName => {
    vi.stubEnv('MUSE_BOT_FIVE_PLAYBACK', 'true');
    const events: string[] = [];
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      events.push('fetch');
      const sent = JSON.parse(options.body as string);
      expect(sent.action).toBe(commandName === 'next' ? 'skip' : commandName);
      expect(sent).toMatchObject(ids);
      expect(options.body).not.toContain('private-interaction-token');
      expect(options.body).not.toContain('private-discord-token');
      expect(sent).not.toHaveProperty('workerId');
      return new Response(JSON.stringify(result()));
    });
    vi.stubGlobal('fetch', fetcher);
    const interaction = {
      token: 'private-interaction-token', id: ids.requestId, guildId: ids.guildId,
      channelId: ids.textChannelId, user: {id: ids.userId},
      guild: {voiceStates: {cache: new Map([[ids.userId, {channelId: ids.voiceChannelId}]])}},
      commandName, isButton: () => false, isChatInputCommand: () => true,
      options: {
        getString: () => 'song', getBoolean: () => null,
        getInteger: (name: string) => name === 'level' ? 65 : name === 'number' ? 2 : null,
      },
      deferReply: vi.fn(async () => { events.push('defer'); }),
      editReply: vi.fn(async () => undefined),
    };
    await expect(handlePlaybackInteraction(interaction as never, {
      WORKER_ID: 'muse-05', CONTROL_TOKEN: 'test-worker-05-key', DISCORD_TOKEN: 'private-discord-token',
    } as never)).resolves.toBe(true);
    expect(events).toEqual(['defer', 'fetch']);
    expect(interaction.editReply).toHaveBeenCalledWith({content: 'ok', allowedMentions: {parse: []}});
  });

  it('keeps bot 05 on its local command path without its own flag', async () => {
    for (const flag of flags.slice(0, 4)) {
      vi.stubEnv(`MUSE_BOT_${flag}_PLAYBACK`, 'true');
    }
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackInteraction({} as never, {WORKER_ID: 'muse-05'} as never)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('bot-five overlay scope', () => {
  it('changes only the orchestrator and bot 05 environments', async () => {
    const overlay = await readFile(new URL('../deploy/docker-compose.bot-five-playback.yml', import.meta.url), 'utf8');
    expect([...overlay.matchAll(/^  ([a-z0-9-]+):$/gm)].map(match => match[1])).toEqual(['orchestrator', 'muse-05']);
    expect(overlay.match(/MUSE_BOT_FIVE_PLAYBACK: "true"/g)).toHaveLength(2);
    expect(overlay).not.toMatch(/\b(?:ports|secrets|volumes|networks|privileged):/);
    for (const flag of flags.slice(0, 4)) {
      expect(overlay).not.toContain(`MUSE_BOT_${flag}_PLAYBACK`);
    }
  });
});
