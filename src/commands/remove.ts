import {ChatInputCommandInteraction} from 'discord.js';
import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {UserError, t} from '../i18n/index.js';
import {getGuildLocale} from '../i18n/guild-locale.js';
import {SlashCommandBuilder} from '@discordjs/builders';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('remove')
    .setDescription('remove songs from the queue')
    .setDescriptionLocalizations({it: 'rimuovi brani dalla coda'})
    .addIntegerOption(option =>
      option.setName('position')
        .setDescription('position of the song to remove [default: 1]')
        .setDescriptionLocalizations({it: 'posizione del brano da rimuovere [predefinita: 1]'})
        .setMinValue(1)
        .setRequired(false),
    )
    .addIntegerOption(option =>
      option.setName('range')
        .setDescription('number of songs to remove [default: 1]')
        .setDescriptionLocalizations({it: 'numero di brani da rimuovere [predefinito: 1]'})
        .setMinValue(1)
        .setRequired(false));

  private readonly playerManager: PlayerManager;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager) {
    this.playerManager = playerManager;
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = this.playerManager.get(interaction.guild!.id);

    const position = interaction.options.getInteger('position') ?? 1;
    const range = interaction.options.getInteger('range') ?? 1;

    if (position < 1) {
      throw new UserError('positionAtLeastOne');
    }

    if (range < 1) {
      throw new UserError('removeRangeAtLeastOne');
    }

    if (position > player.queueSize()) {
      throw new UserError('removeOutOfRange');
    }

    player.removeFromQueue(position, range);

    await interaction.reply(t(await getGuildLocale(interaction.guild!.id), 'removeDone'));
  }
}
