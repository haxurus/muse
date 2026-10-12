import {isSnowflake} from '../control/snowflake.js';
import {MAX_MENTION_ROLES} from '../control/mention-roles.js';
import {commitWithBackup, isPlainObject, isPrintable, loadWithBackup} from './durable-file.js';
import {isValidActor, type Actor} from './super-store.js';

/**
 * Server and channel where every bot posts its "online" message (`null` channel disables it) and the
 * roles it mentions. `statusGuildId` is `null` only for a setting saved before the server was stored.
 */
export type StatusChannelSetting = {
  statusGuildId: string | null;
  statusChannelId: string | null;
  mentionRoleIds: string[];
  updatedAt: string | null;
  updatedBy: Actor | null;
};

type StoredStatusChannel = {
  /** Optional on disk so a file written before the server was stored stays valid. */
  statusGuildId?: string | null;
  statusChannelId: string | null;
  /** Optional on disk so a file written before role mentions existed stays valid. */
  mentionRoleIds?: string[];
  updatedAt: string | null;
  updatedBy: Actor | null;
};

/**
 * Instance-wide settings of the super console (Sentinel: InstanceConfig): the public contacts shown
 * on the pricing and beta pages, and whether the beta waitlist accepts new requests.
 */
export type InstanceConfig = {
  waitlistOpen: boolean;
  contactEmail: string | null;
  /** A Discord username, or an https link (invite or profile). */
  contactDiscord: string | null;
  /** An https website or contact form. */
  contactUrl: string | null;
  updatedAt: string | null;
  updatedBy: Actor | null;
};

type PlatformFile = {
  version: 1;
  statusChannel: StoredStatusChannel;
  /** Optional on disk so a file written before contacts existed stays valid. */
  instance?: InstanceConfig;
};

export const MAX_CONTACT_LENGTH = 200;
export const MAX_CONTACT_URL_LENGTH = 500;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const isContactEmail = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_CONTACT_LENGTH && EMAIL.test(value);

export const isContactDiscord = (value: unknown): value is string =>
  typeof value === 'string' && isPrintable(value, 2, MAX_CONTACT_LENGTH) && (!value.includes('://') || isHttpsUrl(value));

export const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > MAX_CONTACT_URL_LENGTH) {
    return false;
  }

  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const emptyInstance = (): InstanceConfig => ({
  waitlistOpen: false, contactEmail: null, contactDiscord: null, contactUrl: null, updatedAt: null, updatedBy: null,
});

const isValidInstance = (value: unknown): value is InstanceConfig => isPlainObject(value)
  && typeof value.waitlistOpen === 'boolean'
  && (value.contactEmail === null || isContactEmail(value.contactEmail))
  && (value.contactDiscord === null || isContactDiscord(value.contactDiscord))
  && (value.contactUrl === null || isHttpsUrl(value.contactUrl))
  && (value.updatedAt === null || typeof value.updatedAt === 'string')
  && (value.updatedBy === null || isValidActor(value.updatedBy));

export const isValidMentionRoleIds = (value: unknown): value is string[] => Array.isArray(value)
  && value.length <= MAX_MENTION_ROLES
  && value.every(id => isSnowflake(id))
  && new Set(value).size === value.length;

const emptyStatusChannel = (): StatusChannelSetting => ({statusGuildId: null, statusChannelId: null, mentionRoleIds: [], updatedAt: null, updatedBy: null});

const isValidStatusChannel = (value: unknown): value is StoredStatusChannel => isPlainObject(value)
  && (value.statusGuildId === undefined || value.statusGuildId === null || isSnowflake(value.statusGuildId))
  && (value.statusChannelId === null || isSnowflake(value.statusChannelId))
  && (value.mentionRoleIds === undefined || isValidMentionRoleIds(value.mentionRoleIds))
  && (value.updatedAt === null || typeof value.updatedAt === 'string')
  && (value.updatedBy === null || isValidActor(value.updatedBy));

const isValidPlatformFile = (value: unknown): value is PlatformFile => isPlainObject(value)
  && value.version === 1
  && isValidStatusChannel(value.statusChannel)
  && (value.instance === undefined || isValidInstance(value.instance));

const copyInstance = (instance: InstanceConfig | undefined): InstanceConfig => {
  const value = instance ?? emptyInstance();
  return {...value, updatedBy: value.updatedBy === null ? null : {...value.updatedBy}};
};

const copyStatusChannel = (setting: StoredStatusChannel): StatusChannelSetting => ({
  statusGuildId: setting.statusGuildId ?? null,
  statusChannelId: setting.statusChannelId,
  mentionRoleIds: [...(setting.mentionRoleIds ?? [])],
  updatedAt: setting.updatedAt,
  updatedBy: setting.updatedBy === null ? null : {...setting.updatedBy},
});

/**
 * Durable platform-wide settings set from the super console (`/state/platform-settings.json`).
 * Single-process store like the other orchestrator stores: exactly one orchestrator per state volume.
 */
export class PlatformSettingsStore {
  private data: PlatformFile;

  constructor(private readonly filePath: string) {
    this.data = loadWithBackup<PlatformFile>(
      filePath,
      isValidPlatformFile,
      () => ({version: 1, statusChannel: emptyStatusChannel()}),
      'Platform settings store',
    );
  }

  statusChannel(): StatusChannelSetting {
    return copyStatusChannel(this.data.statusChannel);
  }

  /**
   * Replace the status server and channel (`null` channel disables it, and then the server is cleared
   * too) and its role mentions; returns the stored value.
   */
  setStatusChannel(statusGuildId: string | null, statusChannelId: string | null, mentionRoleIds: string[], actor: Actor): StatusChannelSetting {
    const statusChannel: StatusChannelSetting = {
      statusGuildId: statusChannelId === null ? null : statusGuildId,
      statusChannelId,
      mentionRoleIds: [...mentionRoleIds],
      updatedAt: new Date().toISOString(),
      updatedBy: {...actor},
    };
    this.commit({...this.data, statusChannel});
    return copyStatusChannel(statusChannel);
  }

  instance(): InstanceConfig {
    return copyInstance(this.data.instance);
  }

  /** Merge a partial instance config (fields already validated) and record who changed it. */
  setInstance(patch: Partial<Pick<InstanceConfig, 'waitlistOpen' | 'contactEmail' | 'contactDiscord' | 'contactUrl'>>, actor: Actor): InstanceConfig {
    const instance: InstanceConfig = {
      ...copyInstance(this.data.instance),
      ...patch,
      updatedAt: new Date().toISOString(),
      updatedBy: {...actor},
    };
    this.commit({...this.data, instance});
    return copyInstance(instance);
  }

  private commit(next: PlatformFile): void {
    // The in-memory state always equals the last good file, so it is the backup copy.
    commitWithBackup(this.filePath, this.data, next);
    this.data = next;
  }
}
