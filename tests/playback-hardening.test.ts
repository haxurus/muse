import {Readable} from 'node:stream';
import {ChannelType, PermissionFlagsBits} from 'discord.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type AddQueryToQueue from '../src/services/add-query-to-queue.js';
import {STATUS} from '../src/services/player-types.js';
import PlaybackGate from '../src/playback/gate.js';
import PlaybackWorker, {describePlaybackError} from '../src/playback/worker.js';
import {handlePlaybackProxy, sendPlayback} from '../src/playback/transport.js';
import {handleBotOneInteraction, handlePlaybackInteraction} from '../src/playback/controller.js';
import {
  PLAYBACK_OUTCOME_UNKNOWN_MESSAGE,
  parsePlaybackRequest,
  resolveOrchestratorPlaybackUrl,
  type PlaybackResult,
} from '../src/playback/protocol.js';

vi.mock('../src/utils/get-guild-settings.js', () => ({getGuildSettings: async () => ({defaultQueuePageSize: 5})}));

const ids = {
  requestId: '123456789012345678', guildId: '223456789012345678', userId: '323456789012345678',
  voiceChannelId: '423456789012345678', textChannelId: '523456789012345678',
};
const pause = (patch: Partial<typeof ids> = {}) => parsePlaybackRequest({...ids, ...patch, action: 'pause'});
const result = (patch: Partial<PlaybackResult> = {}): PlaybackResult => ({
  workerId: 'muse-01', guildId: ids.guildId, requestId: ids.requestId,
  channelId: ids.voiceChannelId, state: 'PLAYING', message: 'ok', ...patch,
});
const orchestratorUrl = 'http://orchestrator:3100/v1/playback';
const jsonResponse = (body: unknown, status: number) => new Response(JSON.stringify(body), {status});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('unknown playback outcome (HIGH-1)', () => {
  it('reports an unconfirmed outcome as 504 and tells the user to check /queue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('socket hang up');
    }));
    await expect(sendPlayback(orchestratorUrl, 'key', pause())).rejects.toMatchObject({
      statusCode: 504,
      message: PLAYBACK_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(PLAYBACK_OUTCOME_UNKNOWN_MESSAGE).toMatch(/Check \/queue before retrying/);
  });

  it('keeps an orchestrator 504 distinct from a 503 "not ready" error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({error: PLAYBACK_OUTCOME_UNKNOWN_MESSAGE}, 504)));
    await expect(sendPlayback(orchestratorUrl, 'key', pause())).rejects.toMatchObject({statusCode: 504, message: PLAYBACK_OUTCOME_UNKNOWN_MESSAGE});

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({error: 'Discord is not ready.'}, 503)));
    await expect(sendPlayback(orchestratorUrl, 'key', pause())).rejects.toMatchObject({statusCode: 503, message: 'The bot is not ready. Try again later.'});
  });

  it('returns 504 from the orchestrator when the worker hop is unconfirmed', async () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('timeout');
    }));
    const incoming = Object.assign(Readable.from([JSON.stringify(pause())]), {
      url: '/v1/playback', method: 'POST', headers: {authorization: `Bearer ${'a'.repeat(32)}`},
    });
    const config = {
      host: '127.0.0.1', port: 3100, groupsFile: '/state/groups.json', apiToken: 'b'.repeat(32),
      workers: [{id: 'muse-01', baseUrl: 'http://muse-01:3101', token: 'a'.repeat(32)}],
    };
    await expect(handlePlaybackProxy(incoming as never, {writeHead: vi.fn(), end: vi.fn()} as never, config))
      .rejects.toMatchObject({statusCode: 504, message: PLAYBACK_OUTCOME_UNKNOWN_MESSAGE});
  });
});

describe('trusted error message propagation (MEDIUM-5)', () => {
  it('passes short safe 4xx messages through and falls back to fixed messages otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({error: 'No songs were found for that query.'}, 404)));
    await expect(sendPlayback(orchestratorUrl, 'key', pause())).rejects.toMatchObject({statusCode: 404, message: 'No songs were found for that query.'});

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({error: 'see https://provider.invalid/?sig=secret'}, 409)));
    await expect(sendPlayback(orchestratorUrl, 'key', pause())).rejects.toMatchObject({statusCode: 409, message: 'The bot is busy or belongs to another voice channel in this server.'});

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({error: 'x'.repeat(201)}, 400)));
    await expect(sendPlayback(orchestratorUrl, 'key', pause())).rejects.toMatchObject({statusCode: 400, message: 'Invalid playback request.'});

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({error: 'unauthorized'}, 401)));
    await expect(sendPlayback(orchestratorUrl, 'key', pause())).rejects.toMatchObject({statusCode: 401, message: 'Playback service authentication failed.'});

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', {status: 409})));
    await expect(sendPlayback(orchestratorUrl, 'key', pause())).rejects.toMatchObject({statusCode: 409, message: 'The bot is busy or belongs to another voice channel in this server.'});
  });

  it('redacts URLs and credential-like words from logged worker errors', () => {
    const description = describePlaybackError(new TypeError('failed secret-token=abc https://cdn.invalid/x?key=1 Bearer abc.def'));
    expect(description).toMatch(/^TypeError: /);
    expect(description).not.toMatch(/abc|cdn\.invalid|secret/);
  });
});

