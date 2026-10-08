import {describe, expect, it} from 'vitest';
import {HttpError} from '../src/control/http.js';
import {
  decodeStatusMentionRoleIds,
  encodeStatusMentionRoleIds,
  sanitizeGuildSettingsPatch,
  toGuildSettingsData,
  toGuildSettingsView,
} from '../src/control/settings-validation.js';

describe('control-plane guild settings validation', () => {
  it('accepts a safe multi-setting patch', () => {
    expect(sanitizeGuildSettingsPatch({
      defaultVolume: 65,
      playlistLimit: 80,
      leaveIfNoListeners: false,
    })).toEqual({
      defaultVolume: 65,
      playlistLimit: 80,
      leaveIfNoListeners: false,
    });
  });

  it('rejects unknown settings', () => {
    expect(() => sanitizeGuildSettingsPatch({discordToken: 'secret'}))
      .toThrowError(HttpError);
  });

  it.each([
    {defaultVolume: 101},
    {playlistLimit: 0},
    {secondsToWaitAfterQueueEmpties: -1},
    {defaultQueuePageSize: 31},
    {turnDownVolumeWhenPeopleSpeak: 'yes'},
  ])('rejects invalid values: %o', patch => {
    expect(() => sanitizeGuildSettingsPatch(patch)).toThrowError(HttpError);
  });
});

describe('status channel settings shape', () => {
  const channelId = '666666666666666666';
  const roleA = '777777777777777771';
  const roleB = '777777777777777772';
  const tooMany = Array.from({length: 11}, (_, index) => `7777777777777777${String(index).padStart(2, '0')}`);

  const codeOf = (patch: unknown): string | undefined => {
    try {
      sanitizeGuildSettingsPatch(patch);
    } catch (error: unknown) {
      return error instanceof HttpError ? error.code : 'not-http';
    }

    return undefined;
  };

  it('accepts a channel id or null, and 0-10 role ids with duplicates removed', () => {
    expect(sanitizeGuildSettingsPatch({statusChannelId: channelId, statusMentionRoleIds: [roleA, roleB, roleA]}))
      .toEqual({statusChannelId: channelId, statusMentionRoleIds: [roleA, roleB]});
    expect(sanitizeGuildSettingsPatch({statusChannelId: null, statusMentionRoleIds: []}))
      .toEqual({statusChannelId: null, statusMentionRoleIds: []});
    expect(sanitizeGuildSettingsPatch({statusMentionRoleIds: tooMany.slice(0, 10)}).statusMentionRoleIds).toHaveLength(10);
  });

  it.each([
    [{statusChannelId: '1234'}, 'INVALID_STATUS_CHANNEL'],
    [{statusChannelId: 666_666_666_666_666}, 'INVALID_STATUS_CHANNEL'],
    [{statusChannelId: ''}, 'INVALID_STATUS_CHANNEL'],
    [{statusChannelId: '<#666666666666666666>'}, 'INVALID_STATUS_CHANNEL'],
    [{statusMentionRoleIds: roleA}, 'INVALID_STATUS_ROLES'],
    [{statusMentionRoleIds: ['@everyone']}, 'INVALID_STATUS_ROLES'],
    [{statusMentionRoleIds: [Number(roleA)]}, 'INVALID_STATUS_ROLES'],
    [{statusMentionRoleIds: null}, 'INVALID_STATUS_ROLES'],
    [{statusMentionRoleIds: tooMany}, 'INVALID_STATUS_ROLES'],
  ])('rejects %o with %s', (patch, code) => {
    expect(codeOf(patch)).toBe(code);
  });

  it('keeps the CSV column conversion in one place', () => {
    expect(encodeStatusMentionRoleIds([])).toBe('');
    expect(encodeStatusMentionRoleIds([roleA, roleB])).toBe(`${roleA},${roleB}`);
    expect(decodeStatusMentionRoleIds('')).toEqual([]);
    expect(decodeStatusMentionRoleIds(null)).toEqual([]);
    expect(decodeStatusMentionRoleIds(`${roleA},${roleB}`)).toEqual([roleA, roleB]);
    // Hand-edited rows: malformed entries and duplicates are dropped.
    expect(decodeStatusMentionRoleIds(` ${roleA},nope,,${roleA},${roleB}`)).toEqual([roleA, roleB]);

    expect(toGuildSettingsData({statusChannelId: channelId, statusMentionRoleIds: [roleA, roleB], defaultVolume: 40}))
      .toEqual({statusChannelId: channelId, statusMentionRoleIds: `${roleA},${roleB}`, defaultVolume: 40});
    expect(toGuildSettingsData({statusChannelId: null})).toEqual({statusChannelId: null});

    const row = {guildId: '111111111111111111', locale: 'it', statusChannelId: channelId, statusMentionRoleIds: `${roleA},${roleB}`};
    expect(toGuildSettingsView(row as never)).toEqual({...row, statusMentionRoleIds: [roleA, roleB]});
    expect(toGuildSettingsView({...row, statusChannelId: null, statusMentionRoleIds: ''} as never))
      .toMatchObject({statusChannelId: null, statusMentionRoleIds: []});
  });
});
