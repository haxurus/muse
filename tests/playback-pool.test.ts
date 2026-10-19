import {Readable} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import PlaybackPool, {POOL_LEASE_MS} from '../src/orchestrator/playback-pool.js';
import type {SettledStatus} from '../src/orchestrator/plan-service.js';
import {routePoolInteraction, type PoolAnswer} from '../src/playback/pool.js';
import {handlePlaybackInteraction} from '../src/playback/controller.js';
import {isPlaybackExecutorEnabled} from '../src/playback/protocol.js';
import type Config from '../src/services/config.js';

const guildId = '223456789012345678';
const channelA = '423456789012345671';
const channelB = '423456789012345672';
const channelC = '423456789012345673';

const workers = ['muse-01', 'muse-02', 'muse-03'].map(id => ({id, baseUrl: `http://${id}:3101`, token: `${id}-token`}));

const status = (workerId: string, botNumber: number, voiceChannelId: string | null = null, inGuild = true): SettledStatus => ({
  workerId,
  ok: true,
  value: {
    workerId,
    discordReady: true,
    bot: {id: `90000000000000000${botNumber}`, username: workerId},
    guilds: inGuild ? [{id: guildId, name: 'Guild'}] : [],
    players: voiceChannelId ? [{guildId, connected: true, channelId: voiceChannelId, status: 'PLAYING'}] : [],
    uptimeSeconds: 1,
  },
});

