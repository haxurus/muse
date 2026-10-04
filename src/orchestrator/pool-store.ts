import {promises as fs} from 'node:fs';
import path from 'node:path';
import {HttpError} from '../control/http.js';
import type {GuildPoolConfig, PoolGroup} from './pool-types.js';

type PoolStoreFile = {
  version: 1;
  guilds: Record<string, GuildPoolConfig>;
};

const GROUP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u;

const uniqueStrings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new HttpError(400, label + ' must be a string array');
  }

  const strings = value as string[];
  if (new Set(strings).size !== strings.length) {
    throw new HttpError(400, label + ' contains duplicates');
  }

  return strings;
};

const parseInteger = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, label + ' must be an integer between ' + min + ' and ' + max);
  }

  return value;
};

export const sanitizeGuildPoolConfig = (
  input: unknown,
  knownWorkerIds: readonly string[],
): GuildPoolConfig => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'pool configuration must be an object');
  }

  const body = input as {maxConcurrentPlayers?: unknown; groups?: unknown};
  const maxConcurrentPlayers = parseInteger(
    body.maxConcurrentPlayers,
    'maxConcurrentPlayers',
    0,
    knownWorkerIds.length,
  );

  if (!Array.isArray(body.groups) || body.groups.length > knownWorkerIds.length) {
    throw new HttpError(400, 'groups must contain at most ' + knownWorkerIds.length + ' entries');
  }

  const knownWorkers = new Set(knownWorkerIds);
  const groupIds = new Set<string>();
  const assignedWorkers = new Set<string>();
  const assignedChannels = new Set<string>();
  let defaultGroups = 0;

  const groups: PoolGroup[] = body.groups.map((rawGroup, index) => {
    if (typeof rawGroup !== 'object' || rawGroup === null || Array.isArray(rawGroup)) {
      throw new HttpError(400, 'groups[' + index + '] must be an object');
    }

    const candidate = rawGroup as {
      id?: unknown;
      name?: unknown;
      workerIds?: unknown;
      voiceChannelIds?: unknown;
      maxConcurrentPlayers?: unknown;
      isDefault?: unknown;
    };

    if (typeof candidate.id !== 'string' || !GROUP_ID.test(candidate.id)) {
      throw new HttpError(400, 'groups[' + index + '].id is invalid');
    }

    if (groupIds.has(candidate.id)) {
      throw new HttpError(400, 'duplicate group id: ' + candidate.id);
    }
    groupIds.add(candidate.id);

    if (typeof candidate.name !== 'string') {
      throw new HttpError(400, 'groups[' + index + '].name is required');
    }
    const name = candidate.name.trim();
    if (name.length < 1 || name.length > 48) {
      throw new HttpError(400, 'groups[' + index + '].name must be between 1 and 48 characters');
    }

    const workerIds = uniqueStrings(candidate.workerIds, 'groups[' + index + '].workerIds');
    if (workerIds.length === 0) {
      throw new HttpError(400, 'groups[' + index + '] must contain at least one worker');
    }

    for (const workerId of workerIds) {
      if (!knownWorkers.has(workerId)) {
        throw new HttpError(400, 'unknown worker in group ' + candidate.id + ': ' + workerId);
      }

      if (assignedWorkers.has(workerId)) {
        throw new HttpError(400, 'worker ' + workerId + ' belongs to more than one group');
      }

      assignedWorkers.add(workerId);
    }

    const voiceChannelIds = uniqueStrings(candidate.voiceChannelIds, 'groups[' + index + '].voiceChannelIds');
    for (const channelId of voiceChannelIds) {
      if (!/^\d{10,32}$/u.test(channelId)) {
        throw new HttpError(400, 'invalid voice channel id in group ' + candidate.id);
      }

      if (assignedChannels.has(channelId)) {
        throw new HttpError(400, 'voice channel ' + channelId + ' belongs to more than one group');
      }

      assignedChannels.add(channelId);
    }

    if (typeof candidate.isDefault !== 'boolean') {
      throw new HttpError(400, 'groups[' + index + '].isDefault must be a boolean');
    }
    if (candidate.isDefault) {
      defaultGroups++;
    }

    return {
      id: candidate.id,
      name,
      workerIds,
      voiceChannelIds,
      maxConcurrentPlayers: parseInteger(
        candidate.maxConcurrentPlayers,
        'groups[' + index + '].maxConcurrentPlayers',
        0,
        workerIds.length,
      ),
      isDefault: candidate.isDefault,
    };
  });

  if (groups.length > 0 && defaultGroups !== 1) {
    throw new HttpError(400, 'exactly one group must be marked as default');
  }

  return {
    maxConcurrentPlayers,
    groups,
  };
};

export default class PoolStore {
  private state: PoolStoreFile = {version: 1, guilds: {}};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), {recursive: true});

    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as PoolStoreFile;
      if (raw.version !== 1 || typeof raw.guilds !== 'object' || raw.guilds === null) {
        throw new Error('unsupported pool store format');
      }

      this.state = raw;
    } catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }

      this.state = {version: 1, guilds: {}};
      await this.persist();
    }
  }

  getGuild(guildId: string, defaultMax: number): GuildPoolConfig {
    const stored = this.state.guilds[guildId];
    return stored
      ? structuredClone(stored)
      : {
        maxConcurrentPlayers: defaultMax,
        groups: [],
      };
  }

  async setGuild(guildId: string, config: GuildPoolConfig): Promise<GuildPoolConfig> {
    this.state.guilds[guildId] = structuredClone(config);
    await this.persist();
    return this.getGuild(guildId, config.maxConcurrentPlayers);
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const tmp = this.filePath + '.' + process.pid + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2) + '\n', {mode: 0o600});
      await fs.rename(tmp, this.filePath);
    });

    return this.writeChain;
  }
}
