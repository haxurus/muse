import {IncomingMessage, ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';

const MAX_JSON_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
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

export const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_JSON_BODY_BYTES) {
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
