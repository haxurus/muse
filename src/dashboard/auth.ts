import {IncomingMessage, ServerResponse} from 'node:http';
import {HttpError} from '../control/http.js';
import type {DashboardConfig} from './config.js';
import DiscordOAuthClient, {DiscordGuild, canManageGuild} from './discord-oauth.js';
import {parseCookies, redirect, safeEqual} from './http.js';
import SessionStore, {DashboardSession} from './session-store.js';

const STATE_COOKIE = 'muse_oauth_state';
const SESSION_COOKIE = 'muse_session';
const GUILD_CACHE_MS = 60 * 1000;

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

export default class DashboardAuth {
  private readonly store: SessionStore;
  private readonly discord: DiscordOAuthClient;
  private readonly secureCookies: boolean;

  constructor(private readonly config: DashboardConfig) {
    this.store = new SessionStore(config.sessionTtlMs);
    this.discord = new DiscordOAuthClient(config);
    this.secureCookies = config.publicUrl.protocol === 'https:';
  }

  begin(response: ServerResponse): void {
    const state = this.store.issueOAuthState();
    redirect(response, this.discord.authorizationUrl(state), [
      cookie(STATE_COOKIE, state, 600, this.secureCookies, '/auth/discord/callback'),
    ]);
  }

  async callback(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.config.publicUrl);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const cookies = parseCookies(request);
    const storedState = cookies[STATE_COOKIE];

    if (!code || !returnedState || !storedState
      || !safeEqual(returnedState, storedState)
      || !this.store.consumeOAuthState(returnedState)) {
      throw new HttpError(400, 'invalid OAuth state');
    }

    const token = await this.discord.exchangeCode(code);
    const user = await this.discord.currentUser(token.access_token);
    const session = this.store.createSession(user, token.access_token, token.expires_in);

    redirect(response, this.config.publicUrl.toString(), [
      clearCookie(STATE_COOKIE, this.secureCookies, '/auth/discord/callback'),
      cookie(
        SESSION_COOKIE,
        session.id,
        Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
        this.secureCookies,
        '/',
      ),
    ]);
  }

  requireSession(request: IncomingMessage): DashboardSession {
    const session = this.store.get(parseCookies(request)[SESSION_COOKIE]);
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

    const guilds = await this.discord.currentUserGuilds(session.accessToken);
    session.guildCache = {
      fetchedAt: now,
      guilds,
    };
    return guilds.filter(canManageGuild);
  }

  assertCsrf(request: IncomingMessage, session: DashboardSession): void {
    const origin = request.headers.origin;
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
    const session = this.store.get(cookies[SESSION_COOKIE]);

    if (session) {
      this.assertCsrf(request, session);
      this.store.delete(session.id);
      try {
        await this.discord.revoke(session.accessToken);
      } catch {
        // Session is already deleted locally. Remote revocation failure is non-fatal.
      }
    }

    redirect(response, this.config.publicUrl.toString(), [
      clearCookie(SESSION_COOKIE, this.secureCookies, '/'),
    ]);
  }
}
