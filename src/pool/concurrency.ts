import {HttpError} from '../control/http.js';

// Locks and replay records are bounded. Failed jobs never poison a later lock.
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly counts = new Map<string, number>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const count = this.counts.get(key) ?? 0;
    if (count >= 16 || (count === 0 && this.tails.size >= 256)) {
      throw new HttpError(429, 'Troppe richieste in attesa.');
    }

    this.counts.set(key, count + 1);
    const result = (this.tails.get(key) ?? Promise.resolve()).then(work);
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(key, settled);
    try {
      return await result;
    } finally {
      const remaining = (this.counts.get(key) ?? 1) - 1;
      if (remaining === 0) {
        this.counts.delete(key);
      } else {
        this.counts.set(key, remaining);
      }

      if (this.tails.get(key) === settled) {
        this.tails.delete(key);
      }
    }
  }
}

type ReplayEntry<T> = {fingerprint: string; promise: Promise<T>; expiresAt: number};

export class ReplayGuard<T> {
  private readonly records = new Map<string, ReplayEntry<T>>();

  run(key: string, fingerprint: string, work: () => Promise<T>): Promise<T> {
    for (const [id, record] of this.records) {
      if (record.expiresAt <= Date.now()) {
        this.records.delete(id);
      }
    }

    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new HttpError(409, 'Identificativo richiesta gia utilizzato.'));
      }

      return existing.promise;
    }

    if (this.records.size >= 4096) {
      return Promise.reject(new HttpError(429, 'Limite richieste raggiunto. Riprova piu tardi.'));
    }

    const entry: ReplayEntry<T> = {fingerprint, expiresAt: Infinity, promise: Promise.resolve().then(work)};
    entry.promise = entry.promise.then(value => {
      entry.expiresAt = Date.now() + 15 * 60_000;
      return value;
    }, (error: unknown) => {
      entry.expiresAt = Date.now() + 15 * 60_000;
      throw error;
    });
    this.records.set(key, entry);
    return entry.promise;
  }
}
