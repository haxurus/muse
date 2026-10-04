import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {HttpError, getPathSegments, hasBearerToken, readJsonBody, sendJson} from '../control/http.js';
import {sanitizeGuildSettingsPatch} from '../control/settings-validation.js';
import type {OrchestratorConfig} from './config.js';
import WorkerClient from './worker-client.js';
import GuildGroupStore from './guild-group-store.js';
import GuildRoutingStore from './guild-routing-store.js';
import PlaybackLeaseManager from './playback-lease-manager.js';
import PlaybackOrchestrator from './playback-orchestrator.js';

type WorkerResult<T> = {
  workerId: string;
  ok: true;
  value: T;
} | {
  workerId: string;
  ok: false;
  error: string;
};

const errorLabel = (error: unknown): string => error instanceof Error ? error.name : 'Error';

export default class OrchestratorServer {
  private server?: Server;
  private readonly workers: WorkerClient[];
  private readonly groups: GuildGroupStore;
  private readonly routing: GuildRoutingStore;
  private readonly playback: PlaybackOrchestrator;
  private reconcileTimer?: NodeJS.Timeout;

  constructor(private readonly config: OrchestratorConfig) {
    this.workers = config.workers.map(worker => new WorkerClient(worker));
    this.groups = new GuildGroupStore(
      config.groupsFile,
      new Set(config.workers.map(worker => worker.id)),
    );
    this.routing = new GuildRoutingStore(config.routingFile);
    this.playback = new PlaybackOrchestrator(
      this.workers,
      this.groups,
      this.routing,
      new PlaybackLeaseManager(),
    );
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

    await this.playback.reconcileAll();
    this.reconcileTimer = setInterval(() => {
      void this.playback.reconcileAll().catch(error => {
        console.error('Playback lease reconciliation failed:', error);
      });
    }, 15_000);
    this.reconcileTimer.unref();

    console.log(`Muse orchestrator listening on ${this.config.host}:${this.config.port} with ${this.workers.length} workers`);
  }

