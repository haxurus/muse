import {SlashCommandBuilder} from '@discordjs/builders';
import {ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits} from 'discord.js';
import {injectable} from 'inversify';
import {prisma} from '../utils/db.js';
import Command from './index.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {UserError, isLocale, localeOf, t, type Locale} from '../i18n/index.js';

// Matches the dashboard validator; each playlist track costs provider API quota.
const MAX_PLAYLIST_LIMIT = 500;
// One day. Delays past ~24.8 days would overflow setTimeout and fire immediately.
const MAX_WAIT_AFTER_QUEUE_EMPTIES_SECONDS = 86_400;

const languageName = (locale: Locale) => t(locale, locale === 'it' ? 'languageNameIt' : 'languageNameEn');

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('config')
    .setDescription('configure bot settings')
    .setDescriptionLocalizations({it: 'configura le impostazioni del bot'})
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(subcommand => subcommand
      .setName('set-playlist-limit')
      .setDescription('set the maximum number of tracks that can be added from a playlist')
      .setDescriptionLocalizations({it: 'imposta il numero massimo di brani aggiungibili da una playlist'})
      .addIntegerOption(option => option
        .setName('limit')
        .setDescription('maximum number of tracks')
        .setDescriptionLocalizations({it: 'numero massimo di brani'})
        .setMinValue(1)
        .setMaxValue(MAX_PLAYLIST_LIMIT)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-wait-after-queue-empties')
      .setDescription('set the time to wait before leaving the voice channel when queue empties')
      .setDescriptionLocalizations({it: 'imposta l\'attesa prima di lasciare il canale vocale quando la coda si svuota'})
      .addIntegerOption(option => option
        .setName('delay')
        .setDescription('delay in seconds (set to 0 to never leave)')
        .setDescriptionLocalizations({it: 'attesa in secondi (0 per non uscire mai)'})
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(MAX_WAIT_AFTER_QUEUE_EMPTIES_SECONDS)))
    .addSubcommand(subcommand => subcommand
      .setName('set-leave-if-no-listeners')
      .setDescription('set whether to leave when all other participants leave')
      .setDescriptionLocalizations({it: 'imposta se uscire quando tutti gli altri partecipanti escono'})
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether to leave when everyone else leaves')
        .setDescriptionLocalizations({it: 'se uscire quando tutti gli altri escono'})
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-queue-add-response-hidden')
      .setDescription('set whether bot responses to queue additions are only displayed to the requester')
      .setDescriptionLocalizations({it: 'imposta se le risposte alle aggiunte in coda sono visibili solo al richiedente'})
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether bot responses to queue additions are only displayed to the requester')
        .setDescriptionLocalizations({it: 'se le risposte alle aggiunte in coda sono visibili solo al richiedente'})
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-reduce-vol-when-voice')
      .setDescription('set whether to turn down the volume when people speak')
      .setDescriptionLocalizations({it: 'imposta se abbassare il volume quando qualcuno parla'})
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether to turn down the volume when people speak')
        .setDescriptionLocalizations({it: 'se abbassare il volume quando qualcuno parla'})
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-reduce-vol-when-voice-target')
      .setDescription('set the target volume when people speak')
      .setDescriptionLocalizations({it: 'imposta il volume da usare quando qualcuno parla'})
      .addIntegerOption(option => option
        .setName('volume')
        .setDescription('volume percentage (0 is muted, 100 is max & default)')
        .setDescriptionLocalizations({it: 'percentuale del volume (0 è muto, 100 è il massimo e il predefinito)'})
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-auto-announce-next-song')
      .setDescription('set whether to announce the next song in the queue automatically')
      .setDescriptionLocalizations({it: 'imposta se annunciare automaticamente il prossimo brano in coda'})
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('whether to announce the next song in the queue automatically')
        .setDescriptionLocalizations({it: 'se annunciare automaticamente il prossimo brano in coda'})
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-default-volume')
      .setDescription('set default volume used when entering the voice channel')
      .setDescriptionLocalizations({it: 'imposta il volume predefinito all\'ingresso nel canale vocale'})
      .addIntegerOption(option => option
        .setName('level')
        .setDescription('volume percentage (0 is muted, 100 is max & default)')
        .setDescriptionLocalizations({it: 'percentuale del volume (0 è muto, 100 è il massimo e il predefinito)'})
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-default-queue-page-size')
      .setDescription('set the default page size of the /queue command')
      .setDescriptionLocalizations({it: 'imposta il numero predefinito di brani per pagina di /queue'})
      .addIntegerOption(option => option
        .setName('page-size')
        .setDescription('page size of the /queue command')
        .setDescriptionLocalizations({it: 'brani per pagina di /queue'})
        .setMinValue(1)
        .setMaxValue(30)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-language')
      .setDescription('set the language of bot messages')
      .setDescriptionLocalizations({it: 'imposta la lingua dei messaggi del bot'})
      .addStringOption(option => option
        .setName('language')
        .setDescription('bot language')
        .setDescriptionLocalizations({it: 'lingua del bot'})
        .setRequired(true)
        .addChoices(
          {name: 'English', value: 'en'},
          {name: 'Italiano', value: 'it'},
        )))
    .addSubcommand(subcommand => subcommand
      .setName('get')
      .setDescription('show all settings')
      .setDescriptionLocalizations({it: 'mostra tutte le impostazioni'}));

  // eslint-disable-next-line complexity
  async execute(interaction: ChatInputCommandInteraction) {
    // Ensure guild settings exist before trying to update
    const currentSettings = await getGuildSettings(interaction.guild!.id);
    const locale = localeOf(currentSettings);

    switch (interaction.options.getSubcommand()) {
      case 'set-playlist-limit': {
        const limit: number = interaction.options.getInteger('limit')!;

        if (limit < 1 || limit > MAX_PLAYLIST_LIMIT) {
          throw new UserError('configInvalidLimit', {max: MAX_PLAYLIST_LIMIT});
        }

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            playlistLimit: limit,
          },
        });

        await interaction.reply(t(locale, 'configLimitUpdated'));

        break;
      }

      case 'set-wait-after-queue-empties': {
        const delay = interaction.options.getInteger('delay')!;

        if (delay < 0 || delay > MAX_WAIT_AFTER_QUEUE_EMPTIES_SECONDS) {
          throw new UserError('configInvalidDelay', {max: MAX_WAIT_AFTER_QUEUE_EMPTIES_SECONDS});
        }

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            secondsToWaitAfterQueueEmpties: delay,
          },
        });

        await interaction.reply(t(locale, 'configWaitUpdated'));

        break;
      }

      case 'set-leave-if-no-listeners': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            leaveIfNoListeners: value,
          },
        });

        await interaction.reply(t(locale, 'configLeaveUpdated'));

        break;
      }

      case 'set-queue-add-response-hidden': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            queueAddResponseEphemeral: value,
          },
        });

        await interaction.reply(t(locale, 'configQueueAddUpdated'));

        break;
      }

      case 'set-auto-announce-next-song': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            autoAnnounceNextSong: value,
          },
        });

        await interaction.reply(t(locale, 'configAutoAnnounceUpdated'));

        break;
      }

      case 'set-default-volume': {
        const value = interaction.options.getInteger('level')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            defaultVolume: value,
          },
        });

        await interaction.reply(t(locale, 'configVolumeUpdated'));

        break;
      }

      case 'set-default-queue-page-size': {
        const value = interaction.options.getInteger('page-size')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            defaultQueuePageSize: value,
          },
        });

        await interaction.reply(t(locale, 'configQueuePageSizeUpdated'));

        break;
      }

      case 'set-reduce-vol-when-voice': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            turnDownVolumeWhenPeopleSpeak: value,
          },
        });

        await interaction.reply(t(locale, 'configReduceVolumeUpdated'));

        break;
      }

      case 'set-reduce-vol-when-voice-target': {
        const value = interaction.options.getInteger('volume')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            turnDownVolumeWhenPeopleSpeakTarget: value,
          },
        });

        await interaction.reply(t(locale, 'configReduceVolumeTargetUpdated'));

        break;
      }

      case 'set-language': {
        const value = interaction.options.getString('language');

        // Discord enforces the choices, but the value is still validated before it is stored.
        if (!isLocale(value)) {
          throw new UserError('configInvalidLanguage');
        }

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            locale: value,
          },
        });

        // Confirm in the newly selected language.
        await interaction.reply(t(value, 'configLanguageUpdated'));

        break;
      }

      case 'get': {
        const embed = new EmbedBuilder().setTitle(t(locale, 'configTitle'));

        const config = await getGuildSettings(interaction.guild!.id);
        const yesNo = (value: boolean) => t(locale, value ? 'yes' : 'no');

        const settingsToShow: Array<[string, string | number]> = [
          [t(locale, 'configPlaylistLimit'), config.playlistLimit],
          [t(locale, 'configWaitBeforeLeaving'), config.secondsToWaitAfterQueueEmpties === 0
            ? t(locale, 'configNeverLeave')
            : `${config.secondsToWaitAfterQueueEmpties}s`],
          [t(locale, 'configLeaveIfNoListeners'), yesNo(config.leaveIfNoListeners)],
          [t(locale, 'configAutoAnnounce'), yesNo(config.autoAnnounceNextSong)],
          [t(locale, 'configQueueAddEphemeral'), yesNo(config.queueAddResponseEphemeral)],
          [t(locale, 'configDefaultVolume'), config.defaultVolume],
          [t(locale, 'configDefaultQueuePageSize'), config.defaultQueuePageSize],
          [t(locale, 'configReduceVolume'), yesNo(config.turnDownVolumeWhenPeopleSpeak)],
          [t(locale, 'configReduceVolumeTarget'), config.turnDownVolumeWhenPeopleSpeakTarget],
          [t(locale, 'configLanguage'), languageName(localeOf(config))],
        ];

        let description = '';
        for (const [key, value] of settingsToShow) {
          description += `**${key}**: ${value}\n`;
        }

        embed.setDescription(description);

        await interaction.reply({embeds: [embed]});

        break;
      }

      default:
        throw new UserError('unknownSubcommand');
    }
  }
}
