import {HttpError} from '../control/http.js';

export type PlaybackLeaseState = 'RESERVED' | 'ACTIVE' | 'PAUSED';

export type PlaybackLease = {
  guildId: string;
  voiceChannelId: string;
  workerId: string;
  groupId: string | null;
  state: PlaybackLeaseState;
  createdAt: string;
  updatedAt: string;
};

export default class PlaybackLeaseManager {
  private readonly leasesByVoice = new Map<string, PlaybackLease>();
  private readonly voiceByGuildWorker = new Map<string, string>();
  private readonly guildLocks = new Map<string, Promise<void>>();

  async withGuildLock<T>(guildId: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.guildLocks.get(guildId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.guildLocks.set(guildId, previous.then(() => current));

    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.guildLocks.get(guildId) === current) {
        this.guildLocks.delete(guildId);
      }
    }
  }

  get(guildId: string, voiceChannelId: string): PlaybackLease | undefined {
    const lease = this.leasesByVoice.get(this.voiceKey(guildId, voiceChannelId));
    return lease ? {...lease} : undefined;
  }

  allForGuild(guildId: string): PlaybackLease[] {
    return [...this.leasesByVoice.values()]
      .filter(lease => lease.guildId === guildId)
      .map(lease => ({...lease}));
  }

  reserve(
    guildId: string,
    voiceChannelId: string,
    workerId: string,
    groupId: string | null,
  ): PlaybackLease {
    const voiceKey = this.voiceKey(guildId, voiceChannelId);
    const existing = this.leasesByVoice.get(voiceKey);
    if (existing) {
      return {...existing};
    }

    const workerKey = this.workerKey(guildId, workerId);
    if (this.voiceByGuildWorker.has(workerKey)) {
      throw new HttpError(409, 'worker is already reserved in this server');
    }

    const now = new Date().toISOString();
    const lease: PlaybackLease = {
      guildId,
      voiceChannelId,
      workerId,
      groupId,
      state: 'RESERVED',
      createdAt: now,
      updatedAt: now,
    };

    this.leasesByVoice.set(voiceKey, lease);
    this.voiceByGuildWorker.set(workerKey, voiceChannelId);
    return {...lease};
  }

  setState(guildId: string, voiceChannelId: string, state: PlaybackLeaseState): void {
    const key = this.voiceKey(guildId, voiceChannelId);
    const lease = this.leasesByVoice.get(key);
    if (!lease) {
      return;
    }

    lease.state = state;
    lease.updatedAt = new Date().toISOString();
  }

  release(guildId: string, voiceChannelId: string): void {
    const key = this.voiceKey(guildId, voiceChannelId);
    const lease = this.leasesByVoice.get(key);
    if (!lease) {
      return;
    }

    this.leasesByVoice.delete(key);
    this.voiceByGuildWorker.delete(this.workerKey(guildId, lease.workerId));
  }

  releaseWorker(guildId: string, workerId: string): void {
    const voiceChannelId = this.voiceByGuildWorker.get(this.workerKey(guildId, workerId));
    if (voiceChannelId) {
      this.release(guildId, voiceChannelId);
    }
  }

  recover(
    guildId: string,
    voiceChannelId: string,
    workerId: string,
    state: PlaybackLeaseState,
  ): PlaybackLease {
    const existing = this.get(guildId, voiceChannelId);
    if (existing) {
      return existing;
    }

    const conflictingVoice = this.voiceByGuildWorker.get(this.workerKey(guildId, workerId));
    if (conflictingVoice && conflictingVoice !== voiceChannelId) {
      this.release(guildId, conflictingVoice);
    }

    const lease = this.reserve(guildId, voiceChannelId, workerId, null);
    this.setState(guildId, voiceChannelId, state);
    return {...lease, state};
  }

  private voiceKey(guildId: string, voiceChannelId: string): string {
    return `${guildId}:${voiceChannelId}`;
  }

  private workerKey(guildId: string, workerId: string): string {
    return `${guildId}:${workerId}`;
  }
}
