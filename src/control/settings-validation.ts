import type {Setting} from '@prisma/client';
import {type Except} from 'type-fest';
import {HttpError} from './http.js';
import {isSnowflake} from './snowflake.js';
import {SUPPORTED_LOCALES, isLocale} from '../i18n/index.js';

/** Upper bound on the roles pinged by the bot status message of a guild. */
export const MAX_STATUS_MENTION_ROLES = 10;

/**
 * Guild settings as exposed by the control API: the database row, except that the status
 * message roles (a comma-separated column) are a list of role ids.
 */
export type GuildSettingsView = Except<Setting, 'statusMentionRoleIds'> & {
  statusMentionRoleIds: string[];
};

export type GuildSettingsPatch = Partial<Pick<GuildSettingsView,
'playlistLimit'
| 'secondsToWaitAfterQueueEmpties'
| 'leaveIfNoListeners'
| 'queueAddResponseEphemeral'
| 'autoAnnounceNextSong'
| 'defaultVolume'
| 'defaultQueuePageSize'
| 'turnDownVolumeWhenPeopleSpeak'
| 'turnDownVolumeWhenPeopleSpeakTarget'
| 'locale'
| 'statusChannelId'
| 'statusMentionRoleIds'>>;

/** Patch in database form (`statusMentionRoleIds` as the comma-separated column). */
export type GuildSettingsData = Except<GuildSettingsPatch, 'statusMentionRoleIds'> & {
  statusMentionRoleIds?: string;
};

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

/** `null` (disabled) or a Discord channel id; `400 INVALID_STATUS_CHANNEL` otherwise. */
const parseStatusChannelId = (value: unknown): string | null => {
  if (value !== null && !isSnowflake(value)) {
    throw new HttpError(400, 'statusChannelId must be a Discord channel id or null', 'INVALID_STATUS_CHANNEL');
  }

  return value;
};

/** 0-10 Discord role ids, duplicates removed; `400 INVALID_STATUS_ROLES` otherwise. */
export const parseStatusMentionRoleIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every(id => isSnowflake(id))) {
    throw new HttpError(400, 'statusMentionRoleIds must be an array of Discord role ids', 'INVALID_STATUS_ROLES');
  }

  const unique = [...new Set(value as string[])];
  if (unique.length > MAX_STATUS_MENTION_ROLES) {
    throw new HttpError(400, `statusMentionRoleIds must contain at most ${MAX_STATUS_MENTION_ROLES} role ids`, 'INVALID_STATUS_ROLES');
  }

  return unique;
};

/* The status roles column is the only place where role ids are stored as text: these two helpers are the whole codec. */

/** Database column -> role ids. Malformed entries (never written by the API) are dropped. */
export const decodeStatusMentionRoleIds = (column: string | null | undefined): string[] => {
  if (typeof column !== 'string' || column === '') {
    return [];
  }

  return [...new Set(column.split(',').map(id => id.trim()).filter(id => isSnowflake(id)))].slice(0, MAX_STATUS_MENTION_ROLES);
};

/** Role ids -> database column ("" for none). */
export const encodeStatusMentionRoleIds = (roleIds: readonly string[]): string => roleIds.join(',');

/** Database row -> control API shape. */
export const toGuildSettingsView = (setting: Setting): GuildSettingsView => ({
  ...setting,
  statusMentionRoleIds: decodeStatusMentionRoleIds(setting.statusMentionRoleIds),
});

/** Validated patch -> Prisma update data. */
export const toGuildSettingsData = (patch: GuildSettingsPatch): GuildSettingsData => {
  const {statusMentionRoleIds, ...rest} = patch;
  return statusMentionRoleIds === undefined
    ? rest
    : {...rest, statusMentionRoleIds: encodeStatusMentionRoleIds(statusMentionRoleIds)};
};

/**
 * Shape validation of a settings patch (types, ranges, id formats). Whether the status channel and
 * roles belong to the guild is checked by the worker, which has the Discord client, before saving.
 */
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

    if (key === 'statusChannelId') {
      patch.statusChannelId = parseStatusChannelId(value);
      continue;
    }

    if (key === 'statusMentionRoleIds') {
      patch.statusMentionRoleIds = parseStatusMentionRoleIds(value);
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
