import {ChatInputCommandInteraction} from 'discord.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import {TYPES} from '../types.js';
import {inject, injectable} from 'inversify';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {UserError, t} from '../i18n/index.js';
import {getGuildLocale} from '../i18n/guild-locale.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('stop playback, disconnect, and clear all songs in the queue')
    .setDescriptionLocalizations({it: 'ferma la riproduzione, disconnetti il bot e svuota la coda'});

  public requiresVC = true;

  private readonly playerManager: PlayerManager;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager) {
    this.playerManager = playerManager;
  }

  public async execute(interaction: ChatInputCommandInteraction) {
    const player = this.playerManager.get(interaction.guild!.id);

    if (!player.voiceConnection) {
      throw new UserError('notConnected');
    }

    player.stop();
    await interaction.reply(t(await getGuildLocale(interaction.guild!.id), 'stopDone'));
  }
}