  async close(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }

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
    try {
      if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, 200, {ok: true, workersConfigured: this.workers.length});
        return;
      }

      const segments = getPathSegments(request);
      const isPlaybackRoute = segments.length >= 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'playback';
      const isAdmin = hasBearerToken(request, this.config.apiToken);
      const isController = isPlaybackRoute
        && hasBearerToken(request, this.config.controllerToken);

      if (!isAdmin && !isController) {
        sendJson(response, 401, {error: 'unauthorized'});
        return;
      }

      if (request.method === 'GET' && segments.join('/') === 'v1/workers') {
        sendJson(response, 200, {workers: await this.workerStatuses()});
        return;
      }

      if (request.method === 'GET' && segments.join('/') === 'v1/guilds') {
        sendJson(response, 200, {guilds: await this.guilds()});
        return;
      }

      if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'guilds' && segments[3] === 'workers' && request.method === 'GET') {
        sendJson(response, 200, await this.guildWorkers(segments[2]));
        return;
      }

      if (segments.length === 5
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'workers'
        && segments[4] === 'settings'
        && request.method === 'PATCH') {
        sendJson(response, 200, await this.updateGuildWorkers(segments[2], await readJsonBody(request)));
        return;
      }

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'channels'
        && request.method === 'GET') {
        sendJson(response, 200, await this.playback.channels(segments[2]));
        return;
      }

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'routing'
        && request.method === 'GET') {
        sendJson(response, 200, {guildId: segments[2], routing: this.routing.get(segments[2])});
        return;
      }

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'routing'
        && request.method === 'PUT') {
        sendJson(response, 200, {
          guildId: segments[2],
          routing: this.routing.update(segments[2], await readJsonBody(request), this.groups),
        });
        return;
      }

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'playback'
        && request.method === 'GET') {
        sendJson(response, 200, await this.playback.state(segments[2]));
        return;
      }

      if (segments.length === 5
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'playback') {
        const action = segments[4];
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          if (action === 'play') {
            sendJson(response, 200, await this.playback.play(segments[2], body));
            return;
          }

          if (['pause', 'resume', 'skip', 'stop', 'disconnect', 'volume'].includes(action)) {
            sendJson(response, 200, await this.playback.action(
              segments[2],
              action as 'pause' | 'resume' | 'skip' | 'stop' | 'disconnect' | 'volume',
              body,
            ));
            return;
          }
        }

        if (request.method === 'GET' && (action === 'queue' || action === 'now-playing')) {
          const url = new URL(request.url ?? '/', 'http://orchestrator');
          sendJson(response, 200, await this.playback.read(
            segments[2],
            action,
            url.searchParams.get('voiceChannelId'),
          ));
          return;
        }
      }

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'groups'
        && request.method === 'GET') {
        sendJson(response, 200, {guildId: segments[2], groups: this.groups.list(segments[2])});
        return;
      }

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'groups'
        && request.method === 'POST') {
        sendJson(response, 201, {
          guildId: segments[2],
          group: this.groups.create(segments[2], await readJsonBody(request)),
        });
        return;
      }

      if (segments.length === 5
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'groups'
        && request.method === 'PATCH') {
        sendJson(response, 200, {
          guildId: segments[2],
          group: this.groups.update(segments[2], segments[4], await readJsonBody(request)),
        });
        return;
      }

      if (segments.length === 5
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'groups'
        && request.method === 'DELETE') {
        this.groups.delete(segments[2], segments[4]);
        this.routing.removeGroupReferences(segments[2], segments[4]);
        sendJson(response, 200, {guildId: segments[2], deletedGroupId: segments[4]});
        return;
      }

      sendJson(response, 404, {error: 'not found'});
    } catch (error: unknown) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message = error instanceof HttpError ? error.message : 'internal server error';
      if (!(error instanceof HttpError)) {
        console.error('Orchestrator API error:', error);
      }

      sendJson(response, statusCode, {error: message});
    }
  }

  private async workerStatuses() {
    return Promise.all(this.workers.map(async worker => this.wrap(worker.id, worker.status())));
  }

  private async guilds() {
    const statuses = await this.workerStatuses();
    const guilds = new Map<string, {id: string; name: string; availableWorkers: number}>();

    for (const result of statuses) {
      if (!result.ok) {
        continue;
      }

      for (const guild of result.value.guilds) {
        const existing = guilds.get(guild.id);
        guilds.set(guild.id, {
          id: guild.id,
          name: guild.name,
          availableWorkers: (existing?.availableWorkers ?? 0) + 1,
        });
      }
    }

    return [...guilds.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private async guildWorkers(guildId: string) {
    const statuses = await this.workerStatuses();
    const present = statuses.filter(result => result.ok && result.value.guilds.some(guild => guild.id === guildId));

    const workers = await Promise.all(present.map(async result => {
      if (!result.ok) {
        return result;
      }

      const worker = this.workers.find(candidate => candidate.id === result.workerId)!;
      return this.wrap(worker.id, worker.guildSettings(guildId).then(settings => ({
        status: result.value,
        settings,
      })));
    }));

    return {
      guildId,
      workers,
      groups: this.groups.list(guildId),
    };
  }

  private async updateGuildWorkers(guildId: string, input: unknown) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new HttpError(400, 'request body must be an object');
    }

    const body = input as {workerIds?: unknown; settings?: unknown};
    const patch = sanitizeGuildSettingsPatch(body.settings);

    let selected: WorkerClient[];
    if (body.workerIds === undefined) {
      const statuses = await this.workerStatuses();
      const presentIds = new Set(statuses
        .filter(result => result.ok && result.value.guilds.some(guild => guild.id === guildId))
        .map(result => result.workerId));
      selected = this.workers.filter(worker => presentIds.has(worker.id));
    } else {
      if (!Array.isArray(body.workerIds)
        || body.workerIds.length === 0
        || body.workerIds.some(workerId => typeof workerId !== 'string')) {
        throw new HttpError(400, 'workerIds must be a non-empty string array');
      }

      const requestedIds = new Set(body.workerIds as string[]);
      const unknownIds = [...requestedIds].filter(id => !this.workers.some(worker => worker.id === id));
      if (unknownIds.length > 0) {
        throw new HttpError(400, `unknown workers: ${unknownIds.join(', ')}`);
      }

      selected = this.workers.filter(worker => requestedIds.has(worker.id));
    }

    if (selected.length === 0) {
      throw new HttpError(404, 'no matching workers are available in that guild');
    }

    const results = await Promise.all(selected.map(async worker => this.wrap(
      worker.id,
      worker.updateGuildSettings(guildId, patch),
    )));

    return {
      guildId,
      requestedWorkers: selected.map(worker => worker.id),
      updated: results.filter(result => result.ok),
      failed: results.filter(result => !result.ok),
    };
  }

  private async wrap<T>(workerId: string, promise: Promise<T>): Promise<WorkerResult<T>> {
    try {
      return {
        workerId,
        ok: true,
        value: await promise,
      };
    } catch (error: unknown) {
      return {
        workerId,
        ok: false,
        error: errorLabel(error),
      };
    }
  }
}
