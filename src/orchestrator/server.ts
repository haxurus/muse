import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {HttpError, getPathSegments, hasBearerToken, readJsonBody, sendJson} from '../control/http.js';
import {sanitizeGuildSettingsPatch} from '../control/settings-validation.js';
import type {OrchestratorConfig} from './config.js';
import PoolEngine, {type ReachableWorker} from './pool-engine.js';
import PoolStore, {sanitizeGuildPoolConfig} from './pool-store.js';
import type {PoolAssignmentMode} from './pool-types.js';
import WorkerClient from './worker-client.js';

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
  private readonly poolStore: PoolStore;
  private readonly poolEngine = new PoolEngine();

  constructor(private readonly config: OrchestratorConfig) {
    this.workers = config.workers.map(worker => new WorkerClient(worker));
    this.poolStore = new PoolStore(config.poolStorePath);
  }

  async start(): Promise<void> {
    await this.poolStore.load();

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

    console.log('Muse orchestrator listening on '
      + this.config.host + ':' + this.config.port
      + ' with ' + this.workers.length + ' workers');
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
    try {
      if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, 200, {ok: true, workersConfigured: this.workers.length});
        return;
      }

      const segments = getPathSegments(request);
      if (request.method === 'POST' && segments.join('/') === 'v1/pool/assign') {
        const sourceWorker = this.workerForRequest(request);
        if (!sourceWorker) {
          sendJson(response, 401, {error: 'unauthorized worker'});
          return;
        }

        sendJson(response, 200, await this.assignPoolWorker(sourceWorker.id, await readJsonBody(request)));
        return;
      }

      if (!hasBearerToken(request, this.config.apiToken)) {
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

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'workers'
        && request.method === 'GET') {
        sendJson(response, 200, await this.guildWorkers(segments[2]));
        return;
      }

      if (segments.length === 4
        && segments[0] === 'v1'
        && segments[1] === 'guilds'
        && segments[3] === 'pool') {
        if (request.method === 'GET') {
          sendJson(response, 200, await this.guildPool(segments[2]));
          return;
        }

        if (request.method === 'PUT') {
          sendJson(response, 200, await this.updateGuildPool(segments[2], await readJsonBody(request)));
          return;
        }
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

  private workerForRequest(request: IncomingMessage): WorkerClient | undefined {
    return this.workers.find(worker => hasBearerToken(request, worker.token));
  }

  private async workerStatuses() {
    return Promise.all(this.workers.map(async worker => this.wrap(worker.id, worker.status())));
  }

  private async reachableWorkers(): Promise<ReachableWorker[]> {
    const statuses = await this.workerStatuses();
    return statuses
      .filter((result): result is Extract<typeof result, {ok: true}> => result.ok)
      .map(result => ({
        id: result.workerId,
        status: result.value,
      }));
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
    };
  }

  private async guildPool(guildId: string) {
    const reachable = await this.reachableWorkers();
    const present = reachable.filter(worker => worker.status.guilds.some(guild => guild.id === guildId));
    if (present.length === 0) {
      throw new HttpError(404, 'no Muse worker is available in that guild');
    }

    const voiceChannels = new Map<string, string>();
    for (const worker of present) {
      const guild = worker.status.guilds.find(candidate => candidate.id === guildId);
      for (const channel of guild?.voiceChannels ?? []) {
        voiceChannels.set(channel.id, channel.name);
      }
    }

    return {
      guildId,
      config: this.poolStore.getGuild(guildId, present.length),
      availableWorkerIds: present.map(worker => worker.id),
      voiceChannels: [...voiceChannels.entries()]
        .map(([id, name]) => ({id, name}))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private async updateGuildPool(guildId: string, input: unknown) {
    const reachable = await this.reachableWorkers();
    const present = reachable.filter(worker => worker.status.guilds.some(guild => guild.id === guildId));
    if (present.length === 0) {
      throw new HttpError(404, 'no Muse worker is available in that guild');
    }

    const config = sanitizeGuildPoolConfig(input, present.map(worker => worker.id));

    const knownVoiceChannels = new Set<string>();
    for (const worker of present) {
      const guild = worker.status.guilds.find(candidate => candidate.id === guildId);
      for (const channel of guild?.voiceChannels ?? []) {
        knownVoiceChannels.add(channel.id);
      }
    }

    for (const group of config.groups) {
      const unknownChannels = group.voiceChannelIds.filter(channelId => !knownVoiceChannels.has(channelId));
      if (unknownChannels.length > 0) {
        throw new HttpError(400, 'unknown voice channels: ' + unknownChannels.join(', '));
      }
    }

    return {
      guildId,
      config: await this.poolStore.setGuild(guildId, config),
    };
  }

  private async assignPoolWorker(sourceWorkerId: string, input: unknown) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new HttpError(400, 'assignment request must be an object');
    }

    const body = input as {
      guildId?: unknown;
      voiceChannelId?: unknown;
      mode?: unknown;
    };

    if (typeof body.guildId !== 'string' || !/^\d{10,32}$/u.test(body.guildId)) {
      throw new HttpError(400, 'guildId is invalid');
    }

    if (typeof body.voiceChannelId !== 'string' || !/^\d{10,32}$/u.test(body.voiceChannelId)) {
      throw new HttpError(400, 'voiceChannelId is invalid');
    }

    if (body.mode !== 'assign' && body.mode !== 'existing') {
      throw new HttpError(400, 'mode must be assign or existing');
    }

    const workers = await this.reachableWorkers();
    const present = workers.filter(worker => worker.status.guilds.some(guild => guild.id === body.guildId));
    if (present.length === 0) {
      throw new HttpError(404, 'no Muse worker is available in that guild');
    }

    if (!present.some(worker => worker.id === sourceWorkerId)) {
      throw new HttpError(403, 'source worker is not a member of that guild');
    }

    const config = this.poolStore.getGuild(body.guildId, present.length);
    return this.poolEngine.assign({
      guildId: body.guildId,
      voiceChannelId: body.voiceChannelId,
      currentWorkerId: sourceWorkerId,
      mode: body.mode as PoolAssignmentMode,
      config,
      workers: present,
    });
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
        throw new HttpError(400, 'unknown workers: ' + unknownIds.join(', '));
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
