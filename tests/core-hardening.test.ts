import 'reflect-metadata';
import {afterEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  debug: vi.fn(),
  keyValueCache: {
    deleteMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock('../src/utils/db.js', () => ({
  prisma: {keyValueCache: mocks.keyValueCache},
}));

vi.mock('../src/utils/debug.js', () => ({
  default: mocks.debug,
}));

vi.mock('../src/services/player.js', () => ({
  MediaSource: {Youtube: 0, HLS: 1, SoundCloud: 2},
  STATUS: {PLAYING: 0, PAUSED: 1, IDLE: 2},
}));

import KeyValueCacheProvider, {EXPIRED_ROW_PURGE_INTERVAL_MS} from '../src/services/key-value-cache.js';
import SpotifyAPI from '../src/services/spotify-api.js';
import {buildPlayingMessageEmbed} from '../src/utils/build-embed.js';
import {getHttpStreamInputOptions, isValidAllowedStreamHost} from '../src/utils/http-stream.js';
import {DISCORD_CHOICE_MAX_LENGTH, toDiscordAutocompleteChoices} from '../src/utils/string.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('direct HTTP stream FFmpeg options', () => {
  it('restricts protocols and bounds reads for HTTPS streams', () => {
    expect(getHttpStreamInputOptions('https://radio.example/live.m3u8')).toEqual([
      '-protocol_whitelist',
      'https,tls,tcp,crypto,httpproxy',
      '-rw_timeout',
      '15000000',
    ]);
  });

  it('adds plain HTTP only for http:// inputs', () => {
    expect(getHttpStreamInputOptions('http://radio.example/live.mp3')).toContain('https,tls,tcp,crypto,httpproxy,http');
  });

  it.each(['/cache/audio.webm', 'file:///etc/passwd', 'not a url'])('adds nothing for non-HTTP input %s', input => {
    expect(getHttpStreamInputOptions(input)).toEqual([]);
  });

  it.each([
    ['radio.example', true],
    ['streams.radio.example', true],
    ['example', false],
    ['*.radio.example', false],
    ['radio.example:8443', false],
    ['radio.example/live', false],
    ['.radio.example', false],
    ['', false],
  ])('validates allowlist host %s', (host, expected) => {
    expect(isValidAllowedStreamHost(host)).toBe(expected);
  });
});

describe('Discord autocomplete choice limits', () => {
  it('truncates long names and drops choices whose value cannot be submitted', () => {
    const longName = 'n'.repeat(150);
    const choices = toDiscordAutocompleteChoices([
      {name: longName, value: 'short value'},
      {name: 'too long value', value: 'v'.repeat(101)},
      {name: 'ok', value: 'ok'},
    ]);

    expect(choices).toHaveLength(2);
    expect(choices[0].name).toHaveLength(DISCORD_CHOICE_MAX_LENGTH);
    expect(choices[0].value).toBe('short value');
    expect(choices[1]).toEqual({name: 'ok', value: 'ok'});
  });
});

describe('Spotify track conversion', () => {
  it('tolerates a track without artists', async () => {
    const spotify = {
      getTrack: vi.fn().mockResolvedValue({body: {name: 'Local file', artists: []}}),
    };
    const api = new SpotifyAPI({spotify} as never);

    await expect(api.getTrack('spotify:track:track-id')).resolves.toEqual({name: 'Local file', artist: ''});
  });
});

describe('playing embed for direct streams', () => {
  it('keeps a very long stream URL title within Discord embed limits', () => {
    const url = `https://radio.example/${'a'.repeat(2000)}`;
    const player = {
      getCurrent: () => ({
        title: url,
        artist: url,
        url,
        length: 0,
        offset: 0,
        playlist: null,
        isLive: true,
        thumbnailUrl: null,
        source: 1,
        addedInChannelId: 'channel',
        requestedBy: 'user',
      }),
      getPosition: () => 0,
      getVolume: () => 100,
      loopCurrentQueue: false,
      loopCurrentSong: false,
      status: 0,
    };

    const embed = buildPlayingMessageEmbed(player as never).toJSON();

    expect(embed.description!.length).toBeLessThan(4096);
    expect(embed.description).not.toContain(`](${url})`);
  });
});

describe('KeyValueCacheProvider expired-row purge', () => {
  it('purges expired rows at most once per interval and never fails the wrapped call', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
    mocks.keyValueCache.findUnique.mockResolvedValue(null);
    mocks.keyValueCache.upsert.mockResolvedValue({});
    mocks.keyValueCache.deleteMany
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue({count: 3});
    const cache = new KeyValueCacheProvider();

    await expect(cache.wrap(vi.fn().mockResolvedValue('first'), {expiresIn: 60, key: 'first-key'})).resolves.toBe('first');
    await vi.waitFor(() => {
      expect(mocks.debug).toHaveBeenCalledWith('Failed to purge expired cache entries: database is locked');
    });
    expect(mocks.keyValueCache.deleteMany).toHaveBeenCalledOnce();
    expect(mocks.keyValueCache.deleteMany).toHaveBeenCalledWith({
      where: {expiresAt: {lt: new Date('2026-10-05T12:00:00.000Z')}},
    });

    await cache.wrap(vi.fn().mockResolvedValue('second'), {expiresIn: 60, key: 'second-key'});
    expect(mocks.keyValueCache.deleteMany).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date(Date.now() + EXPIRED_ROW_PURGE_INTERVAL_MS));
    await cache.wrap(vi.fn().mockResolvedValue('third'), {expiresIn: 60, key: 'third-key'});
    expect(mocks.keyValueCache.deleteMany).toHaveBeenCalledTimes(2);
  });
});
