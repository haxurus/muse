/** Requests per window for one session (or one client address when anonymous), on `/api/*` and `/auth/*`. */
export const DASHBOARD_RATE_LIMIT = 120;
export const DASHBOARD_RATE_WINDOW_MS = 60 * 1000;
/** Upper bound on tracked keys; the oldest window is forgotten first when the map is full. */
export const DASHBOARD_RATE_MAX_KEYS = 10_000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  maxKeys: number;
};

export type RateLimitDecision = {
  allowed: true;
} | {
  allowed: false;
  retryAfterSeconds: number;
};

type Window = {
  startedAt: number;
  count: number;
};

/**
 * In-memory fixed-window limiter. A key gets `limit` requests per window that starts at its
 * first request; the window then resets. The map is bounded: expired windows are pruned
 * periodically and, when it is still full, the oldest window is evicted.
 */
export default class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: RateLimitOptions = {
      limit: DASHBOARD_RATE_LIMIT,
      windowMs: DASHBOARD_RATE_WINDOW_MS,
      maxKeys: DASHBOARD_RATE_MAX_KEYS,
    },
    private readonly now: () => number = Date.now,
  ) {
    this.cleanupTimer = setInterval(() => {
      this.prune(this.now());
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  get size(): number {
    return this.windows.size;
  }

  close(): void {
    clearInterval(this.cleanupTimer);
  }

  consume(key: string): RateLimitDecision {
    const {limit, windowMs, maxKeys} = this.options;
    const now = this.now();
    const current = this.windows.get(key);

    if (current && now - current.startedAt < windowMs) {
      if (current.count >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + windowMs - now) / 1000)),
        };
      }

      current.count += 1;
      return {allowed: true};
    }

    if (!current && this.windows.size >= maxKeys) {
      this.prune(now);
      for (const oldestKey of this.windows.keys()) {
        if (this.windows.size < maxKeys) {
          break;
        }

        this.windows.delete(oldestKey);
      }
    }

    // Delete first so the key moves to the end of the insertion order (the eviction order).
    this.windows.delete(key);
    this.windows.set(key, {startedAt: now, count: 1});
    return {allowed: true};
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.options.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}
