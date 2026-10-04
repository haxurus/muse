import {describe, expect, it} from 'vitest';
import {HttpError} from '../src/control/http.js';
import {sanitizeGuildSettingsPatch} from '../src/control/settings-validation.js';

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
