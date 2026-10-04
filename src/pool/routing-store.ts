import {closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HttpError} from '../control/http.js';
import {isDiscordId, isUuid, objectBody, type PoolCommand} from './protocol.js';

export type GuildRouting = {
  defaultGroupId: string | null;
  channelGroups: Record<string, string>;
  categoryGroups: Record<string, string>;
};
type RoutingFile = {version: 1; guilds: Record<string, GuildRouting>};
type Group = {id: string; workerIds: string[]};
const defaults = (): GuildRouting => ({defaultGroupId: null, channelGroups: {}, categoryGroups: {}});

const mappings = (input: unknown): Record<string, string> => {
  const body = objectBody(input);
  if (Object.keys(body).length > 100) {
    throw new HttpError(400, 'Massimo 100 associazioni per tipo.');
  }

  const result: Record<string, string> = {};
  for (const [id, groupId] of Object.entries(body)) {
    if (!isDiscordId(id) || !isUuid(groupId)) {
      throw new HttpError(400, 'Associazione canale/gruppo non valida.');
    }

    result[id] = groupId;
  }

  return result;
};

const parseRouting = (input: unknown): GuildRouting => {
  const body = objectBody(input);
  if (Object.keys(body).some(key => !['defaultGroupId', 'channelGroups', 'categoryGroups'].includes(key))
    || (body.defaultGroupId !== null && !isUuid(body.defaultGroupId))) {
    throw new HttpError(400, 'Configurazione del pool non valida.');
  }

  return {
    defaultGroupId: body.defaultGroupId as string | null,
    channelGroups: mappings(body.channelGroups),
    categoryGroups: mappings(body.categoryGroups),
  };
};

export default class PoolRoutingStore {
  private data: RoutingFile;

  constructor(
    private readonly filePath: string,
    private readonly groups: (guildId: string) => Group[],
    private readonly workerIds: readonly string[],
  ) {
    this.data = this.load();
  }

  get(guildId: string): GuildRouting {
    if (!isDiscordId(guildId)) {
      throw new HttpError(400, 'Server Discord non valido.');
    }

    const value = this.data.guilds[guildId] ?? defaults();
    return {...value, channelGroups: {...value.channelGroups}, categoryGroups: {...value.categoryGroups}};
  }

  set(guildId: string, input: unknown): GuildRouting {
    const next = parseRouting({...this.get(guildId), ...objectBody(input)});
    const known = new Set(this.groups(guildId).map(group => group.id));
    const referenced = [next.defaultGroupId, ...Object.values(next.channelGroups), ...Object.values(next.categoryGroups)];
    if (referenced.some(id => id !== null && !known.has(id))) {
      throw new HttpError(400, 'Un gruppo non appartiene a questo server oppure e stato eliminato.');
    }

    const data: RoutingFile = {version: 1, guilds: {...this.data.guilds, [guildId]: next}};
    this.persist(data);
    this.data = data;
    return this.get(guildId);
  }

  referenced(guildId: string, groupId: string): boolean {
    const routing = this.get(guildId);
    return [routing.defaultGroupId, ...Object.values(routing.channelGroups), ...Object.values(routing.categoryGroups)].includes(groupId);
  }

  eligible(command: PoolCommand): readonly string[] {
    const routing = this.get(command.guildId);
    const groupId = routing.channelGroups[command.voiceChannelId]
      ?? (command.categoryId === null ? undefined : routing.categoryGroups[command.categoryId])
      ?? routing.defaultGroupId;
    if (groupId === null) {
      return this.workerIds;
    }

    const group = this.groups(command.guildId).find(candidate => candidate.id === groupId);
    if (!group) {
      throw new HttpError(409, 'Il gruppo assegnato non esiste piu. Correggere le regole nella dashboard.');
    }

    return group.workerIds.filter(workerId => this.workerIds.includes(workerId));
  }

  private load(): RoutingFile {
    mkdirSync(path.dirname(this.filePath), {recursive: true, mode: 0o700});
    try {
      const parsed = objectBody(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown);
      if (parsed.version !== 1) {
        throw new Error('Unsupported pool routing file');
      }

      const guilds: Record<string, GuildRouting> = {};
      for (const [guildId, routing] of Object.entries(objectBody(parsed.guilds))) {
        if (!isDiscordId(guildId)) {
          throw new Error('Invalid guild in pool routing file');
        }

        guilds[guildId] = parseRouting(routing);
      }

      return {version: 1, guilds};
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {version: 1, guilds: {}};
      }

      throw error;
    }
  }

  private persist(data: RoutingFile): void {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(data)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    try {
      renameSync(temporary, this.filePath);
    } catch (error: unknown) {
      unlinkSync(temporary);
      throw error;
    }
  }
}
