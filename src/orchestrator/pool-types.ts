export type PoolGroup = {
  id: string;
  name: string;
  workerIds: string[];
  voiceChannelIds: string[];
  maxConcurrentPlayers: number;
  isDefault: boolean;
};

export type GuildPoolConfig = {
  maxConcurrentPlayers: number;
  groups: PoolGroup[];
};

export type PoolAssignmentMode = 'assign' | 'existing';

export type PoolAssignment = {
  guildId: string;
  voiceChannelId: string;
  workerId: string;
  bot: {
    id: string;
    username: string;
  } | null;
  groupId: string | null;
  groupName: string | null;
  reserved: boolean;
};
