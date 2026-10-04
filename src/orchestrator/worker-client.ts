import got from 'got';
import type {GuildSettingsPatch} from '../control/settings-validation.js';
import type {WorkerGuildSettings, WorkerStatus} from '../control/types.js';
import type {WorkerDefinition} from './config.js';

const requestOptions = (token: string) => ({
  headers: {
    authorization: `Bearer ${token}`,
  },
  retry: {
    limit: 0,
  },
  timeout: {
    request: 3000,
  },
});

export default class WorkerClient {
  constructor(private readonly worker: WorkerDefinition) {}

  get id(): string {
    return this.worker.id;
  }

  async status(): Promise<WorkerStatus> {
    return got.get(
      `${this.worker.baseUrl}/v1/status`,
      requestOptions(this.worker.token),
    ).json<WorkerStatus>();
  }

  async guildSettings(guildId: string): Promise<WorkerGuildSettings> {
    return got.get(
      `${this.worker.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/settings`,
      requestOptions(this.worker.token),
    ).json<WorkerGuildSettings>();
  }

  async updateGuildSettings(guildId: string, patch: GuildSettingsPatch): Promise<WorkerGuildSettings> {
    return got.patch(
      `${this.worker.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/settings`,
      {
        ...requestOptions(this.worker.token),
        json: patch,
      },
    ).json<WorkerGuildSettings>();
  }
}
