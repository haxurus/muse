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
