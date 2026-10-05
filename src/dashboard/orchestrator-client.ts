import got from 'got';
import type {DashboardConfig} from './config.js';
import {DashboardHttpError, describeUpstreamError} from './http.js';

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

// Orchestrator client errors that are meaningful to the browser keep their status.
const FORWARDED_CLIENT_STATUSES = new Set([400, 404, 409, 413, 422]);
const MAX_FORWARDED_MESSAGE_LENGTH = 200;

const isPrintable = (value: string): boolean =>
  [...value].every(character => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });

const forwardedMessage = (body: unknown): string | undefined => {
  let parsed = body;
  if (Buffer.isBuffer(parsed)) {
    parsed = parsed.toString('utf8');
  }

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const {error} = parsed as {error?: unknown};
  if (typeof error !== 'string') {
    return undefined;
  }

  const message = error.trim();
  if (message.length === 0 || message.length > MAX_FORWARDED_MESSAGE_LENGTH || !isPrintable(message)) {
    return undefined;
  }

  return message;
};

/**
 * Maps an orchestrator failure to a browser-safe error: selected 4xx statuses are
 * forwarded with the orchestrator's short JSON `error` message (or a generic one);
 * everything else (5xx, auth failures, network errors, timeouts) becomes 502.
 */
export const orchestratorError = (error: unknown): DashboardHttpError => {
  const failure = describeUpstreamError(error);
  const {statusCode} = failure;

  if (statusCode !== undefined && FORWARDED_CLIENT_STATUSES.has(statusCode)) {
    return new DashboardHttpError(
      statusCode,
      forwardedMessage(failure.body) ?? 'orchestrator rejected the request',
    );
  }

  return new DashboardHttpError(502, 'orchestrator unavailable', {
    causeName: failure.name,
    causeStatus: statusCode,
  });
};

const call = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error: unknown) {
    throw orchestratorError(error);
  }
};

export default class OrchestratorClient {
  constructor(private readonly config: DashboardConfig) {}

  async guilds(): Promise<OrchestratorGuildList> {
    return call(async () => got.get(
      `${this.config.orchestratorUrl}/v1/guilds`,
      options(this.config.orchestratorToken),
    ).json<OrchestratorGuildList>());
  }

  async guildWorkers(guildId: string): Promise<OrchestratorGuildWorkers> {
    return call(async () => got.get(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/workers`,
      options(this.config.orchestratorToken),
    ).json<OrchestratorGuildWorkers>());
  }

  async createGuildGroup(guildId: string, body: {name: string; workerIds: string[]}): Promise<unknown> {
    return call(async () => got.post(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/groups`,
      {
        ...options(this.config.orchestratorToken),
        json: body,
      },
    ).json<unknown>());
  }

  async updateGuildGroup(
    guildId: string,
    groupId: string,
    body: {name?: string; workerIds?: string[]},
  ): Promise<unknown> {
    return call(async () => got.patch(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/groups/${encodeURIComponent(groupId)}`,
      {
        ...options(this.config.orchestratorToken),
        json: body,
      },
    ).json<unknown>());
  }

  async deleteGuildGroup(guildId: string, groupId: string): Promise<unknown> {
    return call(async () => got.delete(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/groups/${encodeURIComponent(groupId)}`,
      options(this.config.orchestratorToken),
    ).json<unknown>());
  }

  async updateGuildSettings(guildId: string, body: GuildSettingsUpdate): Promise<unknown> {
    return call(async () => got.patch(
      `${this.config.orchestratorUrl}/v1/guilds/${encodeURIComponent(guildId)}/workers/settings`,
      {
        ...options(this.config.orchestratorToken),
        json: body,
      },
    ).json<unknown>());
  }
}
