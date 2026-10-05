import {HttpError} from './http.js';

/** Discord snowflakes are positive 64-bit integers; current IDs have 17-20 decimal digits. */
const SNOWFLAKE_PATTERN = /^[1-9]\d{9,21}$/u;

export const isSnowflake = (value: unknown): value is string =>
  typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);

export const assertGuildId = (guildId: string): void => {
  if (!isSnowflake(guildId)) {
    throw new HttpError(400, 'invalid Discord guild id');
  }
};
