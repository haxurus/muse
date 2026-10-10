import type {Setting} from '@prisma/client';

/** Fields added after the first release are optional so mixed-version fleets keep working. */
export type WorkerGuild = {
  id: string;
  name: string;
  iconUrl?: string | null;
  memberCount?: number | null;
  ownerId?: string | null;
  playerActive?: boolean;
};

export type WorkerPlayerStatus = {
  guildId: string;
  connected: boolean;
  channelId: string | null;
  status: string;
};

export type WorkerStatus = {
  workerId: string;
  discordReady: boolean;
  bot: {
    id: string;
    username: string;
    avatarUrl?: string | null;
  } | null;
  guilds: WorkerGuild[];
  players: WorkerPlayerStatus[];
  uptimeSeconds: number;
};

export type WorkerGuildSettings = Setting;

export type WorkerLeaveGuildResult = {
  workerId: string;
  guildId: string;
  left: true;
};

export type WorkerBlocklistResult = {
  workerId: string;
  left: string[];
  failed: string[];
};

/** Why a worker could not post a status message (see src/status/announce.ts). */
export const STATUS_ANNOUNCE_ERRORS = [
  'NOT_READY',
  'CHANNEL_NOT_FOUND',
  'INVALID_CHANNEL',
  'MISSING_PERMISSIONS',
  'DISCORD_ERROR',
] as const;

export type StatusAnnounceError = typeof STATUS_ANNOUNCE_ERRORS[number];

export const isStatusAnnounceError = (value: unknown): value is StatusAnnounceError =>
  typeof value === 'string' && (STATUS_ANNOUNCE_ERRORS as readonly string[]).includes(value);

export type StatusAnnounceResult = {ok: true} | {ok: false; error: StatusAnnounceError};

/** Body of `POST /v1/status-channel/announce` on a worker. */
export type StatusAnnounceRequest = {
  channelId: string;
  /** Super console test message instead of the startup "online" message. */
  test: boolean;
  /** Roles pinged by the message (0-10). */
  mentionRoleIds: string[];
};

/** Answer of `POST /v1/status-channel/announce` on a worker. */
export type WorkerStatusAnnounceResult = StatusAnnounceResult & {workerId: string};

/** `GET /v1/worker/config` on the orchestrator (worker control token). */
export type WorkerPlatformConfig = {
  statusChannelId: string | null;
  mentionRoleIds: string[];
};
