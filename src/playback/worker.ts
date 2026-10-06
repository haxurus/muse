import {ChannelType, PermissionFlagsBits, type Client} from 'discord.js';
import type PlayerManager from '../managers/player.js';
import type Player from '../services/player.js';
import type AddQueryToQueue from '../services/add-query-to-queue.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {STATUS} from '../services/player-types.js';
import {HttpError} from '../control/http.js';
import PlaybackGate from './gate.js';
import {parsePlaybackRequest, type PlaybackRequest, type PlaybackResult, type PlaybackWorkerId} from './protocol.js';
import {DEFAULT_LOCALE, t, type Locale, type MessageKey} from '../i18n/index.js';
import {getGuildLocale} from '../i18n/guild-locale.js';

/** Known player/enqueue failures (matched on their English message) mapped to client errors with fixed, user-safe messages. */
const KNOWN_PLAYER_ERRORS = new Map<string, readonly [number, MessageKey]>([
  ['no songs found', [404, 'playbackNoSongsForQuery']],
  ['that doesn\'t exist', [404, 'playbackNoSongsForQuery']],
  ['video could not be found.', [404, 'playbackVideoNotFound']],
  ['playlist could not be found.', [404, 'playbackPlaylistNotFound']],
  ['spotify is not enabled!', [400, 'playbackSpotifyDisabled']],
  ['that url provider is not allowed', [400, 'playbackProviderNotAllowed']],
  ['no playable songs found', [422, 'playbackNoPlayableSongs']],
  ['no song to skip to', [409, 'playbackNoSongToSkip']],
  ['no songs in queue to forward to.', [409, 'playbackNoSongToSkip']],
  ['not currently playing.', [409, 'playbackNothingPlaying']],
  ['no song currently playing', [409, 'playbackNothingPlaying']],
  ['no song currently playing.', [409, 'playbackNothingPlaying']],
  ['queue empty.', [409, 'playbackQueueEmpty']],
  ['not connected to a voice channel.', [409, 'playbackBotNotConnected']],
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
      // Same bot and database as the command-receiving controller, so the guild's own locale applies.
      let locale: Locale = DEFAULT_LOCALE;
      try {
        locale = await getGuildLocale(request.guildId);
        return await this.apply(request, locale);
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
          throw new HttpError(known[0], t(locale, known[1]));
        }

        throw new HttpError(502, t(locale, 'playbackFailed'));
      }
    });
  }

  // eslint-disable-next-line complexity
  private async authorize(request: PlaybackRequest, locale: Locale) {
    if (!this.client.isReady()) {
      throw new HttpError(503, t(locale, 'playbackDiscordNotReady'));
    }

    const guild = this.client.guilds.cache.get(request.guildId);
    if (!guild) {
      throw new HttpError(404, t(locale, 'playbackGuildUnavailable'));
    }

    const member = await guild.members.fetch({user: request.userId, force: true});
    const voice = await guild.channels.fetch(request.voiceChannelId);
    const text = await guild.channels.fetch(request.textChannelId);
    if (!voice || voice.type !== ChannelType.GuildVoice) {
      throw new HttpError(400, t(locale, 'playbackStageUnsupported'));
    }

    if (!text || text.type !== ChannelType.GuildText) {
      throw new HttpError(400, t(locale, 'playbackTextChannelOnly'));
    }

    // Defense in depth: the guild channel manager should only return channels of this guild.
    if (voice.guildId !== guild.id || text.guildId !== guild.id) {
      throw new HttpError(403, t(locale, 'playbackChannelsWrongGuild'));
    }

    const bot = guild.members.me;
    if (!bot) {
      throw new HttpError(503, t(locale, 'playbackDiscordNotReady'));
    }

    if (member.user.bot || member.voice.channelId !== voice.id
      || !voice.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
      || !text.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.UseApplicationCommands])) {
      throw new HttpError(403, t(locale, 'playbackPermissionsChanged'));
    }

    if (!voice.permissionsFor(bot).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new HttpError(403, t(locale, 'playbackBotNeedsVoicePermissions'));
    }

    if (!text.permissionsFor(bot).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      throw new HttpError(403, t(locale, 'playbackBotNeedsTextPermissions'));
    }

    // Song announcements are sent as embeds.
    if (request.action === 'play' && !text.permissionsFor(bot).has(PermissionFlagsBits.EmbedLinks)) {
      throw new HttpError(403, t(locale, 'playbackBotNeedsEmbedLinks'));
    }

    const connection = this.players.get(guild.id).voiceConnection;
    if (connection && connection.joinConfig.channelId !== voice.id) {
      throw new HttpError(409, t(locale, 'playbackAssignedElsewhere'));
    }

    if (!connection && request.action === 'play' && voice.userLimit > 0 && voice.members.size >= voice.userLimit
      && !voice.permissionsFor(bot).has(PermissionFlagsBits.MoveMembers)) {
      throw new HttpError(403, t(locale, 'playbackChannelFull'));
    }

    return {guild, member, text};
  }

  // eslint-disable-next-line complexity
  private async apply(request: PlaybackRequest, locale: Locale): Promise<PlaybackResult> {
    const context = await this.authorize(request, locale);
    const player = this.players.get(request.guildId);
    let message = t(locale, 'playbackCommandCompleted');
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
            await this.authorize(request, locale);
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
        message = t(locale, 'playbackPartiallyApplied');
      }
    } else if (request.action === 'queue') {
      const pageSize = request.pageSize ?? (await getGuildSettings(request.guildId)).defaultQueuePageSize;
      const start = ((request.page ?? 1) - 1) * pageSize;
      const queue = player.getQueue();
      message = [
        t(locale, 'playbackQueueCurrent', {title: player.getCurrent()?.title.slice(0, 120) ?? t(locale, 'playbackQueueNone')}),
        t(locale, 'playbackQueueSummary', {count: queue.length, page: request.page ?? 1}),
        ...queue.slice(start, start + pageSize).map((song, index) => `${start + index + 1}. ${song.title.slice(0, 45)}`),
      ].join('\n');
    } else {
      if (player.voiceConnection === null) {
        throw new HttpError(409, t(locale, 'playbackBotNotConnected'));
      }

      switch (request.action) {
        case 'pause':
          if (player.status === STATUS.IDLE) {
            throw new HttpError(409, t(locale, 'playbackNothingPlaying'));
          }

          if (player.status === STATUS.PLAYING) {
            player.pause();
          }

          message = t(locale, 'playbackPaused');
          break;
        case 'resume':
          await player.ensureVoiceConnectionReady();
          await this.authorize(request, locale);
          if (player.status !== STATUS.PLAYING) {
            await player.play();
          }

          message = t(locale, 'playbackResumed');
          break;
        case 'skip':
          await player.forward(request.amount ?? 1);
          message = t(locale, 'playbackSkipped');
          break;
        case 'stop':
          player.stop();
          message = t(locale, 'playbackStopped');
          break;
        case 'disconnect':
          player.disconnect();
          message = t(locale, 'playbackDisconnected');
          break;
        case 'volume':
          if (request.volume !== undefined) {
            player.setVolume(request.volume);
          }

          message = t(locale, 'playbackVolume', {volume: player.getVolume()});
          break;
        default:
          throw new HttpError(400, t(locale, 'playbackUnsupportedAction'));
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
