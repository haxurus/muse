import {IncomingMessage, ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {HttpError} from '../control/http.js';

const MAX_BODY_BYTES = 64 * 1024;

export type HttpErrorDetails = {
  retryAfterSeconds?: number;
  causeName?: string;
  causeStatus?: number;
};

/**
 * HttpError carrying optional client hints (Retry-After) and sanitized
 * diagnostics about an upstream failure (error name and HTTP status only).
 */
export class DashboardHttpError extends HttpError {
  constructor(statusCode: number, message: string, public readonly details: HttpErrorDetails = {}) {
    super(statusCode, message);
  }
}

export type UpstreamFailure = {
  name: string;
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

/**
 * Extracts the non-secret parts of a got HTTPError (or any thrown value):
 * the error name, the upstream status code, response headers and body.
 */
export const describeUpstreamError = (error: unknown): UpstreamFailure => {
  if (typeof error !== 'object' || error === null) {
    return {name: 'UnknownError', headers: {}};
  }

  const {name, response} = error as {name?: unknown; response?: unknown};
  const failure: UpstreamFailure = {
    name: typeof name === 'string' ? name : 'Error',
    headers: {},
  };

  if (typeof response !== 'object' || response === null) {
    return failure;
  }

  const {statusCode, headers, body} = response as {statusCode?: unknown; headers?: unknown; body?: unknown};
  if (typeof statusCode === 'number') {
    failure.statusCode = statusCode;
  }

  if (typeof headers === 'object' && headers !== null) {
    failure.headers = headers as Record<string, string | string[] | undefined>;
  }

  failure.body = body;
  return failure;
};

export const securityHeaders = (): Record<string, string> => ({
  'content-security-policy': 'default-src \'self\'; img-src \'self\' https://cdn.discordapp.com data:; style-src \'self\'; script-src \'self\'; connect-src \'self\'; object-src \'none\'; frame-src \'none\'; frame-ancestors \'none\'; base-uri \'none\'; form-action \'self\'',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

export const send = (
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  extraHeaders: Record<string, string | string[]> = {},
): void => {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    'cache-control': 'no-store',
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
};

export const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string | string[]> = {},
): void => {
  send(response, statusCode, 'application/json; charset=utf-8', JSON.stringify(body), extraHeaders);
};

export const redirect = (
  response: ServerResponse,
  location: string,
  cookies: string[] = [],
): void => {
  const body = 'Redirecting';
  send(response, 302, 'text/plain; charset=utf-8', body, {
    location,
    ...(cookies.length > 0 ? {'set-cookie': cookies} : {}),
  });
};

export const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
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

export const parseCookies = (request: IncomingMessage): Record<string, string> => {
  const result: Record<string, string> = {};
  const raw = request.headers.cookie;
  if (!raw) {
    return result;
  }

  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    result[key] = value;
  }

  return result;
};

export const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
