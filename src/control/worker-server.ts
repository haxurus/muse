import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {ChannelType, Client} from 'discord.js';
import Config from '../services/config.js';
import PlayerManager from '../managers/player.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {HttpError, getPathSegments, hasBearerToken, readJsonBody, sendJson} from './http.js';
import {sanitizeGuildSettingsPatch, updateGuildSettings} from './guild-settings.js';
import AddQueryToQueue from '../services/add-query-to-queue.js';
import PlaybackControl from './playback-control.js';

export default class WorkerControlServer {
  private server?: Server;
  private readonly playback: PlaybackControl;

  constructor(
    private readonly config: Config,
    private readonly client: Client,
    private readonly playerManager: PlayerManager,
    addQueryToQueue: AddQueryToQueue,
  ) {
    this.playback = new PlaybackControl(client, playerManager, addQueryToQueue);
  }

  async start(): Promise<void> {
    if (!this.config.WORKER_ID) {
      return;
    }

    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.CONTROL_PORT, this.config.CONTROL_HOST, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    console.log(`Worker control API listening for ${this.config.WORKER_ID} on ${this.config.CONTROL_HOST}:${this.config.CONTROL_PORT}`);
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close(error => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, 200, {
          ok: true,
          workerId: this.config.WORKER_ID,
          discordReady: this.client.isReady(),
        });
        return;
      }

      if (!hasBearerToken(request, this.config.CONTROL_TOKEN)) {
        sendJson(response, 401, {error: 'unauthorized'});
        return;
      }

      const segments = getPathSegments(request);
      if (request.method === 'GET' && segments.join('/') === 'v1/status') {
        sendJson(response, 200, this.status());
        return;
      }

      if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'guilds' && segments[3] === 'settings') {
        const guildId = segments[2];
        if (!this.client.guilds.cache.has(guildId)) {
          throw new HttpError(404, 'worker is not a member of that guild');
        }

        if (request.method === 'GET') {
          sendJson(response, 200, await getGuildSettings(guildId));
          return;
        }

        if (request.method === 'PATCH') {
          const patch = sanitizeGuildSettingsPatch(await readJsonBody(request));
          sendJson(response, 200, await updateGuildSettings(guildId, patch));
          return;
        }
      }

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'channels'
        && request.method === 'GET') {
        sendJson(response, 200, this.guildChannels(segments[2]));
        return;
      }

      if (segments.length === 5
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'playback') {
        await this.handlePlayback(request, response, segments[2], segments[4]);
        return;
      }

      sendJson(response, 404, {error: 'not found'});
    } catch (error: unknown) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message = error instanceof HttpError ? error.message : 'internal server error';
      if (!(error instanceof HttpError)) {
        console.error('Worker control API error:', error);
      }

      sendJson(response, statusCode, {error: message});
    }
  }

  private async handlePlayback(
    request: IncomingMessage,
    response: ServerResponse,
    guildId: string,
    action: string,
  ): Promise<void> {
    if (!this.client.guilds.cache.has(guildId)) {
      throw new HttpError(404, 'worker is not a member of that guild');
    }

    if (request.method === 'GET' && action === 'queue') {
      sendJson(response, 200, this.playback.queue(guildId));
      return;
    }

    if (request.method === 'GET' && action === 'now-playing') {
      sendJson(response, 200, this.playback.nowPlaying(guildId));
      return;
    }

    if (request.method !== 'POST') {
      throw new HttpError(405, 'method not allowed');
    }

    const body = await readJsonBody(request);
    switch (action) {
      case 'play':
        sendJson(response, 200, await this.playback.play(guildId, body));
        return;
      case 'pause':
        sendJson(response, 200, this.playback.pause(guildId, body));
        return;
      case 'resume':
        sendJson(response, 200, await this.playback.resume(guildId, body));
        return;
      case 'skip':
        sendJson(response, 200, await this.playback.skip(guildId, body));
        return;
      case 'stop':
        sendJson(response, 200, this.playback.stop(guildId, body));
        return;
      case 'disconnect':
        sendJson(response, 200, this.playback.disconnect(guildId, body));
        return;
      case 'volume':
        sendJson(response, 200, this.playback.volume(guildId, body));
        return;
      default:
        throw new HttpError(404, 'unknown playback action');
    }
  }

  private guildChannels(guildId: string) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      throw new HttpError(404, 'worker is not a member of that guild');
    }

    return {
      guildId,
      categories: guild.channels.cache
        .filter(channel => channel.type === ChannelType.GuildCategory)
        .map(channel => ({id: channel.id, name: channel.name})),
      voiceChannels: guild.channels.cache
        .filter(channel => channel.type === ChannelType.GuildVoice)
        .map(channel => ({
          id: channel.id,
          name: channel.name,
          parentId: channel.parentId,
        })),
    };
  }

  private status() {
    return {
      workerId: this.config.WORKER_ID,
      discordReady: this.client.isReady(),
      bot: this.client.user
        ? {
          id: this.client.user.id,
          username: this.client.user.username,
        }
        : null,
      guilds: this.client.guilds.cache.map(guild => ({
        id: guild.id,
        name: guild.name,
      })),
      players: this.playerManager.snapshot(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
