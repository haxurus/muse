import got from 'got';
import {HttpError} from '../control/http.js';
import type {WorkerDefinition} from '../orchestrator/config.js';
import type {PoolTransport} from './coordinator.js';
import {COMMAND_TTL_MS, isDiscordId, isUuid, objectBody, type PlaybackEnvelope, type PlaybackReply, type PlaybackState} from './protocol.js';

const options = (token: string, timeout: number) => ({
  headers: {authorization: `Bearer ${token}`},
  retry: {limit: 0},
  followRedirect: false,
  timeout: {request: timeout},
});

export const readPlaybackReply = (input: unknown): PlaybackReply => {
  const body = objectBody(input);
  if (!isDiscordId(body.requestId) || !isDiscordId(body.guildId) || typeof body.workerId !== 'string'
    || typeof body.text !== 'string' || body.text.length > 1900) {
    throw new HttpError(502, 'Risposta del pool non valida.');
  }

  return {requestId: body.requestId, guildId: body.guildId, workerId: body.workerId, text: body.text};
};

const assertSuccess = (statusCode: number, input: unknown): void => {
  if (statusCode === 200) {
    return;
  }

  const value = objectBody(input);
  const status = [400, 401, 403, 404, 409, 422, 429].includes(statusCode) ? statusCode : 503;
  const message = typeof value.error === 'string' ? value.error.slice(0, 300) : 'Servizio del pool non disponibile.';
  throw new HttpError(status, message);
};

export const postPoolJson = async (url: string, token: string, body: unknown): Promise<PlaybackReply> => {
  const response = await got.post(url, {
    ...options(token, COMMAND_TTL_MS + 10_000),
    json: body, responseType: 'json', throwHttpErrors: false,
  });
  assertSuccess(response.statusCode, response.body);
  return readPlaybackReply(response.body);
};

export const readPlaybackState = (input: unknown, workerId: string, guildId: string): PlaybackState => {
  const body = objectBody(input);
  if (body.workerId !== workerId || body.guildId !== guildId || !isUuid(body.instanceId)
    || ['present', 'ready', 'connected', 'busy'].some(key => typeof body[key] !== 'boolean')
    || (body.channelId !== null && !isDiscordId(body.channelId))
    || (body.leaseId !== null && !isUuid(body.leaseId))
    || !['PLAYING', 'PAUSED', 'IDLE'].includes(body.status as string)) {
    throw new HttpError(502, 'Stato del worker non valido.');
  }

  return {
    workerId, guildId, instanceId: body.instanceId,
    present: body.present as boolean, ready: body.ready as boolean,
    connected: body.connected as boolean, busy: body.busy as boolean,
    channelId: body.channelId, leaseId: body.leaseId,
    status: body.status as PlaybackState['status'],
  };
};

export default class WorkerPoolTransport implements PoolTransport {
  private readonly workers: Map<string, WorkerDefinition>;

  constructor(workers: WorkerDefinition[]) {
    this.workers = new Map(workers.map(worker => [worker.id, worker]));
  }

  async state(workerId: string, guildId: string): Promise<PlaybackState> {
    const worker = this.workers.get(workerId)!;
    const body = await got.get(`${worker.baseUrl}/v1/guilds/${guildId}/playback`, options(worker.token, 3000)).json<unknown>();
    return readPlaybackState(body, workerId, guildId);
  }

  async reserve(workerId: string, envelope: PlaybackEnvelope): Promise<PlaybackState> {
    const worker = this.workers.get(workerId)!;
    const {guildId} = envelope.command;
    const response = await got.post(`${worker.baseUrl}/v1/guilds/${guildId}/playback/reserve`, {
      ...options(worker.token, 5000),
      json: envelope, responseType: 'json', throwHttpErrors: false,
    });
    assertSuccess(response.statusCode, response.body);
    return readPlaybackState(response.body, workerId, guildId);
  }

  async execute(workerId: string, envelope: PlaybackEnvelope): Promise<PlaybackReply> {
    const worker = this.workers.get(workerId)!;
    return postPoolJson(`${worker.baseUrl}/v1/guilds/${envelope.command.guildId}/playback`, worker.token, envelope);
  }
}
