import {inject, injectable, optional} from 'inversify';
import Config from './config.js';
import * as spotifyURI from 'spotify-uri';
import {SongMetadata, QueuedPlaylist, MediaSource} from './player.js';
import {TYPES} from '../types.js';
import ffmpeg from 'fluent-ffmpeg';
import YoutubeAPI from './youtube-api.js';
import SpotifyAPI, {SpotifyTrack} from './spotify-api.js';
import {URL} from 'node:url';
import {getSoundCloudMetadata, YtDlpMediaUnavailableError} from '../utils/yt-dlp.js';
import pLimit from 'p-limit';
import {getHttpStreamInputOptions, HTTP_STREAM_PROBE_TIMEOUT_MS, isValidAllowedStreamHost} from '../utils/http-stream.js';
import {DEFAULT_LOCALE, UserError, t, type Locale} from '../i18n/index.js';

// Bounds parallel YouTube search API calls when converting Spotify collections.
const SPOTIFY_TO_YOUTUBE_SEARCH_CONCURRENCY = 4;

@injectable()
export default class {
  private readonly youtubeAPI: YoutubeAPI;
  private readonly spotifyAPI?: SpotifyAPI;

  private readonly config: Pick<Config, 'ALLOW_HTTP_STREAMS' | 'HTTP_STREAM_ALLOWED_HOSTS'>;

  constructor(@inject(TYPES.Services.YoutubeAPI) youtubeAPI: YoutubeAPI,
    @inject(TYPES.Services.SpotifyAPI) @optional() spotifyAPI?: SpotifyAPI,
    @inject(TYPES.Config) @optional() config?: Config) {
    this.youtubeAPI = youtubeAPI;
    this.spotifyAPI = spotifyAPI;
    this.config = config ?? {ALLOW_HTTP_STREAMS: false, HTTP_STREAM_ALLOWED_HOSTS: []};
  }

  async getSongs(query: string, playlistLimit: number, shouldSplitChapters: boolean, locale: Locale = DEFAULT_LOCALE): Promise<[SongMetadata[], string]> {
    const newSongs: SongMetadata[] = [];
    let extraMsg = '';
    let url: URL | undefined;

    // Test if it's a complete URL
    try {
      url = new URL(query);
    } catch (_: unknown) {
      url = undefined;
    }

    const supportedProtocols = ['http:', 'https:', 'spotify:'];

    if (!url || !supportedProtocols.includes(url.protocol)) {
      // Not a supported provider URL, so search YouTube as free text.
      const songs = await this.youtubeVideoSearch(query, shouldSplitChapters);

      if (songs) {
        newSongs.push(...songs);
      } else {
        throw new UserError('songDoesNotExist');
      }

      return [newSongs, extraMsg];
    }

    const YOUTUBE_HOSTS = [
      'www.youtube.com',
      'youtu.be',
      'youtube.com',
      'music.youtube.com',
      'www.music.youtube.com',
    ];

    if (YOUTUBE_HOSTS.includes(url.host)) {
      // YouTube source
      if (url.searchParams.get('list')) {
        // YouTube playlist
        const songs = await this.youtubePlaylist(url.searchParams.get('list')!, shouldSplitChapters, playlistLimit);
        newSongs.push(...songs.slice(0, playlistLimit));
      } else {
        const songs = await this.youtubeVideo(url.href, shouldSplitChapters);

        if (songs) {
          newSongs.push(...songs);
        } else {
          throw new UserError('songDoesNotExist');
        }
      }
    } else if (['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com', 'snd.sc'].includes(url.host)) {
      newSongs.push(...await this.soundCloudSource(url.href, playlistLimit));
    } else if (url.protocol === 'spotify:' || url.host === 'open.spotify.com') {
      if (this.spotifyAPI === undefined) {
        throw new UserError('spotifyNotEnabled');
      }

      const [convertedSongs, nSongsNotFound, totalSongs] = await this.spotifySource(query, playlistLimit, shouldSplitChapters);

      if (totalSongs > playlistLimit) {
        extraMsg = t(locale, 'songsRandomSample', {count: playlistLimit});
      }

      if (totalSongs > playlistLimit && nSongsNotFound !== 0) {
        extraMsg += t(locale, 'songsJoiner');
      }

      if (nSongsNotFound !== 0) {
        if (nSongsNotFound === 1) {
          extraMsg += t(locale, 'songsOneNotFound');
        } else {
          extraMsg += t(locale, 'songsManyNotFound', {count: nSongsNotFound});
        }
      }

      newSongs.push(...convertedSongs);
    } else {
      if (!this.isAllowedHttpStream(url)) {
        throw new UserError('urlProviderNotAllowed');
      }

      const song = await this.httpLiveStream(url.href);

      if (song) {
        newSongs.push(song);
      } else {
        throw new UserError('songDoesNotExist');
      }
    }

    return [newSongs, extraMsg];
  }

  private async youtubeVideoSearch(query: string, shouldSplitChapters: boolean): Promise<SongMetadata[]> {
    return this.youtubeAPI.search(query, shouldSplitChapters);
  }

  private async youtubeVideo(url: string, shouldSplitChapters: boolean): Promise<SongMetadata[]> {
    return this.youtubeAPI.getVideo(url, shouldSplitChapters);
  }

