import got from 'got';
import type {DashboardConfig} from './config.js';

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
const DISCORD_REVOKE = 'https://discord.com/api/oauth2/token/revoke';

export type DiscordOAuthToken = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
};

export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

export type DiscordGuild = {
  id: string;
  name: string;
  icon?: string | null;
  owner: boolean;
  permissions: string;
};

const requestOptions = (accessToken: string) => ({
  headers: {
    authorization: `Bearer ${accessToken}`,
  },
  retry: {
    limit: 0,
  },
  timeout: {
    request: 5000,
  },
});

export const ADMINISTRATOR = 1n << 3n;
export const MANAGE_GUILD = 1n << 5n;

export const canManageGuild = (guild: DiscordGuild): boolean => {
  if (guild.owner) {
    return true;
  }

  const permissions = BigInt(guild.permissions);
  return (permissions & ADMINISTRATOR) === ADMINISTRATOR
    || (permissions & MANAGE_GUILD) === MANAGE_GUILD;
};

export default class DiscordOAuthClient {
  constructor(private readonly config: DashboardConfig) {}

  authorizationUrl(state: string): string {
    const url = new URL(DISCORD_AUTHORIZE);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.discordClientId);
    url.searchParams.set('redirect_uri', this.config.oauthRedirectUri);
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<DiscordOAuthToken> {
    return got.post(DISCORD_TOKEN, {
      form: {
        client_id: this.config.discordClientId,
        client_secret: this.config.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.oauthRedirectUri,
      },
      retry: {limit: 0},
      timeout: {request: 5000},
    }).json<DiscordOAuthToken>();
  }

  async currentUser(accessToken: string): Promise<DiscordUser> {
    return got.get(
      `${DISCORD_API}/users/@me`,
      requestOptions(accessToken),
    ).json<DiscordUser>();
  }

  async currentUserGuilds(accessToken: string): Promise<DiscordGuild[]> {
    return got.get(
      `${DISCORD_API}/users/@me/guilds?limit=200`,
      requestOptions(accessToken),
    ).json<DiscordGuild[]>();
  }

  async revoke(accessToken: string): Promise<void> {
    await got.post(DISCORD_REVOKE, {
      form: {
        client_id: this.config.discordClientId,
        client_secret: this.config.discordClientSecret,
        token: accessToken,
        token_type_hint: 'access_token',
      },
      retry: {limit: 0},
      timeout: {request: 5000},
    });
  }
}
