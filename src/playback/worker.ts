import {ChannelType, PermissionFlagsBits, type Client} from 'discord.js';
import type PlayerManager from '../managers/player.js';
import type Player from '../services/player.js';
import type AddQueryToQueue from '../services/add-query-to-queue.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {STATUS} from '../services/player-types.js';
import {HttpError} from '../control/http.js';
import PlaybackGate from './gate.js';
import {parsePlaybackRequest, type PlaybackRequest, type PlaybackResult, type PlaybackWorkerId} from './protocol.js';

/** Known player/enqueue failures mapped to client errors with fixed, user-safe messages. */
const KNOWN_PLAYER_ERRORS = new Map<string, readonly [number, string]>([
  ['no songs found', [404, 'No songs were found for that query.']],
  ['that doesn\'t exist', [404, 'No songs were found for that query.']],
  ['video could not be found.', [404, 'That video could not be found.']],
  ['playlist could not be found.', [404, 'That playlist could not be found.']],
  ['spotify is not enabled!', [400, 'Spotify links are not enabled on this bot.']],
  ['that url provider is not allowed', [400, 'That URL provider is not allowed.']],
  ['no playable songs found', [422, 'No playable songs were found for that query.']],
  ['no song to skip to', [409, 'There is no song to skip to.']],
  ['no songs in queue to forward to.', [409, 'There is no song to skip to.']],
  ['not currently playing.', [409, 'Nothing is playing.']],
  ['no song currently playing', [409, 'Nothing is playing.']],
  ['no song currently playing.', [409, 'Nothing is playing.']],
  ['queue empty.', [409, 'The queue is empty.']],
  ['not connected to a voice channel.', [409, 'The bot is not connected to this voice channel.']],
]);

/** Error name plus a redacted, bounded message: native media errors may contain provider URLs or credentials. */
export const describePlaybackError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : 'Error';
  const detail = (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/giu, '[URL]')
    .replace(/\b(?:bearer|authorization)\s+\S+/giu, '[redacted]')
    .replace(/\S*(?:token|secret|key|passw|cookie|auth|sig)\S*/giu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200);
  return `${name}: ${detail || 'unknown error'}`;
};

/** Changes whenever songs are added to the queue or a song becomes current. */
const queueSignature = (player: Player): string =>
  `${player.getCurrent()?.title ?? ''}\u0000${player.getQueue().length}`;

export default class PlaybackWorker {
  private readonly gate = new PlaybackGate();

  constructor(
    private readonly client: Client,
    private readonly players: PlayerManager,
    private readonly enqueue: AddQueryToQueue,
    private readonly workerId: PlaybackWorkerId = 'muse-01',
  ) {}

  async execute(input: unknown): Promise<PlaybackResult> {
    const request = parsePlaybackRequest(input);
    return this.gate.run(request, async () => {
      try {
        return await this.apply(request);
      } catch (error: unknown) {
        if (error instanceof HttpError) {
          throw error;
        }

        console.error('Orchestrated playback failed', {
          workerId: this.workerId,
          guildId: request.guildId,
          requestId: request.requestId,
          action: request.action,
          error: describePlaybackError(error),
        });
        const known = error instanceof Error ? KNOWN_PLAYER_ERRORS.get(error.message.trim().toLowerCase()) : undefined;
        if (known) {
          throw new HttpError(known[0], known[1]);
        }

        throw new HttpError(502, 'Playback failed. Check the worker status before retrying.');
      }
    });
  }

