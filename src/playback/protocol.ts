import {HttpError} from '../control/http.js';

export const PLAYBACK_ACTIONS = ['play', 'pause', 'resume', 'skip', 'stop', 'disconnect', 'queue', 'volume'] as const;
export type PlaybackAction = typeof PLAYBACK_ACTIONS[number];
export type PlaybackRequest = {
  requestId: string;
  guildId: string;
  userId: string;
  voiceChannelId: string;
  textChannelId: string;
  action: PlaybackAction;
  query?: string;
  volume?: number;
  amount?: number;
  page?: number;
  pageSize?: number;
  immediate?: boolean;
  shuffle?: boolean;
  split?: boolean;
  skip?: boolean;
};
export type PlaybackResult = {
  workerId: 'muse-01';
  requestId: string;
  guildId: string;
  channelId: string | null;
  state: 'FREE' | 'PLAYING' | 'PAUSED' | 'IDLE';
  message: string;
};

export const isBotOnePlaybackEnabled = (workerId: string): boolean =>
  process.env.MUSE_BOT_ONE_PLAYBACK === 'true' && workerId === 'muse-01';

export const parsePlaybackRequest = (input: unknown): PlaybackRequest => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Invalid playback request.');
  }

  const body = input as Record<string, unknown>;
  const identityKeys = ['requestId', 'guildId', 'userId', 'voiceChannelId', 'textChannelId'];
  const commonKeys = [...identityKeys, 'action'];
  if (!PLAYBACK_ACTIONS.includes(body.action as PlaybackAction)) {
    throw new HttpError(400, 'Unsupported playback action.');
  }

  const action = body.action as PlaybackAction;
  const allowed = new Set([...commonKeys, ...(action === 'play' ? ['query', 'immediate', 'shuffle', 'split', 'skip'] : []), ...(action === 'volume' ? ['volume'] : []), ...(action === 'skip' ? ['amount'] : []), ...(action === 'queue' ? ['page', 'pageSize'] : [])]);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    throw new HttpError(400, 'Unexpected playback field.');
  }

  for (const key of identityKeys) {
    if (typeof body[key] !== 'string' || !/^[1-9]\d{9,21}$/u.test(body[key] as string)) {
      throw new HttpError(400, 'Invalid Discord identifier.');
    }
  }

  const result: PlaybackRequest = {
    requestId: body.requestId as string,
    guildId: body.guildId as string,
    userId: body.userId as string,
    voiceChannelId: body.voiceChannelId as string,
    textChannelId: body.textChannelId as string,
    action,
  };
  if (action === 'play') {
    if (typeof body.query !== 'string' || body.query.trim().length === 0 || body.query.length > 2000) {
      throw new HttpError(400, 'Query must contain 1-2000 characters.');
    }

    result.query = body.query.trim();
    for (const key of ['immediate', 'shuffle', 'split', 'skip'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') {
        throw new HttpError(400, 'Playback options must be booleans.');
      }

      result[key] = body[key] === true;
    }
  }

  if (action === 'volume' && body.volume !== undefined) {
    if (typeof body.volume !== 'number' || !Number.isInteger(body.volume) || body.volume < 0 || body.volume > 100) {
      throw new HttpError(400, 'Volume must be an integer between 0 and 100.');
    }

    result.volume = body.volume;
  }

  for (const key of ['amount', 'page', 'pageSize'] as const) {
    const value = body[key];
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > (key === 'pageSize' ? 30 : 10_000)) {
        throw new HttpError(400, 'Invalid skip count or queue page.');
      }

      result[key] = value;
    }
  }

  return result;
};
