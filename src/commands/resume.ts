import {SlashCommandBuilder} from '@discordjs/builders';
import {inject, injectable} from 'inversify';
import Command from './index.js';
import {UserError, t} from '../i18n/index.js';
import {getGuildLocale} from '../i18n/guild-locale.js';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import {STATUS} from '../services/player.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';
import {getMemberVoiceChannel, getMostPopularVoiceChannel} from '../utils/channels.js';
import {ChatInputCommandInteraction, GuildMember} from 'discord.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('resume')
    .setDescription('resume playback')
    .setDescriptionLocalizations({it: 'riprendi la riproduzione'});

  public requiresVC = true;

  private readonly playerManager: PlayerManager;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager) {
    this.playerManager = playerManager;
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = this.playerManager.get(interaction.guild!.id);
    const [targetVoiceChannel] = getMemberVoiceChannel(interaction.member as GuildMember) ?? getMostPopularVoiceChannel(interaction.guild!);
    if (player.status === STATUS.PLAYING) {
      throw new UserError('resumeAlreadyPlaying');
    }

    // Must be resuming play
    if (!player.getCurrent()) {
      throw new UserError('resumeNothingToPlay');
    }

    await interaction.deferReply({ephemeral: true});
    await player.connect(targetVoiceChannel);
    await player.play();
    if (!player.getCurrent()) {
      throw new UserError('noPlayableSongsFound');
    }

    const locale = await getGuildLocale(interaction.guild!.id);
    await interaction.followUp({
      content: t(locale, 'resumeDone'),
      embeds: [buildPlayingMessageEmbed(player, locale)],
    });
    await interaction.deleteReply().catch(() => undefined);
  }
}
