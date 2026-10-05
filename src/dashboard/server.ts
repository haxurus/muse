import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {HttpError} from '../control/http.js';
import DashboardAuth from './auth.js';
import type {DashboardConfig} from './config.js';
import {DashboardHttpError, describeUpstreamError, readJsonBody, send, sendJson} from './http.js';
import OrchestratorClient, {GuildSettingsUpdate} from './orchestrator-client.js';
import type {DashboardSession} from './session-store.js';

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

type MutationResult = {
  statusCode: number;
  body: unknown;
};

type MutationAudit = {
  action: string;
  guildId: string;
  groupId?: string;
  workerIds?: string[];
};

const auditMutation = (session: DashboardSession, audit: MutationAudit, outcome: string): void => {
  console.log(JSON.stringify({
    event: 'dashboard_mutation',
    timestamp: new Date().toISOString(),
    userId: session.user.id,
    guildId: audit.guildId,
    action: audit.action,
    ...(audit.groupId === undefined ? {} : {groupId: audit.groupId}),
    workerCount: audit.workerIds?.length ?? null,
    workerIds: audit.workerIds ?? null,
    outcome,
  }));
};

export type DashboardServerDependencies = {
  auth?: DashboardAuth;
  orchestrator?: OrchestratorClient;
};

export default class DashboardServer {
  private server?: Server;
  private readonly auth: DashboardAuth;
  private readonly orchestrator: OrchestratorClient;

  constructor(private readonly config: DashboardConfig, dependencies: DashboardServerDependencies = {}) {
    this.auth = dependencies.auth ?? new DashboardAuth(config);
    this.orchestrator = dependencies.orchestrator ?? new OrchestratorClient(config);
  }

  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : undefined;
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
    this.auth.close();
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
    const {pathname} = new URL(request.url ?? '/', this.config.publicUrl);

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
      if (segments[0] === 'api' && segments[1] === 'guilds') {
        const guildId = segments[2];

        if (segments.length === 3 && request.method === 'GET') {
          await this.guildResponse(request, response, guildId);
          return;
        }

        if (segments.length === 3 && request.method === 'PATCH') {
          await this.updateGuild(request, response, guildId);
          return;
        }

        if (segments.length === 4 && segments[3] === 'groups' && request.method === 'POST') {
          await this.createGroup(request, response, guildId);
          return;
        }

        if (segments.length === 5 && segments[3] === 'groups' && request.method === 'PATCH') {
          await this.updateGroup(request, response, guildId, segments[4]);
          return;
        }

        if (segments.length === 5 && segments[3] === 'groups' && request.method === 'DELETE') {
          await this.deleteGroup(request, response, guildId, segments[4]);
          return;
        }
      }

