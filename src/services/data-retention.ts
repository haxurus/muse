import type {Client} from 'discord.js';
import {prisma} from '../utils/db.js';

/** A server's settings and favorites are kept this long after the bot left it, so a quick re-invite keeps them. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Period of the purge job on a worker, after the run at startup. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Until Discord is ready the guild cache is incomplete, so the job waits and retries this often. */
export const RETENTION_READY_RETRY_MS = 60 * 1000;

export type RetentionInput = {
  /** Epoch milliseconds of the run. */
  now: number;
  /** Servers the bot is a member of right now (its client cache). */
  currentGuildIds: ReadonlySet<string>;
  /** Departure time (epoch milliseconds) of every server that has a departure record. */
  departures: ReadonlyMap<string, number>;
  /** Servers that have stored rows (settings or favorites), in any order and possibly repeated. */
  storedGuildIds: readonly string[];
};

export type RetentionPlan = {
  /** Servers the bot left more than RETENTION_MS ago: their settings, favorites and departure record are deleted. */
  purge: string[];
  /** Servers with stored rows that the bot is not in and that have no departure record: one is created at `now`. */
  markDeparted: string[];
  /** Servers with a departure record that the bot is in again: the record is dropped. */
  clearDeparture: string[];
};

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/**
 * Which servers the retention job purges, marks and unmarks. Pure: the database and the
 * Discord cache are read by the caller. Servers without rows and without a departure record
 * are not touched.
 */
export const planRetention = ({now, currentGuildIds, departures, storedGuildIds}: RetentionInput): RetentionPlan => ({
  purge: sorted([...departures]
    .filter(([guildId, leftAt]) => !currentGuildIds.has(guildId) && now - leftAt > RETENTION_MS)
    .map(([guildId]) => guildId)),
  markDeparted: sorted(storedGuildIds.filter(guildId => !currentGuildIds.has(guildId) && !departures.has(guildId))),
  clearDeparture: sorted([...departures.keys()].filter(guildId => currentGuildIds.has(guildId))),
});

/** Records that the bot left a server now (or refreshes the time when it is removed again). */
export const recordGuildDeparture = async (guildId: string, leftAt: Date): Promise<void> => {
  await prisma.guildDeparture.upsert({
    where: {guildId},
    create: {guildId, leftAt},
    update: {leftAt},
  });
};

/** The bot is in the server again: its rows stay and the departure record is dropped. */
export const clearGuildDeparture = async (guildId: string): Promise<void> => {
  await prisma.guildDeparture.deleteMany({where: {guildId}});
};

/** One retention run against this worker's database and Discord cache. Call only when Discord is ready. */
export const sweepRetention = async (client: Client, now = Date.now()): Promise<RetentionPlan> => {
  const [departures, settings, favorites] = await Promise.all([
    prisma.guildDeparture.findMany({select: {guildId: true, leftAt: true}}),
    prisma.setting.findMany({select: {guildId: true}}),
    prisma.favoriteQuery.findMany({select: {guildId: true}}),
  ]);

  const plan = planRetention({
    now,
    currentGuildIds: new Set(client.guilds.cache.keys()),
    departures: new Map(departures.map((departure): [string, number] => [departure.guildId, departure.leftAt.getTime()])),
    storedGuildIds: [...settings, ...favorites].map(row => row.guildId),
  });

  // An empty `in` list matches nothing, so the operations below are safe when a list is empty.
  await prisma.$transaction([
    ...plan.markDeparted.map(guildId => prisma.guildDeparture.upsert({
      where: {guildId},
      create: {guildId, leftAt: new Date(now)},
      update: {},
    })),
    prisma.guildDeparture.deleteMany({where: {guildId: {in: plan.clearDeparture}}}),
    prisma.setting.deleteMany({where: {guildId: {in: plan.purge}}}),
    prisma.favoriteQuery.deleteMany({where: {guildId: {in: plan.purge}}}),
    prisma.guildDeparture.deleteMany({where: {guildId: {in: plan.purge}}}),
  ]);

  return plan;
};

const errorLabel = (error: unknown): string => error instanceof Error ? error.name : 'Error';

/**
 * Periodic purge on a worker: the first run at startup (retried every minute until Discord is
 * ready), then every six hours. One timer at a time, so runs never overlap.
 */
export default class DataRetentionJob {
  private timer?: NodeJS.Timeout;
  private stopped = true;

  constructor(private readonly client: Client) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.stopped) {
      return;
    }

    let nextDelayMs = RETENTION_READY_RETRY_MS;
    try {
      if (this.client.isReady()) {
        await this.sweep();
        nextDelayMs = RETENTION_SWEEP_INTERVAL_MS;
      }
    } catch (error: unknown) {
      // Only the error class is logged: database messages can contain user data.
      console.error(`Data retention sweep failed: ${errorLabel(error)}`);
      nextDelayMs = RETENTION_SWEEP_INTERVAL_MS;
    }

    this.schedule(nextDelayMs);
  }

  private async sweep(): Promise<void> {
    const plan = await sweepRetention(this.client);
    const changed = plan.purge.length + plan.markDeparted.length + plan.clearDeparture.length;
    if (changed > 0) {
      console.log(`Data retention: purged ${plan.purge.length} servers, marked ${plan.markDeparted.length} departures, cleared ${plan.clearDeparture.length} returns`);
    }
  }
}
