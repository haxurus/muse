import OrchestratorConfig from './config.js';
import {getPoolSnapshot, selectAvailableWorker} from './store.js';
import {executeWorkerCommand} from './worker-client.js';
import {RemoteCommandRequest, RemoteCommandResult} from '../worker-control/commands.js';
import {prisma} from '../utils/db.js';

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
  'favorites',
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

const requireStringOption = (request: PoolIngressRequest, name: string) => {
  const value = request.options[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing ${name}`);
  }

  return value.trim();
};

const routeFavoriteCommand = async (
  request: PoolIngressRequest,
  config: OrchestratorConfig,
): Promise<PoolIngressResult> => {
  const subcommand = request.options.subcommand;
  if (typeof subcommand !== 'string') {
    throw new Error('missing favorites subcommand');
  }

  if (subcommand === 'create') {
    const name = requireStringOption(request, 'name');
    const query = requireStringOption(request, 'query');
    const existing = await prisma.favoriteQuery.findFirst({where: {guildId: request.guildId, name}});
    if (existing) {
      throw new Error('a favorite with that name already exists');
    }

    await prisma.favoriteQuery.create({
      data: {
        guildId: request.guildId,
        authorId: request.userId,
        name,
        query,
      },
    });

    return {workerId: config.INGRESS_WORKER_ID, workerLabel: 'Muse Control', response: '👍 favorite created'};
  }

  if (subcommand === 'remove') {
    const name = requireStringOption(request, 'name');
    const favorite = await prisma.favoriteQuery.findFirst({where: {guildId: request.guildId, name}});
    if (!favorite) {
      throw new Error('no favorite with that name exists');
    }

    if (favorite.authorId !== request.userId && request.guildOwnerId !== request.userId) {
      throw new Error('you can only remove your own favorites');
    }

    await prisma.favoriteQuery.delete({where: {id: favorite.id}});
    return {workerId: config.INGRESS_WORKER_ID, workerLabel: 'Muse Control', response: '👍 favorite removed'};
  }

  if (subcommand === 'list') {
    const favorites = await prisma.favoriteQuery.findMany({
      where: {guildId: request.guildId},
      orderBy: {name: 'asc'},
    });
    if (favorites.length === 0) {
      return {workerId: config.INGRESS_WORKER_ID, workerLabel: 'Muse Control', response: 'there aren\'t any favorites yet'};
    }

    const lines = favorites.map(favorite => `**${favorite.name}** - ${favorite.query} (<@${favorite.authorId}>)`);
    let content = lines.join('\n');
    if (content.length > 1900) {
      content = `${content.slice(0, 1870)}\n… more favorites are available`;
    }

    return {workerId: config.INGRESS_WORKER_ID, workerLabel: 'Muse Control', response: content};
  }

  if (subcommand === 'use') {
    const name = requireStringOption(request, 'name');
    const favorite = await prisma.favoriteQuery.findFirst({where: {guildId: request.guildId, name}});
    if (!favorite) {
      throw new Error('no favorite with that name exists');
    }

    return routePoolIngressCommand({
      ...request,
      commandName: 'play',
      options: {
        query: favorite.query,
        immediate: request.options.immediate === true,
        shuffle: request.options.shuffle === true,
        split: request.options.split === true,
        skip: request.options.skip === true,
      },
    }, config);
  }

  throw new Error('unknown favorites subcommand');
};

export const getFavoriteAutocomplete = async (
  request: Pick<PoolIngressRequest, 'guildId' | 'guildOwnerId' | 'userId'> & {
    subcommand: string;
    query: string;
  },
) => {
  if (!['use', 'remove'].includes(request.subcommand)) {
    return [];
  }

  const favorites = await prisma.favoriteQuery.findMany({
    where: {guildId: request.guildId},
    orderBy: {name: 'asc'},
  });
  const query = request.query.trim().toLowerCase();
  const filtered = favorites
    .filter(favorite => query === '' || favorite.name.toLowerCase().startsWith(query))
    .filter(favorite => request.subcommand !== 'remove'
      || favorite.authorId === request.userId
      || request.guildOwnerId === request.userId)
    .slice(0, 25);

  return filtered.map(favorite => ({name: favorite.name, value: favorite.name}));
};

export const routePoolIngressCommand = async (
  request: PoolIngressRequest,
  config: OrchestratorConfig,
): Promise<PoolIngressResult> => {
  if (request.commandName === 'favorites') {
    return routeFavoriteCommand(request, config);
  }

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
  const queued = previous.then(() => current);
  guildLocks.set(guildId, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (guildLocks.get(guildId) === queued) {
      guildLocks.delete(guildId);
    }
  }
};
