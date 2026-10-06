import {HttpError} from '../control/http.js';
import {isSnowflake} from '../control/snowflake.js';
import {EN_MESSAGES} from '../i18n/en.js';

export const PLAYBACK_ACTIONS = ['play', 'pause', 'resume', 'skip', 'stop', 'disconnect', 'queue', 'volume'] as const;
export const PLAYBACK_WORKER_IDS = ['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05'] as const;
export type PlaybackAction = typeof PLAYBACK_ACTIONS[number];
export type PlaybackWorkerId = typeof PLAYBACK_WORKER_IDS[number];
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
  workerId: PlaybackWorkerId;
  requestId: string;
  guildId: string;
  channelId: string | null;
  state: 'FREE' | 'PLAYING' | 'PAUSED' | 'IDLE';
  message: string;
};

const PLAYBACK_FLAG_BY_WORKER: Record<PlaybackWorkerId, string> = {
  'muse-01': 'MUSE_BOT_ONE_PLAYBACK',
  'muse-02': 'MUSE_BOT_TWO_PLAYBACK',
  'muse-03': 'MUSE_BOT_THREE_PLAYBACK',
  'muse-04': 'MUSE_BOT_FOUR_PLAYBACK',
  'muse-05': 'MUSE_BOT_FIVE_PLAYBACK',
};

export const isPlaybackWorkerId = (workerId: string): workerId is PlaybackWorkerId =>
  PLAYBACK_WORKER_IDS.some(candidate => candidate === workerId);

export const isPlaybackWorkerEnabled = (workerId: string): workerId is PlaybackWorkerId =>
  isPlaybackWorkerId(workerId) && process.env[PLAYBACK_FLAG_BY_WORKER[workerId]] === 'true';

/** Shared by every hop so an unknown outcome is never mistaken for a retryable "not ready" error. */
export const PLAYBACK_OUTCOME_UNKNOWN_STATUS = 504;
/** English on the wire; the command-receiving bot translates it for the guild. */
export const PLAYBACK_OUTCOME_UNKNOWN_MESSAGE: string = EN_MESSAGES.playbackOutcomeUnknown;

const DEFAULT_ORCHESTRATOR_URL = 'http://orchestrator:3100';

/** Resolve a private orchestrator endpoint (`route` starts with '/') from MUSE_ORCHESTRATOR_URL (http/https origin with an optional path). */
export const resolveOrchestratorUrl = (route: string, value: string | undefined = process.env.MUSE_ORCHESTRATOR_URL): string => {
  const configured = value?.trim();
  let url: URL;
  try {
    url = new URL(configured ? configured : DEFAULT_ORCHESTRATOR_URL);
  } catch {
    throw new Error('MUSE_ORCHESTRATOR_URL must be a valid http(s) URL');
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('MUSE_ORCHESTRATOR_URL must be an http(s) URL without credentials, query or fragment');
  }

  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}${route}`;
};

/** Resolve the private playback endpoint from MUSE_ORCHESTRATOR_URL. */
export const resolveOrchestratorPlaybackUrl = (value: string | undefined = process.env.MUSE_ORCHESTRATOR_URL): string =>
  resolveOrchestratorUrl('/v1/playback', value);

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
    if (!isSnowflake(body[key])) {
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
