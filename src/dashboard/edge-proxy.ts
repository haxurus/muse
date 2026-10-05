import {IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse, request as httpRequest} from 'node:http';
import {pipeline} from 'node:stream';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const MAX_FORWARDED_FOR_LENGTH = 512;
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Removes hop-by-hop headers, including any header named in the Connection header.
 */
export const stripHopByHop = (
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> => {
  const listed = new Set(
    (headers.connection ?? '')
      .split(',')
      .map(token => token.trim().toLowerCase())
      .filter(Boolean),
  );

  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lowerName) || listed.has(lowerName)) {
      continue;
    }

    result[lowerName] = value;
  }

  return result;
};

/**
 * Value for X-Forwarded-For: the chain set by Nginx Proxy Manager when present,
 * otherwise the address of the connecting peer. Always overwrites the client value.
 */
export const forwardedFor = (incoming: IncomingMessage): string => {
  const header = incoming.headers['x-forwarded-for'];
  const supplied = (Array.isArray(header) ? header.join(', ') : header ?? '').trim();
  if (supplied && supplied.length <= MAX_FORWARDED_FOR_LENGTH && /^[\d\s.,:a-f]+$/iu.test(supplied)) {
    return supplied;
  }

  return incoming.socket.remoteAddress ?? 'unknown';
};

export type EdgeHandler = (incoming: IncomingMessage, outgoing: ServerResponse) => void;

export const createEdgeHandler = (upstream: URL, timeoutMs = UPSTREAM_TIMEOUT_MS): EdgeHandler =>
  (incoming, outgoing) => {
    if (incoming.method === 'GET' && incoming.url === '/edge-health') {
      outgoing.writeHead(200, {'content-type': 'application/json'});
      outgoing.end('{"ok":true}');
      return;
    }

    const headers: OutgoingHttpHeaders = stripHopByHop(incoming.headers);
    headers.host = upstream.host;
    headers['x-forwarded-for'] = forwardedFor(incoming);

    const proxy = httpRequest({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: incoming.method,
      path: incoming.url,
      headers,
    });

    let failed = false;
    const fail = (): void => {
      if (failed) {
        return;
      }

      failed = true;
      proxy.destroy();

      // Once the status line has been sent the only safe signal is to abort the response.
      if (outgoing.headersSent || outgoing.destroyed) {
        outgoing.destroy();
        return;
      }

      outgoing.writeHead(502, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      outgoing.end('{"error":"dashboard unavailable"}');
    };

    proxy.setTimeout(timeoutMs, () => {
      proxy.destroy(new Error('upstream timeout'));
    });

    proxy.on('error', fail);
    outgoing.on('error', fail);

    // Abort the upstream request when the client goes away before the response completes.
    outgoing.on('close', () => {
      if (!outgoing.writableFinished) {
        failed = true;
        proxy.destroy();
      }
    });

    proxy.on('response', proxiedResponse => {
      const responseHeaders = stripHopByHop(proxiedResponse.headers);
      outgoing.writeHead(proxiedResponse.statusCode ?? 502, responseHeaders);
      pipeline(proxiedResponse, outgoing, error => {
        if (error) {
          fail();
        }
      });
    });

    pipeline(incoming, proxy, error => {
      if (error) {
        fail();
      }
    });
  };
