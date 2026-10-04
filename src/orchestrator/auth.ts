import {IncomingMessage, ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import got from 'got';
import OrchestratorConfig from './config.js';

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

export type SessionGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
};

export type DashboardSession = {
  id: string;
  csrfToken: string;
  expiresAt: number;
  user: {
    id: string;
    username: string;
    displayName: string;
    avatar: string | null;
  };
  guilds: SessionGuild[];
};

const sessions = new Map<string, DashboardSession>();
const oauthStates = new Map<string, number>();

const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const cleanExpired = () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
    }
  }

  for (const [state, createdAt] of oauthStates) {
    if (createdAt + OAUTH_STATE_TTL_MS <= now) {
      oauthStates.delete(state);
    }
  }
};

const parseCookies = (request: IncomingMessage) => Object.fromEntries(
  (request.headers.cookie ?? '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const separator = part.indexOf('=');
      if (separator === -1) {
        return [part, ''];
      }

      return [
        decodeURIComponent(part.slice(0, separator)),
        decodeURIComponent(part.slice(separator + 1)),
      ];
    }),
);

const canManageGuild = (guild: SessionGuild) => {
  if (guild.owner) {
    return true;
  }

  try {
    const permissions = BigInt(guild.permissions);
    return (permissions & MANAGE_GUILD) === MANAGE_GUILD
      || (permissions & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
};

const redirect = (response: ServerResponse, location: string) => {
  response.writeHead(302, {
    location,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end();
};

const sessionCookie = (config: OrchestratorConfig, sessionId: string, maxAgeSeconds: number) => {
  const secure = new URL(config.PUBLIC_BASE_URL).protocol === 'https:' ? '; Secure' : '';
  return `muse_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
};

export const getSession = (request: IncomingMessage): DashboardSession | null => {
  cleanExpired();
  const sessionId = parseCookies(request).muse_session;
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
};

export const requireGuildAccess = (session: DashboardSession, guildId: string) => {
  const guild = session.guilds.find(candidate => candidate.id === guildId);
  if (!guild || !canManageGuild(guild)) {
    throw new Error('forbidden');
  }

  return guild;
};

export const requireCsrf = (request: IncomingMessage, session: DashboardSession) => {
  const token = request.headers['x-csrf-token'];
  if (typeof token !== 'string' || token !== session.csrfToken) {
    throw new Error('invalid csrf token');
  }
};

export const beginDiscordLogin = (response: ServerResponse, config: OrchestratorConfig) => {
  cleanExpired();
  const state = randomBytes(32).toString('hex');
  oauthStates.set(state, Date.now());

  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.searchParams.set('client_id', config.DISCORD_CLIENT_ID);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', `${config.PUBLIC_BASE_URL}/auth/callback`);
  authorize.searchParams.set('scope', 'identify guilds');
  authorize.searchParams.set('state', state);

  redirect(response, authorize.toString());
};

export const completeDiscordLogin = async (
  response: ServerResponse,
  config: OrchestratorConfig,
  requestUrl: URL,
) => {
  cleanExpired();
  const state = requestUrl.searchParams.get('state');
  const code = requestUrl.searchParams.get('code');
  const stateCreatedAt = state ? oauthStates.get(state) : undefined;

  if (!state || !code || !stateCreatedAt || stateCreatedAt + OAUTH_STATE_TTL_MS <= Date.now()) {
    response.writeHead(400, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
    response.end('Invalid or expired OAuth request.');
    return;
  }

  oauthStates.delete(state);

  const token = await got.post('https://discord.com/api/v10/oauth2/token', {
    form: {
      client_id: config.DISCORD_CLIENT_ID,
      client_secret: config.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.PUBLIC_BASE_URL}/auth/callback`,
    },
    timeout: {request: 10_000},
    retry: {limit: 0},
  }).json<{access_token: string; token_type: string}>();

  const authorization = `${token.token_type} ${token.access_token}`;
  const [user, guilds] = await Promise.all([
    got('https://discord.com/api/v10/users/@me', {
      headers: {authorization},
      timeout: {request: 10_000},
      retry: {limit: 0},
    }).json<DiscordUser>(),
    got('https://discord.com/api/v10/users/@me/guilds', {
      headers: {authorization},
      timeout: {request: 10_000},
      retry: {limit: 0},
    }).json<SessionGuild[]>(),
  ]);

  const sessionId = randomBytes(32).toString('hex');
  const session: DashboardSession = {
    id: sessionId,
    csrfToken: randomBytes(32).toString('hex'),
    expiresAt: Date.now() + config.SESSION_TTL_MS,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.global_name?.trim() || user.username,
      avatar: user.avatar ?? null,
    },
    guilds: guilds.filter(canManageGuild),
  };

  sessions.set(sessionId, session);
  response.setHeader('set-cookie', sessionCookie(config, sessionId, Math.floor(config.SESSION_TTL_MS / 1000)));
  redirect(response, '/');
};

export const logout = (request: IncomingMessage, response: ServerResponse, config: OrchestratorConfig) => {
  const sessionId = parseCookies(request).muse_session;
  if (sessionId) {
    sessions.delete(sessionId);
  }

  response.setHeader('set-cookie', sessionCookie(config, '', 0));
  redirect(response, '/');
};
