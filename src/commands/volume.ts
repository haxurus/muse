import {ChatInputCommandInteraction} from 'discord.js';
import {TYPES} from '../types.js';
import {inject, injectable} from 'inversify';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {UserError, t} from '../i18n/index.js';
import {getGuildLocale} from '../i18n/guild-locale.js';
import {SlashCommandBuilder} from '@discordjs/builders';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('volume')
    .setDescription('set current player volume level')
    .setDescriptionLocalizations({it: 'imposta il volume del player'})
    .addIntegerOption(option =>
      option.setName('level')
        .setDescription('volume percentage (0 is muted, 100 is max & default)')
        .setDescriptionLocalizations({it: 'percentuale del volume (0 è muto, 100 è il massimo e il predefinito)'})
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true),
    );

  public requiresVC = true;

  private readonly playerManager: PlayerManager;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager) {
    this.playerManager = playerManager;
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = this.playerManager.get(interaction.guild!.id);

    const currentSong = player.getCurrent();

    if (!currentSong) {
      throw new UserError('nothingIsPlaying');
    }

    const level = interaction.options.getInteger('level') ?? 100;
    player.setVolume(level);
    await interaction.reply(t(await getGuildLocale(interaction.guild!.id), 'volumeDone', {level}));
  }
}
