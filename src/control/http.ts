import {IncomingMessage, ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';

export const MAX_JSON_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  /** `code` is an optional machine-readable UPPER_SNAKE_CASE identifier sent next to `error`. */
  constructor(public readonly statusCode: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const sendJson = (response: ServerResponse, statusCode: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
};

/** Error body shape shared by the control and orchestrator APIs: `{error, code?}`. */
export const errorBody = (error: HttpError): {error: string; code?: string} =>
  error.code === undefined ? {error: error.message} : {error: error.message, code: error.code};

export const readJsonBody = async (request: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new HttpError(413, 'request body too large');
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
};

export const hasBearerToken = (request: IncomingMessage, expectedToken: string): boolean => {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return false;
  }

  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};

export const getPathSegments = (request: IncomingMessage): string[] => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  return url.pathname.split('/').filter(Boolean);
};
