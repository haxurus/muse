import {ChannelType, Client, VoiceChannel} from 'discord.js';
import PlayerManager from '../managers/player.js';
import AddQueryToQueue from '../services/add-query-to-queue.js';
import {STATUS} from '../services/player.js';
import type {
  PlaybackActionResult,
  PlaybackChannelRequest,
  PlaybackPlayRequest,
  PlaybackQueueEntry,
  PlaybackSkipRequest,
  PlaybackSnapshot,
  PlaybackVolumeRequest,
} from './playback-types.js';
import {HttpError} from './http.js';

const SNOWFLAKE = /^\d{10,32}$/u;

const requireSnowflake = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) {
    throw new HttpError(400, `${label} must be a Discord snowflake`);
  }

  return value;
};

const serializeSong = (song: ReturnType<ReturnType<PlayerManager['get']>['getCurrent']>): PlaybackQueueEntry | null => {
  if (!song) {
    return null;
  }

  return {
    title: song.title,
    artist: song.artist,
    url: song.url,
    length: song.length,
    offset: song.offset,
    playlist: song.playlist,
    isLive: song.isLive,
    thumbnailUrl: song.thumbnailUrl,
    source: song.source,
    requestedBy: song.requestedBy,
  };
};

export default class PlaybackControl {
  constructor(
    private readonly client: Client,
    private readonly playerManager: PlayerManager,
    private readonly addQueryToQueue: AddQueryToQueue,
  ) {}

  snapshot(guildId: string): PlaybackSnapshot {
    const player = this.playerManager.find(guildId);
    if (!player) {
      return {
        guildId,
        connected: false,
        voiceChannelId: null,
        status: 'IDLE',
        volume: 100,
        positionSeconds: 0,
        current: null,
        queue: [],
      };
    }

    return {
      guildId,
      connected: player.voiceConnection !== null,
      voiceChannelId: player.voiceConnection?.joinConfig.channelId ?? null,
      status: STATUS[player.status] as PlaybackSnapshot['status'],
      volume: player.getVolume(),
      positionSeconds: player.getPosition(),
      current: serializeSong(player.getCurrent()),
      queue: player.getQueue().map(song => serializeSong(song)!),
    };
  }

  async play(guildId: string, input: unknown): Promise<PlaybackActionResult> {
    const body = this.playRequest(input);
    const channel = this.requireVoiceChannel(guildId, body.voiceChannelId);
    this.requireRequesterInChannel(channel, body.requesterId);

    const result = await this.addQueryToQueue.addRequest({
      guildId,
      targetVoiceChannel: channel,
      textChannelId: body.textChannelId,
      requesterId: body.requesterId,
      query: body.query.trim(),
      addToFrontOfQueue: body.immediate ?? false,
      shuffleAdditions: body.shuffle ?? false,
      shouldSplitChapters: body.split ?? false,
      skipCurrentTrack: body.skip ?? false,
    });

    return {
      message: result.message,
      playback: this.snapshot(guildId),
    };
  }

  pause(guildId: string, input: unknown): PlaybackActionResult {
    const body = this.channelRequest(input);
    const player = this.requireAssignedPlayer(guildId, body);

    if (player.status !== STATUS.PLAYING) {
      throw new HttpError(409, 'not currently playing');
    }

    player.pause();
    return {message: 'the stop-and-go light is now red', playback: this.snapshot(guildId)};
  }

  async resume(guildId: string, input: unknown): Promise<PlaybackActionResult> {
    const body = this.channelRequest(input);
    const channel = this.requireVoiceChannel(guildId, body.voiceChannelId);
    this.requireRequesterInChannel(channel, body.requesterId);
    const player = this.playerManager.find(guildId);

    if (!player?.getCurrent()) {
      throw new HttpError(409, 'nothing to play');
    }

    if (player.status === STATUS.PLAYING) {
      throw new HttpError(409, 'already playing');
    }

    if (player.voiceConnection === null) {
      await player.connect(channel);
    } else if (player.voiceConnection.joinConfig.channelId !== channel.id) {
      throw new HttpError(409, 'this worker is assigned to another voice channel');
    } else {
      await player.ensureVoiceConnectionReady();
    }

    await player.play();
    return {message: 'the stop-and-go light is now green', playback: this.snapshot(guildId)};
  }

  async skip(guildId: string, input: unknown): Promise<PlaybackActionResult> {
    const body = this.skipRequest(input);
    const player = this.requireAssignedPlayer(guildId, body);
    const count = body.count ?? 1;

    if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
      throw new HttpError(400, 'count must be an integer between 1 and 100');
    }

