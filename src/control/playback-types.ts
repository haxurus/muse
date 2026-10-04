import type {SongMetadata} from '../services/player.js';

export type PlaybackPlayRequest = {
  voiceChannelId: string;
  textChannelId: string;
  requesterId: string;
  query: string;
  immediate?: boolean;
  shuffle?: boolean;
  split?: boolean;
  skip?: boolean;
};

export type PlaybackChannelRequest = {
  voiceChannelId: string;
  requesterId: string;
};

export type PlaybackSkipRequest = PlaybackChannelRequest & {
  count?: number;
};

export type PlaybackVolumeRequest = PlaybackChannelRequest & {
  level: number;
};

export type PlaybackQueueEntry = SongMetadata & {
  requestedBy: string;
};

export type PlaybackSnapshot = {
  guildId: string;
  connected: boolean;
  voiceChannelId: string | null;
  status: 'PLAYING' | 'PAUSED' | 'IDLE';
  volume: number;
  positionSeconds: number;
  current: PlaybackQueueEntry | null;
  queue: PlaybackQueueEntry[];
};

export type PlaybackActionResult = {
  message: string;
  playback: PlaybackSnapshot;
};
