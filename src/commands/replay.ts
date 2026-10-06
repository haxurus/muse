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
    .setName('replay')
    .setDescription('replay the current song')
    .setDescriptionLocalizations({it: 'riascolta il brano corrente dall\'inizio'});

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

    if (currentSong.isLive) {
      throw new UserError('replayLivestream');
    }

    await Promise.all([
      player.seek(0),
      interaction.deferReply(),
    ]);

    await interaction.editReply(t(await getGuildLocale(interaction.guild!.id), 'replayDone'));
  }
}
