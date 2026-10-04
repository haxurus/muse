import {describe, expect, it} from 'vitest';
import DiscordOAuthClient, {canManageGuild} from '../src/dashboard/discord-oauth.js';
import type {DashboardConfig} from '../src/dashboard/config.js';
import SessionStore from '../src/dashboard/session-store.js';

const config: DashboardConfig = {
  host: '127.0.0.1',
  port: 3000,
  publicUrl: new URL('https://music.example.test'),
  oauthRedirectUri: 'https://music.example.test/auth/discord/callback',
  discordClientId: '123456789012345678',
  discordClientSecret: 'not-a-real-secret',
  orchestratorUrl: 'http://orchestrator:3100',
  orchestratorToken: 'not-a-real-token',
  sessionTtlMs: 8 * 60 * 60 * 1000,
};

describe('Discord dashboard OAuth', () => {
  it('requests only identify and guilds with state and the exact redirect URI', () => {
    const client = new DiscordOAuthClient(config);
    const url = new URL(client.authorizationUrl('state-value'));

    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(config.discordClientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.oauthRedirectUri);
    expect(url.searchParams.get('scope')).toBe('identify guilds');
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('allows owners, administrators, and Manage Guild users only', () => {
    const guild = {
      id: '1',
      name: 'Guild',
      icon: null,
      owner: false,
      permissions: '0',
    };

    expect(canManageGuild({...guild, owner: true})).toBe(true);
    expect(canManageGuild({...guild, permissions: String(1 << 3)})).toBe(true);
    expect(canManageGuild({...guild, permissions: String(1 << 5)})).toBe(true);
    expect(canManageGuild({...guild, permissions: String(1 << 10)})).toBe(false);
  });

  it('consumes OAuth state exactly once', () => {
    const store = new SessionStore(config.sessionTtlMs);
    const state = store.issueOAuthState();

    expect(store.consumeOAuthState(state)).toBe(true);
    expect(store.consumeOAuthState(state)).toBe(false);
  });
});
