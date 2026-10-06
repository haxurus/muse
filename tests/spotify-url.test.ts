import {describe, expect, it} from 'vitest';
import * as spotifyURI from 'spotify-uri';
import {normalizeSpotifyUrl} from '../src/utils/spotify-url.js';

describe('normalizeSpotifyUrl', () => {
  it('drops the intl locale segment and the tracking query', () => {
    expect(normalizeSpotifyUrl('https://open.spotify.com/intl-it/track/4uLU6hMCjMI75M1A2tKUQC?si=abc'))
      .toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    expect(normalizeSpotifyUrl('https://open.spotify.com/intl-pt-BR/playlist/37i9dQZF1DXcBWIGoYBM5M'))
      .toBe('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
  });

  it('keeps plain links and spotify: URIs parseable', () => {
    expect(normalizeSpotifyUrl('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3'))
      .toBe('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3');
    expect(normalizeSpotifyUrl('spotify:track:4uLU6hMCjMI75M1A2tKUQC')).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(normalizeSpotifyUrl('not a url')).toBe('not a url');
  });

  it('produces URLs that spotify-uri can parse', () => {
    const parsed = spotifyURI.parse(normalizeSpotifyUrl('https://open.spotify.com/intl-it/track/4uLU6hMCjMI75M1A2tKUQC?si=abc'));
    expect(parsed.type).toBe('track');
    expect((parsed as spotifyURI.Track).id).toBe('4uLU6hMCjMI75M1A2tKUQC');
  });
});
