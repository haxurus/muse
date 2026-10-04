import {IncomingMessage, ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {HttpError} from '../control/http.js';

const MAX_BODY_BYTES = 64 * 1024;

export const securityHeaders = (): Record<string, string> => ({
  'content-security-policy': "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

export const sendJson = (response: ServerResponse, statusCode: number, body: unknown): void => {
  send(response, statusCode, 'application/json; charset=utf-8', JSON.stringify(body));
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
