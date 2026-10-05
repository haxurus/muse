import type {IncomingMessage, ServerResponse} from 'node:http';
import {HttpError, hasBearerToken, readJsonBody, sendJson} from '../control/http.js';
import type {OrchestratorConfig} from '../orchestrator/config.js';
import {
  PLAYBACK_OUTCOME_UNKNOWN_MESSAGE,
  PLAYBACK_OUTCOME_UNKNOWN_STATUS,
  isPlaybackWorkerEnabled,
  parsePlaybackRequest,
  type PlaybackRequest,
  type PlaybackResult,
  type PlaybackWorkerId,
} from './protocol.js';

const SAFE_STATUS_MESSAGES: Record<number, string> = {
  400: 'Invalid playback request.',
  401: 'Playback service authentication failed.',
  403: 'You must still be in the requested voice channel and have access to it.',
  404: 'The requested playback service or channel is unavailable.',
  409: 'The bot is busy or belongs to another voice channel in this server.',
  429: 'Too many playback requests. Try again later.',
  502: 'Playback failed. Check the worker status before retrying.',
  503: 'The bot is not ready. Try again later.',
  [PLAYBACK_OUTCOME_UNKNOWN_STATUS]: PLAYBACK_OUTCOME_UNKNOWN_MESSAGE,
};

/** Client errors whose short, plain-text message from the trusted hop may be shown to the user verbatim. */
const PASS_THROUGH_STATUSES = new Set([400, 403, 404, 409, 422, 429]);

const isSafeErrorMessage = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0
  && value.length <= 200
  && !value.includes('://')
  && /^[^\p{Cc}]+$/u.test(value);

const errorMessageFor = (status: number, text: string): string => {
  if (PASS_THROUGH_STATUSES.has(status)) {
    try {
      const {error} = JSON.parse(text) as {error?: unknown};
      if (isSafeErrorMessage(error)) {
        return error;
      }
    } catch {}
  }

  return SAFE_STATUS_MESSAGES[status] ?? 'Playback request failed.';
};

/** Fixed internal destinations only. Never retry a timed-out audio mutation locally. */
export const sendPlayback = async (url: string, token: string, body: PlaybackRequest, expectedWorkerId: PlaybackWorkerId = 'muse-01'): Promise<PlaybackResult> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(180_000),
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify(body),
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Missing playback response');
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      size += chunk.value.byteLength;
      if (size > 8192) {
        // Cancel this single response stream before rejecting it.
        // eslint-disable-next-line no-await-in-loop
        await reader.cancel();
        throw new Error('Oversized playback response');
      }

      chunks.push(chunk.value);
    }

    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      throw new HttpError(response.status, errorMessageFor(response.status, text));
    }

    const payload = JSON.parse(text) as Partial<PlaybackResult>;
    if (payload.workerId !== expectedWorkerId || payload.guildId !== body.guildId || payload.requestId !== body.requestId
      || typeof payload.message !== 'string' || payload.message.length > 1900
      || !['FREE', 'PLAYING', 'PAUSED', 'IDLE'].includes(payload.state ?? '')
      || (payload.channelId !== null && typeof payload.channelId !== 'string')) {
      throw new Error('Invalid playback response');
    }

    return payload as PlaybackResult;
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      throw error;
    }

    // Timeouts, resets and malformed responses leave the mutation outcome unknown.
    throw new HttpError(PLAYBACK_OUTCOME_UNKNOWN_STATUS, PLAYBACK_OUTCOME_UNKNOWN_MESSAGE);
  }
};

export const handlePlaybackProxy = async (
  request: IncomingMessage,
  response: ServerResponse,
  config: OrchestratorConfig,
): Promise<boolean> => {
  if (request.url !== '/v1/playback') {
    return false;
  }

  const enabledWorkers = config.workers.filter(worker => isPlaybackWorkerEnabled(worker.id));
  if (enabledWorkers.length === 0) {
    return false;
  }

  const authenticatedWorkers = enabledWorkers.filter(worker => hasBearerToken(request, worker.token));
  if (authenticatedWorkers.length !== 1) {
    throw new HttpError(401, 'Unauthorized playback controller.');
  }

  const worker = authenticatedWorkers[0];
  if (request.method !== 'POST') {
    throw new HttpError(405, 'Method not allowed.');
  }

  const body = parsePlaybackRequest(await readJsonBody(request));
  sendJson(
    response,
    200,
    await sendPlayback(`${worker.baseUrl}/v1/playback`, worker.token, body, worker.id as PlaybackWorkerId),
  );
  return true;
};
