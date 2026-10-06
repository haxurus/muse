import {HttpError} from './http.js';
import {isSnowflake} from './snowflake.js';

/** Upper bound on the roles pinged by the bot status message. */
export const MAX_MENTION_ROLES = 10;

/** 0-10 Discord role ids, duplicates removed; anything else is `400 INVALID_ROLE_IDS`. */
export const parseMentionRoleIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every(id => isSnowflake(id))) {
    throw new HttpError(400, 'mentionRoleIds must be an array of Discord role ids', 'INVALID_ROLE_IDS');
  }

  const unique = [...new Set(value as string[])];
  if (unique.length > MAX_MENTION_ROLES) {
    throw new HttpError(400, `mentionRoleIds must contain at most ${MAX_MENTION_ROLES} role ids`, 'INVALID_ROLE_IDS');
  }

  return unique;
};
