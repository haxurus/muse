import {closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HttpError} from '../control/http.js';
import {assertGuildId, isSnowflake} from '../control/snowflake.js';

export type GuildWorkerGroup = {
  id: string;
  name: string;
  workerIds: string[];
  createdAt: string;
  updatedAt: string;
};

type StoreData = {
  version: 1;
  guilds: Record<string, GuildWorkerGroup[]>;
};

type LoadResult = {status: 'ok'; data: StoreData} | {status: 'missing'} | {status: 'invalid'};

const MAX_GROUPS_PER_GUILD = 16;

const isPrintableName = (name: string): boolean => {
  const hasControlCharacter = [...name].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });

  return name.length >= 1 && name.length <= 48 && !hasControlCharacter;
};

const normalizeName = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'group name must be a string');
  }

  const name = value.trim();
  if (!isPrintableName(name)) {
    throw new HttpError(400, 'group name must contain 1-48 printable characters');
  }

  return name;
};

const normalizeWorkerIds = (value: unknown, configuredWorkerIds: Set<string>): string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > configuredWorkerIds.size) {
    throw new HttpError(400, 'workerIds must contain at least one configured worker');
  }

  if (value.some(workerId => typeof workerId !== 'string')) {
    throw new HttpError(400, 'workerIds must contain only strings');
  }

  const workerIds = [...new Set(value as string[])];
  const unknown = workerIds.filter(workerId => !configuredWorkerIds.has(workerId));
  if (unknown.length > 0) {
    throw new HttpError(400, `unknown workers: ${unknown.join(', ')}`);
  }

  return workerIds.sort();
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Workers removed from the configuration are tolerated: groups keep unavailable members.
const isValidGroup = (value: unknown): value is GuildWorkerGroup => isPlainObject(value)
  && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 64
  && typeof value.name === 'string' && isPrintableName(value.name)
  && Array.isArray(value.workerIds) && value.workerIds.length > 0
  && value.workerIds.every(workerId => typeof workerId === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/u.test(workerId))
  && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string';

const isValidStore = (value: unknown): value is StoreData => isPlainObject(value)
  && value.version === 1
  && isPlainObject(value.guilds)
  && Object.entries(value.guilds).every(([guildId, groups]) => isSnowflake(guildId)
    && Array.isArray(groups)
    && groups.length <= MAX_GROUPS_PER_GUILD
    && groups.every(group => isValidGroup(group)));

const serialize = (data: StoreData): string => `${JSON.stringify(data, null, 2)}\n`;

