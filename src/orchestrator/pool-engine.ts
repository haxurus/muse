import {HttpError} from '../control/http.js';
import type {WorkerStatus} from '../control/types.js';
import type {GuildPoolConfig, PoolAssignment, PoolAssignmentMode, PoolGroup} from './pool-types.js';

export type ReachableWorker = {
  id: string;
  status: WorkerStatus;
};

type Reservation = {
  workerId: string;
  expiresAt: number;
};

const RESERVATION_TTL_MS = 45_000;

const keyFor = (guildId: string, voiceChannelId: string) => guildId + ':' + voiceChannelId;

export default class PoolEngine {
  private readonly reservations = new Map<string, Reservation>();

  assign(options: {
    guildId: string;
    voiceChannelId: string;
    currentWorkerId: string;
    mode: PoolAssignmentMode;
    config: GuildPoolConfig;
    workers: ReachableWorker[];
  }): PoolAssignment {
    this.cleanupReservations();

    const {
      guildId,
      voiceChannelId,
      currentWorkerId,
      mode,
      config,
      workers,
    } = options;

    const active = this.sessionAssignments(guildId, workers);
    const existing = active.find(assignment => assignment.voiceChannelId === voiceChannelId);
    if (existing) {
      return this.toAssignment(guildId, voiceChannelId, existing.worker, config, false);
    }

    const reservationKey = keyFor(guildId, voiceChannelId);
    const reservation = this.reservations.get(reservationKey);
    if (reservation) {
      const reservedWorker = workers.find(worker => worker.id === reservation.workerId);
      if (reservedWorker) {
        return this.toAssignment(guildId, voiceChannelId, reservedWorker, config, true);
      }

      this.reservations.delete(reservationKey);
    }

    if (mode === 'existing') {
      throw new HttpError(409, 'this voice channel has no active Muse player');
    }

    const group = this.groupForChannel(config, voiceChannelId);
    const eligibleIds = new Set(group?.workerIds ?? workers.map(worker => worker.id));
    const activeWorkerIds = new Set(active.map(assignment => assignment.worker.id));
    const reservedWorkerIds = new Set(
      [...this.reservations.entries()]
        .filter(([key]) => key.startsWith(guildId + ':'))
        .map(([, value]) => value.workerId),
    );

    const activeCount = active.length + reservedWorkerIds.size;
    if (activeCount >= config.maxConcurrentPlayers) {
      throw new HttpError(409, 'server player quota reached (' + config.maxConcurrentPlayers + ')');
    }

    if (group) {
      const groupBusy = active.filter(assignment => group.workerIds.includes(assignment.worker.id)).length
        + [...reservedWorkerIds].filter(workerId => group.workerIds.includes(workerId)).length;
      if (groupBusy >= group.maxConcurrentPlayers) {
        throw new HttpError(409, 'group player quota reached for ' + group.name + ' (' + group.maxConcurrentPlayers + ')');
      }
    }

    const available = workers.filter(worker => (
      worker.status.discordReady
      && worker.status.guilds.some(guild => guild.id === guildId)
      && eligibleIds.has(worker.id)
      && !activeWorkerIds.has(worker.id)
      && !reservedWorkerIds.has(worker.id)
    ));

    const chosen = available.find(worker => worker.id === currentWorkerId) ?? available[0];
    if (!chosen) {
      throw new HttpError(409, 'no free music worker is available for this voice channel');
    }

    this.reservations.set(reservationKey, {
      workerId: chosen.id,
      expiresAt: Date.now() + RESERVATION_TTL_MS,
    });

    return this.toAssignment(guildId, voiceChannelId, chosen, config, true);
  }

  private sessionAssignments(guildId: string, workers: ReachableWorker[]) {
    return workers.flatMap(worker => worker.status.players
      .filter(player => (
        player.guildId === guildId
        && (player.connected || player.hasCurrent)
        && (player.channelId || player.lastChannelId)
      ))
      .map(player => ({
        worker,
        voiceChannelId: (player.channelId ?? player.lastChannelId)!,
      })));
  }

  private groupForChannel(config: GuildPoolConfig, voiceChannelId: string): PoolGroup | null {
    if (config.groups.length === 0) {
      return null;
    }

    return config.groups.find(group => group.voiceChannelIds.includes(voiceChannelId))
      ?? config.groups.find(group => group.isDefault)
      ?? null;
  }

  private toAssignment(
    guildId: string,
    voiceChannelId: string,
    worker: ReachableWorker,
    config: GuildPoolConfig,
    reserved: boolean,
  ): PoolAssignment {
    const group = this.groupForChannel(config, voiceChannelId);

    return {
      guildId,
      voiceChannelId,
      workerId: worker.id,
      bot: worker.status.bot,
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      reserved,
    };
  }

  private cleanupReservations(): void {
    const now = Date.now();
    for (const [key, reservation] of this.reservations.entries()) {
      if (reservation.expiresAt <= now) {
        this.reservations.delete(key);
      }
    }
  }
}
