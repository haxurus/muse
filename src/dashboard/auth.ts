import {IncomingMessage, ServerResponse} from 'node:http';
import {HttpError} from '../control/http.js';
import type {DashboardConfig} from './config.js';
import DiscordOAuthClient, {
  DiscordGuild,
  DiscordOAuthToken,
  DiscordUser,
  canManageGuild,
  hasRequiredScopes,
} from './discord-oauth.js';
import {DashboardHttpError, describeUpstreamError, parseCookies, redirect, safeEqual} from './http.js';
import SessionStore, {DashboardSession} from './session-store.js';

const STATE_COOKIE_PATH = '/auth/discord/callback';
const GUILD_CACHE_MS = 60 * 1000;
const MAX_RETRY_AFTER_SECONDS = 3600;

export type DashboardCookieNames = {
  session: string;
  state: string;
};

/**
 * In https mode the session cookie uses the `__Host-` prefix (Secure, Path=/, no Domain)
 * and the state cookie the `__Secure-` prefix (it is scoped to the callback path).
 * Plain names are kept for local http development.
 */
export const dashboardCookieNames = (secure: boolean): DashboardCookieNames => secure
  ? {session: '__Host-muse_session', state: '__Secure-muse_oauth_state'}
  : {session: 'muse_session', state: 'muse_oauth_state'};

const cookie = (
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
  path: string,
): string => [
  `${name}=${value}`,
  `Path=${path}`,
  `Max-Age=${maxAgeSeconds}`,
  'HttpOnly',
  'SameSite=Lax',
  secure ? 'Secure' : '',
].filter(Boolean).join('; ');

const clearCookie = (name: string, secure: boolean, path: string): string =>
  cookie(name, '', 0, secure, path);

const retryAfterSeconds = (headers: Record<string, string | string[] | undefined>, body: unknown): number | undefined => {
  const header = headers['retry-after'];
  const raw = Array.isArray(header) ? header[0] : header;
  let seconds = Number.parseFloat(raw ?? '');

  if (!Number.isFinite(seconds) && typeof body === 'string') {
    try {
      const value = (JSON.parse(body) as {retry_after?: unknown} | null)?.retry_after;
      seconds = typeof value === 'number' ? value : Number.NaN;
    } catch {
      seconds = Number.NaN;
    }
  }

  if (!Number.isFinite(seconds)) {
    return undefined;
  }

  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
};

export type DashboardAuthDependencies = {
  store?: SessionStore;
  discord?: DiscordOAuthClient;
};

export default class DashboardAuth {
  private readonly store: SessionStore;
  private readonly discord: DiscordOAuthClient;
  private readonly secureCookies: boolean;
  private readonly cookieNames: DashboardCookieNames;
  private readonly loginFailedUrl: string;

  constructor(private readonly config: DashboardConfig, dependencies: DashboardAuthDependencies = {}) {
    this.store = dependencies.store ?? new SessionStore(config.sessionTtlMs);
    this.discord = dependencies.discord ?? new DiscordOAuthClient(config);
    this.secureCookies = config.publicUrl.protocol === 'https:';
    this.cookieNames = dashboardCookieNames(this.secureCookies);
    this.loginFailedUrl = new URL('/?login=failed', config.publicUrl).toString();
  }

  close(): void {
    this.store.close();
  }

  begin(response: ServerResponse): void {
    const state = this.store.issueOAuthState();
    redirect(response, this.discord.authorizationUrl(state), [
      cookie(this.cookieNames.state, state, 600, this.secureCookies, STATE_COOKIE_PATH),
    ]);
  }

  async callback(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.config.publicUrl);
    const cookies = parseCookies(request);
    const clearState = clearCookie(this.cookieNames.state, this.secureCookies, STATE_COOKIE_PATH);

    const fail = (reason: string): void => {
      console.warn(`Dashboard login failed: ${reason}`);
      redirect(response, this.loginFailedUrl, [clearState]);
    };

    if (url.searchParams.has('error')) {
      fail('authorization denied or cancelled');
      return;
    }

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const storedState = cookies[this.cookieNames.state];

