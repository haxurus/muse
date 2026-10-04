import OrchestratorConfig from './config.js';
import {getPoolSnapshot, selectAvailableWorker} from './store.js';
import {executeWorkerCommand} from './worker-client.js';
import {RemoteCommandRequest, RemoteCommandResult} from '../worker-control/commands.js';

export type PoolIngressRequest = RemoteCommandRequest & {
  guildName: string;
  guildOwnerId: string;
};

export type PoolIngressResult = RemoteCommandResult & {
  workerId: string;
  workerLabel: string;
};

const REMOTE_PLAYER_COMMANDS = new Set([
  'clear',
  'disconnect',
  'fseek',
  'loop-queue',
  'loop',
  'move',
  'next',
  'now-playing',
  'pause',
  'play',
  'queue',
  'remove',
  'replay',
  'resume',
  'seek',
  'shuffle',
  'skip',
  'stop',
  'unskip',
  'volume',
]);

const SNOWFLAKE = /^\d{5,25}$/u;

const validatePrimitiveOptions = (options: unknown): options is Record<string, string | number | boolean> => (
  typeof options === 'object'
  && options !== null
  && !Array.isArray(options)
  && Object.values(options).every(value => (
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  ))
);

export const validatePoolIngressRequest = (input: unknown): PoolIngressRequest => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid pool command request');
  }

  const request = input as Partial<PoolIngressRequest>;
  if (typeof request.guildId !== 'string'
    || !SNOWFLAKE.test(request.guildId)
    || typeof request.guildName !== 'string'
    || request.guildName.length > 200
    || typeof request.guildOwnerId !== 'string'
    || !SNOWFLAKE.test(request.guildOwnerId)
    || (request.voiceChannelId !== null && (typeof request.voiceChannelId !== 'string' || !SNOWFLAKE.test(request.voiceChannelId)))
    || typeof request.textChannelId !== 'string'
    || !SNOWFLAKE.test(request.textChannelId)
    || typeof request.userId !== 'string'
    || !SNOWFLAKE.test(request.userId)
    || typeof request.commandName !== 'string'
    || !REMOTE_PLAYER_COMMANDS.has(request.commandName)
    || !validatePrimitiveOptions(request.options)) {
    throw new Error('invalid or unsupported pool command');
  }

  return request as PoolIngressRequest;
};

const chooseExistingWorker = async (
  request: PoolIngressRequest,
  config: OrchestratorConfig,
) => {
  const pool = await getPoolSnapshot(request.guildId, request.guildName, config.WORKERS);
  const candidates = pool.workers.filter(worker => worker.enabled && worker.online && worker.inGuild);

  if (request.voiceChannelId) {
    const sameChannel = candidates.find(worker => worker.player?.voiceChannelId === request.voiceChannelId);
    if (sameChannel) {
      return sameChannel;
    }
  }

  const withSession = candidates.filter(worker => worker.player?.currentTitle);
  if (withSession.length === 1) {
    return withSession[0];
  }

  const active = candidates.filter(worker => worker.player?.voiceChannelId);
  if (active.length === 1) {
    return active[0];
  }

  if (active.length > 1 || withSession.length > 1) {
    throw new Error('join the voice channel whose player you want to control');
  }

  throw new Error('there is no active player to control');
};

export const routePoolIngressCommand = async (
  request: PoolIngressRequest,
  config: OrchestratorConfig,
): Promise<PoolIngressResult> => {
  const selected = request.commandName === 'play'
    ? await selectAvailableWorker({
      guildId: request.guildId,
      guildName: request.guildName,
      workers: config.WORKERS,
      voiceChannelId: request.voiceChannelId,
    })
    : await chooseExistingWorker(request, config);

  if (!selected) {
    throw new Error('all available music players are currently in use');
  }

  const worker = config.WORKERS.find(candidate => candidate.id === selected.id);
  if (!worker) {
    throw new Error('selected worker is no longer configured');
  }

  const result = await executeWorkerCommand(worker, request);
  return {
    ...result,
    workerId: selected.id,
    workerLabel: selected.label,
  };
};

const guildLocks = new Map<string, Promise<void>>();

export const withGuildPoolLock = async <T>(guildId: string, operation: () => Promise<T>): Promise<T> => {
  const previous = guildLocks.get(guildId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  guildLocks.set(guildId, previous.then(() => current));

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (guildLocks.get(guildId) === current) {
      guildLocks.delete(guildId);
    }
  }
};
