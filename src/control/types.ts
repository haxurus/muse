import type {Setting} from '@prisma/client';
import type {LogEntry} from '../utils/log-buffer.js';

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

/** `POST /v1/guilds/:guildId/branding`: Discord refusals are a 200 with `ok: false`. */
export type WorkerBrandingResult = {
  workerId: string;
  guildId: string;
  ok: true;
} | {
  workerId: string;
  guildId: string;
  ok: false;
  /** MISSING_PERMISSION when the bot lacks Change Nickname, DISCORD_REJECTED otherwise. */
  error: 'MISSING_PERMISSION' | 'DISCORD_REJECTED';
  discordStatus: number | null;
};

export type WorkerBlocklistResult = {
  workerId: string;
  left: string[];
  failed: string[];
};

/** `GET /v1/logs` on a worker: the newest log lines, oldest first (see docs/SUPER_CONSOLE.md). */
export type WorkerLogs = {
  workerId: string;
  entries: LogEntry[];
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

/** Health alerts the orchestrator posts when a bot goes down or comes back (see docs/SUPER_CONSOLE.md). */
export const WORKER_ALERT_KINDS = ['worker-down', 'worker-recovered'] as const;

export type WorkerAlertKind = typeof WORKER_ALERT_KINDS[number];

export const isWorkerAlertKind = (value: unknown): value is WorkerAlertKind =>
  typeof value === 'string' && (WORKER_ALERT_KINDS as readonly string[]).includes(value);

/** The worker an alert is about. `botName` is the bot's last known username (the worker id when never seen). */
export type WorkerAlertSubject = {
  workerId: string;
  botName: string;
  /** ISO 8601: when the outage began (first failed check). */
  since: string;
};

/** A refused installation: the server, who added the bot (when the audit log shows it) and which bot. */
export type InstallSubject = {
  guildId: string;
  guildName: string;
  memberCount: number;
  installerId: string | null;
  workerId: string;
  botName: string;
  /** Why an accepted installation was authorized (install grant source); absent for a refusal. */
  source?: string;
};

/** Install notices in the status channel: Sentinel's "added to a server" and "installation refused". */
export type InstallNoticeKind = 'install-approved' | 'install-rejected';

/** Public contacts shown to whoever tried to add a bot (super console "Public contacts"). */
export type InstallContacts = {
  email: string | null;
  discord: string | null;
  url: string | null;
};

/** Answer of `POST /v1/worker/install-check` on the orchestrator. */
export type InstallCheckResult = {
  approved: boolean;
  source: string | null;
  contacts: InstallContacts;
};

/** Body of `POST /v1/status-channel/announce` on a worker. */
export type StatusAnnounceRequest = {
  /** Server the channel must belong to; `null` only for settings saved before the server was stored. */
  guildId: string | null;
  channelId: string;
  /** Super console test message instead of the startup "online" message. */
  test: boolean;
  /** Roles pinged by the message (0-10). */
  mentionRoleIds: string[];
  /** Health alert instead of the online or test message (then `test` is `false`). Absent for those. */
  kind?: WorkerAlertKind | InstallNoticeKind;
  /** The worker a health alert is about; required with a health alert `kind`. */
  worker?: WorkerAlertSubject;
  /** The installation; required with an install notice `kind`. */
  install?: InstallSubject;
};

/** Answer of `POST /v1/status-channel/announce` on a worker. */
export type WorkerStatusAnnounceResult = StatusAnnounceResult & {workerId: string};

/** `GET /v1/worker/config` on the orchestrator (worker control token). */
export type WorkerPlatformConfig = {
  statusGuildId: string | null;
  statusChannelId: string | null;
  mentionRoleIds: string[];
};

/** A channel where the status message can be posted (standard text or announcement channel). */
export type GuildMetaChannel = {
  id: string;
  name: string;
  type: 'text' | 'announcement';
  parentName: string | null;
  position: number;
  /** This bot has View Channel, Send Messages and Embed Links there. */
  canPost: boolean;
};

/** A role that can be mentioned by the status message (not @everyone, not managed by an integration). */
export type GuildMetaRole = {
  id: string;
  name: string;
  /** Discord role color as an integer (0 = no color). */
  color: number;
  mentionable: boolean;
  position: number;
};

/** `GET /v1/guilds/:guildId/meta` on a worker: channels in display order, roles by position (highest first). */
export type WorkerGuildMeta = {
  workerId: string;
  guildId: string;
  channels: GuildMetaChannel[];
  roles: GuildMetaRole[];
};

/** A saved favorite as exported (name, query, author and creation time; the row id is not exported). */
export type WorkerFavoriteExport = {
  name: string;
  query: string;
  authorId: string;
  createdAt: string;
};

/** `GET /v1/guilds/:guildId/export` on a worker: this bot's settings row (null when none) and favorites of the guild. */
export type WorkerGuildExport = {
  workerId: string;
  guildId: string;
  settings: WorkerGuildSettings | null;
  favorites: WorkerFavoriteExport[];
};

/** `DELETE /v1/guilds/:guildId/privacy/user/:userId` on a worker: favorites removed in that guild. */
export type WorkerGuildUserDataDeletion = {
  workerId: string;
  guildId: string;
  userId: string;
  favorites: number;
};

/** `DELETE /v1/users/:userId/data` on a worker: favorites removed in every guild this bot has data for. */
export type WorkerUserDataDeletion = {
  workerId: string;
  userId: string;
  favorites: number;
};
