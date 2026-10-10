import got, {type CancelableRequest, type Response} from 'got';
import type {GuildSettingsPatch} from '../control/settings-validation.js';
import type {
  WorkerBlocklistResult,
  WorkerGuildSettings,
  WorkerLeaveGuildResult,
  WorkerStatus,
  StatusAnnounceRequest,
  WorkerStatusAnnounceResult,
} from '../control/types.js';
import type {Blocklist} from '../control/blocklist.js';
import type {WorkerDefinition} from './config.js';

/** Worker responses are small JSON documents; anything larger is treated as a failure. */
export const MAX_WORKER_RESPONSE_BYTES = 1024 * 1024;

const requestOptions = (token: string) => ({
  headers: {
    authorization: `Bearer ${token}`,
  },
  followRedirect: false,
  hooks: {
    afterResponse: [
      // With redirects disabled got treats 3xx as success; a worker never redirects.
      (response: Response) => {
        if (response.statusCode >= 300) {
          throw new Error(`Unexpected worker response status ${response.statusCode}`);
        }

        return response;
      },
    ],
  },
  retry: {
    limit: 0,
  },
  timeout: {
    request: 3000,
  },
});

const capResponseSize = (request: CancelableRequest<Response<string>>): CancelableRequest<Response<string>> => {
  void request.on('downloadProgress', progress => {
    if (progress.transferred > MAX_WORKER_RESPONSE_BYTES || (progress.total ?? 0) > MAX_WORKER_RESPONSE_BYTES) {
      request.cancel('worker response too large');
    }
  });
  return request;
};

export default class WorkerClient {
  constructor(private readonly worker: WorkerDefinition) {}

  get id(): string {
    return this.worker.id;
  }

  async status(): Promise<WorkerStatus> {
    return capResponseSize(got.get(
      `${this.worker.baseUrl}/v1/status`,
      requestOptions(this.worker.token),
    )).json<WorkerStatus>();
  }

  async guildSettings(guildId: string): Promise<WorkerGuildSettings> {
    return capResponseSize(got.get(
      `${this.worker.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/settings`,
      requestOptions(this.worker.token),
    )).json<WorkerGuildSettings>();
  }

  async updateGuildSettings(guildId: string, patch: GuildSettingsPatch): Promise<WorkerGuildSettings> {
    return capResponseSize(got.patch(
      `${this.worker.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/settings`,
      {
        ...requestOptions(this.worker.token),
        json: patch,
      },
    )).json<WorkerGuildSettings>();
  }

  async leaveGuild(guildId: string): Promise<WorkerLeaveGuildResult> {
    return capResponseSize(got.post(
      `${this.worker.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/leave`,
      requestOptions(this.worker.token),
    )).json<WorkerLeaveGuildResult>();
  }

  /** Replace the worker's in-memory blocklist; the worker leaves blocked guilds immediately. */
  async pushBlocklist(blocklist: Blocklist): Promise<WorkerBlocklistResult> {
    return capResponseSize(got.put(
      `${this.worker.baseUrl}/v1/blocklist`,
      {
        ...requestOptions(this.worker.token),
        // Leaving newly blocked guilds is part of the request and can take a few Discord round trips.
        timeout: {request: 10_000},
        json: blocklist,
      },
    )).json<WorkerBlocklistResult>();
  }

  /** Ask the worker to post a status message (online or test) in `channelId`, mentioning `mentionRoleIds`. */
  async announceStatus(request: StatusAnnounceRequest): Promise<WorkerStatusAnnounceResult> {
    return capResponseSize(got.post(
      `${this.worker.baseUrl}/v1/status-channel/announce`,
      {
        ...requestOptions(this.worker.token),
        // Fetching the channel and sending the message takes a few Discord round trips.
        timeout: {request: 10_000},
        json: request,
      },
    )).json<WorkerStatusAnnounceResult>();
  }
}
