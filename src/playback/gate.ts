import {HttpError} from '../control/http.js';
import type {PlaybackRequest, PlaybackResult} from './protocol.js';

type Entry = {fingerprint: string; promise: Promise<PlaybackResult>; expiresAt: number};

/** One active mutation per guild, with bounded in-process request deduplication. */
export default class PlaybackGate {
  private readonly busy = new Set<string>();
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxEntries = 512, private readonly ttlMs = 15 * 60_000) {}

  // Admission throws synchronously and duplicates retain the exact cached promise.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run(request: PlaybackRequest, operation: () => Promise<PlaybackResult>): Promise<PlaybackResult> {
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

    const guildEntries = [...this.entries.keys()].filter(id => id.startsWith(`${request.guildId}:`)).length;
    if (this.entries.size >= this.maxEntries || this.busy.size >= 8 || guildEntries >= 64) {
      throw new HttpError(429, 'Playback capacity reached. Try again later.');
    }

    this.busy.add(request.guildId);
    const entry: Entry = {
      fingerprint,
      expiresAt: Number.POSITIVE_INFINITY,
      promise: Promise.resolve().then(operation).finally(() => {
        this.busy.delete(request.guildId);
        entry.expiresAt = Date.now() + this.ttlMs;
      }),
    };
    this.entries.set(key, entry);
    return entry.promise;
  }
}
