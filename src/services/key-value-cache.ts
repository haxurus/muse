import {injectable} from 'inversify';
import {prisma} from '../utils/db.js';
import debug from '../utils/debug.js';

type Seconds = number;

type Options = {
  expiresIn: Seconds;
  key?: string;
};

const futureTimeToDate = (time: Seconds) => new Date(new Date().getTime() + (time * 1000));

// Expired rows are otherwise only replaced when the same key is requested again.
export const EXPIRED_ROW_PURGE_INTERVAL_MS = 60 * 60 * 1000;

@injectable()
export default class KeyValueCacheProvider {
  private lastPurgeAt = 0;
  private isPurging = false;

  async purgeExpired(): Promise<number> {
    const {count} = await prisma.keyValueCache.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });

    return count;
  }

  async wrap<T extends [...any[], Options], F>(func: (...options: any) => Promise<F>, ...options: T): Promise<F> {
    if (options.length === 0) {
      throw new Error('Missing cache options');
    }

    const functionArgs = options.slice(0, options.length - 1);

    const {
      key = JSON.stringify(functionArgs),
      expiresIn,
    } = options[options.length - 1] as Options;

    if (key.length < 4) {
      throw new Error(`Cache key ${key} is too short.`);
    }

    const cachedResult = await prisma.keyValueCache.findUnique({
      where: {
        key,
      },
    });

    if (cachedResult) {
      if (new Date() < cachedResult.expiresAt) {
        debug(`Cache hit: ${key}`);
        return JSON.parse(cachedResult.value) as F;
      }

      // Keep the expired row until upsert replaces it. Concurrent readers may
      // have observed the same row, so deleting it here races their refreshes.
    }

    debug(`Cache miss: ${key}`);

    const result = await func(...options as any[]);

    // Save result
    const value = JSON.stringify(result);
    const expiresAt = futureTimeToDate(expiresIn);
    await prisma.keyValueCache.upsert({
      where: {
        key,
      },
      update: {
        value,
        expiresAt,
      },
      create: {
        key,
        value,
        expiresAt,
      },
    });

    this.purgeExpiredInBackground();

    return result;
  }

  private purgeExpiredInBackground(): void {
    const now = Date.now();
    if (this.isPurging || now - this.lastPurgeAt < EXPIRED_ROW_PURGE_INTERVAL_MS) {
      return;
    }

    this.lastPurgeAt = now;
    this.isPurging = true;
    void this.purgeExpired()
      .then(count => {
        debug(`Purged ${count} expired cache entries`);
      })
      .catch((error: unknown) => {
        debug(`Failed to purge expired cache entries: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.isPurging = false;
      });
  }
}
