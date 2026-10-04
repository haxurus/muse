import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HttpError} from '../control/http.js';

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

const EMPTY_STORE: StoreData = {
  version: 1,
  guilds: {},
};

const normalizeName = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'group name must be a string');
  }

  const name = value.trim();
  const hasControlCharacter = [...name].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });

  if (name.length < 1 || name.length > 48 || hasControlCharacter) {
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

const validateGuildId = (guildId: string): void => {
  if (!/^\d{10,32}$/u.test(guildId)) {
    throw new HttpError(400, 'invalid Discord guild id');
  }
};

export default class GuildGroupStore {
  private readonly data: StoreData;

  constructor(
    private readonly filePath: string,
    private readonly configuredWorkerIds: Set<string>,
  ) {
    this.data = this.load();
  }

  list(guildId: string): GuildWorkerGroup[] {
    validateGuildId(guildId);
    return [...(this.data.guilds[guildId] ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(group => ({...group, workerIds: [...group.workerIds]}));
  }

  create(guildId: string, input: unknown): GuildWorkerGroup {
    validateGuildId(guildId);
    const body = this.objectBody(input);
    const name = normalizeName(body.name);
    const workerIds = normalizeWorkerIds(body.workerIds, this.configuredWorkerIds);
    const groups = this.data.guilds[guildId] ?? [];

    if (groups.length >= 16) {
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

    this.data.guilds[guildId] = [...groups, group];
    this.persist();
    return {...group, workerIds: [...group.workerIds]};
  }

  update(guildId: string, groupId: string, input: unknown): GuildWorkerGroup {
    validateGuildId(guildId);
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
    this.data.guilds[guildId] = next;
    this.persist();
    return {...updated, workerIds: [...updated.workerIds]};
  }

  delete(guildId: string, groupId: string): void {
    validateGuildId(guildId);
    const groups = this.data.guilds[guildId] ?? [];
    const next = groups.filter(group => group.id !== groupId);
    if (next.length === groups.length) {
      throw new HttpError(404, 'group not found');
    }

    if (next.length === 0) {
      this.data.guilds = Object.fromEntries(
        Object.entries(this.data.guilds).filter(([id]) => id !== guildId),
      );
    } else {
      this.data.guilds[guildId] = next;
    }

    this.persist();
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

  private load(): StoreData {
    mkdirSync(path.dirname(this.filePath), {recursive: true, mode: 0o700});

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreData;
      if (parsed.version !== 1 || typeof parsed.guilds !== 'object' || parsed.guilds === null) {
        throw new Error('unsupported group store');
      }

      return parsed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {version: EMPTY_STORE.version, guilds: {}};
      }

      throw error;
    }
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.tmp`);

    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'w',
    });
    renameSync(temporary, this.filePath);
  }
}
