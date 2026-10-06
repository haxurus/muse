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

export type OrchestratorWorkerStatus = {
  workerId: string;
  ok: boolean;
  value?: {
    discordReady?: boolean;
    bot?: {id: string; username: string} | null;
  };
  error?: string;
};

export type OrchestratorWorkerList = {
  workers: OrchestratorWorkerStatus[];
};

/** Identity of the dashboard user performing a super-admin action, forwarded for auditing. */
export type SuperActor = {
  userId: string;
  username: string;
};

export type BlockKind = 'GUILD' | 'USER';

const MAX_ACTOR_NAME_LENGTH = 64;

const isControlCharacter = (code: number): boolean => code < 32 || (code >= 127 && code <= 159);

/**
 * Header-safe actor name: control characters dropped, each remaining character
 * percent-encoded (`encodeURIComponent`, a no-op for plain Discord usernames), cut so
 * the header value never exceeds 64 characters. The orchestrator decodes it.
 */
export const actorName = (username: string): string => {
  let result = '';
  for (const character of username) {
    if (isControlCharacter(character.codePointAt(0) ?? 0)) {
      continue;
    }

    let encoded: string;
    try {
      encoded = encodeURIComponent(character);
    } catch {
      // Lone surrogate: not representable, skip it.
      continue;
    }

    if (result.length + encoded.length > MAX_ACTOR_NAME_LENGTH) {
      break;
    }

    result += encoded;
  }

  return result === '' ? 'unknown' : result;
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

const actorOptions = (token: string, actor: SuperActor) => {
  const base = options(token);
  return {
    ...base,
    headers: {
      ...base.headers,
      'x-muse-actor-id': actor.userId,
      'x-muse-actor-name': actorName(actor.username),
    },
  };
};

const parseOptionalJson = (body: string): unknown => {
  if (body.trim() === '') {
    return {ok: true};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return {ok: true};
  }
};

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

  async workers(): Promise<OrchestratorWorkerList> {
    return call(async () => got.get(
      `${this.config.orchestratorUrl}/v1/workers`,
      options(this.config.orchestratorToken),
    ).json<OrchestratorWorkerList>());
  }

  /** Returns whether the orchestrator block list contains this Discord user; throws if unknown. */
  async isUserBlocked(userId: string): Promise<boolean> {
    const body = await call(async () => got.get(
      `${this.config.orchestratorUrl}/v1/blocks/users/${encodeURIComponent(userId)}`,
      options(this.config.orchestratorToken),
    ).json<unknown>());

    const blocked = typeof body === 'object' && body !== null ? (body as {blocked?: unknown}).blocked : undefined;
    if (typeof blocked !== 'boolean') {
      throw new DashboardHttpError(502, 'orchestrator returned an invalid block status');
    }

    return blocked;
  }

  async superOverview(actor: SuperActor): Promise<unknown> {
    return call(async () => got.get(
      `${this.config.orchestratorUrl}/v1/super/overview`,
      actorOptions(this.config.orchestratorToken, actor),
    ).json<unknown>());
  }

  async superLeaveGuild(guildId: string, body: {workerIds?: string[]}, actor: SuperActor): Promise<unknown> {
    return call(async () => got.post(
      `${this.config.orchestratorUrl}/v1/super/guilds/${encodeURIComponent(guildId)}/leave`,
      {
        ...actorOptions(this.config.orchestratorToken, actor),
        json: body,
      },
    ).json<unknown>());
  }

  async superPutBlock(kind: BlockKind, subjectId: string, body: {reason?: string}, actor: SuperActor): Promise<unknown> {
    return call(async () => got.put(
      `${this.config.orchestratorUrl}/v1/super/blocks/${kind}/${encodeURIComponent(subjectId)}`,
      {
        ...actorOptions(this.config.orchestratorToken, actor),
        json: body,
      },
    ).json<unknown>());
  }

  async superDeleteBlock(kind: BlockKind, subjectId: string, actor: SuperActor): Promise<unknown> {
    // Any 2xx counts as success, including an empty 204 body.
    const body = await call(async () => got.delete(
      `${this.config.orchestratorUrl}/v1/super/blocks/${kind}/${encodeURIComponent(subjectId)}`,
      actorOptions(this.config.orchestratorToken, actor),
    ).text());
    return parseOptionalJson(body);
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
