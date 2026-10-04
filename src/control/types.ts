import type {Setting} from '@prisma/client';

export type WorkerGuild = {
  id: string;
  name: string;
};

export type WorkerPlayerStatus = {
  guildId: string;
  connected: boolean;
  channelId: string | null;
  status: string;
  hasCurrent: boolean;
  queueSize: number;
};

export type WorkerStatus = {
  workerId: string;
  discordReady: boolean;
  bot: {
    id: string;
    username: string;
  } | null;
  guilds: WorkerGuild[];
  players: WorkerPlayerStatus[];
  uptimeSeconds: number;
};

export type WorkerGuildSettings = Setting;
