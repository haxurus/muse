import type {IncomingMessage, ServerResponse} from 'node:http';
import path from 'node:path';
import {HttpError, getPathSegments, hasBearerToken, readJsonBody, sendJson} from '../control/http.js';
import type {OrchestratorConfig} from '../orchestrator/config.js';
import type GuildGroupStore from '../orchestrator/guild-group-store.js';
import PoolCoordinator from './coordinator.js';
import PoolRoutingStore from './routing-store.js';
import WorkerPoolTransport from './transport.js';
import {poolSecret} from './runtime.js';

export default class PoolApi {
  private readonly routing: PoolRoutingStore;
  private readonly coordinator?: PoolCoordinator;
  private readonly clientToken?: string;

  constructor(private readonly config: OrchestratorConfig, groups: GuildGroupStore) {
    const workerIds = config.workers.map(worker => worker.id);
    this.routing = new PoolRoutingStore(path.join(path.dirname(config.groupsFile), 'pool-routes.json'),
      guildId => groups.list(guildId), workerIds);
    if (process.env.MUSE_POOL_ENABLED === 'true') {
      this.clientToken = poolSecret();
      this.coordinator = new PoolCoordinator(workerIds, new WorkerPoolTransport(config.workers), command => this.routing.eligible(command));
    }
  }

  assertGroupUnused(guildId: string, groupId: string): void {
    if (this.routing.referenced(guildId, groupId)) {
      throw new HttpError(409, 'Il gruppo e usato da una regola del pool. Rimuovere prima la regola.');
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const segments = getPathSegments(request);
    if (segments.join('/') === 'v1/pool/commands') {
      if (!this.coordinator || !this.clientToken) {
        throw new HttpError(503, 'Pool non abilitato.');
      }

      if (!hasBearerToken(request, this.clientToken)) {
        throw new HttpError(401, 'unauthorized');
      }

      if (request.method !== 'POST') {
        throw new HttpError(405, 'Metodo non consentito.');
      }

      sendJson(response, 200, await this.coordinator.execute(await readJsonBody(request)));
      return true;
    }

    if (segments.length !== 4 || segments[0] !== 'v1' || segments[1] !== 'guilds' || segments[3] !== 'routing') {
      return false;
    }

    // The controller playback credential is deliberately insufficient here.
    if (!hasBearerToken(request, this.config.apiToken)) {
      throw new HttpError(401, 'unauthorized');
    }

    const guildId = segments[2];
    if (request.method === 'GET') {
      sendJson(response, 200, {guildId, routing: this.routing.get(guildId)});
    } else if (request.method === 'PATCH') {
      sendJson(response, 200, {guildId, routing: this.routing.set(guildId, await readJsonBody(request))});
    } else {
      throw new HttpError(405, 'Metodo non consentito.');
    }

    return true;
  }
}