  private async youtubePlaylist(listId: string, shouldSplitChapters: boolean, playlistLimit: number): Promise<SongMetadata[]> {
    return this.youtubeAPI.getPlaylist(listId, shouldSplitChapters, playlistLimit);
  }

  private async spotifySource(url: string, playlistLimit: number, shouldSplitChapters: boolean): Promise<[SongMetadata[], number, number]> {
    if (this.spotifyAPI === undefined) {
      return [[], 0, 0];
    }

    const parsed = spotifyURI.parse(url);

    switch (parsed.type) {
      case 'album': {
        const [tracks, playlist] = await this.spotifyAPI.getAlbum(url, playlistLimit);
        return this.spotifyToYouTube(tracks, shouldSplitChapters, playlist);
      }

      case 'playlist': {
        const [tracks, playlist] = await this.spotifyAPI.getPlaylist(url, playlistLimit);
        return this.spotifyToYouTube(tracks, shouldSplitChapters, playlist);
      }

      case 'track': {
        const tracks = [await this.spotifyAPI.getTrack(url)];
        return this.spotifyToYouTube(tracks, shouldSplitChapters);
      }

      case 'artist': {
        const tracks = await this.spotifyAPI.getArtist(url, playlistLimit);
        return this.spotifyToYouTube(tracks, shouldSplitChapters);
      }

      default: {
        return [[], 0, 0];
      }
    }
  }

  private isAllowedHttpStream(url: URL): boolean {
    if (!this.config.ALLOW_HTTP_STREAMS) {
      return false;
    }

    const host = url.hostname.toLowerCase();
    return this.config.HTTP_STREAM_ALLOWED_HOSTS
      .map(allowedHost => allowedHost.trim().toLowerCase())
      .filter(allowedHost => isValidAllowedStreamHost(allowedHost))
      .some(allowedHost => (
        host === allowedHost || host.endsWith(`.${allowedHost}`)
      ));
  }

  private async httpLiveStream(url: string): Promise<SongMetadata> {
    return new Promise((resolve, reject) => {
      // The ffprobe process cannot be cancelled here; -rw_timeout bounds it, and this
      // timer keeps a stalled probe from holding the command reply open.
      const probeTimeout = setTimeout(() => {
        reject(new Error('timed out while probing the stream'));
      }, HTTP_STREAM_PROBE_TIMEOUT_MS);

      ffmpeg(url).ffprobe(getHttpStreamInputOptions(url), (err, _) => {
        clearTimeout(probeTimeout);
        if (err) {
          reject(err);
          return;
        }

        resolve({
          url,
          source: MediaSource.HLS,
          isLive: true,
          title: url,
          artist: url,
          length: 0,
          offset: 0,
          playlist: null,
          thumbnailUrl: null,
        });
      });
    });
  }

  private async soundCloudSource(url: string, playlistLimit: number): Promise<SongMetadata[]> {
    const metadata = await getSoundCloudMetadata(url, playlistLimit);
    const playlist = metadata.entries ? {title: metadata.title ?? 'SoundCloud playlist', source: url} : null;
    const tracks = metadata.entries ?? [metadata];

    const limit = pLimit(4);
    const songs = await Promise.all(tracks.slice(0, playlistLimit).map(async track => limit(async () => {
      if (!track) {
        return [];
      }

      // Keep the page URL in the queue; signed audio URLs must be resolved at playback time.
      const trackUrl = playlist ? track.webpage_url ?? track.url : url;
      if (!trackUrl) {
        return [];
      }

      // Flat SoundCloud playlist entries can contain only a URL, with no title or duration.
      let details;
      try {
        details = playlist ? await getSoundCloudMetadata(trackUrl, 1) : track;
      } catch (error: unknown) {
        if (error instanceof YtDlpMediaUnavailableError) {
          return [];
        }

        throw error;
      }

      if (details.entries || !details.title) {
        return [];
      }

      return [{
        url: trackUrl,
        source: MediaSource.SoundCloud,
        isLive: false,
        title: details.title,
        artist: details.artist ?? details.uploader ?? 'SoundCloud',
        length: Math.max(0, details.duration ?? 0),
        offset: 0,
        playlist,
        thumbnailUrl: details.thumbnail ?? null,
      }];
    })));
    return songs.flat();
  }

  private async spotifyToYouTube(tracks: SpotifyTrack[], shouldSplitChapters: boolean, playlist?: QueuedPlaylist | undefined): Promise<[SongMetadata[], number, number]> {
    const limit = pLimit(SPOTIFY_TO_YOUTUBE_SEARCH_CONCURRENCY);
    const promisedResults = tracks.map(async track => limit(async () => this.youtubeAPI.search(`"${track.name}" "${track.artist}"`, shouldSplitChapters)));
    const searchResults = await Promise.allSettled(promisedResults);

    let nSongsNotFound = 0;

    // Count songs that couldn't be found
    const songs: SongMetadata[] = searchResults.reduce((accum: SongMetadata[], result) => {
      if (result.status === 'fulfilled') {
        if (result.value.length === 0) {
          nSongsNotFound++;
        }

        for (const v of result.value) {
          accum.push({
            ...v,
            ...(playlist ? {playlist} : {}),
          });
        }
      } else {
        nSongsNotFound++;
      }

      return accum;
    }, []);

    return [songs, nSongsNotFound, tracks.length];
  }
}