/** Write via temp file + fsync + rename, then fsync the directory where the platform supports it. */
const writeDurably = (target: string, content: string): void => {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.tmp`);
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temporary, target);
  try {
    const directoryFd = openSync(directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    // Directory fsync is not supported on every platform (for example Windows).
  }
};

/**
 * Single-process store: the orchestrator must run as exactly one instance per state volume,
 * because concurrent writers would overwrite each other's changes.
 */
export default class GuildGroupStore {
  private data: StoreData;
  private readonly backupPath: string;

  constructor(
    private readonly filePath: string,
    private readonly configuredWorkerIds: Set<string>,
  ) {
    this.backupPath = `${filePath}.bak`;
    this.data = this.load();
  }

  list(guildId: string): GuildWorkerGroup[] {
    assertGuildId(guildId);
    return [...(this.data.guilds[guildId] ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(group => ({...group, workerIds: [...group.workerIds]}));
  }

  create(guildId: string, input: unknown): GuildWorkerGroup {
    assertGuildId(guildId);
    const body = this.objectBody(input);
    const name = normalizeName(body.name);
    const workerIds = normalizeWorkerIds(body.workerIds, this.configuredWorkerIds);
    const groups = this.data.guilds[guildId] ?? [];

    if (groups.length >= MAX_GROUPS_PER_GUILD) {
      throw new HttpError(409, 'this server already has the maximum of 16 groups');
    }

    this.assertUniqueName(groups, name);

    const now = new Date().toISOString();
    const group: GuildWorkerGroup = {
      id: randomUUID(),
      name,
      workerIds,
      createdAt: now,
      updatedAt: now,
    };

    this.commit({...this.data.guilds, [guildId]: [...groups, group]});
    return {...group, workerIds: [...group.workerIds]};
  }

  update(guildId: string, groupId: string, input: unknown): GuildWorkerGroup {
    assertGuildId(guildId);
    const body = this.objectBody(input);
    const groups = this.data.guilds[guildId] ?? [];
    const index = groups.findIndex(group => group.id === groupId);
    if (index < 0) {
      throw new HttpError(404, 'group not found');
    }

    if (body.name === undefined && body.workerIds === undefined) {
      throw new HttpError(400, 'group update is empty');
    }

    const current = groups[index];
    const name = body.name === undefined ? current.name : normalizeName(body.name);
    const workerIds = body.workerIds === undefined
      ? [...current.workerIds]
      : normalizeWorkerIds(body.workerIds, this.configuredWorkerIds);

    this.assertUniqueName(groups, name, groupId);

    const updated: GuildWorkerGroup = {
      ...current,
      name,
      workerIds,
      updatedAt: new Date().toISOString(),
    };

    const next = [...groups];
    next[index] = updated;
    this.commit({...this.data.guilds, [guildId]: next});
    return {...updated, workerIds: [...updated.workerIds]};
  }

  delete(guildId: string, groupId: string): void {
    assertGuildId(guildId);
    const groups = this.data.guilds[guildId] ?? [];
    const next = groups.filter(group => group.id !== groupId);
    if (next.length === groups.length) {
      throw new HttpError(404, 'group not found');
    }

    this.commit(next.length === 0
      ? Object.fromEntries(Object.entries(this.data.guilds).filter(([id]) => id !== guildId))
      : {...this.data.guilds, [guildId]: next});
  }

  private objectBody(input: unknown): Record<string, unknown> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new HttpError(400, 'group body must be an object');
    }

    return input as Record<string, unknown>;
  }

  private assertUniqueName(groups: GuildWorkerGroup[], name: string, ignoreId?: string): void {
    const duplicate = groups.some(group =>
      group.id !== ignoreId && group.name.localeCompare(name, undefined, {sensitivity: 'accent'}) === 0);
    if (duplicate) {
      throw new HttpError(409, 'a group with this name already exists in the server');
    }
  }

  private read(filePath: string): LoadResult {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {status: 'missing'};
      }

      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return isValidStore(parsed) ? {status: 'ok', data: parsed} : {status: 'invalid'};
    } catch {
      return {status: 'invalid'};
    }
  }

  private load(): StoreData {
    mkdirSync(path.dirname(this.filePath), {recursive: true, mode: 0o700});

    const primary = this.read(this.filePath);
    if (primary.status === 'ok') {
      return primary.data;
    }

    const backup = this.read(this.backupPath);
    if (backup.status === 'ok') {
      console.warn(`Group store ${this.filePath} is ${primary.status}; recovered from ${this.backupPath}`);
      return backup.data;
    }

    if (primary.status === 'missing') {
      return {version: 1, guilds: {}};
    }

    throw new Error(`Group store ${this.filePath} is unreadable or has an invalid schema, and no valid backup exists at ${this.backupPath}. Restore it from a backup before starting the orchestrator.`);
  }

  /** Persist the next state first; memory only changes after the write succeeded. */
  private commit(guilds: Record<string, GuildWorkerGroup[]>): void {
    const next: StoreData = {version: 1, guilds};
    // The in-memory state always equals the last good file, so it is the backup copy.
    writeDurably(this.backupPath, serialize(this.data));
    writeDurably(this.filePath, serialize(next));
    this.data = next;
  }
}
