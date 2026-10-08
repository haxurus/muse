import type {Client} from 'discord.js';
import type {StatusAnnounceResult} from '../control/types.js';
import {listStatusChannelTargets, type StatusChannelTarget} from '../control/guild-settings.js';
import {normalizeLocale} from '../i18n/index.js';
import type Config from '../services/config.js';
import {postStatusMessage, type StatusMessageInput} from './announce.js';

/** At most one round of "Bot started" messages per bot process in this window, so a flapping gateway does not spam. */
export const STATUS_ANNOUNCE_INTERVAL_MS = 5 * 60 * 1000;
/** Pause between two guilds, to stay well below Discord's rate limits on large fleets. */
export const STATUS_GUILD_DELAY_MS = 1000;

const errorLabel = (error: unknown): string => error instanceof Error ? error.name : 'Error';

export type StatusAnnouncerDependencies = {
  listTargets: () => Promise<StatusChannelTarget[]>;
  post: (client: Client, input: StatusMessageInput) => Promise<StatusAnnounceResult>;
  now: () => number;
  delay: (ms: number) => Promise<void>;
};

export type AnnounceSummary = {
  outcome: 'done' | 'failed' | 'skipped';
  posted: string[];
  failed: Array<{guildId: string; error: string}>;
};

const skipped = (): AnnounceSummary => ({outcome: 'skipped', posted: [], failed: []});

const sleep = async (ms: number): Promise<void> => new Promise<void>(resolve => {
  setTimeout(resolve, ms);
});

/**
 * Posts the "Bot started" message in every guild where this bot's own settings name a status channel
 * (chosen per server in the dashboard "Log" tab), after startup and after a full reconnect. Only managed
 * workers (MUSE_WORKER_ID) announce. Guilds are handled one at a time with a short pause; a failure in
 * one guild is logged and the next one is tried. It never throws and is never awaited by the ready
 * handlers, so Discord or the database being slow cannot delay readiness.
 */
export default class StatusAnnouncer {
  private lastAnnouncedAt?: number;
  private inFlight = false;
  private readonly dependencies: StatusAnnouncerDependencies;

  constructor(
    private readonly client: Client,
    private readonly config: Pick<Config, 'WORKER_ID'>,
    dependencies: Partial<StatusAnnouncerDependencies> = {},
  ) {
    this.dependencies = {
      listTargets: async () => listStatusChannelTargets(),
      post: async (target, input) => postStatusMessage(target, input),
      now: () => Date.now(),
      delay: sleep,
      ...dependencies,
    };
  }

  async announceOnline(): Promise<AnnounceSummary> {
    if (!this.config.WORKER_ID || this.inFlight) {
      return skipped();
    }

    if (this.lastAnnouncedAt !== undefined && this.dependencies.now() - this.lastAnnouncedAt < STATUS_ANNOUNCE_INTERVAL_MS) {
      return skipped();
    }

    this.inFlight = true;
    try {
      return await this.announce();
    } catch (error: unknown) {
      console.warn(`Status channel: online messages failed (${errorLabel(error)})`);
      return {outcome: 'failed', posted: [], failed: []};
    } finally {
      this.inFlight = false;
    }
  }

  private async announce(): Promise<AnnounceSummary> {
    let targets: StatusChannelTarget[];
    try {
      targets = await this.dependencies.listTargets();
    } catch (error: unknown) {
      // Not counted against the rate limit: the next full reconnect tries again.
      console.warn(`Status channel: could not read the status channel settings (${errorLabel(error)})`);
      return {outcome: 'failed', posted: [], failed: []};
    }

    // Rows of servers this bot has left stay in the database: only current guilds are announced.
    const current = targets.filter(target => this.client.guilds.cache.has(target.guildId));
    if (current.length === 0) {
      return skipped();
    }

    // Count every round, so a channel with missing permissions is not retried on each reconnect.
    this.lastAnnouncedAt = this.dependencies.now();
    const summary: AnnounceSummary = {outcome: 'done', posted: [], failed: []};
    for (const [index, target] of current.entries()) {
      if (index > 0) {
        // eslint-disable-next-line no-await-in-loop
        await this.dependencies.delay(STATUS_GUILD_DELAY_MS);
      }

      // eslint-disable-next-line no-await-in-loop
      const error = await this.postOne(target);
      if (error === undefined) {
        summary.posted.push(target.guildId);
      } else {
        summary.failed.push({guildId: target.guildId, error});
        console.warn(`Status channel: online message not posted in guild ${target.guildId} (${error})`);
      }
    }

    console.log(`Status channel: online message posted in ${summary.posted.length}/${current.length} guilds`);
    return summary;
  }

  /** Returns the error code, or undefined when the message was posted. Never throws. */
  private async postOne(target: StatusChannelTarget): Promise<string | undefined> {
    try {
      const result = await this.dependencies.post(this.client, {
        guildId: target.guildId,
        channelId: target.channelId,
        test: false,
        mentionRoleIds: target.mentionRoleIds,
        locale: normalizeLocale(target.locale),
      });
      return result.ok ? undefined : result.error;
    } catch (error: unknown) {
      return errorLabel(error);
    }
  }
}
