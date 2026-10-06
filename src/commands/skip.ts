import {ChatInputCommandInteraction} from 'discord.js';
import {TYPES} from '../types.js';
import {inject, injectable} from 'inversify';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {UserError, t} from '../i18n/index.js';
import {getGuildLocale} from '../i18n/guild-locale.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('skip')
    .setDescription('skip the next songs')
    .setDescriptionLocalizations({it: 'salta i prossimi brani'})
    .addIntegerOption(option => option
      .setName('number')
      .setDescription('number of songs to skip [default: 1]')
      .setDescriptionLocalizations({it: 'numero di brani da saltare [predefinito: 1]'})
      .setRequired(false));

  public requiresVC = true;

  private readonly playerManager: PlayerManager;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager) {
    this.playerManager = playerManager;
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const numToSkip = interaction.options.getInteger('number') ?? 1;

    if (numToSkip < 1) {
      throw new UserError('skipInvalidNumber');
    }

    const player = this.playerManager.get(interaction.guild!.id);
    await interaction.deferReply({ephemeral: true});

    try {
      await player.forward(numToSkip);
      const locale = await getGuildLocale(interaction.guild!.id);
      await interaction.followUp({
        content: t(locale, 'skipDone'),
        embeds: player.getCurrent() ? [buildPlayingMessageEmbed(player, locale)] : [],
      });
      await interaction.deleteReply().catch(() => undefined);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'No songs in queue to forward to.') {
        throw new UserError('noSongToSkipTo');
      }

      throw error;
    }
  }
}