describe('Discord controller user-visible messages', () => {
  const interaction = () => ({
    id: ids.requestId, guildId: ids.guildId, channelId: ids.textChannelId,
    user: {id: ids.userId}, guild: {voiceStates: {cache: new Map([[ids.userId, {channelId: ids.voiceChannelId}]])}},
    commandName: 'pause', isButton: () => false, isChatInputCommand: () => true,
    options: {getString: () => null, getBoolean: () => null, getInteger: () => null},
    deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined),
  });
  const config = {WORKER_ID: 'muse-01', CONTROL_TOKEN: 'a'.repeat(32)};

  it.each([
    ['a network failure', async () => {
      throw new Error('socket hang up');
    }],
    ['an orchestrator 504', async () => jsonResponse({error: PLAYBACK_OUTCOME_UNKNOWN_MESSAGE}, 504)],
  ])('tells the user the outcome is unknown after %s', async (_label, fetcher) => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(fetcher));
    const discord = interaction();
    await expect(handlePlaybackInteraction(discord as never, config as never)).resolves.toBe(true);
    expect(discord.editReply).toHaveBeenLastCalledWith({content: PLAYBACK_OUTCOME_UNKNOWN_MESSAGE, allowedMentions: {parse: []}});
    expect(discord.editReply).not.toHaveBeenCalledWith(expect.objectContaining({content: expect.stringMatching(/not ready/) as unknown}));
  });

  it('shows the not-ready message only for 503', async () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({error: 'Discord is not ready.'}, 503)));
    const discord = interaction();
    await handlePlaybackInteraction(discord as never, config as never);
    expect(discord.editReply).toHaveBeenLastCalledWith({content: 'The bot is not ready. Try again later.', allowedMentions: {parse: []}});
  });

  it('uses MUSE_ORCHESTRATOR_URL and keeps the legacy export name', async () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    vi.stubEnv('MUSE_ORCHESTRATOR_URL', 'https://orchestrator.internal:9443/base/');
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => jsonResponse(result({message: 'Playback paused.'}), 200));
    vi.stubGlobal('fetch', fetcher);
    const discord = interaction();
    await expect(handleBotOneInteraction(discord as never, config as never)).resolves.toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe('https://orchestrator.internal:9443/base/v1/playback');
    expect(discord.editReply).toHaveBeenLastCalledWith({content: 'Playback paused.', allowedMentions: {parse: []}});
  });

  it('validates the orchestrator URL', () => {
    expect(resolveOrchestratorPlaybackUrl(undefined)).toBe(orchestratorUrl);
    expect(resolveOrchestratorPlaybackUrl('  ')).toBe(orchestratorUrl);
    for (const invalid of ['ftp://orchestrator', 'not a url', 'http://user:pass@orchestrator:3100', 'http://orchestrator:3100/?x=1']) {
      expect(() => resolveOrchestratorPlaybackUrl(invalid)).toThrow(/MUSE_ORCHESTRATOR_URL/);
    }
  });
});

