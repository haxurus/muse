import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import Player, {STATUS} from '../services/player.js';
import FileCacheProvider from '../services/file-cache.js';
import type YoutubeAPI from '../services/youtube-api.js';

@injectable()
export default class {
  private readonly guildPlayers: Map<string, Player>;
  private readonly fileCache: FileCacheProvider;
  private readonly youtubeAPI: YoutubeAPI;

  constructor(@inject(TYPES.FileCache) fileCache: FileCacheProvider,
    @inject(TYPES.Services.YoutubeAPI) youtubeAPI: YoutubeAPI) {
    this.guildPlayers = new Map();
    this.fileCache = fileCache;
    this.youtubeAPI = youtubeAPI;
  }

  snapshot(): Array<{guildId: string; connected: boolean; channelId: string | null; status: string; hasCurrent: boolean; queueSize: number}> {
    return [...this.guildPlayers.entries()].map(([guildId, player]) => ({
      guildId,
      connected: player.voiceConnection !== null,
      channelId: player.voiceConnection?.joinConfig.channelId ?? null,
      status: STATUS[player.status],
      hasCurrent: player.getCurrent() !== null,
      queueSize: player.queueSize(),
    }));
  }

  find(guildId: string): Player | undefined {
    return this.guildPlayers.get(guildId);
  }

  cleanup(): void {
    for (const player of this.guildPlayers.values()) {
      player.stop();
    }

    this.guildPlayers.clear();
  }

  get(guildId: string): Player {
    let player = this.guildPlayers.get(guildId);

    if (!player) {
      player = new Player(
        this.fileCache,
        guildId,
        async song => this.youtubeAPI.findAudioFallback(song),
      );

      this.guildPlayers.set(guildId, player);
    }

    return player;
  }
}
