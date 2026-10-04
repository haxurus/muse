import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {IncomingMessage, ServerResponse} from 'node:http';
import got from 'got';
import {HttpError} from '../control/http.js';
import {isDiscordId, objectBody} from '../pool/protocol.js';
import type DashboardAuth from './auth.js';
import type {DashboardConfig} from './config.js';
import type OrchestratorClient from './orchestrator-client.js';
import {readJsonBody, send, sendJson} from './http.js';

export default class DashboardPoolApi {
  constructor(
    private readonly config: DashboardConfig,
    private readonly auth: DashboardAuth,
    private readonly orchestrator: OrchestratorClient,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const {pathname} = new URL(request.url ?? '/', this.config.publicUrl);
    if (request.method === 'GET' && (pathname === '/pool' || pathname === '/assets/pool-routing.js')) {
      const html = pathname === '/pool';
      const body = readFileSync(path.join(process.cwd(), 'dashboard', html ? 'pool.html' : 'pool-routing.js'), 'utf8');
      send(response, 200, html ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', body);
      return true;
    }

    const segments = pathname.split('/').filter(Boolean);
    if (segments.length !== 4 || segments[0] !== 'api' || segments[1] !== 'guilds' || segments[3] !== 'routing') {
      return false;
    }

    const guildId = segments[2];
    if (!isDiscordId(guildId) || !['GET', 'PATCH'].includes(request.method ?? '')) {
      throw new HttpError(400, 'Richiesta non valida.');
    }

    const session = this.auth.requireSession(request);
    const mutation = request.method === 'PATCH';
    if (mutation) {
      this.auth.assertCsrf(request, session);
      this.auth.assertMutationAllowed(session);
    }

    const guilds = await this.auth.manageableGuilds(session, mutation);
    if (!guilds.some(guild => guild.id === guildId)) {
      throw new HttpError(403, 'Non puoi amministrare questo server Discord.');
    }

    const available = await this.orchestrator.guilds();
    if (!available.guilds.some(guild => guild.id === guildId)) {
      throw new HttpError(404, 'Muse non disponibile in questo server.');
    }

    const body = mutation ? objectBody(await readJsonBody(request)) : undefined;
    const result = await got(`${this.config.orchestratorUrl}/v1/guilds/${guildId}/routing`, {
      method: mutation ? 'PATCH' : 'GET',
      headers: {authorization: `Bearer ${this.config.orchestratorToken}`},
      ...(body === undefined ? {} : {json: body}),
      retry: {limit: 0}, followRedirect: false,
      timeout: {request: 5000}, responseType: 'json', throwHttpErrors: false,
    });
    if (result.statusCode !== 200) {
      const status = [400, 403, 404, 409, 429].includes(result.statusCode) ? result.statusCode : 503;
      const error = objectBody(result.body).error;
      throw new HttpError(status, typeof error === 'string' ? error.slice(0, 300) : 'Regole del pool non disponibili.');
    }

    const value = objectBody(result.body);
    if (value.guildId !== guildId) {
      throw new HttpError(502, 'Risposta del server non valida.');
    }

    sendJson(response, 200, value);
    return true;
  }
}
