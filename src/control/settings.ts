export type GuildSettingsValues = {
  playlistLimit: number;
  secondsToWaitAfterQueueEmpties: number;
  leaveIfNoListeners: boolean;
  queueAddResponseEphemeral: boolean;
  autoAnnounceNextSong: boolean;
  defaultVolume: number;
  defaultQueuePageSize: number;
  turnDownVolumeWhenPeopleSpeak: boolean;
  turnDownVolumeWhenPeopleSpeakTarget: number;
  enableSponsorBlock: boolean;
};

export type GuildSettingsPatch = Partial<{
  [K in keyof GuildSettingsValues]: GuildSettingsValues[K] | null;
}>;

export const PLATFORM_DEFAULT_SETTINGS: GuildSettingsValues = {
  playlistLimit: 50,
  secondsToWaitAfterQueueEmpties: 30,
  leaveIfNoListeners: true,
  queueAddResponseEphemeral: false,
  autoAnnounceNextSong: false,
  defaultVolume: 100,
  defaultQueuePageSize: 10,
  turnDownVolumeWhenPeopleSpeak: false,
  turnDownVolumeWhenPeopleSpeakTarget: 20,
  enableSponsorBlock: false,
};

const NUMBER_RULES: Record<string, {min: number; max: number}> = {
  playlistLimit: {min: 1, max: 1000},
  secondsToWaitAfterQueueEmpties: {min: 0, max: 86_400},
  defaultVolume: {min: 0, max: 100},
  defaultQueuePageSize: {min: 1, max: 30},
  turnDownVolumeWhenPeopleSpeakTarget: {min: 0, max: 100},
};

const BOOLEAN_KEYS = new Set([
  'leaveIfNoListeners',
  'queueAddResponseEphemeral',
  'autoAnnounceNextSong',
  'turnDownVolumeWhenPeopleSpeak',
  'enableSponsorBlock',
]);

const SETTING_KEYS = new Set<keyof GuildSettingsValues>(
  Object.keys(PLATFORM_DEFAULT_SETTINGS) as Array<keyof GuildSettingsValues>,
);

export const normalizeSettingsPatch = (input: unknown): GuildSettingsPatch => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('settings patch must be an object');
  }

  const patch: GuildSettingsPatch = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!SETTING_KEYS.has(key as keyof GuildSettingsValues)) {
      throw new Error(`unsupported setting: ${key}`);
    }

    if (value === null) {
      (patch as Record<string, unknown>)[key] = null;
      continue;
    }

    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') {
        throw new Error(`${key} must be a boolean`);
      }

      (patch as Record<string, unknown>)[key] = value;
      continue;
    }

    const rule = NUMBER_RULES[key];
    if (!rule || typeof value !== 'number' || !Number.isInteger(value) || value < rule.min || value > rule.max) {
      throw new Error(`${key} must be an integer between ${rule?.min ?? 0} and ${rule?.max ?? 0}`);
    }

    (patch as Record<string, unknown>)[key] = value;
  }

  return patch;
};

export const parseStoredSettingsPatch = (value: string): GuildSettingsPatch => {
  if (value.trim() === '') {
    return {};
  }

  return normalizeSettingsPatch(JSON.parse(value) as unknown);
};

export const updateStoredSettingsPatch = (
  current: GuildSettingsPatch,
  patch: GuildSettingsPatch,
): GuildSettingsPatch => {
  const next: GuildSettingsPatch = {...current};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete (next as Record<string, unknown>)[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }

  return next;
};

export const resolveEffectiveSettings = (...patches: GuildSettingsPatch[]): GuildSettingsValues => {
  const result: GuildSettingsValues = {...PLATFORM_DEFAULT_SETTINGS};

  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== null && typeof value !== 'undefined') {
        (result as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  return result;
};
