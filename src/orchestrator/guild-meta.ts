import {type Except} from 'type-fest';
import {HttpError} from '../control/http.js';
import {isSnowflake} from '../control/snowflake.js';
import type {GuildMetaChannel, GuildMetaRole} from '../control/types.js';
import {isPlainObject} from './durable-file.js';

/** Outcome of one worker call, as produced by the orchestrator's `wrap`. */
export type WorkerCallResult<T> = {workerId: string; ok: true; value: T} | {workerId: string; ok: false; error: string; code?: string};

/** A picker channel with the workers (bots) that can post there. */
export type MergedGuildChannel = Except<GuildMetaChannel, 'canPost'> & {postableBy: string[]};

/** `GET /v1/super/guilds/:guildId/meta` on the orchestrator. */
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
