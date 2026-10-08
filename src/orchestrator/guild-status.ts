import {type Except} from 'type-fest';
import {HttpError} from '../control/http.js';
import {isSnowflake} from '../control/snowflake.js';
import {
  isStatusAnnounceError,
  type GuildMetaChannel,
  type GuildMetaRole,
  type StatusTestResult,
} from '../control/types.js';
import {isPlainObject} from './durable-file.js';

/** Outcome of one worker call, as produced by the orchestrator's `wrap`. */
export type WorkerCallResult<T> = {workerId: string; ok: true; value: T} | {workerId: string; ok: false; error: string; code?: string};

/** A picker channel with the workers (bots) that can post there. */
export type MergedGuildChannel = Except<GuildMetaChannel, 'canPost'> & {postableBy: string[]};

/** `GET /v1/guilds/:guildId/meta` on the orchestrator. */
export type MergedGuildMeta = {
  guildId: string;
  /** Workers present in the guild that were asked, in configuration order. */
  workerIds: string[];
  /** The worker whose view of the channels and roles is returned. */
  sourceWorkerId: string;
  channels: MergedGuildChannel[];
  roles: GuildMetaRole[];
  /** Present workers that did not answer (their `postableBy` entries are unknown, so missing). */
  failed: Array<{workerId: string; error: string}>;
};

const MAX_NAME_LENGTH = 100;

const isName = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_NAME_LENGTH;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/* Worker answers are validated, not trusted: malformed entries are dropped. */

const parseChannel = (value: unknown): GuildMetaChannel | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const {id, name, type, parentName, position, canPost} = value;
  if (!isSnowflake(id)
    || !isName(name)
    || (type !== 'text' && type !== 'announcement')
    || (parentName !== null && !isName(parentName))
    || !isFiniteNumber(position)
    || typeof canPost !== 'boolean') {
    return undefined;
  }

  return {id, name, type, parentName, position, canPost};
};

const parseRole = (value: unknown): GuildMetaRole | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const {id, name, color, mentionable, position} = value;
  if (!isSnowflake(id)
    || !isName(name)
    || !isFiniteNumber(color)
    || typeof mentionable !== 'boolean'
    || !isFiniteNumber(position)) {
    return undefined;
  }

  return {id, name, color, mentionable, position};
};

const parseList = <T>(value: unknown, parse: (entry: unknown) => T | undefined): T[] | undefined =>
  Array.isArray(value) ? value.flatMap(entry => {
    const parsed = parse(entry);
    return parsed === undefined ? [] : [parsed];
  }) : undefined;

const parseMeta = (value: unknown): {channels: GuildMetaChannel[]; roles: GuildMetaRole[]} | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const channels = parseList(value.channels, parseChannel);
  const roles = parseList(value.roles, parseRole);
  return channels && roles ? {channels, roles} : undefined;
};

/**
 * Merges the meta answers of the workers present in a guild (configuration order): channels and roles
 * come from the first ready worker that answered; every channel lists the workers that reported they
 * can post there. `503 META_UNAVAILABLE` when no worker answered.
 */
export const mergeGuildMeta = (
  guildId: string,
  answers: Array<{ready: boolean; result: WorkerCallResult<unknown>}>,
): MergedGuildMeta => {
  const parsed = answers.map(({ready, result}) => ({
    ready,
    workerId: result.workerId,
    meta: result.ok ? parseMeta(result.value) : undefined,
    error: result.ok ? 'InvalidResponse' : result.error,
  }));

  const usable = parsed.flatMap(({workerId, ready, meta}) => meta === undefined ? [] : [{workerId, ready, meta}]);
  const source = usable.find(answer => answer.ready) ?? (usable.length > 0 ? usable[0] : undefined);
  if (source === undefined) {
    throw new HttpError(503, 'no bot in that guild could list its channels', 'META_UNAVAILABLE');
  }

  const postable = new Map<string, string[]>();
  for (const answer of usable) {
    for (const channel of answer.meta.channels) {
      if (channel.canPost) {
        postable.set(channel.id, [...(postable.get(channel.id) ?? []), answer.workerId]);
      }
    }
  }

  return {
    guildId,
    workerIds: parsed.map(answer => answer.workerId),
    sourceWorkerId: source.workerId,
    channels: source.meta.channels.map((channel): MergedGuildChannel => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentName: channel.parentName,
      position: channel.position,
      postableBy: postable.get(channel.id) ?? [],
    })),
    roles: source.meta.roles,
    failed: parsed.filter(answer => answer.meta === undefined).map(answer => ({workerId: answer.workerId, error: answer.error})),
  };
};

/** One worker's test answer; `UNREACHABLE` when it did not answer, `DISCORD_ERROR` for anything unexpected. */
export const statusTestResult = (result: WorkerCallResult<unknown>): StatusTestResult => {
  if (!result.ok) {
    return {workerId: result.workerId, ok: false, error: 'UNREACHABLE'};
  }

  const answer = result.value;
  if (isPlainObject(answer) && answer.ok === true) {
    return {workerId: result.workerId, ok: true};
  }

  const error = isPlainObject(answer) ? answer.error : undefined;
  return {workerId: result.workerId, ok: false, error: isStatusAnnounceError(error) ? error : 'DISCORD_ERROR'};
};

const ERROR_CODE = /^[A-Z][A-Z_]{1,63}$/u;

/**
 * Machine-readable `code` of a worker 4xx answer (for example `INVALID_STATUS_CHANNEL` from a settings
 * patch), when the HTTP client error carries the response; undefined otherwise.
 */
export const workerErrorCode = (error: unknown): string | undefined => {
  const response = typeof error === 'object' && error !== null ? (error as {response?: unknown}).response : undefined;
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }

  const {statusCode, body} = response as {statusCode?: unknown; body?: unknown};
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) {
    return undefined;
  }

  let parsed: unknown = body;
  try {
    if (Buffer.isBuffer(parsed)) {
      parsed = parsed.toString('utf8');
    }

    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed) as unknown;
    }
  } catch {
    return undefined;
  }

  const code = isPlainObject(parsed) ? parsed.code : undefined;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
};
