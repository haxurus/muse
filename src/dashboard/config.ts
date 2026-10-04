import {readFileSync} from 'node:fs';

const readRequiredSecret = (path: string | undefined, label: string): string => {
  if (!path?.startsWith('/run/secrets/')) {
    throw new Error(`${label} must be provided through a file under /run/secrets`);
  }

  const value = readFileSync(path, 'utf8').trim();
  if (!value) {
    throw new Error(`${label} is empty`);
  }

  return value;
};

const readPort = (value: string | undefined, fallback: number, label: string): number => {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${label} must be a valid TCP port`);
  }

  return parsed;
};

const validateInternalUrl = (value: string, label: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an internal http URL`);
  }

  if (!/^[a-z0-9][a-z0-9-]*$/u.test(url.hostname)) {
    throw new Error(`${label} hostname must be a Docker service name`);
  }

  if (url.pathname !== '/') {
    throw new Error(`${label} must not contain a path`);
  }

  return value.replace(/\/$/u, '');
};

export type DashboardConfig = {
  host: string;
  port: number;
  publicUrl: URL;
  oauthRedirectUri: string;
  discordClientId: string;
  discordClientSecret: string;
  orchestratorUrl: string;
  orchestratorToken: string;
  sessionTtlMs: number;
};

export const loadDashboardConfig = (): DashboardConfig => {
  const publicUrl = new URL(process.env.MUSE_DASHBOARD_PUBLIC_URL ?? 'http://localhost:3000');
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
    throw new Error('MUSE_DASHBOARD_PUBLIC_URL must be an origin without path, query or credentials');
  }

  if (process.env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:') {
    throw new Error('MUSE_DASHBOARD_PUBLIC_URL must use https in production');
  }

  const clientId = process.env.MUSE_DASHBOARD_DISCORD_CLIENT_ID?.trim() ?? '';
  if (!/^\d{10,32}$/u.test(clientId)) {
    throw new Error('MUSE_DASHBOARD_DISCORD_CLIENT_ID must be a Discord application ID');
  }

  const ttlHours = Number.parseInt(process.env.MUSE_DASHBOARD_SESSION_HOURS ?? '8', 10);
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 24) {
    throw new Error('MUSE_DASHBOARD_SESSION_HOURS must be between 1 and 24');
  }

  return {
    host: process.env.MUSE_DASHBOARD_HOST ?? '0.0.0.0',
    port: readPort(process.env.MUSE_DASHBOARD_PORT, 3000, 'MUSE_DASHBOARD_PORT'),
    publicUrl,
    oauthRedirectUri: new URL('/auth/discord/callback', publicUrl).toString(),
    discordClientId: clientId,
    discordClientSecret: readRequiredSecret(
      process.env.MUSE_DASHBOARD_DISCORD_CLIENT_SECRET_FILE,
      'Discord OAuth client secret',
    ),
    orchestratorUrl: validateInternalUrl(
      process.env.MUSE_DASHBOARD_ORCHESTRATOR_URL ?? 'http://orchestrator:3100',
      'MUSE_DASHBOARD_ORCHESTRATOR_URL',
    ),
    orchestratorToken: readRequiredSecret(
      process.env.MUSE_ORCHESTRATOR_TOKEN_FILE,
      'Orchestrator token',
    ),
    sessionTtlMs: ttlHours * 60 * 60 * 1000,
  };
};
