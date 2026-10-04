import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {HttpError} from '../control/http.js';
import type GuildGroupStore from './guild-group-store.js';

export type GuildRoutingPolicy = {
  defaultGroupId: string | null;
  categoryGroups: Record<string, string>;
  voiceChannelGroups: Record<string, string>;
  updatedAt: string;
};

type RoutingStoreData = {
  version: 1;
  guilds: Record<string, GuildRoutingPolicy>;
};

const SNOWFLAKE = /^\d{10,32}$/u;

const emptyPolicy = (): GuildRoutingPolicy => ({
  defaultGroupId: null,
  categoryGroups: {},
  voiceChannelGroups: {},
  updatedAt: new Date(0).toISOString(),
});

const validateGuildId = (guildId: string): void => {
  if (!SNOWFLAKE.test(guildId)) {
    throw new HttpError(400, 'invalid Discord guild id');
  }
};

export default class GuildRoutingStore {
  private readonly data: RoutingStoreData;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  get(guildId: string): GuildRoutingPolicy {
    validateGuildId(guildId);
    const policy = this.data.guilds[guildId] ?? emptyPolicy();
    return {
      defaultGroupId: policy.defaultGroupId,
      categoryGroups: {...policy.categoryGroups},
      voiceChannelGroups: {...policy.voiceChannelGroups},
      updatedAt: policy.updatedAt,
    };
  }

  update(guildId: string, input: unknown, groups: GuildGroupStore): GuildRoutingPolicy {
    validateGuildId(guildId);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new HttpError(400, 'routing policy must be an object');
    }

    const body = input as Record<string, unknown>;
    const current = this.get(guildId);
    const next: GuildRoutingPolicy = {
      defaultGroupId: body.defaultGroupId === undefined
        ? current.defaultGroupId
        : this.groupIdOrNull(guildId, body.defaultGroupId, groups),
      categoryGroups: body.categoryGroups === undefined
        ? current.categoryGroups
        : this.ruleMap(guildId, body.categoryGroups, groups, 'categoryGroups'),
      voiceChannelGroups: body.voiceChannelGroups === undefined
        ? current.voiceChannelGroups
        : this.ruleMap(guildId, body.voiceChannelGroups, groups, 'voiceChannelGroups'),
      updatedAt: new Date().toISOString(),
    };

    this.data.guilds[guildId] = next;
    this.persist();
    return this.get(guildId);
  }

  resolveGroupId(
    guildId: string,
    voiceChannelId: string,
    categoryId: string | null,
    groups: GuildGroupStore,
  ): string | null {
    const policy = this.get(guildId);
    const candidate = policy.voiceChannelGroups[voiceChannelId]
      ?? (categoryId ? policy.categoryGroups[categoryId] : undefined)
      ?? policy.defaultGroupId
      ?? null;

    return candidate && groups.get(guildId, candidate) ? candidate : null;
  }

  removeGroupReferences(guildId: string, groupId: string): void {
    const current = this.get(guildId);
    const categoryGroups = Object.fromEntries(
      Object.entries(current.categoryGroups).filter(([, value]) => value !== groupId),
    );
    const voiceChannelGroups = Object.fromEntries(
      Object.entries(current.voiceChannelGroups).filter(([, value]) => value !== groupId),
    );

    this.data.guilds[guildId] = {
      defaultGroupId: current.defaultGroupId === groupId ? null : current.defaultGroupId,
      categoryGroups,
      voiceChannelGroups,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
  }

  private groupIdOrNull(guildId: string, value: unknown, groups: GuildGroupStore): string | null {
    if (value === null) {
      return null;
    }

    if (typeof value !== 'string' || !groups.get(guildId, value)) {
      throw new HttpError(400, 'routing rule references an unknown group');
    }

    return value;
  }

  private ruleMap(
    guildId: string,
    value: unknown,
    groups: GuildGroupStore,
    label: string,
  ): Record<string, string> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HttpError(400, `${label} must be an object`);
    }

    const result: Record<string, string> = {};
    for (const [channelId, groupId] of Object.entries(value)) {
      if (!SNOWFLAKE.test(channelId) || typeof groupId !== 'string' || !groups.get(guildId, groupId)) {
        throw new HttpError(400, `${label} contains an invalid channel or group`);
      }

      result[channelId] = groupId;
    }

    return result;
  }

  private load(): RoutingStoreData {
    mkdirSync(path.dirname(this.filePath), {recursive: true, mode: 0o700});

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as RoutingStoreData;
      if (parsed.version !== 1 || typeof parsed.guilds !== 'object' || parsed.guilds === null) {
        throw new Error('unsupported routing store');
      }

      return parsed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {version: 1, guilds: {}};
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
