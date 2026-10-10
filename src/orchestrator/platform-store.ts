import {isSnowflake} from '../control/snowflake.js';
import {MAX_MENTION_ROLES} from '../control/mention-roles.js';
import {commitWithBackup, isPlainObject, loadWithBackup} from './durable-file.js';
import {isValidActor, type Actor} from './super-store.js';

/** Discord channel where every bot posts its "online" message (`null` disables it) and the roles it mentions. */
export type StatusChannelSetting = {
  statusChannelId: string | null;
  mentionRoleIds: string[];
  updatedAt: string | null;
  updatedBy: Actor | null;
};

type StoredStatusChannel = {
  statusChannelId: string | null;
  /** Optional on disk so a file written before role mentions existed stays valid. */
  mentionRoleIds?: string[];
  updatedAt: string | null;
  updatedBy: Actor | null;
};

type PlatformFile = {
  version: 1;
  statusChannel: StoredStatusChannel;
};

export const isValidMentionRoleIds = (value: unknown): value is string[] => Array.isArray(value)
  && value.length <= MAX_MENTION_ROLES
  && value.every(id => isSnowflake(id))
  && new Set(value).size === value.length;

const emptyStatusChannel = (): StatusChannelSetting => ({statusChannelId: null, mentionRoleIds: [], updatedAt: null, updatedBy: null});

const isValidStatusChannel = (value: unknown): value is StoredStatusChannel => isPlainObject(value)
  && (value.statusChannelId === null || isSnowflake(value.statusChannelId))
  && (value.mentionRoleIds === undefined || isValidMentionRoleIds(value.mentionRoleIds))
  && (value.updatedAt === null || typeof value.updatedAt === 'string')
  && (value.updatedBy === null || isValidActor(value.updatedBy));

const isValidPlatformFile = (value: unknown): value is PlatformFile => isPlainObject(value)
  && value.version === 1
  && isValidStatusChannel(value.statusChannel);

const copyStatusChannel = (setting: StoredStatusChannel): StatusChannelSetting => ({
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

  /** Replace the status channel (`null` disables it) and its role mentions; returns the stored value. */
  setStatusChannel(statusChannelId: string | null, mentionRoleIds: string[], actor: Actor): StatusChannelSetting {
    const statusChannel: StatusChannelSetting = {
      statusChannelId,
      mentionRoleIds: [...mentionRoleIds],
      updatedAt: new Date().toISOString(),
      updatedBy: {...actor},
    };
    const next: PlatformFile = {version: 1, statusChannel};
    // The in-memory state always equals the last good file, so it is the backup copy.
    commitWithBackup(this.filePath, this.data, next);
    this.data = next;
    return copyStatusChannel(statusChannel);
  }
}
