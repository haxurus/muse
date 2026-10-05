import {ChannelType} from 'discord.js';
import {describe, expect, it, vi} from 'vitest';
import type AddQueryToQueue from '../src/services/add-query-to-queue.js';
import {STATUS} from '../src/services/player-types.js';
import BotOnePlaybackWorker from '../src/playback/worker.js';

vi.mock('../src/utils/get-guild-settings.js', () => ({getGuildSettings: async () => ({defaultQueuePageSize: 5})}));

const ids = {
  requestId: '123456789012345678', guildId: '223456789012345678', userId: '323456789012345678',
  voiceChannelId: '423456789012345678', textChannelId: '523456789012345678',
};
type Options = Parameters<AddQueryToQueue['addToQueue']>[0];
const harness = (connected = true) => {
  const member = {user: {bot: false, id: ids.userId}, voice: {channelId: ids.voiceChannelId}};
  const permissions = {has: vi.fn(() => true)};
  const voice = {id: ids.voiceChannelId, guildId: ids.guildId, type: ChannelType.GuildVoice, permissionsFor: () => permissions};
  const text = {id: ids.textChannelId, guildId: ids.guildId, type: ChannelType.GuildText, permissionsFor: () => permissions};
  const guild = {
    id: ids.guildId,
    members: {me: {}, fetch: vi.fn(async () => member)},
    channels: {fetch: vi.fn(async (id: string) => id === voice.id ? voice : text)},
  };
  const client = {isReady: vi.fn(() => true), guilds: {cache: new Map([[ids.guildId, guild]])}};
  const player = {
    voiceConnection: connected ? {joinConfig: {channelId: ids.voiceChannelId}} : null as null | {joinConfig: {channelId: string}},
    status: STATUS.PLAYING,
    pause: vi.fn(() => { player.status = STATUS.PAUSED; }),
    play: vi.fn(async () => { player.status = STATUS.PLAYING; }),
    ensureVoiceConnectionReady: vi.fn(async () => undefined),
    forward: vi.fn(async (_amount: number) => undefined),
    setVolume: vi.fn((_volume: number) => undefined), getVolume: () => 65,
    getCurrent: () => ({title: 'Current song'}),
    getQueue: () => Array.from({length: 12}, (_, index) => ({title: `Song ${index + 1}`})),
    disconnect: vi.fn(() => { player.voiceConnection = null; }),
    stop: vi.fn(() => { player.voiceConnection = null; }),
  };
  const enqueue = {addToQueue: vi.fn(async (options: Options) => {
    await options.beforeEnqueue?.();
    player.voiceConnection = {joinConfig: {channelId: ids.voiceChannelId}};
    await options.beforeEnqueue?.();
    await options.interaction.editReply('Song added.');
  })};
  const worker = new BotOnePlaybackWorker(client as never, {get: () => player} as never, enqueue as never);
  return {worker, member, permissions, voice, text, guild, client, player, enqueue};
};

