import got from 'got';
import {signControlRequest} from '../control/signature.js';
import {GuildSettingsValues} from '../control/settings.js';
import {WorkerDefinition} from './config.js';
import {RemoteCommandRequest, RemoteCommandResult} from '../worker-control/commands.js';

export type WorkerStatus = {
  workerId: string;
  label: string;
  discordReady: boolean;
  discordUserId: string | null;
  guilds: Array<{guildId: string; name: string}>;
  players: Array<{
    guildId: string;
    voiceChannelId: string | null;
    status: number;
    queueLength: number;
    currentTitle: string | null;
  }>;
};

const requestWorker = async <T>(
  worker: WorkerDefinition,
  method: 'GET' | 'PUT' | 'POST',
  requestPath: string,
  payload?: unknown,
): Promise<T> => {
  const body = typeof payload === 'undefined' ? '' : JSON.stringify(payload);
  const {timestamp, signature} = signControlRequest(worker.secret, method, requestPath, body);

  const response = await got(`${worker.url}${requestPath}`, {
    method,
    body: body === '' ? undefined : body,
    headers: {
      ...(body === '' ? {} : {'content-type': 'application/json'}),
      'x-muse-timestamp': timestamp,
      'x-muse-signature': signature,
    },
    timeout: {request: method === 'POST' && requestPath.endsWith('/commands') ? 85_000 : 5000},
    retry: {limit: 0},
    followRedirect: false,
    responseType: 'json',
    throwHttpErrors: false,
  });

  const responseBody = response.body as T | {error?: unknown};
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = typeof (responseBody as {error?: unknown}).error === 'string'
      ? (responseBody as {error: string}).error
      : `worker returned HTTP ${response.statusCode}`;
    throw new Error(error.slice(0, 300));
  }

  return responseBody as T;
};

export const getWorkerStatus = async (worker: WorkerDefinition) => requestWorker<WorkerStatus>(
  worker,
  'GET',
  '/v1/status',
);

export const getWorkerGuildSettings = async (worker: WorkerDefinition, guildId: string) => requestWorker<{
  settings: GuildSettingsValues;
  enabled: boolean;
}>(
  worker,
  'GET',
  `/v1/guilds/${guildId}/settings`,
);

export const putWorkerGuildSettings = async (
  worker: WorkerDefinition,
  guildId: string,
  settings: GuildSettingsValues,
  enabled: boolean,
) => requestWorker<{settings: GuildSettingsValues; enabled?: boolean}>(
  worker,
  'PUT',
  `/v1/guilds/${guildId}/settings`,
  {settings, enabled},
);

export const disconnectWorkerFromGuild = async (worker: WorkerDefinition, guildId: string) => requestWorker<{ok: boolean}>(
  worker,
  'POST',
  `/v1/guilds/${guildId}/disconnect`,
  {},
);

export const executeWorkerCommand = async (
  worker: WorkerDefinition,
  request: RemoteCommandRequest,
) => requestWorker<RemoteCommandResult>(
  worker,
  'POST',
  `/v1/guilds/${request.guildId}/commands`,
  request,
);
