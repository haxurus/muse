import {afterEach, describe, expect, it, vi} from 'vitest';
import PlaybackGate from '../src/playback/gate.js';
import {isBotOnePlaybackEnabled, parsePlaybackRequest, type PlaybackResult} from '../src/playback/protocol.js';

const raw = {
  requestId: '123456789012345678', guildId: '223456789012345678',
  userId: '323456789012345678', voiceChannelId: '423456789012345678',
  textChannelId: '523456789012345678', action: 'play', query: 'test music',
};
const request = () => parsePlaybackRequest(raw);
const result = (): PlaybackResult => ({workerId: 'muse-01', guildId: raw.guildId, requestId: raw.requestId, channelId: raw.voiceChannelId, state: 'PLAYING', message: 'ok'});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('bot-one playback protocol', () => {
  it('is opt-in and never enables another worker', () => {
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'false');
    expect(isBotOnePlaybackEnabled('muse-01')).toBe(false);
    vi.stubEnv('MUSE_BOT_ONE_PLAYBACK', 'true');
    expect(isBotOnePlaybackEnabled('muse-01')).toBe(true);
    for (const id of ['muse-02', 'muse-03', 'muse-04', 'muse-05', '']) {
      expect(isBotOnePlaybackEnabled(id)).toBe(false);
    }
  });
  it('normalizes an allowlisted request without credentials', () => {
    expect(parsePlaybackRequest({...raw, query: ' song '})).toMatchObject({query: 'song', immediate: false});
  });
  it.each([
    {token: 'do-not-forward'}, {workerId: 'muse-02'}, {action: 'eval'},
    {query: ''}, {query: 'x'.repeat(2001)}, {guildId: '../state'}, {userId: 123}, {split: 'yes'},
  ])('rejects unexpected or malformed input %o', patch => {
    expect(() => parsePlaybackRequest({...raw, ...patch})).toThrow();
  });
  it('bounds volume, skip count and queue page size', () => {
    const {query, ...identity} = raw;
    expect(() => parsePlaybackRequest({...identity, action: 'volume', volume: 101})).toThrow();
    expect(() => parsePlaybackRequest({...identity, action: 'skip', amount: -1})).toThrow();
    expect(() => parsePlaybackRequest({...identity, action: 'queue', pageSize: 31})).toThrow();
    expect(parsePlaybackRequest({...identity, action: 'volume', volume: 0}).volume).toBe(0);
  });
});

describe('per-guild admission and idempotency', () => {
  it('executes a duplicated request only once and rejects a conflicting payload', async () => {
    const gate = new PlaybackGate();
    const operation = vi.fn(async () => result());
    const first = gate.run(request(), operation);
    expect(gate.run(request(), operation)).toBe(first);
    await first;
    expect(gate.run(request(), operation)).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(() => gate.run({...request(), query: 'different'}, operation)).toThrow(/different payload/);
  });
  it('reserves one guild synchronously, but does not reserve the bot globally', async () => {
    const gate = new PlaybackGate();
    let finish!: (value: PlaybackResult) => void;
    const pending = gate.run(request(), () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    expect(() => gate.run({...request(), requestId: '623456789012345678'}, async () => result())).toThrow(/still running/);
    await expect(gate.run({...request(), guildId: '723456789012345678'}, async () => result())).resolves.toBeTruthy();
    finish(result());
    await pending;
  });
  it('releases a failed reservation and preserves the failed request result', async () => {
    const gate = new PlaybackGate();
    const operation = vi.fn(async () => { throw new Error('failed'); });
    await expect(gate.run(request(), operation)).rejects.toThrow('failed');
    await expect(gate.run(request(), operation)).rejects.toThrow('failed');
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(gate.run({...request(), requestId: '623456789012345678'}, async () => result())).resolves.toBeTruthy();
  });
  it('bounds retained requests and does not expire active reservations', async () => {
    vi.useFakeTimers();
    const gate = new PlaybackGate(1, 1000);
    let finish!: (value: PlaybackResult) => void;
    const pending = gate.run(request(), () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    vi.advanceTimersByTime(2000);
    expect(() => gate.run({...request(), guildId: '723456789012345678'}, async () => result())).toThrow(/capacity/);
    finish(result());
    await pending;
    vi.advanceTimersByTime(1001);
    await expect(gate.run({...request(), guildId: '723456789012345678'}, async () => result())).resolves.toBeTruthy();
  });
});
