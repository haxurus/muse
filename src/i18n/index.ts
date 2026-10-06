import {EN_MESSAGES, type MessageDictionary, type MessageKey} from './en.js';
import {IT_MESSAGES} from './it.js';

export type {MessageDictionary, MessageKey};

/** Locales the bot can answer in. English is the default and the fallback for every key. */
export const SUPPORTED_LOCALES = ['en', 'it'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
export const DEFAULT_LOCALE: Locale = 'en';

export type MessageVars = Record<string, string | number>;

const DICTIONARIES: Record<Locale, Partial<MessageDictionary>> = {
  en: EN_MESSAGES,
  it: IT_MESSAGES,
};

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);

/** Unknown, missing or malformed values fall back to English. */
export const normalizeLocale = (value: unknown): Locale => isLocale(value) ? value : DEFAULT_LOCALE;

/** Locale of an already-loaded settings row (or a partial test double). */
export const localeOf = (settings: {locale?: string | null} | null | undefined): Locale => normalizeLocale(settings?.locale);

/** Maps a Discord locale such as `it` or `en-US` to a supported bot locale. */
export const localeFromDiscord = (discordLocale: string | null | undefined): Locale =>
  typeof discordLocale === 'string' && discordLocale.toLowerCase().startsWith('it') ? 'it' : DEFAULT_LOCALE;

const interpolate = (template: string, vars?: MessageVars): string => {
  if (!vars) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
};

/** Translates `key` into `locale`, falling back to English for unknown locales or missing keys. */
export const t = (locale: string | null | undefined, key: MessageKey, vars?: MessageVars): string => {
  const template = DICTIONARIES[normalizeLocale(locale)][key] ?? EN_MESSAGES[key];
  return interpolate(template, vars);
};

const ENGLISH_MESSAGE_KEYS = new Map<string, MessageKey>();
for (const [key, value] of Object.entries(EN_MESSAGES) as Array<[MessageKey, string]>) {
  if (!value.includes('{') && !ENGLISH_MESSAGE_KEYS.has(value)) {
    ENGLISH_MESSAGE_KEYS.set(value, key);
  }
}

/**
 * Translates a fixed English message (for example a plain `Error` thrown by the player or a
 * status message from the playback relay) when it matches a dictionary entry; anything else
 * is returned unchanged.
 */
export const localizeEnglishMessage = (locale: string | null | undefined, message: string): string => {
  const key = ENGLISH_MESSAGE_KEYS.get(message);
  return key === undefined ? message : t(locale, key);
};

/**
 * An intentional, user-facing error. Its `message` stays English so logs and existing checks on
 * `error.message` keep working; `localize()` renders it in the guild's locale.
 */
export class UserError extends Error {
  constructor(public readonly key: MessageKey, public readonly vars?: MessageVars) {
    super(t(DEFAULT_LOCALE, key, vars));
    this.name = 'UserError';
  }

  localize(locale: string | null | undefined): string {
    return t(locale, this.key, this.vars);
  }
}

/** Renders any error for a user in `locale`. */
export const localizeError = (locale: string | null | undefined, error: unknown): string => {
  if (error instanceof UserError) {
    return error.localize(locale);
  }

  return error instanceof Error ? localizeEnglishMessage(locale, error.message) : String(error);
};
