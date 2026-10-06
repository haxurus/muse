import {Setting} from '@prisma/client';
import {HttpError} from './http.js';
import {SUPPORTED_LOCALES, isLocale} from '../i18n/index.js';

export type GuildSettingsPatch = Partial<Pick<Setting,
'playlistLimit'
| 'secondsToWaitAfterQueueEmpties'
| 'leaveIfNoListeners'
| 'queueAddResponseEphemeral'
| 'autoAnnounceNextSong'
| 'defaultVolume'
| 'defaultQueuePageSize'
| 'turnDownVolumeWhenPeopleSpeak'
| 'turnDownVolumeWhenPeopleSpeakTarget'
| 'locale'>>;

const BOOLEAN_KEYS = new Set<keyof GuildSettingsPatch>([
  'leaveIfNoListeners',
  'queueAddResponseEphemeral',
  'autoAnnounceNextSong',
  'turnDownVolumeWhenPeopleSpeak',
]);

const NUMBER_RANGES: Partial<Record<keyof GuildSettingsPatch, readonly [number, number]>> = {
  playlistLimit: [1, 500],
  secondsToWaitAfterQueueEmpties: [0, 86_400],
  defaultVolume: [0, 100],
  defaultQueuePageSize: [1, 30],
  turnDownVolumeWhenPeopleSpeakTarget: [0, 100],
};

export const sanitizeGuildSettingsPatch = (input: unknown): GuildSettingsPatch => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'settings patch must be an object');
  }

  const patch: GuildSettingsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'locale') {
      // Exact, case-sensitive match: the bot only ships these dictionaries.
      if (!isLocale(value)) {
        throw new HttpError(400, `locale must be one of: ${SUPPORTED_LOCALES.join(', ')}`);
      }

      patch.locale = value;
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(NUMBER_RANGES, key) && !BOOLEAN_KEYS.has(key as keyof GuildSettingsPatch)) {
      throw new HttpError(400, `unsupported setting: ${key}`);
    }

    const typedKey = key as keyof GuildSettingsPatch;
    if (BOOLEAN_KEYS.has(typedKey)) {
      if (typeof value !== 'boolean') {
        throw new HttpError(400, `${key} must be a boolean`);
      }

      (patch as Record<string, unknown>)[key] = value;
      continue;
    }

    const range = NUMBER_RANGES[typedKey];
    if (!range || typeof value !== 'number' || !Number.isSafeInteger(value) || value < range[0] || value > range[1]) {
      throw new HttpError(400, `${key} must be an integer between ${range?.[0] ?? 0} and ${range?.[1] ?? 0}`);
    }

    (patch as Record<string, unknown>)[key] = value;
  }

  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'settings patch is empty');
  }

  return patch;
};
