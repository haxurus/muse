import 'reflect-metadata';
import {describe, expect, it, vi} from 'vitest';
import AddQueryToQueue from '../src/services/add-query-to-queue.js';
import {STATUS} from '../src/services/player-types.js';

vi.mock('../src/utils/get-guild-settings.js', () => ({getGuildSettings: async () => ({playlistLimit: 10, queueAddResponseEphemeral: false})}));
vi.mock('../src/utils/channels.js', () => ({getMemberVoiceChannel: () => [{id: '423456789012345678'}], getMostPopularVoiceChannel: () => []}));
vi.mock('../src/utils/build-embed.js', () => ({buildPlayingMessageEmbed: () => ({})}));

const harness = () => {
  const trace: string[] = [];
  const song = {title: 'Song', url: 'video-id', offset: 0, length: 60};
  const player = {
    voiceConnection: null as object | null,
    status: STATUS.IDLE,
    getCurrentQueueEntryId: () => null,
    getCurrent: () => song,
    connect: vi.fn(async () => { trace.push('connect'); player.voiceConnection = {}; }),
    ensureVoiceConnectionReady: vi.fn(async () => undefined),
    add: vi.fn(() => { trace.push('add'); }),
    play: vi.fn(async () => { trace.push('play'); }),
  };
  const songs = {getSongs: vi.fn(async () => { trace.push('resolve'); return [[song], '']; })};
  const enqueue = new AddQueryToQueue(songs as never, {get: () => player} as never, {SPONSORBLOCK_TIMEOUT: 5, ENABLE_SPONSORBLOCK: false} as never, {} as never);
  const interaction = {
    guild: {id: '223456789012345678'}, member: {user: {id: '323456789012345678'}}, channel: {id: '523456789012345678'},
    deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined),
  };
  const options = {query: 'song', addToFrontOfQueue: false, shuffleAdditions: false, shouldSplitChapters: false, skipCurrentTrack: false, interaction: interaction as never};
  return {trace, player, enqueue, options};
};

describe('native enqueue authorization checkpoints', () => {
  it('validates after media lookup and again after connecting, before adding a track', async () => {
    const h = harness();
    await h.enqueue.addToQueue({...h.options, beforeEnqueue: async () => { h.trace.push('guard'); }});
    expect(h.trace).toEqual(['resolve', 'guard', 'connect', 'guard', 'add', 'play']);
  });
  it('does not join or add tracks when authorization expires during media lookup', async () => {
    const h = harness();
    await expect(h.enqueue.addToQueue({...h.options, beforeEnqueue: async () => { throw new Error('denied'); }})).rejects.toThrow('denied');
    expect(h.player.connect).not.toHaveBeenCalled();
    expect(h.player.add).not.toHaveBeenCalled();
  });
  it('does not add tracks when authorization expires during the voice handshake', async () => {
    const h = harness();
    const guard = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    await expect(h.enqueue.addToQueue({...h.options, beforeEnqueue: guard})).rejects.toThrow('denied');
    expect(h.player.connect).toHaveBeenCalledOnce();
    expect(h.player.add).not.toHaveBeenCalled();
  });
  it('preserves the original enqueue path when no remote guard is installed', async () => {
    const h = harness();
    await h.enqueue.addToQueue(h.options);
    expect(h.trace).toEqual(['resolve', 'connect', 'add', 'play']);
  });
});
