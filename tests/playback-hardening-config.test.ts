import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const loadConfig = async (environment: Record<string, string>) => {
  vi.stubEnv('DISCORD_TOKEN', 'test-discord-token');
  vi.stubEnv('YOUTUBE_API_KEY', 'test-youtube-key');
  vi.stubEnv('DATA_DIR', '/tmp/muse-config-test');
  for (const [key, value] of Object.entries(environment)) {
    vi.stubEnv(key, value);
  }

  const {default: Config} = await import('../src/services/config.js');
  return Config;
};

const worker = {
  MUSE_WORKER_ID: 'muse-01',
  MUSE_CONTROL_PORT: '3101',
  MUSE_CONTROL_TOKEN: 'c'.repeat(32),
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('secret source conflicts (MEDIUM-4)', () => {
  it('refuses to start when a secret is set both directly and through _FILE', async () => {
    const Config = await loadConfig({DISCORD_TOKEN_FILE: '/run/secrets/discord_token'});
    expect(() => new Config()).toThrow(/DISCORD_TOKEN \/ DISCORD_TOKEN_FILE/);
    expect(() => new Config()).not.toThrow(/test-discord-token/);
  });

  it('still accepts a single direct secret', async () => {
    const Config = await loadConfig({});
    expect(new Config().DISCORD_TOKEN).toBe('test-discord-token');
  });
});

describe('managed worker control token and orchestrator URL (LOW-5)', () => {
  it('requires a control token of at least 32 characters', async () => {
    const Config = await loadConfig({...worker, MUSE_CONTROL_TOKEN: 'too-short-control-token'});
    expect(() => new Config()).toThrow(/MUSE_CONTROL_TOKEN must be at least 32 characters/);
  });

  it('accepts a strong control token and the default orchestrator URL', async () => {
    const Config = await loadConfig(worker);
    expect(new Config().CONTROL_TOKEN).toBe('c'.repeat(32));
  });

  it('rejects a non-http orchestrator URL at startup', async () => {
    const Config = await loadConfig({...worker, MUSE_ORCHESTRATOR_URL: 'file:///etc/passwd'});
    expect(() => new Config()).toThrow(/MUSE_ORCHESTRATOR_URL/);
  });
});
