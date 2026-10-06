import {ChatInputCommandInteraction} from 'discord.js';
import {TYPES} from '../types.js';
import {inject, injectable} from 'inversify';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {UserError, t} from '../i18n/index.js';
import {getGuildLocale} from '../i18n/guild-locale.js';
import {parseTime, prettyTime} from '../utils/time.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import durationStringToSeconds from '../utils/duration-string-to-seconds.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('seek')
    .setDescription('seek to a position from beginning of song')
    .setDescriptionLocalizations({it: 'vai a una posizione dall\'inizio del brano'})
    .addStringOption(option =>
      option.setName('time')
        .setDescription('an interval expression or number of seconds (1m, 30s, 100)')
        .setDescriptionLocalizations({it: 'un intervallo o un numero di secondi (1m, 30s, 100)'})
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

    if (currentSong.isLive) {
      throw new UserError('seekLivestream');
    }

    const time = interaction.options.getString('time')!.trim();

    let seekTime = 0;

    if (time.includes(':')) {
      if (!/^\+?\d+(?::\d+)+$/.test(time)) {
        throw new UserError('seekInvalidValue');
      }

      seekTime = parseTime(time);
    } else {
      seekTime = durationStringToSeconds(time);
    }

    if (!Number.isFinite(seekTime) || seekTime < 0) {
      throw new UserError('seekInvalidValue');
    }

    if (seekTime > currentSong.length) {
      throw new UserError('seekPastEnd');
    }

    await Promise.all([
      player.seek(seekTime),
      interaction.deferReply(),
    ]);

    await interaction.editReply(t(await getGuildLocale(interaction.guild!.id), 'seekDone', {time: prettyTime(player.getPosition())}));
  }
}
