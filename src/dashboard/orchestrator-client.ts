import got from 'got';
import type {DashboardConfig} from './config.js';

type OrchestratorGuild = {
  id: string;
  name: string;
  availableWorkers: number;
};

export type OrchestratorGuildList = {
  guilds: OrchestratorGuild[];
};

export type GuildWorkerGroup = {
  id: string;
  name: string;
  workerIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type OrchestratorGuildWorkers = {
  guildId: string;
  groups: GuildWorkerGroup[];
  workers: Array<{
    workerId: string;
    ok: boolean;
    value?: Record<string, unknown>;
    error?: string;
  }>;
};

export type GuildSettingsUpdate = {
  workerIds?: string[];
  settings: Record<string, unknown>;
};

export type GuildChannels = {
  guildId: string;
  categories: Array<{id: string; name: string}>;
  voiceChannels: Array<{id: string; name: string; parentId: string | null}>;
};

export type GuildRoutingPolicy = {
  defaultGroupId: string | null;
  categoryGroups: Record<string, string>;
  voiceChannelGroups: Record<string, string>;
  updatedAt: string;
};

const options = (token: string) => ({
  headers: {
    authorization: `Bearer ${token}`,
  },
  retry: {
    limit: 0,
  },
  timeout: {
    request: 5000,
  },
});

export default class OrchestratorClient {
  constructor(private readonly config: DashboardConfig) {}

  async guilds(): Promise<OrchestratorGuildList> {
    return got.get(
      `${this.config.orchestratorUrl}/v1/guilds`,
      options(this.config.orchestratorToken),
    ).json<OrchestratorGuildList>();
  }

  async guildWorkers(guildId: string): Promise<OrchestratorGuildWorkers> {
    return got.get(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/workers`,
      options(this.config.orchestratorToken),
    ).json<OrchestratorGuildWorkers>();
  }

  async guildChannels(guildId: string): Promise<GuildChannels> {
    return got.get(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/channels`,
      options(this.config.orchestratorToken),
    ).json<GuildChannels>();
  }

  async guildRouting(guildId: string): Promise<{guildId: string; routing: GuildRoutingPolicy}> {
    return got.get(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/routing`,
      options(this.config.orchestratorToken),
    ).json<{guildId: string; routing: GuildRoutingPolicy}>();
  }

  async updateGuildRouting(
    guildId: string,
    routing: Partial<Pick<GuildRoutingPolicy, 'defaultGroupId' | 'categoryGroups' | 'voiceChannelGroups'>>,
  ): Promise<{guildId: string; routing: GuildRoutingPolicy}> {
    return got.put(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/routing`,
      {
        ...options(this.config.orchestratorToken),
        json: routing,
      },
    ).json<{guildId: string; routing: GuildRoutingPolicy}>();
  }

  async guildPlayback(guildId: string): Promise<unknown> {
    return got.get(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/playback`,
      options(this.config.orchestratorToken),
    ).json<unknown>();
  }

  async createGuildGroup(guildId: string, body: {name: string; workerIds: string[]}): Promise<unknown> {
    return got.post(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/groups`,
      {
        ...options(this.config.orchestratorToken),
        json: body,
      },
    ).json<unknown>();
  }

  async updateGuildGroup(
    guildId: string,
    groupId: string,
    body: {name?: string; workerIds?: string[]},
  ): Promise<unknown> {
    return got.patch(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/groups/${encodeURIComponent(groupId)}`,
      {
        ...options(this.config.orchestratorToken),
        json: body,
      },
    ).json<unknown>();
  }

  async deleteGuildGroup(guildId: string, groupId: string): Promise<unknown> {
    return got.delete(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/groups/${encodeURIComponent(groupId)}`,
      options(this.config.orchestratorToken),
    ).json<unknown>();
  }

  async updateGuildSettings(guildId: string, body: GuildSettingsUpdate): Promise<unknown> {
    return got.patch(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/workers/settings`,
      {
        ...options(this.config.orchestratorToken),
        json: body,
      },
    ).json<unknown>();
  }
}
