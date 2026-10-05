import {HttpError} from '../control/http.js';
import {PLAYBACK_OUTCOME_UNKNOWN_MESSAGE, PLAYBACK_OUTCOME_UNKNOWN_STATUS, type PlaybackRequest, type PlaybackResult} from './protocol.js';

type Entry = {fingerprint: string; promise: Promise<PlaybackResult>; expiresAt: number; inFlight: boolean};

/** Must stay below the 180s transport timeout so the caller receives an explicit unknown-outcome error. */
export const PLAYBACK_OPERATION_DEADLINE_MS = 170_000;
const MAX_BUSY_GUILDS = 8;

/** One active mutation per guild, with bounded in-process request deduplication. */
export default class PlaybackGate {
  private readonly busy = new Set<string>();
  private readonly entries = new Map<string, Entry>();

  /**
   * @param maxEntries Upper bound on retained entries. Only in-flight entries count toward admission;
   * completed entries are evicted oldest-first when the bound is reached.
   * @param ttlMs How long a completed result is kept for duplicate interaction deliveries.
   * @param deadlineMs Hard deadline after which the guild slot is released even if the operation is still running.
   */
  constructor(
    private readonly maxEntries = 512,
    private readonly ttlMs = 60_000,
    private readonly deadlineMs = PLAYBACK_OPERATION_DEADLINE_MS,
  ) {}

  // Admission throws synchronously and duplicates retain the exact cached promise.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run(request: PlaybackRequest, operation: () => Promise<PlaybackResult>): Promise<PlaybackResult> {
    // Read-only requests are neither deduplicated nor serialized behind player mutations.
    if (request.action === 'queue') {
      return Promise.resolve().then(operation);
    }

    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }

    const key = `${request.guildId}:${request.requestId}`;
    const fingerprint = JSON.stringify(request);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new HttpError(409, 'Request identifier already used with a different payload.');
      }

      return existing.promise;
    }

    if (this.busy.has(request.guildId)) {
      throw new HttpError(409, 'Another playback command is still running in this server.');
    }

    this.evictCompleted();
    const inFlight = [...this.entries.values()].filter(entry => entry.inFlight).length;
    if (inFlight >= this.maxEntries || this.busy.size >= MAX_BUSY_GUILDS) {
      throw new HttpError(429, 'Playback capacity reached. Try again later.');
    }

    this.busy.add(request.guildId);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // The underlying operation may still complete; only the admission slot is released here.
        console.warn('Orchestrated playback exceeded its deadline; releasing the guild slot', {
          guildId: request.guildId,
          requestId: request.requestId,
          action: request.action,
        });
        reject(new HttpError(PLAYBACK_OUTCOME_UNKNOWN_STATUS, PLAYBACK_OUTCOME_UNKNOWN_MESSAGE));
      }, this.deadlineMs);
    });
    const entry: Entry = {
      fingerprint,
      expiresAt: Number.POSITIVE_INFINITY,
      inFlight: true,
      promise: Promise.race([Promise.resolve().then(operation), deadline]).finally(() => {
        clearTimeout(timer);
        this.busy.delete(request.guildId);
        entry.inFlight = false;
        entry.expiresAt = Date.now() + this.ttlMs;
      }),
    };
    this.entries.set(key, entry);
    return entry.promise;
  }

  private evictCompleted(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size < this.maxEntries) {
        return;
      }

      if (!entry.inFlight) {
        this.entries.delete(key);
      }
    }
  }
}
