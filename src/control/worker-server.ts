import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {Client, type Guild} from 'discord.js';
import Config from '../services/config.js';
import PlayerManager from '../managers/player.js';
import {HttpError, errorBody, getPathSegments, hasBearerToken, readJsonBody, sendJson} from './http.js';
import {getGuildSettingsView, updateGuildSettings} from './guild-settings.js';
import {sanitizeGuildSettingsPatch} from './settings-validation.js';
import type PlaybackWorker from '../playback/worker.js';
import {assertGuildId} from './snowflake.js';
import {MAX_BLOCKLIST_BODY_BYTES, blocklist, sanitizeBlocklist} from './blocklist.js';
import type {WorkerBlocklistResult, WorkerGuildMeta, WorkerLeaveGuildResult, WorkerStatus, WorkerStatusTestResult} from './types.js';
import {normalizeLocale} from '../i18n/index.js';
import {postStatusMessage} from '../status/announce.js';
import {assertStatusSettingsForGuild, buildGuildMeta} from '../status/guild-meta.js';

const errorLabel = (error: unknown): string => error instanceof Error ? error.name : 'Error';

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

  // eslint-disable-next-line complexity
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

      if (request.method === 'PUT' && segments.join('/') === 'v1/blocklist') {
        const next = sanitizeBlocklist(await readJsonBody(request, MAX_BLOCKLIST_BODY_BYTES));
        sendJson(response, 200, await this.applyBlocklist(next.guildIds, next.userIds));
        return;
      }

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'leave'
        && request.method === 'POST') {
        sendJson(response, 200, await this.leaveGuild(segments[2]));
        return;
      }

      if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'guilds' && segments[3] === 'settings') {
        const guild = this.memberGuild(segments[2]);

        if (request.method === 'GET') {
          sendJson(response, 200, await getGuildSettingsView(guild.id));
          return;
        }

        if (request.method === 'PATCH') {
          const patch = sanitizeGuildSettingsPatch(await readJsonBody(request));
          // The status channel and roles must belong to this guild: checked here, where the Discord client is.
          assertStatusSettingsForGuild(guild, patch);
          sendJson(response, 200, await updateGuildSettings(guild.id, patch));
          return;
        }
      }

      if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'guilds' && segments[3] === 'meta' && request.method === 'GET') {
        sendJson(response, 200, this.guildMeta(segments[2]));
        return;
      }

      if (segments.length === 5
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'status-channel'
        && segments[4] === 'test'
        && request.method === 'POST') {
        sendJson(response, 200, await this.testStatusChannel(segments[2]));
        return;
      }

      sendJson(response, 404, {error: 'not found'});
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, errorBody(error));
        return;
      }

      console.error('Worker control API error:', error);
      sendJson(response, 500, {error: 'internal server error'});
    }
  }

  /** A guild this bot is a member of; `400` for a malformed id, `404` otherwise. */
  private memberGuild(guildId: string): Guild {
    assertGuildId(guildId);
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      throw new HttpError(404, 'worker is not a member of that guild', 'NOT_IN_GUILD');
    }

    return guild;
  }

  /** Channels and roles for the dashboard "Log" tab pickers, as seen by this bot. */
  private guildMeta(guildId: string): WorkerGuildMeta {
    if (!this.client.isReady()) {
      throw new HttpError(503, 'worker is not connected to Discord', 'NOT_READY');
    }

    const guild = this.memberGuild(guildId);
    return {workerId: this.config.WORKER_ID, guildId: guild.id, ...buildGuildMeta(guild)};
  }

  /** Post the test message with this bot's saved status setting for the guild. Discord failures are a 200 with `ok: false`. */
  private async testStatusChannel(guildId: string): Promise<WorkerStatusTestResult> {
    const workerId = this.config.WORKER_ID;
    if (!this.client.isReady()) {
      assertGuildId(guildId);
      return {workerId, ok: false, error: 'NOT_READY'};
    }

    const guild = this.memberGuild(guildId);
    const settings = await getGuildSettingsView(guild.id);
    if (settings.statusChannelId === null) {
      return {workerId, ok: false, error: 'NOT_CONFIGURED'};
    }

    const result = await postStatusMessage(this.client, {
      guildId: guild.id,
      channelId: settings.statusChannelId,
      test: true,
      mentionRoleIds: settings.statusMentionRoleIds,
      locale: normalizeLocale(settings.locale),
    });
    if (!result.ok) {
      console.warn(`Worker ${workerId} could not post the status test message in guild ${guild.id} (${result.error})`);
    }

    return {workerId, ...result};
  }

  private async leaveGuild(guildId: string): Promise<WorkerLeaveGuildResult> {
    assertGuildId(guildId);
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      throw new HttpError(404, 'worker is not a member of that guild', 'NOT_IN_GUILD');
    }

    await guild.leave();
    console.log(`Worker ${this.config.WORKER_ID} left guild ${guildId} on orchestrator request`);
    return {workerId: this.config.WORKER_ID, guildId, left: true};
  }

  /** Replace the blocklist, then leave every blocked guild this bot is still a member of. */
  private async applyBlocklist(guildIds: string[], userIds: string[]): Promise<WorkerBlocklistResult> {
    blocklist.set({guildIds, userIds});

    const blockedGuilds = this.client.guilds.cache.filter(guild => blocklist.isGuildBlocked(guild.id));
    const left: string[] = [];
    const failed: string[] = [];
    await Promise.all(blockedGuilds.map(async guild => {
      try {
        await guild.leave();
        left.push(guild.id);
      } catch (error: unknown) {
        failed.push(guild.id);
        console.error(`Worker ${this.config.WORKER_ID} failed to leave blocked guild ${guild.id}: ${errorLabel(error)}`);
      }
    }));

    if (left.length > 0) {
      console.log(`Worker ${this.config.WORKER_ID} left blocked guilds: ${left.join(', ')}`);
    }

    return {workerId: this.config.WORKER_ID, left: left.sort(), failed: failed.sort()};
  }

  private status(): WorkerStatus {
    const players = this.playerManager.snapshot();
    const activeGuildIds = new Set(players.filter(player => player.connected).map(player => player.guildId));

    return {
      workerId: this.config.WORKER_ID,
      discordReady: this.client.isReady(),
      bot: this.client.user
        ? {
          id: this.client.user.id,
          username: this.client.user.username,
          avatarUrl: this.client.user.displayAvatarURL(),
        }
        : null,
      guilds: this.client.guilds.cache.map(guild => ({
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL(),
        memberCount: guild.memberCount,
        ownerId: guild.ownerId,
        playerActive: activeGuildIds.has(guild.id),
      })),
      players,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
