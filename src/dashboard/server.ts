import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {HttpError} from '../control/http.js';
import DashboardAuth from './auth.js';
import type {DashboardConfig} from './config.js';
import {readJsonBody, send, sendJson} from './http.js';
import OrchestratorClient, {GuildSettingsUpdate} from './orchestrator-client.js';

const STATIC_ROOT = path.join(process.cwd(), 'dashboard');

const staticAsset = (fileName: string): string =>
  readFileSync(path.join(STATIC_ROOT, fileName), 'utf8');

const INDEX_HTML = staticAsset('index.html');
const DASHBOARD_CSS = staticAsset('dashboard.css');
const DASHBOARD_JS = staticAsset('dashboard.js');

const avatarUrl = (userId: string, avatar?: string | null): string | null =>
  avatar ? `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=128` : null;

const guildIconUrl = (guildId: string, icon?: string | null): string | null =>
  icon ? `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=128` : null;

const routeSegments = (request: IncomingMessage, publicUrl: URL): string[] =>
  new URL(request.url ?? '/', publicUrl).pathname.split('/').filter(Boolean);

export default class DashboardServer {
  private server?: Server;
  private readonly auth: DashboardAuth;
  private readonly orchestrator: OrchestratorClient;

  constructor(private readonly config: DashboardConfig) {
    this.auth = new DashboardAuth(config);
    this.orchestrator = new OrchestratorClient(config);
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    console.log(`Muse dashboard listening on ${this.config.host}:${this.config.port}`);
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
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', this.config.publicUrl).pathname;

    try {
      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, {ok: true});
        return;
      }

      if (request.method === 'GET' && pathname === '/') {
        send(response, 200, 'text/html; charset=utf-8', INDEX_HTML);
        return;
      }

      if (request.method === 'GET' && pathname === '/assets/dashboard.css') {
        send(response, 200, 'text/css; charset=utf-8', DASHBOARD_CSS);
        return;
      }

      if (request.method === 'GET' && pathname === '/assets/dashboard.js') {
        send(response, 200, 'text/javascript; charset=utf-8', DASHBOARD_JS);
        return;
      }

      if (request.method === 'GET' && pathname === '/auth/discord') {
        this.auth.begin(response);
        return;
      }

      if (request.method === 'GET' && pathname === '/auth/discord/callback') {
        await this.auth.callback(request, response);
        return;
      }

      if (request.method === 'POST' && pathname === '/auth/logout') {
        await this.auth.logout(request, response);
        return;
      }

      if (request.method === 'GET' && pathname === '/api/session') {
        await this.sessionResponse(request, response);
        return;
      }

      const segments = routeSegments(request, this.config.publicUrl);
      if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'guilds') {
        const guildId = segments[2];

        if (request.method === 'GET') {
          await this.guildResponse(request, response, guildId);
          return;
        }

        if (request.method === 'PATCH') {
          await this.updateGuild(request, response, guildId);
          return;
        }
      }

      sendJson(response, 404, {error: 'not found'});
    } catch (error: unknown) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message = error instanceof HttpError ? error.message : 'request failed';

      if (!(error instanceof HttpError)) {
        console.error(`Dashboard request failed: ${request.method ?? 'UNKNOWN'} ${pathname}`);
      }

      sendJson(response, statusCode, {error: message});
    }
  }

  private async sessionResponse(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.auth.requireSession(request);
    const [discordGuilds, orchestratorGuilds] = await Promise.all([
      this.auth.manageableGuilds(session),
      this.orchestrator.guilds(),
    ]);

    const availableById = new Map(orchestratorGuilds.guilds.map(guild => [guild.id, guild]));
    const guilds = discordGuilds
      .filter(guild => availableById.has(guild.id))
      .map(guild => ({
        id: guild.id,
        name: guild.name,
        iconUrl: guildIconUrl(guild.id, guild.icon),
        owner: guild.owner,
        availableWorkers: availableById.get(guild.id)!.availableWorkers,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    sendJson(response, 200, {
      user: {
        id: session.user.id,
        username: session.user.username,
        displayName: session.user.global_name ?? session.user.username,
        avatarUrl: avatarUrl(session.user.id, session.user.avatar),
      },
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      guilds,
    });
  }

  private async assertGuildAccess(request: IncomingMessage, guildId: string, forceRefresh: boolean) {
    const session = this.auth.requireSession(request);
    const guilds = await this.auth.manageableGuilds(session, forceRefresh);
    const guild = guilds.find(candidate => candidate.id === guildId);
    if (!guild) {
      throw new HttpError(403, 'you cannot manage this Discord server');
    }

    const orchestratorGuilds = await this.orchestrator.guilds();
    if (!orchestratorGuilds.guilds.some(candidate => candidate.id === guildId)) {
      throw new HttpError(404, 'Muse is not available in this Discord server');
    }

    return {session, guild};
  }

  private async guildResponse(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    const {guild} = await this.assertGuildAccess(request, guildId, false);
    const details = await this.orchestrator.guildWorkers(guildId);

    sendJson(response, 200, {
      guild: {
        id: guild.id,
        name: guild.name,
        iconUrl: guildIconUrl(guild.id, guild.icon),
      },
      ...details,
    });
  }

  private async updateGuild(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    const {session} = await this.assertGuildAccess(request, guildId, true);
    this.auth.assertCsrf(request, session);

    const input = await readJsonBody(request);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new HttpError(400, 'request body must be an object');
    }

    const candidate = input as {workerIds?: unknown; settings?: unknown};
    if (candidate.workerIds !== undefined
      && (!Array.isArray(candidate.workerIds)
        || candidate.workerIds.some(workerId => typeof workerId !== 'string'))) {
      throw new HttpError(400, 'workerIds must be an array of strings');
    }

    if (typeof candidate.settings !== 'object' || candidate.settings === null || Array.isArray(candidate.settings)) {
      throw new HttpError(400, 'settings must be an object');
    }

    const body: GuildSettingsUpdate = {
      ...(candidate.workerIds === undefined ? {} : {workerIds: candidate.workerIds as string[]}),
      settings: candidate.settings as Record<string, unknown>,
    };

    sendJson(response, 200, await this.orchestrator.updateGuildSettings(guildId, body));
  }
}
