import {HttpError} from '../control/http.js';
import type {
  PlaybackActionResult,
  PlaybackChannelRequest,
  PlaybackPlayRequest,
  PlaybackSkipRequest,
  PlaybackVolumeRequest,
} from '../control/playback-types.js';
import type {WorkerStatus} from '../control/types.js';
import GuildGroupStore from './guild-group-store.js';
import GuildRoutingStore from './guild-routing-store.js';
import PlaybackLeaseManager, {PlaybackLease, PlaybackLeaseState} from './playback-lease-manager.js';
import WorkerClient, {WorkerGuildChannels} from './worker-client.js';

type WorkerStatusResult = {
  worker: WorkerClient;
  status: WorkerStatus | null;
};

type RoutedPlayRequest = PlaybackPlayRequest & {
  categoryId?: string | null;
};

const objectBody = (input: unknown): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'playback request body must be an object');
  }

  return input as Record<string, unknown>;
};

const optionalSnowflake = (value: unknown, label: string): string | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string' || !/^\d{10,32}$/u.test(value)) {
    throw new HttpError(400, `${label} must be a Discord snowflake`);
  }

  return value;
};

export default class PlaybackOrchestrator {
  constructor(
    private readonly workers: WorkerClient[],
    private readonly groups: GuildGroupStore,
    private readonly routing: GuildRoutingStore,
    private readonly leases: PlaybackLeaseManager,
  ) {}

  async play(guildId: string, input: unknown): Promise<PlaybackActionResult & {lease: PlaybackLease}> {
    const body = objectBody(input);
    const voiceChannelId = optionalSnowflake(body.voiceChannelId, 'voiceChannelId');
    if (!voiceChannelId) {
      throw new HttpError(400, 'voiceChannelId is required');
    }

    const categoryId = optionalSnowflake(body.categoryId, 'categoryId');
    let wasNewLease = false;

    const allocation = await this.leases.withGuildLock(guildId, async () => {
      await this.reconcileGuild(guildId);

      const existing = this.leases.get(guildId, voiceChannelId);
      if (existing) {
        const worker = this.workerById(existing.workerId);
        return {lease: existing, worker};
      }

      const groupId = this.routing.resolveGroupId(
        guildId,
        voiceChannelId,
        categoryId,
        this.groups,
      );
      const group = groupId ? this.groups.get(guildId, groupId) : undefined;
      const allowedWorkerIds = group
        ? new Set(group.workerIds)
        : new Set(this.workers.map(worker => worker.id));

      const statuses = await this.statuses();
      const worker = this.workers.find(candidate => {
        if (!allowedWorkerIds.has(candidate.id)) {
          return false;
        }

        const status = statuses.find(result => result.worker.id === candidate.id)?.status;
        if (!status?.discordReady || !status.guilds.some(guild => guild.id === guildId)) {
          return false;
        }

        if (this.leases.allForGuild(guildId).some(lease => lease.workerId === candidate.id)) {
          return false;
        }

        const player = status.players.find(candidatePlayer => candidatePlayer.guildId === guildId);
        return !player || (!player.connected && !player.hasCurrent);
      });

      if (!worker) {
        const groupName = group?.name ? ` in group "${group.name}"` : '';
        throw new HttpError(409, `no free music bot is available${groupName}`);
      }

      const lease = this.leases.reserve(guildId, voiceChannelId, worker.id, groupId);
      wasNewLease = true;
      return {lease, worker};
    });

    try {
      const result = await allocation.worker.playbackAction(
        guildId,
        'play',
        body as RoutedPlayRequest as unknown as Record<string, unknown>,
      );
      this.updateLeaseFromPlayback(allocation.lease, result);
      return {...result, lease: this.leases.get(guildId, voiceChannelId) ?? allocation.lease};
    } catch (error: unknown) {
      if (wasNewLease) {
        this.leases.release(guildId, voiceChannelId);
      }

      throw error;
    }
  }

  async action(
    guildId: string,
    action: 'pause' | 'resume' | 'skip' | 'stop' | 'disconnect' | 'volume',
    input: unknown,
  ): Promise<PlaybackActionResult & {lease?: PlaybackLease}> {
    const body = objectBody(input);
    const voiceChannelId = optionalSnowflake(body.voiceChannelId, 'voiceChannelId');
    const lease = await this.resolveLease(guildId, voiceChannelId);
    const worker = this.workerById(lease.workerId);
    const result = await worker.playbackAction(
      guildId,
      action,
      body as unknown as Record<string, unknown>,
    );

    if (action === 'stop') {
      this.leases.release(guildId, lease.voiceChannelId);
      return result;
    }

    this.updateLeaseFromPlayback(lease, result);
    return {
      ...result,
      lease: this.leases.get(guildId, lease.voiceChannelId),
    };
  }

