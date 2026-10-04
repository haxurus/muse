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

export type OrchestratorGuildWorkers = {
  guildId: string;
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
