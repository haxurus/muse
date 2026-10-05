import {createHmac, randomBytes} from 'node:crypto';
import type {DiscordGuild, DiscordUser} from './discord-oauth.js';
import {safeEqual} from './http.js';

export const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_USED_STATES = 10_000;
const MAX_SESSIONS = 5000;
const MAX_SESSIONS_PER_USER = 5;
const CLEANUP_INTERVAL_MS = 60 * 1000;

export type DashboardSession = {
  id: string;
  csrfToken: string;
  user: DiscordUser;
  accessToken: string;
  expiresAt: number;
  guildCache?: {
    fetchedAt: number;
    guilds: DiscordGuild[];
  };
  mutationWindowStartedAt?: number;
  mutationCount?: number;
};

export type SessionStoreOptions = {
  maxSessions?: number;
  maxSessionsPerUser?: number;
};

export default class SessionStore {
  // OAuth state is stateless (HMAC-signed with expiry); only consumed nonces are
  // remembered, in a bounded map that evicts the oldest entries instead of failing.
  private readonly usedStates = new Map<string, number>();
  private readonly sessions = new Map<string, DashboardSession>();
  private readonly stateKey = randomBytes(32);
  private readonly maxSessions: number;
  private readonly maxSessionsPerUser: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly sessionTtlMs: number, options: SessionStoreOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? MAX_SESSIONS);
    this.maxSessionsPerUser = Math.max(1, options.maxSessionsPerUser ?? MAX_SESSIONS_PER_USER);
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  close(): void {
    clearInterval(this.cleanupTimer);
  }

  issueOAuthState(): string {
    const expiresAt = Date.now() + STATE_TTL_MS;
    const payload = `${expiresAt.toString(36)}.${randomBytes(24).toString('hex')}`;
    return `${payload}.${this.sign(payload)}`;
  }

  consumeOAuthState(state: string): boolean {
    const parts = state.split('.');
    if (parts.length !== 3) {
      return false;
    }

    const [expiresPart, nonce, signature] = parts;
    if (!safeEqual(signature, this.sign(`${expiresPart}.${nonce}`))) {
      return false;
    }

    const now = Date.now();
    const expiresAt = Number.parseInt(expiresPart, 36);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + STATE_TTL_MS) {
      return false;
    }

    this.pruneUsedStates(now);
    if (this.usedStates.has(nonce)) {
      return false;
    }

    this.usedStates.set(nonce, expiresAt);
    for (const usedNonce of this.usedStates.keys()) {
      if (this.usedStates.size <= MAX_USED_STATES) {
        break;
      }

      this.usedStates.delete(usedNonce);
    }

    return true;
  }

  createSession(user: DiscordUser, accessToken: string, oauthExpiresInSeconds: number): DashboardSession {
    this.cleanup();

    const id = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const oauthTtlMs = Math.max(0, oauthExpiresInSeconds) * 1000;
    const expiresAt = Date.now() + Math.min(this.sessionTtlMs, oauthTtlMs);

    // Sessions are kept in insertion order, so the first entries are the oldest.
    const userSessions = [...this.sessions.values()].filter(candidate => candidate.user.id === user.id);
    const excessForUser = userSessions.length - this.maxSessionsPerUser + 1;
    for (const stale of userSessions.slice(0, Math.max(0, excessForUser))) {
      this.sessions.delete(stale.id);
    }

    for (const sessionId of this.sessions.keys()) {
      if (this.sessions.size < this.maxSessions) {
        break;
      }

      this.sessions.delete(sessionId);
    }

    const session: DashboardSession = {
      id,
      csrfToken,
      user,
      accessToken,
      expiresAt,
    };

    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string | undefined): DashboardSession | undefined {
    if (!sessionId) {
      return undefined;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    return session;
  }

  delete(sessionId: string): DashboardSession | undefined {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return session;
  }

  consumeMutationBudget(session: DashboardSession, limit = 30, windowMs = 60_000): boolean {
    const now = Date.now();
    if (!session.mutationWindowStartedAt || now - session.mutationWindowStartedAt >= windowMs) {
      session.mutationWindowStartedAt = now;
      session.mutationCount = 1;
      return true;
    }

    const count = session.mutationCount ?? 0;
    if (count >= limit) {
      return false;
    }

    session.mutationCount = count + 1;
    return true;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.stateKey).update(payload).digest('hex');
  }

  private pruneUsedStates(now: number): void {
    for (const [nonce, expiresAt] of this.usedStates.entries()) {
      if (expiresAt <= now) {
        this.usedStates.delete(nonce);
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    this.pruneUsedStates(now);

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
