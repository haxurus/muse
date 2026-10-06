import type {Interaction} from 'discord.js';
import type Config from '../services/config.js';
import {HttpError} from '../control/http.js';
import {PLAYBACK_ACTIONS, isPlaybackWorkerEnabled, parsePlaybackRequest, resolveOrchestratorPlaybackUrl} from './protocol.js';
import {sendPlayback} from './transport.js';
import {DEFAULT_LOCALE, localizeEnglishMessage, t, type Locale} from '../i18n/index.js';

export type PlaybackLocaleResolver = (guildId: string | null) => Promise<Locale>;

const englishOnly: PlaybackLocaleResolver = async () => DEFAULT_LOCALE;

/** Keep the real Discord interaction and its token inside the command-receiving worker. */
export const handlePlaybackInteraction = async (
  interaction: Interaction,
  config: Config,
  resolveLocale: PlaybackLocaleResolver = englishOnly,
): Promise<boolean> => {
  if (!isPlaybackWorkerEnabled(config.WORKER_ID)) {
    return false;
  }

  if (interaction.isButton()) {
    const locale = await resolveLocale(interaction.guildId);
    await interaction.reply({content: t(locale, 'playbackUseSlashCommands'), ephemeral: true});
    return true;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName === 'config') {
    return false;
  }

  const action = interaction.commandName === 'next' ? 'skip' : interaction.commandName;
  if (!PLAYBACK_ACTIONS.some(candidate => candidate === action)) {
    const locale = await resolveLocale(interaction.guildId);
    await interaction.reply({content: t(locale, 'playbackNotInPilot'), ephemeral: true});
    return true;
  }

  await interaction.deferReply({ephemeral: true});
  // The worker answers in the guild's locale; fixed English relay messages are translated here.
  const locale = await resolveLocale(interaction.guildId);
  const voiceChannelId = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channelId;
  if (!interaction.guildId || !voiceChannelId || !interaction.channelId) {
    await interaction.editReply(t(locale, 'playbackJoinVoiceFirst'));
    return true;
  }

  const request = parsePlaybackRequest({
    requestId: interaction.id,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    voiceChannelId,
    textChannelId: interaction.channelId,
    action,
    ...(action === 'play' ? {
      query: interaction.options.getString('query'),
      immediate: interaction.options.getBoolean('immediate') ?? false,
      shuffle: interaction.options.getBoolean('shuffle') ?? false,
      split: interaction.options.getBoolean('split') ?? false,
      skip: interaction.options.getBoolean('skip') ?? false,
    } : {}),
    ...(action === 'skip' ? {amount: interaction.options.getInteger('number') ?? 1} : {}),
    ...(action === 'queue' ? {page: interaction.options.getInteger('page') ?? 1, ...(interaction.options.getInteger('page-size') === null ? {} : {pageSize: interaction.options.getInteger('page-size')})} : {}),
    ...(action === 'volume' ? {volume: interaction.options.getInteger('level') ?? 100} : {}),
  });
  try {
    const result = await sendPlayback(resolveOrchestratorPlaybackUrl(), config.CONTROL_TOKEN, request, config.WORKER_ID);
    await interaction.editReply({content: localizeEnglishMessage(locale, result.message), allowedMentions: {parse: []}});
  } catch (error: unknown) {
    if (!(error instanceof HttpError)) {
      throw error;
    }

    console.warn('Orchestrated playback request failed', {statusCode: error.statusCode, guildId: request.guildId, requestId: request.requestId});
    // HttpError messages are produced by the playback hops and are safe to show verbatim.
    await interaction.editReply({content: localizeEnglishMessage(locale, error.message), allowedMentions: {parse: []}});
  }

  return true;
};

/** @deprecated Kept for existing call sites; use handlePlaybackInteraction. */
export const handleBotOneInteraction = handlePlaybackInteraction;
