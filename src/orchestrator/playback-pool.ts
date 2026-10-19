import type {IncomingMessage, ServerResponse} from 'node:http';
import {HttpError, hasBearerToken, readJsonBody, sendJson} from '../control/http.js';
import {isSnowflake} from '../control/snowflake.js';
import {EN_MESSAGES} from '../i18n/en.js';
import {isPlaybackWorkerId, parsePlaybackRequest, type PlaybackWorkerId} from '../playback/protocol.js';
import {sendPlayback} from '../playback/transport.js';
import type {WorkerDefinition} from './config.js';
import type {SettledStatus} from './plan-service.js';

/** How long a free bot stays reserved for a voice channel until its status shows it connected there. */
export const POOL_LEASE_MS = 90_000;
/** Worker statuses are reused for this long, so a burst of commands costs one status round. */
export const POOL_STATUS_CACHE_MS = 1500;

export type PoolIntent = 'play' | 'control';

export type PoolAssignment = {
  workerId: PlaybackWorkerId;
  /** Discord user id of the bot, for mentions. */
  botId: string | null;
  reason: 'in-channel' | 'reserved' | 'free';
};

type Lease = {channelId: string; expiresAt: number};

/**
 * Playback pool (one voice channel, one bot): a player command sent to any Muse bot of a server is
 * served by the bot already in the requester's voice channel or, for `/play`, by a free bot the
 * server's plan includes. The command-receiving bot is preferred when it is free. Reservations are
 * in memory and short: after an orchestrator restart the workers' own voice state is the truth.
 */
export default class PlaybackPool {
  private readonly leases = new Map<string, Map<string, Lease>>();
  private cachedStatuses?: {at: number; statuses: Promise<SettledStatus[]>};

  constructor(
    private readonly workers: WorkerDefinition[],
    private readonly statuses: () => Promise<SettledStatus[]>,
    private readonly allowedWorkerIds: (guildId: string, statuses: SettledStatus[]) => string[],
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The bot that serves `channelId`; `null` for a control command when no bot is there.
   * Throws `409 ALL_BOTS_BUSY` when `/play` finds no free bot.
   */
  async assign(guildId: string, channelId: string, intent: PoolIntent, callerId: string): Promise<PoolAssignment | null> {
    const statuses = await this.currentStatuses();
    // Everything below is synchronous, so concurrent requests see each other's reservations.
    const now = this.now();
    const allowed = new Set(this.allowedWorkerIds(guildId, statuses));
    const candidates = this.workers
      .map(worker => statuses.find(result => result.workerId === worker.id))
      .filter((result): result is Extract<SettledStatus, {ok: true}> => result?.ok === true
        && result.value.discordReady
        && isPlaybackWorkerId(result.workerId)
        && allowed.has(result.workerId)
        && result.value.guilds.some(guild => guild.id === guildId));
    const voiceChannelOf = (result: Extract<SettledStatus, {ok: true}>): string | null => {
      const player = result.value.players.find(entry => entry.guildId === guildId);
      // A connected player with an unknown channel is busy, never free.
      return player?.connected ? player.channelId ?? 'unknown' : null;
    };

    const leases = this.liveLeases(guildId, now);
    const assignment = (result: Extract<SettledStatus, {ok: true}>, reason: PoolAssignment['reason']): PoolAssignment => ({
      workerId: result.workerId as PlaybackWorkerId,
      botId: result.value.bot?.id ?? null,
      reason,
    });

    const inChannel = candidates.find(result => voiceChannelOf(result) === channelId);
    if (inChannel) {
      return assignment(inChannel, 'in-channel');
    }

    const reserved = candidates.find(result => voiceChannelOf(result) === null && leases.get(result.workerId)?.channelId === channelId);
    if (reserved) {
      if (intent === 'play') {
        leases.set(reserved.workerId, {channelId, expiresAt: now + POOL_LEASE_MS});
        this.leases.set(guildId, leases);
      }

      return assignment(reserved, 'reserved');
    }

    if (intent === 'control') {
      return null;
    }

    const free = candidates.filter(result => voiceChannelOf(result) === null && !leases.has(result.workerId));
    const picked = free.find(result => result.workerId === callerId) ?? free[0];
    if (!picked) {
      throw new HttpError(409, EN_MESSAGES.poolAllBotsBusy, 'ALL_BOTS_BUSY');
    }

    leases.set(picked.workerId, {channelId, expiresAt: now + POOL_LEASE_MS});
    this.leases.set(guildId, leases);
    return assignment(picked, 'free');
  }

  /** The bot left its channel (stop/disconnect): its reservation ends at once. */
  release(guildId: string, workerId: string): void {
    const leases = this.leases.get(guildId);
    if (!leases) {
      return;
    }

    const remaining = new Map([...leases].filter(([id]) => id !== workerId));
    if (remaining.size === 0) {
      this.leases.delete(guildId);
    } else {
      this.leases.set(guildId, remaining);
    }
  }

  /**
   * `POST /v1/playback/assign` and `POST /v1/playback`, authenticated with the calling worker's own
   * control token. Returns false for other paths.
   */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.url !== '/v1/playback' && request.url !== '/v1/playback/assign') {
      return false;
    }

    const callers = this.workers.filter(worker => hasBearerToken(request, worker.token));
    if (callers.length !== 1) {
      throw new HttpError(401, 'Unauthorized playback controller.');
    }

    if (request.method !== 'POST') {
      throw new HttpError(405, 'Method not allowed.');
    }

    const caller = callers[0];
    if (request.url === '/v1/playback/assign') {
      const body = await readJsonBody(request);
      const {guildId, voiceChannelId, intent} = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      if (!isSnowflake(guildId) || !isSnowflake(voiceChannelId) || (intent !== 'play' && intent !== 'control')) {
        throw new HttpError(400, 'Invalid assignment request.');
      }

      const assigned = await this.assign(guildId, voiceChannelId, intent, caller.id);
      sendJson(response, 200, assigned ?? {workerId: null, botId: null, reason: null});
      return true;
    }

    const playback = parsePlaybackRequest(await readJsonBody(request));
    const assigned = await this.assign(playback.guildId, playback.voiceChannelId, playback.action === 'play' ? 'play' : 'control', caller.id);
    if (!assigned) {
      throw new HttpError(409, EN_MESSAGES.poolNoBotInChannel);
    }

    const target = this.workers.find(worker => worker.id === assigned.workerId)!;
    const result = await sendPlayback(`${target.baseUrl}/v1/playback`, target.token, playback, assigned.workerId);
    if (result.state === 'FREE') {
      this.release(playback.guildId, assigned.workerId);
    }

    // The next command must see the new voice state.
    this.cachedStatuses = undefined;
    sendJson(response, 200, result);
    return true;
  }

  private async currentStatuses(): Promise<SettledStatus[]> {
    const now = this.now();
    if (!this.cachedStatuses || now - this.cachedStatuses.at > POOL_STATUS_CACHE_MS) {
      this.cachedStatuses = {at: now, statuses: this.statuses()};
    }

    return this.cachedStatuses.statuses;
  }

  private liveLeases(guildId: string, now: number): Map<string, Lease> {
    return new Map([...this.leases.get(guildId) ?? []].filter(([, lease]) => lease.expiresAt > now));
  }
}
