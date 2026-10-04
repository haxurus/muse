import type {Setting} from '@prisma/client';

export type WorkerVoiceChannel = {
  id: string;
  name: string;
};

export type WorkerGuild = {
  id: string;
  name: string;
  voiceChannels: WorkerVoiceChannel[];
};

export type WorkerPlayerStatus = {
  guildId: string;
  connected: boolean;
  channelId: string | null;
  lastChannelId: string | null;
  hasCurrent: boolean;
  status: string;
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
