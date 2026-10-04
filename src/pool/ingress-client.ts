import got from 'got';
import {AutocompleteInteraction, ChatInputCommandInteraction, GuildMember} from 'discord.js';
import Config from '../services/config.js';
import {getMemberVoiceChannel} from '../utils/channels.js';
import {signControlRequest} from '../control/signature.js';
import {RemoteCommandOptionValue, RemoteCommandResult} from '../worker-control/commands.js';

type InteractionOption = {
  name: string;
  value?: unknown;
  options?: InteractionOption[];
};

export type PoolCommandResult = RemoteCommandResult & {
  workerId: string;
  workerLabel: string;
};

const flattenOptions = (
  entries: InteractionOption[],
  result: Record<string, RemoteCommandOptionValue> = {},
): Record<string, RemoteCommandOptionValue> => {
  for (const entry of entries) {
    if (entry.options) {
      result.subcommand = entry.name;
      flattenOptions(entry.options, result);
      continue;
    }

    if (typeof entry.value === 'string' || typeof entry.value === 'number' || typeof entry.value === 'boolean') {
      result[entry.name] = entry.value;
    }
  }

  return result;
};

export const routePoolCommand = async (
  config: Config,
  interaction: ChatInputCommandInteraction,
): Promise<PoolCommandResult> => {
  if (!interaction.guild || !interaction.guildId || !interaction.channelId) {
    throw new Error('pool commands require a Discord server');
  }

  const voiceChannelId = getMemberVoiceChannel(interaction.member as GuildMember)?.[0].id ?? null;
  const body = JSON.stringify({
    guildId: interaction.guildId,
    guildName: interaction.guild.name,
    guildOwnerId: interaction.guild.ownerId,
    voiceChannelId,
    textChannelId: interaction.channelId,
    userId: interaction.user.id,
    commandName: interaction.commandName,
    options: flattenOptions(interaction.options.data as InteractionOption[]),
  });
  const requestPath = '/internal/v1/commands';
  const {timestamp, signature} = signControlRequest(
    config.WORKER_CONTROL_SECRET,
    'POST',
    requestPath,
    body,
  );

  const response = await got(`${config.ORCHESTRATOR_INTERNAL_URL.replace(/\/$/u, '')}${requestPath}`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-muse-worker-id': config.WORKER_ID,
      'x-muse-timestamp': timestamp,
      'x-muse-signature': signature,
    },
    timeout: {request: 90_000},
    retry: {limit: 0},
    followRedirect: false,
    responseType: 'json',
    throwHttpErrors: false,
  });
  const responseBody = response.body as PoolCommandResult | {error?: unknown};
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = typeof (responseBody as {error?: unknown}).error === 'string'
      ? (responseBody as {error: string}).error
      : `orchestrator returned HTTP ${response.statusCode}`;
    throw new Error(error.slice(0, 300));
  }

  return responseBody as PoolCommandResult;
};

export const routePoolFavoriteAutocomplete = async (
  config: Config,
  interaction: AutocompleteInteraction,
) => {
  if (!interaction.guild || !interaction.guildId) {
    return [];
  }

  const body = JSON.stringify({
    guildId: interaction.guildId,
    guildOwnerId: interaction.guild.ownerId,
    userId: interaction.user.id,
    subcommand: interaction.options.getSubcommand(),
    query: interaction.options.getString('name') ?? '',
  });
  const requestPath = '/internal/v1/autocomplete';
  const {timestamp, signature} = signControlRequest(
    config.WORKER_CONTROL_SECRET,
    'POST',
    requestPath,
    body,
  );

  const response = await got(`${config.ORCHESTRATOR_INTERNAL_URL.replace(/\/$/u, '')}${requestPath}`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-muse-worker-id': config.WORKER_ID,
      'x-muse-timestamp': timestamp,
      'x-muse-signature': signature,
    },
    timeout: {request: 5000},
    retry: {limit: 0},
    followRedirect: false,
    responseType: 'json',
    throwHttpErrors: false,
  });
  const result = response.body as {choices?: Array<{name: string; value: string}>; error?: unknown};
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(typeof result.error === 'string' ? result.error.slice(0, 300) : 'autocomplete unavailable');
  }

  return result.choices ?? [];
};
