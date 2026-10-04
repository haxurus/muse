import {ChatInputCommandInteraction, GuildMember} from 'discord.js';
import {prettyTime} from '../utils/time.js';
import {getMemberVoiceChannel} from '../utils/channels.js';
import OrchestratorPlaybackClient from './orchestrator-playback-client.js';
import type Config from '../services/config.js';
import type {PlaybackQueueEntry} from './playback-types.js';

const COMMANDS = new Set([
  'play',
  'pause',
  'resume',
  'skip',
  'next',
  'stop',
  'disconnect',
  'queue',
  'volume',
  'now-playing',
]);

const songLabel = (song: PlaybackQueueEntry): string =>
  song.artist ? `${song.title} - ${song.artist}` : song.title;

export default class RemoteCommandRouter {
  private readonly client: OrchestratorPlaybackClient;

  constructor(config: Config) {
    this.client = new OrchestratorPlaybackClient(config);
  }

  handles(commandName: string): boolean {
    return COMMANDS.has(commandName);
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guild!.id;
    const member = interaction.member as GuildMember;
    const voiceChannel = getMemberVoiceChannel(member)?.[0] ?? null;
    const requesterId = interaction.user.id;

    switch (interaction.commandName) {
      case 'play': {
        if (!voiceChannel) {
          throw new Error('gotta be in a voice channel');
        }

        await interaction.deferReply();
        const result = await this.client.action(guildId, 'play', {
          voiceChannelId: voiceChannel.id,
          categoryId: voiceChannel.parentId,
          textChannelId: interaction.channelId,
          requesterId,
          query: interaction.options.getString('query', true).trim(),
          immediate: interaction.options.getBoolean('immediate') ?? false,
          shuffle: interaction.options.getBoolean('shuffle') ?? false,
          split: interaction.options.getBoolean('split') ?? false,
          skip: interaction.options.getBoolean('skip') ?? false,
        });
        await interaction.editReply(result.message);
        return;
      }

      case 'pause':
      case 'resume':
      case 'stop':
      case 'disconnect': {
        if (!voiceChannel) {
          throw new Error('gotta be in a voice channel');
        }

        const result = await this.client.action(guildId, interaction.commandName, {
          voiceChannelId: voiceChannel.id,
          requesterId,
        });
        await interaction.reply(result.message);
        return;
      }

      case 'skip':
      case 'next': {
        if (!voiceChannel) {
          throw new Error('gotta be in a voice channel');
        }

        await interaction.deferReply({ephemeral: true});
        const result = await this.client.action(guildId, 'skip', {
          voiceChannelId: voiceChannel.id,
          requesterId,
          count: interaction.commandName === 'next'
            ? 1
            : interaction.options.getInteger('number') ?? 1,
        });
        await interaction.editReply(result.message);
        return;
      }

      case 'volume': {
        if (!voiceChannel) {
          throw new Error('gotta be in a voice channel');
        }

        const result = await this.client.action(guildId, 'volume', {
          voiceChannelId: voiceChannel.id,
          requesterId,
          level: interaction.options.getInteger('level', true),
        });
        await interaction.reply(result.message);
        return;
      }

      case 'queue': {
        const result = await this.client.read(guildId, 'queue', voiceChannel?.id ?? null);
        const page = interaction.options.getInteger('page') ?? 1;
        const pageSize = interaction.options.getInteger('page-size') ?? 10;
        const songs = result.playback.queue;
        const totalPages = Math.max(1, Math.ceil(songs.length / pageSize));

        if (page > totalPages) {
          throw new Error('queue page is out of range');
        }

        const start = (page - 1) * pageSize;
        const entries = songs.slice(start, start + pageSize)
          .map((song, index) => `${start + index + 1}. **${songLabel(song)}**`);

        const current = result.playback.current
          ? `Now: **${songLabel(result.playback.current)}**`
          : 'Nothing is currently playing.';
        const body = entries.length > 0 ? `${current}\n\n${entries.join('\n')}` : current;

        await interaction.reply({
          content: `${body}\n\nPage ${page}/${totalPages} · Worker ${result.lease?.workerId ?? 'unknown'}`,
        });
        return;
      }

      case 'now-playing': {
        const result = await this.client.read(guildId, 'now-playing', voiceChannel?.id ?? null);
        const current = result.playback.current!;
        await interaction.reply(
          `**${songLabel(current)}** · ${prettyTime(result.playback.positionSeconds)} / ${prettyTime(current.length)} · Worker ${result.lease?.workerId ?? 'unknown'}`,
        );
        return;
      }

      default:
        throw new Error('unsupported managed command');
    }
  }
}