  async read(
    guildId: string,
    action: 'queue' | 'now-playing',
    voiceChannelIdInput?: unknown,
  ): Promise<PlaybackActionResult & {lease: PlaybackLease}> {
    const voiceChannelId = optionalSnowflake(voiceChannelIdInput, 'voiceChannelId');
    const lease = await this.resolveLease(guildId, voiceChannelId);
    const result = await this.workerById(lease.workerId).playbackRead(guildId, action);
    return {...result, lease};
  }

  async channels(guildId: string): Promise<WorkerGuildChannels> {
    const statuses = await this.statuses();
    for (const {worker, status} of statuses) {
      if (status?.discordReady && status.guilds.some(guild => guild.id === guildId)) {
        return worker.guildChannels(guildId);
      }
    }

    throw new HttpError(404, 'no reachable Muse worker is available in that guild');
  }

  async state(guildId: string): Promise<{guildId: string; leases: PlaybackLease[]}> {
    await this.leases.withGuildLock(guildId, async () => this.reconcileGuild(guildId));
    return {
      guildId,
      leases: this.leases.allForGuild(guildId),
    };
  }

  async reconcileAll(): Promise<void> {
    const statuses = await this.statuses();
    const guildIds = new Set<string>();

    for (const {status} of statuses) {
      for (const player of status?.players ?? []) {
        guildIds.add(player.guildId);
      }
    }

    for (const guildId of guildIds) {
      this.reconcileGuildFromStatuses(guildId, statuses);
    }
  }

  async reconcileGuild(guildId: string): Promise<void> {
    this.reconcileGuildFromStatuses(guildId, await this.statuses());
  }

  private reconcileGuildFromStatuses(guildId: string, statuses: WorkerStatusResult[]): void {
    for (const {worker, status} of statuses) {
      if (!status) {
        continue;
      }

      const player = status.players.find(candidate => candidate.guildId === guildId);
      if (!player) {
        this.leases.releaseWorker(guildId, worker.id);
        continue;
      }

      const recoverChannelId = player.channelId ?? player.lastChannelId;
      if ((player.connected || player.hasCurrent) && recoverChannelId) {
        const state: PlaybackLeaseState = player.status === 'PLAYING' ? 'ACTIVE' : 'PAUSED';
        this.leases.recover(guildId, recoverChannelId, worker.id, state);
      } else if (!player.connected && !player.hasCurrent) {
        this.leases.releaseWorker(guildId, worker.id);
      }
    }
  }

  private async resolveLease(guildId: string, voiceChannelId: string | null): Promise<PlaybackLease> {
    return this.leases.withGuildLock(guildId, async () => {
      await this.reconcileGuild(guildId);

      if (voiceChannelId) {
        const lease = this.leases.get(guildId, voiceChannelId);
        if (!lease) {
          throw new HttpError(404, 'no music bot is assigned to your voice channel');
        }

        return lease;
      }

      const leases = this.leases.allForGuild(guildId);
      if (leases.length === 0) {
        throw new HttpError(404, 'no active music session in this server');
      }

      if (leases.length > 1) {
        throw new HttpError(409, 'multiple music sessions are active; join the target voice channel');
      }

      return leases[0];
    });
  }

  private async statuses(): Promise<WorkerStatusResult[]> {
    return Promise.all(this.workers.map(async worker => {
      try {
        return {worker, status: await worker.status()};
      } catch {
        return {worker, status: null};
      }
    }));
  }

  private updateLeaseFromPlayback(lease: PlaybackLease, result: PlaybackActionResult): void {
    const {playback} = result;
    if (!playback.connected && !playback.current) {
      this.leases.release(lease.guildId, lease.voiceChannelId);
      return;
    }

    this.leases.setState(
      lease.guildId,
      lease.voiceChannelId,
      playback.status === 'PLAYING' ? 'ACTIVE' : 'PAUSED',
    );
  }

  private workerById(workerId: string): WorkerClient {
    const worker = this.workers.find(candidate => candidate.id === workerId);
    if (!worker) {
      throw new HttpError(500, 'assigned worker is no longer configured');
    }

    return worker;
  }
}
