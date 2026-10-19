import type {Interaction} from 'discord.js';
import type Config from '../services/config.js';
import {HttpError} from '../control/http.js';
import {isSnowflake} from '../control/snowflake.js';
import {
  PLAYBACK_ACTIONS,
  isPlaybackPoolEnabled,
  isPlaybackWorkerId,
  resolveOrchestratorPlaybackUrl,
  resolveOrchestratorUrl,
  type PlaybackAction,
  type PlaybackWorkerId,
} from './protocol.js';
import {sendPlayback} from './transport.js';
import {buildPlaybackRequest} from './controller.js';
import {localizeEnglishMessage, t, type Locale} from '../i18n/index.js';

/** Player commands that follow the bot of the user's voice channel (`/config` and `/favorites` stay local). */
export const POOL_COMMANDS: ReadonlySet<string> = new Set([
  'play', 'pause', 'resume', 'skip', 'next', 'stop', 'disconnect', 'queue', 'volume',
  'clear', 'fseek', 'loop', 'loop-queue', 'move', 'now-playing', 'remove', 'replay', 'seek', 'shuffle', 'unskip',
]);

export type PoolAnswer =
  | {kind: 'assigned'; workerId: PlaybackWorkerId; botId: string | null}
  | {kind: 'none'}
  | {kind: 'busy'}
  | {kind: 'unavailable'};

const isRelayAction = (action: string): action is PlaybackAction => PLAYBACK_ACTIONS.some(candidate => candidate === action);

/** Which bot serves a voice channel; `unavailable` (orchestrator unreachable) means "run it locally". */
export const requestAssignment = async (
  token: string,
  body: {guildId: string; voiceChannelId: string; intent: 'play' | 'control'},
): Promise<PoolAnswer> => {
  let response: Response;
  try {
    response = await fetch(resolveOrchestratorUrl('/v1/playback/assign'), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify(body),
    });
  } catch {
    return {kind: 'unavailable'};
  }

  if (response.status === 409) {
    return {kind: 'busy'};
  }

  if (!response.ok) {
    return {kind: 'unavailable'};
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {kind: 'unavailable'};
  }

  const {workerId, botId} = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  if (workerId === null) {
    return {kind: 'none'};
  }

  if (typeof workerId !== 'string' || !isPlaybackWorkerId(workerId)) {
    return {kind: 'unavailable'};
  }

  return {kind: 'assigned', workerId, botId: isSnowflake(botId) ? botId : null};
};

export type PoolDeps = {
  /** Voice channel this bot is connected to in the guild, or null. */
  ownVoiceChannel: (guildId: string) => string | null;
  resolveLocale: (guildId: string) => Promise<Locale>;
  assign?: typeof requestAssignment;
  relay?: typeof sendPlayback;
};

/**
 * Pool mode: a player command follows the bot of the user's voice channel. Returns true when the
 * interaction was answered here (relayed to the assigned bot, or pointed at it), false to run the
 * command locally (this bot is the assigned one, or the orchestrator cannot answer).
 */
// eslint-disable-next-line complexity
export const routePoolInteraction = async (interaction: Interaction, config: Config, deps: PoolDeps): Promise<boolean> => {
  if (!isPlaybackPoolEnabled() || !interaction.isChatInputCommand() || !interaction.inGuild() || !POOL_COMMANDS.has(interaction.commandName)) {
    return false;
  }

  const {guildId} = interaction;
  const voiceChannelId = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channelId;
  const ownChannel = deps.ownVoiceChannel(guildId);
  if (!voiceChannelId || ownChannel === voiceChannelId) {
    return false;
  }

  const intent = interaction.commandName === 'play' ? 'play' : 'control';
  const answer = await (deps.assign ?? requestAssignment)(config.CONTROL_TOKEN, {guildId, voiceChannelId, intent});
  if (answer.kind === 'unavailable' || (answer.kind === 'assigned' && answer.workerId === config.WORKER_ID)) {
    return false;
  }

  // No bot in the user's channel: a free bot reports it locally, a busy one must not touch its own channel.
  if (answer.kind === 'none' && ownChannel === null) {
    return false;
  }

  const locale = await deps.resolveLocale(guildId);
  if (answer.kind !== 'assigned') {
    await interaction.reply({content: t(locale, answer.kind === 'busy' ? 'poolAllBotsBusy' : 'poolNoBotInChannel'), ephemeral: true});
    return true;
  }

  const action = interaction.commandName === 'next' ? 'skip' : interaction.commandName;
  if (!isRelayAction(action)) {
    await interaction.reply({
      content: t(locale, 'poolUseBotInChannel', {bot: answer.botId ? `<@${answer.botId}>` : answer.workerId}),
      ephemeral: true,
      allowedMentions: {parse: []},
    });
    return true;
  }

  await interaction.deferReply({ephemeral: true});
  if (!interaction.channelId) {
    await interaction.editReply(t(locale, 'playbackJoinVoiceFirst'));
    return true;
  }

  const request = buildPlaybackRequest(interaction, action, voiceChannelId);
  try {
    // The orchestrator routes to the same assignment and checks the bot that answers.
    const result = await (deps.relay ?? sendPlayback)(resolveOrchestratorPlaybackUrl(), config.CONTROL_TOKEN, request, null);
    await interaction.editReply({content: localizeEnglishMessage(locale, result.message), allowedMentions: {parse: []}});
  } catch (error: unknown) {
    if (!(error instanceof HttpError)) {
      throw error;
    }

    console.warn('Pooled playback request failed', {statusCode: error.statusCode, guildId, requestId: request.requestId});
    await interaction.editReply({content: localizeEnglishMessage(locale, error.message), allowedMentions: {parse: []}});
  }

  return true;
};