describe('bot-one worker', () => {
  it('reuses native enqueue options, rechecks permissions and never needs an interaction token', async () => {
    const h = harness(false);
    const response = await h.worker.execute({...ids, action: 'play', query: 'song', immediate: true, split: true});
    expect(response).toMatchObject({workerId: 'muse-01', channelId: ids.voiceChannelId, state: 'PLAYING', message: 'Song added.'});
    expect(h.enqueue.addToQueue).toHaveBeenCalledWith(expect.objectContaining({query: 'song', addToFrontOfQueue: true, shouldSplitChapters: true}));
    expect(h.guild.members.fetch).toHaveBeenCalledTimes(3);
    expect(h.enqueue.addToQueue.mock.calls[0][0].interaction).not.toHaveProperty('token');
  });
  it('rejects a caller from a different voice channel', async () => {
    const h = harness();
    h.member.voice.channelId = '623456789012345678';
    await expect(h.worker.execute({...ids, action: 'pause'})).rejects.toMatchObject({statusCode: 403});
    expect(h.player.pause).not.toHaveBeenCalled();
  });
  it('does not move or control a bot already playing in another channel', async () => {
    const h = harness();
    h.player.voiceConnection!.joinConfig.channelId = '623456789012345678';
    await expect(h.worker.execute({...ids, action: 'play', query: 'song'})).rejects.toMatchObject({statusCode: 409});
    expect(h.enqueue.addToQueue).not.toHaveBeenCalled();
  });
  it('rejects a text channel belonging to another guild', async () => {
    const h = harness();
    h.text.guildId = '923456789012345678';
    await expect(h.worker.execute({...ids, action: 'pause'})).rejects.toMatchObject({statusCode: 403});
    expect(h.player.pause).not.toHaveBeenCalled();
  });
  it('rejects missing channel permissions and an unready Discord client', async () => {
    const h = harness();
    h.permissions.has.mockReturnValue(false);
    await expect(h.worker.execute({...ids, action: 'stop'})).rejects.toMatchObject({statusCode: 403});
    h.client.isReady.mockReturnValue(false);
    await expect(h.worker.execute({...ids, requestId: '723456789012345678', action: 'stop'})).rejects.toMatchObject({statusCode: 503});
    expect(h.player.stop).not.toHaveBeenCalled();
  });
  it('pauses and resumes without changing the target channel', async () => {
    const h = harness();
    await expect(h.worker.execute({...ids, action: 'pause'})).resolves.toMatchObject({state: 'PAUSED'});
    await expect(h.worker.execute({...ids, requestId: '723456789012345678', action: 'resume'})).resolves.toMatchObject({state: 'PLAYING'});
    expect(h.player.ensureVoiceConnectionReady).toHaveBeenCalledOnce();
  });
  it('dispatches skip count and volume without changing per-guild defaults', async () => {
    const h = harness();
    await h.worker.execute({...ids, action: 'skip', amount: 2});
    await h.worker.execute({...ids, requestId: '723456789012345678', action: 'volume', volume: 0});
    expect(h.player.forward).toHaveBeenCalledWith(2);
    expect(h.player.setVolume).toHaveBeenCalledWith(0);
  });
  it.each(['stop', 'disconnect'])('releases the voice assignment on %s', async action => {
    const h = harness();
    await expect(h.worker.execute({...ids, action})).resolves.toMatchObject({state: 'FREE', channelId: null});
    expect(h.player[action as 'stop' | 'disconnect']).toHaveBeenCalledOnce();
  });
  it('uses the guild queue page size unless explicitly overridden', async () => {
    const h = harness();
    const result = await h.worker.execute({...ids, action: 'queue', page: 2});
    expect(result.message).toContain('6. Song 6');
    expect(result.message).not.toContain('11. Song 11');
  });
  it('releases a newly acquired connection after failure and sanitizes the error', async () => {
    const h = harness(false);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.enqueue.addToQueue.mockRejectedValue(new Error('secret-token https://private.invalid/'));
    try {
      await expect(h.worker.execute({...ids, action: 'play', query: 'song'})).rejects.toMatchObject({statusCode: 502});
      expect(h.player.disconnect).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token');
    } finally { log.mockRestore(); }
  });
  it('does not disconnect an existing session when adding a song fails', async () => {
    const h = harness();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.enqueue.addToQueue.mockRejectedValue(new Error('provider unavailable'));
    try {
      await expect(h.worker.execute({...ids, action: 'play', query: 'song'})).rejects.toMatchObject({statusCode: 502});
      expect(h.player.disconnect).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it('aborts before enqueue when the member leaves during media lookup', async () => {
    const h = harness(false);
    h.enqueue.addToQueue.mockImplementation(async options => {
      h.member.voice.channelId = '623456789012345678';
      await options.beforeEnqueue?.();
    });
    await expect(h.worker.execute({...ids, action: 'play', query: 'song'})).rejects.toMatchObject({statusCode: 403});
    expect(h.player.voiceConnection).toBeNull();
  });
});
