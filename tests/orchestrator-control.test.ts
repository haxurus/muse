import {describe, expect, it} from 'vitest';
import {
  normalizeSettingsPatch,
  resolveEffectiveSettings,
  updateStoredSettingsPatch,
} from '../src/control/settings.js';
import {signControlRequest, verifyControlRequest} from '../src/control/signature.js';

describe('orchestrator settings inheritance', () => {
  it('resolves server, group and worker settings from least to most specific', () => {
    const effective = resolveEffectiveSettings(
      {defaultVolume: 80, playlistLimit: 60},
      {defaultVolume: 65},
      {defaultVolume: 45},
    );

    expect(effective.defaultVolume).toBe(45);
    expect(effective.playlistLimit).toBe(60);
    expect(effective.leaveIfNoListeners).toBe(true);
  });

  it('removes inherited overrides when a null patch is applied', () => {
    const stored = updateStoredSettingsPatch(
      {defaultVolume: 45, enableSponsorBlock: true},
      {defaultVolume: null},
    );

    expect(stored).toEqual({enableSponsorBlock: true});
  });

  it('rejects unsupported or out-of-range settings', () => {
    expect(() => normalizeSettingsPatch({defaultVolume: 101})).toThrow();
    expect(() => normalizeSettingsPatch({unknownSetting: true})).toThrow();
  });
});

describe('worker RPC signatures', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('accepts an intact signed request', () => {
    const now = 1_000_000;
    const signed = signControlRequest(secret, 'PUT', '/v1/guilds/123/settings', '{"ok":true}', now);

    expect(verifyControlRequest({
      secret,
      method: 'PUT',
      requestPath: '/v1/guilds/123/settings',
      body: '{"ok":true}',
      timestampHeader: signed.timestamp,
      signatureHeader: signed.signature,
      now,
    })).toBe(true);
  });

  it('rejects body tampering and stale requests', () => {
    const now = 1_000_000;
    const signed = signControlRequest(secret, 'POST', '/v1/guilds/123/disconnect', '{}', now);

    expect(verifyControlRequest({
      secret,
      method: 'POST',
      requestPath: '/v1/guilds/123/disconnect',
      body: '{"tampered":true}',
      timestampHeader: signed.timestamp,
      signatureHeader: signed.signature,
      now,
    })).toBe(false);

    expect(verifyControlRequest({
      secret,
      method: 'POST',
      requestPath: '/v1/guilds/123/disconnect',
      body: '{}',
      timestampHeader: signed.timestamp,
      signatureHeader: signed.signature,
      now: now + 31_000,
    })).toBe(false);
  });
});
