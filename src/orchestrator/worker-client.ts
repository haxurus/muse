import got from 'got';
import type {GuildSettingsPatch} from '../control/settings-validation.js';
import type {WorkerGuildSettings, WorkerStatus} from '../control/types.js';
import type {PlaybackActionResult} from '../control/playback-types.js';
import type {WorkerDefinition} from './config.js';
import {HttpError} from '../control/http.js';

const normalizeWorkerError = (error: unknown): HttpError => {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as {response?: {statusCode?: number; body?: unknown}}).response;
    const statusCode = response?.statusCode && response.statusCode >= 400 && response.statusCode < 500
      ? response.statusCode
      : 502;

    if (typeof response?.body === 'string') {
      try {
        const parsed = JSON.parse(response.body) as {error?: unknown};
        if (typeof parsed.error === 'string') {
          return new HttpError(statusCode, parsed.error);
        }
      } catch {}
    }
  }

  return new HttpError(502, 'music worker is unavailable');
};

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

export type WorkerGuildChannels = {
  guildId: string;
  categories: Array<{id: string; name: string}>;
  voiceChannels: Array<{id: string; name: string; parentId: string | null}>;
};

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

  async guildChannels(guildId: string): Promise<WorkerGuildChannels> {
    try {
      return await got.get(
        `${this.worker.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/channels`,
        requestOptions(this.worker.token),
      ).json<WorkerGuildChannels>();
    } catch (error: unknown) {
      throw normalizeWorkerError(error);
    }
  }

  async playbackAction(
    guildId: string,
    action: 'play' | 'pause' | 'resume' | 'skip' | 'stop' | 'disconnect' | 'volume',
    body: Record<string, unknown>,
  ): Promise<PlaybackActionResult> {
    try {
      return await got.post(
        `${this.worker.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/playback/${action}`,
        {
          ...requestOptions(this.worker.token),
          json: body,
          timeout: {
            request: action === 'play' ? 60_000 : 10_000,
          },
        },
      ).json<PlaybackActionResult>();
    } catch (error: unknown) {
      throw normalizeWorkerError(error);
    }
  }

  async playbackRead(
    guildId: string,
    action: 'queue' | 'now-playing',
  ): Promise<PlaybackActionResult> {
    try {
      return await got.get(
        `${this.worker.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/playback/${action}`,
        {
          ...requestOptions(this.worker.token),
          timeout: {request: 10_000},
        },
      ).json<PlaybackActionResult>();
    } catch (error: unknown) {
      throw normalizeWorkerError(error);
    }
  }
}