describe('playback gate limits, TTL and deadline (MEDIUM-1, MEDIUM-2)', () => {
  it('does not count completed requests toward global or per-guild capacity', async () => {
    const gate = new PlaybackGate(2);
    for (let index = 0; index < 5; index++) {
      // eslint-disable-next-line no-await-in-loop
      await expect(gate.run(pause({guildId: `22345678901234567${index}`}), async () => result())).resolves.toBeTruthy();
    }

    const perGuild = new PlaybackGate();
    for (let index = 0; index < 70; index++) {
      // eslint-disable-next-line no-await-in-loop
      await expect(perGuild.run(pause({requestId: `1234567890123456${String(index).padStart(2, '0')}`}), async () => result())).resolves.toBeTruthy();
    }
  });

  it('keeps completed results for about a minute only', async () => {
    vi.useFakeTimers();
    const gate = new PlaybackGate();
    const operation = vi.fn(async () => result());
    await gate.run(pause(), operation);
    vi.advanceTimersByTime(59_000);
    await gate.run(pause(), operation);
    expect(operation).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    await gate.run(pause(), operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('neither deduplicates nor blocks the read-only queue action', async () => {
    const gate = new PlaybackGate();
    let finish!: (value: PlaybackResult) => void;
    const pending = gate.run(pause(), async () => new Promise(resolve => {
      finish = resolve;
    }));
    const queue = parsePlaybackRequest({...ids, requestId: '623456789012345678', action: 'queue'});
    const operation = vi.fn(async () => result());
    await gate.run(queue, operation);
    await gate.run(queue, operation);
    expect(operation).toHaveBeenCalledTimes(2);
    finish(result());
    await pending;
  });

  it('frees the guild slot at the hard deadline and reports an unknown outcome', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = new PlaybackGate(512, 60_000, 1000);
    const stuck = gate.run(pause(), async () => new Promise<PlaybackResult>(() => undefined));
    const assertion = expect(stuck).rejects.toMatchObject({statusCode: 504, message: PLAYBACK_OUTCOME_UNKNOWN_MESSAGE});
    expect(() => gate.run(pause({requestId: '623456789012345678'}), async () => result())).toThrow(/still running/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(warn).toHaveBeenCalledOnce();
    await expect(gate.run(pause({requestId: '623456789012345678'}), async () => result())).resolves.toBeTruthy();
  });
});

type Options = Parameters<AddQueryToQueue['addToQueue']>[0];
const makeHarness = (connected: boolean) => {
  const member = {user: {bot: false, id: ids.userId}, voice: {channelId: ids.voiceChannelId}};
  const permissions = {has: vi.fn((_flags: unknown) => true)};
  const voice = {
    id: ids.voiceChannelId, guildId: ids.guildId, type: ChannelType.GuildVoice as ChannelType,
    userLimit: 0, members: {size: 0}, permissionsFor: () => permissions,
  };
  const text = {id: ids.textChannelId, guildId: ids.guildId, type: ChannelType.GuildText, permissionsFor: () => permissions};
  const guild = {
    id: ids.guildId,
    members: {me: {}, fetch: vi.fn(async () => member)},
    channels: {fetch: vi.fn(async (id: string) => id === voice.id ? voice : text)},
  };
  const client = {isReady: () => true, guilds: {cache: new Map([[ids.guildId, guild]])}};
  const player = {
    voiceConnection: connected ? {joinConfig: {channelId: ids.voiceChannelId}} : null as null | {joinConfig: {channelId: string}},
    status: STATUS.IDLE,
    queue: [] as Array<{title: string}>,
    current: null as null | {title: string},
    getQueue: () => player.queue,
    getCurrent: () => player.current,
    disconnect: vi.fn(() => {
      player.voiceConnection = null;
    }),
  };
  const enqueue = {addToQueue: vi.fn(async (_options: Options) => undefined)};
  const worker = new PlaybackWorker(client as never, {get: () => player} as never, enqueue as never, 'muse-01');
  return {worker, permissions, voice, player, enqueue};
};
const play = {...ids, action: 'play', query: 'song'};

describe('worker error mapping and partial apply (MEDIUM-5, MEDIUM-6, LOW-6)', () => {
  it('maps a known player error to a client error with a safe message', async () => {
    const h = makeHarness(false);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.enqueue.addToQueue.mockRejectedValue(new Error('no songs found'));
    await expect(h.worker.execute(play)).rejects.toMatchObject({statusCode: 404, message: 'No songs were found for that query.'});
    expect(h.player.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps the session and reports a partial outcome when songs were already queued', async () => {
    const h = makeHarness(false);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.enqueue.addToQueue.mockImplementation(async () => {
      h.player.voiceConnection = {joinConfig: {channelId: ids.voiceChannelId}};
      h.player.current = {title: 'New song'};
      throw new Error('playback start failed');
    });
    await expect(h.worker.execute(play)).resolves.toMatchObject({
      state: 'IDLE',
      channelId: ids.voiceChannelId,
      message: expect.stringMatching(/Songs were added to the queue.*Check \/queue/) as unknown,
    });
    expect(h.player.disconnect).not.toHaveBeenCalled();
  });

  it('explains unsupported voice channel types', async () => {
    const h = makeHarness(false);
    h.voice.type = ChannelType.GuildStageVoice;
    await expect(h.worker.execute(play)).rejects.toMatchObject({statusCode: 400, message: expect.stringMatching(/stage channels/) as unknown});
    expect(h.enqueue.addToQueue).not.toHaveBeenCalled();
  });

  it('refuses to join a full voice channel without Move Members', async () => {
    const h = makeHarness(false);
    h.voice.userLimit = 2;
    h.voice.members.size = 2;
    h.permissions.has.mockImplementation(flags => flags !== PermissionFlagsBits.MoveMembers);
    await expect(h.worker.execute(play)).rejects.toMatchObject({statusCode: 403, message: expect.stringMatching(/full/) as unknown});
    h.permissions.has.mockReturnValue(true);
    await expect(h.worker.execute({...play, requestId: '623456789012345678'})).resolves.toBeTruthy();
  });

  it('requires Embed Links for play announcements only', async () => {
    const h = makeHarness(true);
    h.permissions.has.mockImplementation(flags => flags !== PermissionFlagsBits.EmbedLinks);
    await expect(h.worker.execute(play)).rejects.toMatchObject({statusCode: 403, message: expect.stringMatching(/Embed Links/) as unknown});
    await expect(h.worker.execute({...ids, requestId: '623456789012345678', action: 'queue'})).resolves.toBeTruthy();
  });
});
