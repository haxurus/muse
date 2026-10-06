import {ChatInputCommandInteraction} from 'discord.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {localeOf, type Locale} from '../i18n/index.js';
import {getGuildLocale} from '../i18n/guild-locale.js';
import {buildQueueEmbed} from '../utils/build-embed.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('queue')
    .setDescription('show the current queue')
    .setDescriptionLocalizations({it: 'mostra la coda corrente'})
    .addIntegerOption(option => option
      .setName('page')
      .setDescription('page of queue to show [default: 1]')
      .setDescriptionLocalizations({it: 'pagina della coda da mostrare [predefinita: 1]'})
      .setMinValue(1)
      .setRequired(false))
    .addIntegerOption(option => option
      .setName('page-size')
      .setDescription('how many items to display per page [default: 10, max: 30]')
      .setDescriptionLocalizations({it: 'quanti brani mostrare per pagina [predefinito: 10, max: 30]'})
      .setMinValue(1)
      .setMaxValue(30)
      .setRequired(false));

  private readonly playerManager: PlayerManager;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager) {
    this.playerManager = playerManager;
  }

  public async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guild!.id;
    const player = this.playerManager.get(guildId);

    let pageSize = interaction.options.getInteger('page-size');
    let locale: Locale;
    if (pageSize === null) {
      // Settings are loaded anyway for the default page size: reuse them for the locale.
      const settings = await getGuildSettings(guildId);
      pageSize = settings.defaultQueuePageSize;
      locale = localeOf(settings);
    } else {
      locale = await getGuildLocale(guildId);
    }

    const embed = buildQueueEmbed(
      player,
      interaction.options.getInteger('page') ?? 1,
      pageSize,
      locale,
    );

    await interaction.reply({embeds: [embed]});
  }
}
