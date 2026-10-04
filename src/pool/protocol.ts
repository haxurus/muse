import {HttpError} from '../control/http.js';

export const COMMAND_TTL_MS = 180_000;
export const isDiscordId = (value: unknown): value is string => typeof value === 'string' && /^\d{10,32}$/u.test(value);
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(value);
export const ACTIONS = ['join', 'play', 'pause', 'resume', 'skip', 'stop', 'disconnect', 'queue', 'volume', 'players'] as const;
export type PoolAction = typeof ACTIONS[number];
export type PoolCommand = {
  id: string;
  guildId: string;
  userId: string;
  textChannelId: string;
  voiceChannelId: string;
  categoryId: string | null;
  action: PoolAction;
  query?: string;
  volume?: number;
};
export type PlaybackEnvelope = {
  command: PoolCommand;
  instanceId: string;
  leaseId: string;
  deadline: number;
};
export type PlaybackState = {
  workerId: string;
  guildId: string;
  instanceId: string;
  present: boolean;
  ready: boolean;
  connected: boolean;
  busy: boolean;
  channelId: string | null;
  leaseId: string | null;
  status: 'PLAYING' | 'PAUSED' | 'IDLE';
};
export type PlaybackReply = {
  requestId: string;
  guildId: string;
  workerId: string;
  text: string;
};

export const objectBody = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Oggetto JSON non valido.');
  }

  return input as Record<string, unknown>;
};

export const parsePoolCommand = (input: unknown): PoolCommand => {
  const body = objectBody(input);
  const keys = new Set(['id', 'guildId', 'userId', 'textChannelId', 'voiceChannelId', 'categoryId', 'action', 'query', 'volume']);
  if (Object.keys(body).some(key => !keys.has(key))) {
    throw new HttpError(400, 'Campo non consentito nel comando.');
  }

  for (const key of ['id', 'guildId', 'userId', 'textChannelId', 'voiceChannelId']) {
    if (!isDiscordId(body[key])) {
      throw new HttpError(400, 'Identificativo Discord non valido.');
    }
  }

  if (body.categoryId !== null && !isDiscordId(body.categoryId)) {
    throw new HttpError(400, 'Categoria non valida.');
  }

  if (!ACTIONS.some(action => action === body.action)) {
    throw new HttpError(400, 'Comando non supportato.');
  }

  if (body.action === 'play') {
    if (typeof body.query !== 'string' || body.query.trim().length < 1 || body.query.length > 500) {
      throw new HttpError(400, 'La ricerca deve contenere da 1 a 500 caratteri.');
    }
  } else if (body.query !== undefined) {
    throw new HttpError(400, 'Ricerca non prevista per questo comando.');
  }

  if (body.action === 'volume') {
    if (typeof body.volume !== 'number' || !Number.isInteger(body.volume) || body.volume < 0 || body.volume > 100) {
      throw new HttpError(400, 'Il volume deve essere compreso tra 0 e 100.');
    }
  } else if (body.volume !== undefined) {
    throw new HttpError(400, 'Volume non previsto per questo comando.');
  }

  return {
    id: body.id as string,
    guildId: body.guildId as string,
    userId: body.userId as string,
    textChannelId: body.textChannelId as string,
    voiceChannelId: body.voiceChannelId as string,
    categoryId: body.categoryId as string | null,
    action: body.action as PoolAction,
    ...(body.query === undefined ? {} : {query: (body.query as string).trim()}),
    ...(body.volume === undefined ? {} : {volume: body.volume as number}),
  };
};

export const parseEnvelope = (input: unknown): PlaybackEnvelope => {
  const body = objectBody(input);
  if (Object.keys(body).some(key => !['command', 'instanceId', 'leaseId', 'deadline'].includes(key))
    || !isUuid(body.instanceId) || !isUuid(body.leaseId)
    || typeof body.deadline !== 'number' || !Number.isSafeInteger(body.deadline)
    || body.deadline > Date.now() + COMMAND_TTL_MS + 5000) {
    throw new HttpError(400, 'Prenotazione non valida.');
  }

  return {command: parsePoolCommand(body.command), instanceId: body.instanceId, leaseId: body.leaseId, deadline: body.deadline};
};
