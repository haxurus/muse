import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {handlePlaybackProxy, sendPlayback} from '../src/playback/transport.js';
import {handlePlaybackInteraction} from '../src/playback/controller.js';
import {isPlaybackWorkerEnabled, isPlaybackWorkerId, parsePlaybackRequest, type PlaybackResult, type PlaybackWorkerId} from '../src/playback/protocol.js';

const ids = {
  requestId: '123456789012345678', guildId: '223456789012345678',
  userId: '323456789012345678', voiceChannelId: '423456789012345678',
  textChannelId: '523456789012345678',
};
const request = parsePlaybackRequest({...ids, action: 'queue', page: 1});
const result = (workerId: PlaybackWorkerId = 'muse-03'): PlaybackResult => ({
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
const enableFirstThree = () => {
  for (const name of ['ONE', 'TWO', 'THREE']) {
    vi.stubEnv(`MUSE_BOT_${name}_PLAYBACK`, 'true');
  }
};

beforeEach(() => {
  for (const name of ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']) {
    vi.stubEnv(`MUSE_BOT_${name}_PLAYBACK`, 'false');
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('bot-three playback activation', () => {
  it('recognizes bot 03 but keeps every pilot disabled by default', () => {
    expect(isPlaybackWorkerId('muse-03')).toBe(true);
    for (const worker of config.workers) {
      expect(isPlaybackWorkerEnabled(worker.id)).toBe(false);
    }
  });

  it('enables only bot 03 with its own flag', () => {
    vi.stubEnv('MUSE_BOT_THREE_PLAYBACK', 'true');
    expect(isPlaybackWorkerEnabled('muse-03')).toBe(true);
    for (const id of ['muse-01', 'muse-02', 'muse-04', 'muse-05', '', 'muse-99']) {
      expect(isPlaybackWorkerEnabled(id)).toBe(false);
    }
  });

  it('does not enable bot 03 through the first two flags', () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    vi.stubEnv('MUSE_BOT_TWO_PLAYBACK', 'true');
    expect(isPlaybackWorkerEnabled('muse-03')).toBe(false);
  });

  it('keeps bots 04 and 05 disabled without their own flags', () => {
    enableFirstThree();
    for (const workerId of ['muse-04', 'muse-05']) {
      expect(isPlaybackWorkerId(workerId)).toBe(true);
      expect(isPlaybackWorkerEnabled(workerId)).toBe(false);
    }
  });
});

describe('bot-three private routing', () => {
  it.each(['muse-01', 'muse-02', 'muse-03'] as const)('routes %s only to its authenticated destination with all three enabled', async workerId => {
    enableFirstThree();
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
    const sent = fetcher.mock.calls[0][1];
    expect(JSON.parse(sent.body as string)).toEqual(request);
    expect(sent.body).not.toContain(worker.token);
    expect(sent.body).not.toContain(config.apiToken);
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(result(workerId)));
  });

  it.each(['test-admin-key', 'test-worker-01-key', 'test-worker-02-key', 'test-worker-04-key', 'test-worker-05-key', 'wrong'])('rejects credential %s when only bot 03 is enabled', async token => {
    vi.stubEnv('MUSE_BOT_THREE_PLAYBACK', 'true');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming(token) as never, outgoing() as never, config))
      .rejects.toMatchObject({statusCode: 401});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses bot 03 credentials when its pilot is disabled', async () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming('test-worker-03-key') as never, outgoing() as never, config))
      .rejects.toMatchObject({statusCode: 401});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed if enabled workers share the same control credential', async () => {
    enableFirstThree();
    const conflicting = {...config, workers: config.workers.map(worker => (
      worker.id === 'muse-01' ? {...worker, token: 'test-worker-03-key'} : worker
    ))};
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming('test-worker-03-key') as never, outgoing() as never, conflicting))
      .rejects.toMatchObject({statusCode: 401});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not accept a caller-supplied target worker', async () => {
    enableFirstThree();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const forged = incoming('test-worker-03-key', {...request, workerId: 'muse-01'});
    await expect(handlePlaybackProxy(forged as never, outgoing() as never, config))
      .rejects.toMatchObject({statusCode: 400});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {workerId: 'muse-01'}, {workerId: 'muse-02'},
    {guildId: '923456789012345678'}, {requestId: '823456789012345678'},
  ])('rejects a mismatched response identity %o', async mismatch => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({...result(), ...mismatch}))));
    await expect(sendPlayback('http://orchestrator:3100/v1/playback', 'test-worker-03-key', request, 'muse-03'))
      .rejects.toMatchObject({statusCode: 504});
  });

  it('never retries an uncertain mutation on another bot', async () => {
    vi.stubEnv('MUSE_BOT_THREE_PLAYBACK', 'true');
    const fetcher = vi.fn(async () => { throw new Error('private network detail'); });
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackProxy(incoming('test-worker-03-key') as never, outgoing() as never, config))
      .rejects.toThrow(/No local fallback or automatic replay/);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('http://muse-03:3101/v1/playback', expect.anything());
  });
});

describe('bot-three Discord controller', () => {
  it.each(['play', 'pause', 'resume', 'skip', 'next', 'stop', 'disconnect', 'queue', 'volume'])('forwards /%s without transferring Discord credentials', async commandName => {
    vi.stubEnv('MUSE_BOT_THREE_PLAYBACK', 'true');
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
      WORKER_ID: 'muse-03', CONTROL_TOKEN: 'test-worker-03-key', DISCORD_TOKEN: 'private-discord-token',
    } as never)).resolves.toBe(true);
    expect(events).toEqual(['defer', 'fetch']);
    expect(interaction.editReply).toHaveBeenCalledWith({content: 'ok', allowedMentions: {parse: []}});
  });

  it.each(['muse-04', 'muse-05'])('leaves %s on its unchanged local command path', async workerId => {
    enableFirstThree();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(handlePlaybackInteraction({} as never, {WORKER_ID: workerId} as never)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('bot-three overlay scope', () => {
  it('changes only the orchestrator and bot 03 without adding a service or credential mount', async () => {
    const overlay = await readFile(new URL('../deploy/docker-compose.bot-three-playback.yml', import.meta.url), 'utf8');
    const services = [...overlay.matchAll(/^  ([a-z0-9-]+):$/gm)].map(match => match[1]);
    expect(services).toEqual(['orchestrator', 'muse-03']);
    expect(overlay.match(/MUSE_BOT_THREE_PLAYBACK: "true"/g)).toHaveLength(2);
    expect(overlay).not.toMatch(/\b(?:ports|secrets|volumes|networks|privileged):/);
    expect(overlay).not.toContain('MUSE_BOT_ONE_PLAYBACK');
    expect(overlay).not.toContain('MUSE_BOT_TWO_PLAYBACK');
  });
});
