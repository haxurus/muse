import {randomBytes} from 'node:crypto';
import type {DiscordGuild, DiscordUser} from './discord-oauth.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 1000;

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

export default class SessionStore {
  private readonly pendingStates = new Map<string, number>();
  private readonly sessions = new Map<string, DashboardSession>();

  constructor(private readonly sessionTtlMs: number) {}

  issueOAuthState(): string {
    this.cleanup();

    if (this.pendingStates.size >= MAX_PENDING_STATES) {
      throw new Error('too many pending OAuth requests');
    }

    const state = randomBytes(32).toString('hex');
    this.pendingStates.set(state, Date.now() + STATE_TTL_MS);
    return state;
  }

  consumeOAuthState(state: string): boolean {
    this.cleanup();

    const expiresAt = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  createSession(user: DiscordUser, accessToken: string, oauthExpiresInSeconds: number): DashboardSession {
    this.cleanup();

    const id = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const oauthTtlMs = Math.max(0, oauthExpiresInSeconds) * 1000;
    const expiresAt = Date.now() + Math.min(this.sessionTtlMs, oauthTtlMs);

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

  private cleanup(): void {
    const now = Date.now();

    for (const [state, expiresAt] of this.pendingStates.entries()) {
      if (expiresAt <= now) {
        this.pendingStates.delete(state);
      }
    }

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
