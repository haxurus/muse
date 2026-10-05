import type {Interaction} from 'discord.js';
import type Config from '../services/config.js';
import {PLAYBACK_ACTIONS, isBotOnePlaybackEnabled, parsePlaybackRequest} from './protocol.js';
import {sendPlayback} from './transport.js';

/** Keep the real Discord interaction and its token inside bot 01. */
export const handleBotOneInteraction = async (interaction: Interaction, config: Config): Promise<boolean> => {
  if (!isBotOnePlaybackEnabled(config.WORKER_ID)) {
    return false;
  }

  if (interaction.isButton()) {
    await interaction.reply({content: 'Use slash commands while bot-one pilot mode is enabled.', ephemeral: true});
    return true;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName === 'config') {
    return false;
  }

  const action = interaction.commandName === 'next' ? 'skip' : interaction.commandName;
  if (!PLAYBACK_ACTIONS.some(candidate => candidate === action)) {
    await interaction.reply({content: 'This command is not yet part of the bot-one playback pilot.', ephemeral: true});
    return true;
  }

  await interaction.deferReply({ephemeral: true});
  const voiceChannelId = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channelId;
  if (!interaction.guildId || !voiceChannelId || !interaction.channelId) {
    await interaction.editReply('Join a voice channel in this server first.');
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
  const result = await sendPlayback('http://orchestrator:3100/v1/playback', config.CONTROL_TOKEN, request);
  await interaction.editReply({content: result.message, allowedMentions: {parse: []}});
  return true;
};
