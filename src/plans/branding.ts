import {HttpError} from '../control/http.js';

/**
 * Brand plan (Sentinel model): each bot's own nickname and server banner in one guild,
 * set with `PATCH /guilds/:guildId/members/@me` and reset when the plan no longer includes it.
 */

/** Discord's nickname limit. */
export const MAX_NICKNAME_LENGTH = 32;

/** The dashboard re-encodes banners as 600×240 JPEG under this size (Sentinel: 60 000). */
export const MAX_BANNER_CHARS = 60_000;

/** A banner request is the only large JSON body of the guild routes. */
export const MAX_BRANDING_BODY_BYTES = 96 * 1024;

const BANNER_URI = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z\d+/]+={0,2}$/u;

/** `undefined` leaves a field unchanged, `null` restores Discord's default. */
export type BrandingProfile = {
  nick?: string | null;
  banner?: string | null;
};

/** What the orchestrator remembers for one bot in one guild (never the image itself). */
export type BotBranding = {
  nickname: string | null;
  bannerSet: boolean;
};

const isPrintableNickname = (value: string): boolean =>
  value.length >= 1
  && value.length <= MAX_NICKNAME_LENGTH
  && [...value].every(character => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });

export const isBannerUri = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_BANNER_CHARS && BANNER_URI.test(value);

/** Validates `{nick?, banner?}` (at least one field); throws `400 INVALID_BRANDING`. */
export const sanitizeBrandingProfile = (input: unknown): BrandingProfile => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'branding body must be an object', 'INVALID_BRANDING');
  }

  const body = input as Record<string, unknown>;
  const profile: BrandingProfile = {};
  if (body.nick !== undefined) {
    if (body.nick === null) {
      profile.nick = null;
    } else if (typeof body.nick === 'string' && isPrintableNickname(body.nick.trim())) {
      profile.nick = body.nick.trim();
    } else {
      throw new HttpError(400, `nick must be 1-${MAX_NICKNAME_LENGTH} printable characters or null`, 'INVALID_BRANDING');
    }
  }

  if (body.banner !== undefined) {
    if (body.banner !== null && !isBannerUri(body.banner)) {
      throw new HttpError(400, 'banner must be a PNG, JPEG, WebP or GIF data URI or null', 'INVALID_BRANDING');
    }

    profile.banner = body.banner;
  }

  if (profile.nick === undefined && profile.banner === undefined) {
    throw new HttpError(400, 'set nick, banner or both', 'INVALID_BRANDING');
  }

  return profile;
};

export const isValidBotBranding = (value: unknown): value is BotBranding => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const {nickname, bannerSet} = value as Record<string, unknown>;
  return (nickname === null || (typeof nickname === 'string' && isPrintableNickname(nickname)))
    && typeof bannerSet === 'boolean';
};
