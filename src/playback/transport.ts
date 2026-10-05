import type {IncomingMessage, ServerResponse} from 'node:http';
import {HttpError, hasBearerToken, readJsonBody, sendJson} from '../control/http.js';
import type {OrchestratorConfig} from '../orchestrator/config.js';
import {parsePlaybackRequest, type PlaybackRequest, type PlaybackResult} from './protocol.js';

/** Fixed internal destinations only. Never retry a timed-out audio mutation locally. */
export const sendPlayback = async (url: string, token: string, body: PlaybackRequest): Promise<PlaybackResult> => {
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
        await reader.cancel();
        throw new Error('Oversized playback response');
      }

      chunks.push(chunk.value);
    }

    const text = Buffer.concat(chunks).toString('utf8');
    const payload = JSON.parse(text) as Partial<PlaybackResult> & {error?: unknown};
    if (!response.ok) {
      const safeMessages: Record<number, string> = {
        400: 'Invalid playback request.',
        401: 'Playback service authentication failed.',
        403: 'You must still be in the requested voice channel and have access to it.',
        404: 'The requested playback service or channel is unavailable.',
        409: 'The bot is busy or belongs to another voice channel in this server.',
        429: 'Too many playback requests. Try again later.',
        502: 'Playback failed. Check the worker status before retrying.',
        503: 'The bot is not ready. Try again later.',
      };
      throw new HttpError(response.status, safeMessages[response.status] ?? 'Playback request failed.');
    }

    if (payload.workerId !== 'muse-01' || payload.guildId !== body.guildId || payload.requestId !== body.requestId
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

    throw new HttpError(503, 'Playback outcome could not be confirmed. No local fallback or automatic replay was attempted.');
  }
};

export const handleBotOneProxy = async (
  request: IncomingMessage,
  response: ServerResponse,
  config: OrchestratorConfig,
): Promise<boolean> => {
  if (request.url !== '/v1/playback' || process.env.MUSE_BOT_ONE_PLAYBACK !== 'true') {
    return false;
  }

  const worker = config.workers.find(candidate => candidate.id === 'muse-01');
  if (!worker || !hasBearerToken(request, worker.token)) {
    throw new HttpError(401, 'Unauthorized playback controller.');
  }

  if (request.method !== 'POST') {
    throw new HttpError(405, 'Method not allowed.');
  }

  const body = parsePlaybackRequest(await readJsonBody(request));
  sendJson(response, 200, await sendPlayback(`${worker.baseUrl}/v1/playback`, worker.token, body));
  return true;
};