const makePool = (statuses: SettledStatus[], allowed = ['muse-01', 'muse-02', 'muse-03']) => {
  let now = 1_000_000;
  const pool = new PlaybackPool(workers, async () => statuses, () => allowed, () => now);
  return {pool, advance: (ms: number) => {
    now += ms;
  }};
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('playback pool assignment', () => {
  it('serves a channel with the bot already in it', async () => {
    const {pool} = makePool([status('muse-01', 1, channelB), status('muse-02', 2, channelA), status('muse-03', 3)]);
    expect(await pool.assign(guildId, channelA, 'control', 'muse-01')).toEqual({workerId: 'muse-02', botId: '900000000000000002', reason: 'in-channel'});
    expect(await pool.assign(guildId, channelA, 'play', 'muse-03')).toMatchObject({workerId: 'muse-02'});
  });

  it('prefers the command-receiving bot when it is free, then configuration order', async () => {
    const {pool} = makePool([status('muse-01', 1), status('muse-02', 2), status('muse-03', 3)]);
    expect(await pool.assign(guildId, channelA, 'play', 'muse-03')).toMatchObject({workerId: 'muse-03', reason: 'free'});
    expect(await pool.assign(guildId, channelB, 'play', 'muse-03')).toMatchObject({workerId: 'muse-01', reason: 'free'});
  });

  it('reserves a free bot so two channels never get the same one', async () => {
    const {pool} = makePool([status('muse-01', 1), status('muse-02', 2)], ['muse-01', 'muse-02']);
    const [first, second] = await Promise.all([
      pool.assign(guildId, channelA, 'play', 'muse-01'),
      pool.assign(guildId, channelB, 'play', 'muse-01'),
    ]);
    expect(first?.workerId).toBe('muse-01');
    expect(second?.workerId).toBe('muse-02');
    expect(await pool.assign(guildId, channelA, 'control', 'muse-02')).toMatchObject({workerId: 'muse-01', reason: 'reserved'});
    await expect(pool.assign(guildId, channelC, 'play', 'muse-01')).rejects.toMatchObject({statusCode: 409, code: 'ALL_BOTS_BUSY'});
  });

  it('frees a reservation when it expires or the bot leaves', async () => {
    const {pool, advance} = makePool([status('muse-01', 1)], ['muse-01']);
    await pool.assign(guildId, channelA, 'play', 'muse-01');
    await expect(pool.assign(guildId, channelB, 'play', 'muse-01')).rejects.toMatchObject({code: 'ALL_BOTS_BUSY'});
    advance(POOL_LEASE_MS + 1);
    expect(await pool.assign(guildId, channelB, 'play', 'muse-01')).toMatchObject({workerId: 'muse-01'});
    pool.release(guildId, 'muse-01');
    expect(await pool.assign(guildId, channelC, 'play', 'muse-01')).toMatchObject({workerId: 'muse-01'});
  });

  it('only assigns bots that are in the server and included in its plan', async () => {
    const {pool} = makePool([status('muse-01', 1, null, false), status('muse-02', 2), status('muse-03', 3)], ['muse-03']);
    expect(await pool.assign(guildId, channelA, 'play', 'muse-01')).toMatchObject({workerId: 'muse-03'});
    expect(await pool.assign(guildId, channelB, 'control', 'muse-01')).toBeNull();
  });

  it('authenticates the calling worker and answers the assignment route', async () => {
    const {pool} = makePool([status('muse-01', 1), status('muse-02', 2)]);
    const request = (token: string, body: unknown) => Object.assign(Readable.from([JSON.stringify(body)]), {
      url: '/v1/playback/assign',
      method: 'POST',
      headers: {authorization: `Bearer ${token}`},
    });
    const response = () => ({writeHead: vi.fn(), end: vi.fn()});

    await expect(pool.handle(request('nope', {}) as never, response() as never)).rejects.toMatchObject({statusCode: 401});
    await expect(pool.handle(request('muse-02-token', {guildId, voiceChannelId: 'x', intent: 'play'}) as never, response() as never))
      .rejects.toMatchObject({statusCode: 400});

    const ok = response();
    expect(await pool.handle(request('muse-02-token', {guildId, voiceChannelId: channelA, intent: 'play'}) as never, ok as never)).toBe(true);
    expect(JSON.parse(String(ok.end.mock.calls[0][0]))).toEqual({workerId: 'muse-02', botId: '900000000000000002', reason: 'free'});
    expect(await pool.handle({url: '/v1/other'} as never, response() as never)).toBe(false);
  });
});

describe('playback pool routing on the command-receiving bot', () => {
  const config = {WORKER_ID: 'muse-01', CONTROL_TOKEN: 'muse-01-token'} as unknown as Config;

  const interaction = (commandName: string, voiceChannelId: string | null = channelA) => {
    const reply = vi.fn(async () => undefined);
    const deferReply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
    return {
      reply,
      deferReply,
      editReply,
      id: '123456789012345678',
      guildId,
      channelId: '523456789012345678',
      commandName,
      user: {id: '323456789012345678'},
      guild: {voiceStates: {cache: new Map(voiceChannelId ? [['323456789012345678', {channelId: voiceChannelId}]] : [])}},
      options: {getString: () => 'song', getBoolean: () => null, getInteger: () => null},
      isChatInputCommand: () => true,
      inGuild: () => true,
    };
  };

  const deps = (answer: PoolAnswer, ownVoiceChannel: string | null = null) => ({
    ownVoiceChannel: () => ownVoiceChannel,
    resolveLocale: async () => 'en' as const,
    assign: vi.fn(async () => answer),
    relay: vi.fn(async () => ({workerId: 'muse-02' as const, requestId: '123456789012345678', guildId, channelId: channelA, state: 'PLAYING' as const, message: 'Command completed.'})),
  });

  it('is off unless MUSE_PLAYBACK_POOL is true', async () => {
    const routing = deps({kind: 'assigned', workerId: 'muse-02', botId: null});
    expect(await routePoolInteraction(interaction('play') as never, config, routing)).toBe(false);
    expect(routing.assign).not.toHaveBeenCalled();
    vi.stubEnv('MUSE_PLAYBACK_POOL', 'true');
    expect(isPlaybackExecutorEnabled('muse-04')).toBe(true);
    // The pool supersedes the pilots' own interception.
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    expect(await handlePlaybackInteraction(interaction('play') as never, config)).toBe(false);
  });

  it('runs locally when this bot is in the channel, is the assigned one, or the orchestrator is down', async () => {
    vi.stubEnv('MUSE_PLAYBACK_POOL', 'true');
    const local = deps({kind: 'assigned', workerId: 'muse-02', botId: null}, channelA);
    expect(await routePoolInteraction(interaction('pause') as never, config, local)).toBe(false);
    expect(local.assign).not.toHaveBeenCalled();

    expect(await routePoolInteraction(interaction('play') as never, config, deps({kind: 'assigned', workerId: 'muse-01', botId: null}))).toBe(false);
    expect(await routePoolInteraction(interaction('play') as never, config, deps({kind: 'unavailable'}))).toBe(false);
    expect(await routePoolInteraction(interaction('play', null) as never, config, deps({kind: 'busy'}))).toBe(false);
    expect(await routePoolInteraction(interaction('config') as never, config, deps({kind: 'busy'}))).toBe(false);
  });

  it('relays supported commands to the assigned bot', async () => {
    vi.stubEnv('MUSE_PLAYBACK_POOL', 'true');
    const routing = deps({kind: 'assigned', workerId: 'muse-02', botId: '900000000000000002'}, channelB);
    const command = interaction('play');
    expect(await routePoolInteraction(command as never, config, routing)).toBe(true);
    expect(routing.assign).toHaveBeenCalledWith('muse-01-token', {guildId, voiceChannelId: channelA, intent: 'play'});
    expect(routing.relay).toHaveBeenCalledWith(expect.stringContaining('/v1/playback'), 'muse-01-token', expect.objectContaining({action: 'play', query: 'song', voiceChannelId: channelA}), null);
    expect(command.editReply).toHaveBeenCalledWith({content: 'Command completed.', allowedMentions: {parse: []}});
  });

  it('points other player commands at the bot in the channel and reports busy or empty channels', async () => {
    vi.stubEnv('MUSE_PLAYBACK_POOL', 'true');
    const shuffle = interaction('shuffle');
    expect(await routePoolInteraction(shuffle as never, config, deps({kind: 'assigned', workerId: 'muse-02', botId: '900000000000000002'}))).toBe(true);
    expect(shuffle.reply).toHaveBeenCalledWith(expect.objectContaining({content: expect.stringContaining('<@900000000000000002>'), ephemeral: true}));

    const busy = interaction('play');
    expect(await routePoolInteraction(busy as never, config, deps({kind: 'busy'}))).toBe(true);
    expect(busy.reply).toHaveBeenCalledWith(expect.objectContaining({content: expect.stringContaining('busy')}));

    // This bot plays elsewhere: it must not pause its own channel for a user in another one.
    const pause = interaction('pause');
    expect(await routePoolInteraction(pause as never, config, deps({kind: 'none'}, channelB))).toBe(true);
    expect(pause.reply).toHaveBeenCalledWith(expect.objectContaining({content: expect.stringContaining('No Muse bot')}));
  });
});