  // eslint-disable-next-line complexity
  private async authorize(request: PlaybackRequest) {
    if (!this.client.isReady()) {
      throw new HttpError(503, 'Discord is not ready.');
    }

    const guild = this.client.guilds.cache.get(request.guildId);
    if (!guild) {
      throw new HttpError(404, 'Guild not available.');
    }

    const member = await guild.members.fetch({user: request.userId, force: true});
    const voice = await guild.channels.fetch(request.voiceChannelId);
    const text = await guild.channels.fetch(request.textChannelId);
    if (!voice || voice.type !== ChannelType.GuildVoice) {
      throw new HttpError(400, 'Orchestrated playback supports standard voice channels only; stage channels are not supported.');
    }

    if (!text || text.type !== ChannelType.GuildText) {
      throw new HttpError(400, 'Run playback commands from a standard text channel, not a thread, forum or voice channel chat.');
    }

    // Defense in depth: the guild channel manager should only return channels of this guild.
    if (voice.guildId !== guild.id || text.guildId !== guild.id) {
      throw new HttpError(403, 'Channels must belong to the requested guild.');
    }

    const bot = guild.members.me;
    if (!bot) {
      throw new HttpError(503, 'Discord is not ready.');
    }

    if (member.user.bot || member.voice.channelId !== voice.id
      || !voice.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
      || !text.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.UseApplicationCommands])) {
      throw new HttpError(403, 'Voice membership or channel permissions changed.');
    }

    if (!voice.permissionsFor(bot).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new HttpError(403, 'The bot needs View Channel, Connect and Speak permissions in your voice channel.');
    }

    if (!text.permissionsFor(bot).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      throw new HttpError(403, 'The bot needs View Channel and Send Messages permissions in this text channel.');
    }

    // Song announcements are sent as embeds.
    if (request.action === 'play' && !text.permissionsFor(bot).has(PermissionFlagsBits.EmbedLinks)) {
      throw new HttpError(403, 'The bot needs the Embed Links permission in this text channel to announce songs.');
    }

    const connection = this.players.get(guild.id).voiceConnection;
    if (connection && connection.joinConfig.channelId !== voice.id) {
      throw new HttpError(409, 'This bot is already assigned to another voice channel.');
    }

    if (!connection && request.action === 'play' && voice.userLimit > 0 && voice.members.size >= voice.userLimit
      && !voice.permissionsFor(bot).has(PermissionFlagsBits.MoveMembers)) {
      throw new HttpError(403, 'Your voice channel is full, so the bot cannot join it.');
    }

    return {guild, member, text};
  }

  private async apply(request: PlaybackRequest): Promise<PlaybackResult> {
    const context = await this.authorize(request);
    const player = this.players.get(request.guildId);
    let message = 'Command completed.';
    if (request.action === 'play') {
      const wasDisconnected = player.voiceConnection === null;
      const queueBefore = queueSignature(player);
      try {
        await this.enqueue.addToQueue({
          query: request.query!,
          addToFrontOfQueue: request.immediate ?? false,
          shuffleAdditions: request.shuffle ?? false,
          shouldSplitChapters: request.split ?? false,
          skipCurrentTrack: request.skip ?? false,
          beforeEnqueue: async () => {
            await this.authorize(request);
          },
          interaction: {
            guild: context.guild,
            member: context.member,
            channel: context.text,
            deferReply: async () => undefined,
            editReply: async value => {
              if (typeof value === 'string') {
                message = value;
              }
            },
          },
        });
      } catch (error: unknown) {
        if (queueSignature(player) === queueBefore) {
          if (wasDisconnected) {
            player.disconnect();
          }

          throw error;
        }

        // Songs were already queued: keep the session and report the partial outcome instead of a retryable failure.
        console.warn('Orchestrated playback partially applied', {
          workerId: this.workerId,
          guildId: request.guildId,
          requestId: request.requestId,
          error: describePlaybackError(error),
        });
        message = 'Songs were added to the queue, but playback could not be confirmed. Check /queue before retrying.';
      }
    } else if (request.action === 'queue') {
      const pageSize = request.pageSize ?? (await getGuildSettings(request.guildId)).defaultQueuePageSize;
      const start = ((request.page ?? 1) - 1) * pageSize;
      const queue = player.getQueue();
      message = [
        `Current: ${player.getCurrent()?.title.slice(0, 120) ?? 'none'}`,
        `Queue: ${queue.length} tracks; page ${request.page ?? 1}`,
        ...queue.slice(start, start + pageSize).map((song, index) => `${start + index + 1}. ${song.title.slice(0, 45)}`),
      ].join('\n');
    } else {
      if (player.voiceConnection === null) {
        throw new HttpError(409, 'The bot is not connected to this voice channel.');
      }

      switch (request.action) {
        case 'pause':
          if (player.status === STATUS.IDLE) {
            throw new HttpError(409, 'Nothing is playing.');
          }

          if (player.status === STATUS.PLAYING) {
            player.pause();
          }

          message = 'Playback paused.';
          break;
        case 'resume':
          await player.ensureVoiceConnectionReady();
          await this.authorize(request);
          if (player.status !== STATUS.PLAYING) {
            await player.play();
          }

          message = 'Playback resumed.';
          break;
        case 'skip':
          await player.forward(request.amount ?? 1);
          message = 'Track skipped.';
          break;
        case 'stop':
          player.stop();
          message = 'Playback stopped and queue cleared.';
          break;
        case 'disconnect':
          player.disconnect();
          message = 'Disconnected. Queue retained.';
          break;
        case 'volume':
          if (request.volume !== undefined) {
            player.setVolume(request.volume);
          }

          message = `Volume: ${player.getVolume()}%.`;
          break;
        default:
          throw new HttpError(400, 'Unsupported playback action.');
      }
    }

    return {
      workerId: this.workerId,
      guildId: request.guildId,
      requestId: request.requestId,
      channelId: player.voiceConnection?.joinConfig.channelId ?? null,
      state: player.voiceConnection === null ? 'FREE' : player.status === STATUS.PLAYING ? 'PLAYING' : player.status === STATUS.PAUSED ? 'PAUSED' : 'IDLE',
      message: message.slice(0, 1900),
    };
  }
}
