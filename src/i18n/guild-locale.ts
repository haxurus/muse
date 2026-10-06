import type {Setting} from '@prisma/client';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {DEFAULT_LOCALE, localeOf, type Locale} from './index.js';

/**
 * The guild's configured bot locale. A missing row is created with the default (`en`);
 * any lookup failure also falls back to English so a message is always sent.
 * Prefer `localeOf(settings)` where the settings row is already loaded.
 */
export const getGuildLocale = async (guildId: string | null | undefined): Promise<Locale> => {
  if (!guildId) {
    return DEFAULT_LOCALE;
  }

  try {
    const settings: Partial<Pick<Setting, 'locale'>> | null | undefined = await getGuildSettings(guildId);
    return localeOf(settings);
  } catch {
    return DEFAULT_LOCALE;
  }
};