    try {
      await player.forward(count);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'No songs in queue to forward to.') {
        throw new HttpError(409, 'no song to skip to');
      }

      throw error;
    }

    return {message: 'keep \'er movin\'', playback: this.snapshot(guildId)};
  }

  stop(guildId: string, input: unknown): PlaybackActionResult {
    const body = this.channelRequest(input);
    const player = this.requireAssignedPlayer(guildId, body);
    player.stop();
    return {message: 'u betcha, stopped', playback: this.snapshot(guildId)};
  }

  disconnect(guildId: string, input: unknown): PlaybackActionResult {
    const body = this.channelRequest(input);
    const player = this.requireAssignedPlayer(guildId, body);
    player.disconnect();
    return {message: 'u betcha, disconnected', playback: this.snapshot(guildId)};
  }

  volume(guildId: string, input: unknown): PlaybackActionResult {
    const body = this.volumeRequest(input);
    const player = this.requireAssignedPlayer(guildId, body);

    if (!Number.isSafeInteger(body.level) || body.level < 0 || body.level > 100) {
      throw new HttpError(400, 'level must be an integer between 0 and 100');
    }

    if (!player.getCurrent()) {
      throw new HttpError(409, 'nothing is playing');
    }

    player.setVolume(body.level);
    return {message: `Set volume to ${body.level}%`, playback: this.snapshot(guildId)};
  }

  queue(guildId: string): PlaybackActionResult {
    return {message: 'queue', playback: this.snapshot(guildId)};
  }

  nowPlaying(guildId: string): PlaybackActionResult {
    const playback = this.snapshot(guildId);
    if (!playback.current) {
      throw new HttpError(409, 'nothing is currently playing');
    }

    return {message: 'now playing', playback};
  }

  private requireAssignedPlayer(guildId: string, body: PlaybackChannelRequest) {
    const channel = this.requireVoiceChannel(guildId, body.voiceChannelId);
    this.requireRequesterInChannel(channel, body.requesterId);

    const player = this.playerManager.find(guildId);
    if (!player) {
      throw new HttpError(409, 'no active player for this server');
    }

    const assignedChannelId = player.voiceConnection?.joinConfig.channelId;
    if (assignedChannelId !== body.voiceChannelId) {
      throw new HttpError(409, 'this worker is not assigned to your voice channel');
    }

    return player;
  }

  private requireVoiceChannel(guildId: string, channelId: string): VoiceChannel {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      throw new HttpError(404, 'worker is not a member of that guild');
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new HttpError(400, 'voice channel is unavailable');
    }

    return channel;
  }

  private requireRequesterInChannel(channel: VoiceChannel, requesterId: string): void {
    if (!channel.members.has(requesterId)) {
      throw new HttpError(403, 'requester is not in the target voice channel');
    }
  }

  private channelRequest(input: unknown): PlaybackChannelRequest {
    const body = this.body(input);
    return {
      voiceChannelId: requireSnowflake(body.voiceChannelId, 'voiceChannelId'),
      requesterId: requireSnowflake(body.requesterId, 'requesterId'),
    };
  }

  private playRequest(input: unknown): PlaybackPlayRequest {
    const body = this.body(input);
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (query.length < 1 || query.length > 2000) {
      throw new HttpError(400, 'query must contain 1-2000 characters');
    }

    for (const key of ['immediate', 'shuffle', 'split', 'skip'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') {
        throw new HttpError(400, `${key} must be a boolean`);
      }
    }

    return {
      voiceChannelId: requireSnowflake(body.voiceChannelId, 'voiceChannelId'),
      textChannelId: requireSnowflake(body.textChannelId, 'textChannelId'),
      requesterId: requireSnowflake(body.requesterId, 'requesterId'),
      query,
      immediate: body.immediate as boolean | undefined,
      shuffle: body.shuffle as boolean | undefined,
      split: body.split as boolean | undefined,
      skip: body.skip as boolean | undefined,
    };
  }

  private skipRequest(input: unknown): PlaybackSkipRequest {
    const body = this.body(input);
    const base = this.channelRequest(body);
    return {
      ...base,
      count: body.count === undefined ? undefined : Number(body.count),
    };
  }

  private volumeRequest(input: unknown): PlaybackVolumeRequest {
    const body = this.body(input);
    const base = this.channelRequest(body);
    return {
      ...base,
      level: Number(body.level),
    };
  }

  private body(input: unknown): Record<string, unknown> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new HttpError(400, 'playback request body must be an object');
    }

    return input as Record<string, unknown>;
  }
}
