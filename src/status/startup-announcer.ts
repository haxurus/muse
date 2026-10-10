import type {Client} from 'discord.js';
import {isSnowflake} from '../control/snowflake.js';
import {MAX_MENTION_ROLES} from '../control/mention-roles.js';
import type {StatusAnnounceResult, WorkerPlatformConfig} from '../control/types.js';
import {resolveOrchestratorUrl} from '../playback/protocol.js';
import type Config from '../services/config.js';
import {postStatusMessage, type StatusMessageInput} from './announce.js';

/** At most one "online" message per bot in this window, so a flapping gateway does not spam the channel. */
export const STATUS_ANNOUNCE_INTERVAL_MS = 5 * 60 * 1000;
export const WORKER_CONFIG_TIMEOUT_MS = 5000;
const MAX_WORKER_CONFIG_BYTES = 4096;

const isValidRoleList = (value: unknown): value is string[] => Array.isArray(value)
  && value.length <= MAX_MENTION_ROLES
  && value.every(id => isSnowflake(id));

const errorLabel = (error: unknown): string => error instanceof Error ? error.name : 'Error';

/** `GET /v1/worker/config` on the orchestrator, authenticated with this worker's control token. */
export const fetchWorkerPlatformConfig = async (
  token: string,
  url: string = resolveOrchestratorUrl('/v1/worker/config'),
  timeoutMs = WORKER_CONFIG_TIMEOUT_MS,
): Promise<WorkerPlatformConfig> => {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {authorization: `Bearer ${token}`, accept: 'application/json'},
  });
  if (!response.ok) {
    throw new Error(`Orchestrator answered ${response.status}`);
  }

  const text = await response.text();
  if (text.length > MAX_WORKER_CONFIG_BYTES) {
    throw new Error('Oversized worker config');
  }

  const body = JSON.parse(text) as unknown;
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid worker config');
  }

  const {statusGuildId, statusChannelId, mentionRoleIds} = body as {statusGuildId?: unknown; statusChannelId?: unknown; mentionRoleIds?: unknown};
  if (statusChannelId !== null && !isSnowflake(statusChannelId)) {
    throw new Error('Invalid worker config');
  }

  // A missing server (older orchestrator or setting) means "any server this bot is in".
  if (statusGuildId !== undefined && statusGuildId !== null && !isSnowflake(statusGuildId)) {
    throw new Error('Invalid worker config');
  }

  // A missing list (older orchestrator) means no mentions.
  let roles: string[] = [];
  if (mentionRoleIds !== undefined) {
    if (!isValidRoleList(mentionRoleIds)) {
      throw new Error('Invalid worker config');
    }

    roles = mentionRoleIds;
  }

  return {statusGuildId: isSnowflake(statusGuildId) ? statusGuildId : null, statusChannelId, mentionRoleIds: roles};
};

export type StatusAnnouncerDependencies = {
  fetchConfig: (token: string) => Promise<WorkerPlatformConfig>;
  post: (client: Client, input: StatusMessageInput) => Promise<StatusAnnounceResult>;
  now: () => number;
};

export type AnnounceOutcome = 'posted' | 'failed' | 'skipped';

/**
 * Posts the "bot online" message in the status channel chosen from the super console, after startup
 * and after a full reconnect. Only managed workers (MUSE_WORKER_ID) announce. It never throws and is
 * never awaited by the ready handlers, so the orchestrator or Discord being slow cannot delay readiness.
 */
export default class StatusAnnouncer {
  private lastPostedAt?: number;
  private inFlight = false;
  private readonly dependencies: StatusAnnouncerDependencies;

  constructor(
    private readonly client: Client,
    private readonly config: Pick<Config, 'WORKER_ID' | 'CONTROL_TOKEN'>,
    dependencies: Partial<StatusAnnouncerDependencies> = {},
  ) {
    this.dependencies = {
      fetchConfig: async token => fetchWorkerPlatformConfig(token),
      post: async (target, input) => postStatusMessage(target, input),
      now: () => Date.now(),
      ...dependencies,
    };
  }

  async announceOnline(): Promise<AnnounceOutcome> {
    if (!this.config.WORKER_ID || !this.config.CONTROL_TOKEN || this.inFlight) {
      return 'skipped';
    }

    if (this.lastPostedAt !== undefined && this.dependencies.now() - this.lastPostedAt < STATUS_ANNOUNCE_INTERVAL_MS) {
      return 'skipped';
    }

    this.inFlight = true;
    try {
      return await this.announce();
    } catch (error: unknown) {
      console.warn(`Status channel: online message failed (${errorLabel(error)})`);
      return 'failed';
    } finally {
      this.inFlight = false;
    }
  }

  private async announce(): Promise<AnnounceOutcome> {
    let config: WorkerPlatformConfig;
    try {
      config = await this.dependencies.fetchConfig(this.config.CONTROL_TOKEN);
    } catch (error: unknown) {
      // Not counted against the rate limit: the next full reconnect tries again.
      console.warn(`Status channel: could not read the worker config from the orchestrator (${errorLabel(error)})`);
      return 'failed';
    }

    const {statusGuildId, statusChannelId, mentionRoleIds} = config;
    if (statusChannelId === null) {
      return 'skipped';
    }

    // Bots that are not members of the chosen server stay silent instead of logging a failure.
    if (statusGuildId !== null && !this.client.guilds.cache.has(statusGuildId)) {
      return 'skipped';
    }

    // Count every attempt, so a channel with missing permissions is not retried on each reconnect.
    this.lastPostedAt = this.dependencies.now();
    const result = await this.dependencies.post(this.client, {guildId: statusGuildId, channelId: statusChannelId, workerId: this.config.WORKER_ID, test: false, mentionRoleIds});
    if (!result.ok) {
      console.warn(`Status channel: online message not posted in ${statusChannelId} (${result.error})`);
      return 'failed';
    }

    console.log(`Status channel: online message posted in ${statusChannelId}`);
    return 'posted';
  }
}
