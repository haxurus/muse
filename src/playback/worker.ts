import {ChannelType, PermissionFlagsBits, type Client} from 'discord.js';
import type PlayerManager from '../managers/player.js';
import type AddQueryToQueue from '../services/add-query-to-queue.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {STATUS} from '../services/player-types.js';
import {HttpError} from '../control/http.js';
import PlaybackGate from './gate.js';
import {parsePlaybackRequest, type PlaybackRequest, type PlaybackResult} from './protocol.js';

export default class BotOnePlaybackWorker {
  private readonly gate = new PlaybackGate();

  constructor(
    private readonly client: Client,
    private readonly players: PlayerManager,
    private readonly enqueue: AddQueryToQueue,
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

        // Native media errors may contain provider URLs or credentials.
        console.error('Bot-one playback failed', {guildId: request.guildId, requestId: request.requestId});
        throw new HttpError(502, 'Playback failed. Check the worker status before retrying.');
      }
    });
  }

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
    if (!voice || voice.type !== ChannelType.GuildVoice || !text || text.type !== ChannelType.GuildText) {
      throw new HttpError(400, 'The pilot supports ordinary text and voice channels only.');
    }

    if (voice.guildId !== guild.id || text.guildId !== guild.id) {
      throw new HttpError(403, 'Channels must belong to the requested guild.');
    }

    const bot = guild.members.me;
    if (member.user.bot || member.voice.channelId !== voice.id || !bot
      || !voice.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
      || !text.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.UseApplicationCommands])
      || !voice.permissionsFor(bot).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
      || !text.permissionsFor(bot).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      throw new HttpError(403, 'Voice membership or channel permissions changed.');
    }

    const connection = this.players.get(guild.id).voiceConnection;
    if (connection && connection.joinConfig.channelId !== voice.id) {
      throw new HttpError(409, 'This bot is already assigned to another voice channel.');
    }

    return {guild, member, text};
  }

  private async apply(request: PlaybackRequest): Promise<PlaybackResult> {
    const context = await this.authorize(request);
    const player = this.players.get(request.guildId);
    let message = 'Command completed.';
    if (request.action === 'play') {
      const wasDisconnected = player.voiceConnection === null;
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
        if (wasDisconnected) {
          player.disconnect();
        }

        throw error;
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
      workerId: 'muse-01',
      guildId: request.guildId,
      requestId: request.requestId,
      channelId: player.voiceConnection?.joinConfig.channelId ?? null,
      state: player.voiceConnection === null ? 'FREE' : player.status === STATUS.PLAYING ? 'PLAYING' : player.status === STATUS.PAUSED ? 'PAUSED' : 'IDLE',
      message: message.slice(0, 1900),
    };
  }
}
