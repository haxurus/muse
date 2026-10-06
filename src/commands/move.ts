import {ChatInputCommandInteraction, escapeMarkdown} from 'discord.js';
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
    .setName('move')
    .setDescription('move songs within the queue')
    .setDescriptionLocalizations({it: 'sposta i brani nella coda'})
    .addIntegerOption(option =>
      option.setName('from')
        .setDescription('position of the song to move')
        .setDescriptionLocalizations({it: 'posizione del brano da spostare'})
        .setRequired(true),
    )
    .addIntegerOption(option =>
      option.setName('to')
        .setDescription('position to move the song to')
        .setDescriptionLocalizations({it: 'posizione in cui spostare il brano'})
        .setRequired(true));

  private readonly playerManager: PlayerManager;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager) {
    this.playerManager = playerManager;
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = this.playerManager.get(interaction.guild!.id);

    const from = interaction.options.getInteger('from') ?? 1;
    const to = interaction.options.getInteger('to') ?? 1;

    if (from < 1) {
      throw new UserError('positionAtLeastOne');
    }

    if (to < 1) {
      throw new UserError('positionAtLeastOne');
    }

    const {title} = player.move(from, to);

    await interaction.reply(t(await getGuildLocale(interaction.guild!.id), 'moveDone', {title: escapeMarkdown(title), position: to}));
  }
}
