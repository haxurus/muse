import {HttpError} from './http.js';
import {isSnowflake} from './snowflake.js';
import {t, type Locale} from '../i18n/index.js';

/** Upper bound per list; mirrored by the orchestrator block store. */
export const MAX_BLOCKLIST_ENTRIES = 5000;

/** Large enough for two full lists of maximum-length snowflakes plus JSON overhead. */
export const MAX_BLOCKLIST_BODY_BYTES = 512 * 1024;

export type Blocklist = {
  guildIds: string[];
  userIds: string[];
};

const sanitizeIds = (value: unknown, field: keyof Blocklist): string[] => {
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an array of Discord ids`, 'INVALID_BLOCKLIST');
  }

  if (value.length > MAX_BLOCKLIST_ENTRIES) {
    throw new HttpError(400, `${field} must contain at most ${MAX_BLOCKLIST_ENTRIES} ids`, 'INVALID_BLOCKLIST');
  }

  if (!value.every(id => isSnowflake(id))) {
    throw new HttpError(400, `${field} must contain only Discord ids`, 'INVALID_BLOCKLIST');
  }

  return [...new Set(value as string[])];
};

export const sanitizeBlocklist = (input: unknown): Blocklist => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'blocklist body must be an object', 'INVALID_BLOCKLIST');
  }

  const body = input as Record<string, unknown>;
  return {
    guildIds: sanitizeIds(body.guildIds, 'guildIds'),
    userIds: sanitizeIds(body.userIds, 'userIds'),
  };
};

let blockedGuilds = new Set<string>();
let blockedUsers = new Set<string>();

/**
 * Process-wide blocklist pushed by the orchestrator. It starts empty on every worker start
 * and is re-pushed by the orchestrator's reconcile loop.
 */
export const blocklist = {
  get(): Blocklist {
    return {guildIds: [...blockedGuilds], userIds: [...blockedUsers]};
  },

  set(next: Blocklist): void {
    blockedGuilds = new Set(next.guildIds);
    blockedUsers = new Set(next.userIds);
  },

  isGuildBlocked(guildId: string): boolean {
    return blockedGuilds.has(guildId);
  },

  isUserBlocked(userId: string): boolean {
    return blockedUsers.has(userId);
  },
};

/** English refusal; use `blockedUserMessage(locale)` to answer in the guild's language. */
export const BLOCKED_USER_MESSAGE = t('en', 'blockedUser');

export const blockedUserMessage = (locale: Locale): string => t(locale, 'blockedUser');