      sendJson(response, 404, {error: 'not found'});
    } catch (error: unknown) {
      this.sendError(request, response, pathname, error);
    }
  }

  private sendError(request: IncomingMessage, response: ServerResponse, pathname: string, error: unknown): void {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof HttpError ? error.message : 'request failed';
    const details = error instanceof DashboardHttpError ? error.details : {};

    if (statusCode >= 500) {
      // Log only the error class and upstream HTTP status, never messages that may echo secrets.
      const failure = describeUpstreamError(error);
      const causeName = details.causeName ?? failure.name;
      const causeStatus = details.causeStatus ?? failure.statusCode;
      console.error(`Dashboard request failed: ${request.method ?? 'UNKNOWN'} ${pathname} status=${statusCode} error=${causeName} upstreamStatus=${causeStatus === undefined ? 'none' : causeStatus}`);
    }

    if (response.headersSent) {
      response.destroy();
      return;
    }

    sendJson(
      response,
      statusCode,
      {error: message},
      details.retryAfterSeconds === undefined ? {} : {'retry-after': String(details.retryAfterSeconds)},
    );
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

  private async assertGuildAccess(session: DashboardSession, guildId: string, forceRefresh: boolean) {
    const guilds = await this.auth.manageableGuilds(session, forceRefresh);
    const guild = guilds.find(candidate => candidate.id === guildId);
    if (!guild) {
      throw new HttpError(403, 'you cannot manage this Discord server');
    }

    const orchestratorGuilds = await this.orchestrator.guilds();
    if (!orchestratorGuilds.guilds.some(candidate => candidate.id === guildId)) {
      throw new HttpError(404, 'Muse is not available in this Discord server');
    }

    return guild;
  }

  /**
   * Runs a mutation with checks ordered cheapest-first: session, Origin + CSRF,
   * mutation rate budget, then a forced Discord permission refresh. Every attempt by
   * an authenticated user is written to stdout as a structured audit line.
   */
  private async mutate(
    request: IncomingMessage,
    response: ServerResponse,
    audit: MutationAudit,
    execute: (entry: MutationAudit) => Promise<MutationResult>,
  ): Promise<void> {
    const session = this.auth.requireSession(request);
    let outcome = 'failed';

    try {
      this.auth.assertCsrf(request, session);
      this.auth.assertMutationAllowed(session);
      await this.assertGuildAccess(session, audit.guildId, true);
      const result = await execute(audit);
      sendJson(response, result.statusCode, result.body);
      outcome = 'ok';
    } catch (error: unknown) {
      outcome = error instanceof HttpError ? `rejected_${error.statusCode}` : 'failed';
      throw error;
    } finally {
      auditMutation(session, audit, outcome);
    }
  }

  private async guildResponse(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    const session = this.auth.requireSession(request);
    const guild = await this.assertGuildAccess(session, guildId, false);
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

  private async createGroup(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    await this.mutate(request, response, {action: 'group.create', guildId}, async audit => {
      const input = await readJsonBody(request);
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new HttpError(400, 'group body must be an object');
      }

      const body = input as {name?: unknown; workerIds?: unknown};
      if (typeof body.name !== 'string'
        || !Array.isArray(body.workerIds)
        || body.workerIds.some(workerId => typeof workerId !== 'string')) {
        throw new HttpError(400, 'group requires a name and workerIds string array');
      }

      const workerIds = body.workerIds as string[];
      audit.workerIds = workerIds;

      return {
        statusCode: 201,
        body: await this.orchestrator.createGuildGroup(guildId, {
          name: body.name,
          workerIds,
        }),
      };
    });
  }

  private async updateGroup(
    request: IncomingMessage,
    response: ServerResponse,
    guildId: string,
    groupId: string,
  ): Promise<void> {
    await this.mutate(request, response, {action: 'group.update', guildId, groupId}, async audit => {
      const input = await readJsonBody(request);
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new HttpError(400, 'group body must be an object');
      }

      const body = input as {name?: unknown; workerIds?: unknown};
      if (body.name !== undefined && typeof body.name !== 'string') {
        throw new HttpError(400, 'group name must be a string');
      }

      if (body.workerIds !== undefined
        && (!Array.isArray(body.workerIds)
          || body.workerIds.some(workerId => typeof workerId !== 'string'))) {
        throw new HttpError(400, 'workerIds must be a string array');
      }

      const workerIds = body.workerIds as string[] | undefined;
      audit.workerIds = workerIds;

      return {
        statusCode: 200,
        body: await this.orchestrator.updateGuildGroup(guildId, groupId, {
          ...(body.name === undefined ? {} : {name: body.name}),
          ...(workerIds === undefined ? {} : {workerIds}),
        }),
      };
    });
  }

  private async deleteGroup(
    request: IncomingMessage,
    response: ServerResponse,
    guildId: string,
    groupId: string,
  ): Promise<void> {
    await this.mutate(request, response, {action: 'group.delete', guildId, groupId}, async () => ({
      statusCode: 200,
      body: await this.orchestrator.deleteGuildGroup(guildId, groupId),
    }));
  }

  private async updateGuild(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    await this.mutate(request, response, {action: 'settings.update', guildId}, async audit => {
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

      const workerIds = candidate.workerIds as string[] | undefined;
      audit.workerIds = workerIds;

      const body: GuildSettingsUpdate = {
        ...(workerIds === undefined ? {} : {workerIds}),
        settings: candidate.settings as Record<string, unknown>,
      };

      return {
        statusCode: 200,
        body: await this.orchestrator.updateGuildSettings(guildId, body),
      };
    });
  }
}