    if (!code || !returnedState || !storedState
      || !safeEqual(returnedState, storedState)
      || !this.store.consumeOAuthState(returnedState)) {
      fail('invalid OAuth state');
      return;
    }

    const login = await this.exchange(code);
    if (typeof login === 'string') {
      fail(login);
      return;
    }

    const previousSessionId = cookies[this.cookieNames.session];
    if (previousSessionId) {
      this.store.delete(previousSessionId);
    }

    const session = this.store.createSession(login.user, login.token.access_token, login.token.expires_in);

    redirect(response, this.config.publicUrl.toString(), [
      clearState,
      cookie(
        this.cookieNames.session,
        session.id,
        Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
        this.secureCookies,
        '/',
      ),
    ]);
  }

  requireSession(request: IncomingMessage): DashboardSession {
    const session = this.store.get(parseCookies(request)[this.cookieNames.session]);
    if (!session) {
      throw new HttpError(401, 'authentication required');
    }

    return session;
  }

  async manageableGuilds(session: DashboardSession, forceRefresh = false): Promise<DiscordGuild[]> {
    const now = Date.now();
    if (!forceRefresh
      && session.guildCache
      && now - session.guildCache.fetchedAt < GUILD_CACHE_MS) {
      return session.guildCache.guilds.filter(canManageGuild);
    }

    const guilds = await this.discord.currentUserGuilds(session.accessToken).catch((error: unknown) => {
      throw this.discordFailure(session, error);
    });

    session.guildCache = {
      fetchedAt: now,
      guilds,
    };
    return guilds.filter(canManageGuild);
  }

  assertMutationAllowed(session: DashboardSession): void {
    if (!this.store.consumeMutationBudget(session)) {
      throw new HttpError(429, 'too many configuration changes');
    }
  }

  assertCsrf(request: IncomingMessage, session: DashboardSession): void {
    const {origin} = request.headers;
    if (origin !== this.config.publicUrl.origin) {
      throw new HttpError(403, 'invalid request origin');
    }

    const supplied = request.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || !safeEqual(supplied, session.csrfToken)) {
      throw new HttpError(403, 'invalid CSRF token');
    }
  }

  async logout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cookies = parseCookies(request);
    const session = this.store.get(cookies[this.cookieNames.session]);

    if (session) {
      this.assertCsrf(request, session);
      this.store.delete(session.id);
      await this.revokeQuietly(session.accessToken);
    }

    redirect(response, this.config.publicUrl.toString(), [
      clearCookie(this.cookieNames.session, this.secureCookies, '/'),
    ]);
  }

  /**
   * Exchanges the authorization code and loads the user. Returns a log-safe failure
   * reason (never containing tokens) instead of throwing.
   */
  private async exchange(code: string): Promise<{token: DiscordOAuthToken; user: DiscordUser} | string> {
    try {
      const token = await this.discord.exchangeCode(code);
      if (!hasRequiredScopes(token.scope)) {
        await this.revokeQuietly(token.access_token);
        return 'Discord token is missing the identify/guilds scopes';
      }

      const user = await this.discord.currentUser(token.access_token);
      return {token, user};
    } catch (error: unknown) {
      const failure = describeUpstreamError(error);
      const status = failure.statusCode === undefined ? 'none' : String(failure.statusCode);
      return `Discord token exchange failed (name=${failure.name} status=${status})`;
    }
  }

  private async revokeQuietly(accessToken: string): Promise<void> {
    try {
      await this.discord.revoke(accessToken);
    } catch {
      // Remote revocation failure is non-fatal; the token is no longer stored locally.
    }
  }

  private discordFailure(session: DashboardSession, error: unknown): HttpError {
    const failure = describeUpstreamError(error);

    if (failure.statusCode === 401) {
      this.store.delete(session.id);
      return new HttpError(401, 'authentication required');
    }

    if (failure.statusCode === 429) {
      return new DashboardHttpError(429, 'Discord rate limit reached, retry shortly', {
        retryAfterSeconds: retryAfterSeconds(failure.headers, failure.body),
      });
    }

    return new DashboardHttpError(502, 'Discord is unavailable', {
      causeName: failure.name,
      causeStatus: failure.statusCode,
    });
  }
}
