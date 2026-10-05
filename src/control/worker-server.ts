import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {Client} from 'discord.js';
import Config from '../services/config.js';
import PlayerManager from '../managers/player.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {HttpError, getPathSegments, hasBearerToken, readJsonBody, sendJson} from './http.js';
import {sanitizeGuildSettingsPatch, updateGuildSettings} from './guild-settings.js';
import type PlaybackWorker from '../playback/worker.js';
import {assertGuildId} from './snowflake.js';

export default class WorkerControlServer {
  private server?: Server;

  constructor(
    private readonly config: Config,
    private readonly client: Client,
    private readonly playerManager: PlayerManager,
    private readonly playback?: PlaybackWorker,
  ) {}

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

      if (request.method === 'POST' && request.url === '/v1/playback' && this.playback) {
        sendJson(response, 200, await this.playback.execute(await readJsonBody(request)));
        return;
      }

      const segments = getPathSegments(request);
      if (request.method === 'GET' && segments.join('/') === 'v1/status') {
        sendJson(response, 200, this.status());
        return;
      }

      if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'guilds' && segments[3] === 'settings') {
        const guildId = segments[2];
        assertGuildId(guildId);
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
