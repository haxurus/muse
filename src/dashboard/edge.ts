import {createServer, request as httpRequest} from 'node:http';

const host = process.env.MUSE_DASHBOARD_EDGE_HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.MUSE_DASHBOARD_EDGE_PORT ?? '8080', 10);
const upstream = new URL(process.env.MUSE_DASHBOARD_UPSTREAM ?? 'http://dashboard:3000');

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('MUSE_DASHBOARD_EDGE_PORT must be a valid TCP port');
}

if (upstream.protocol !== 'http:' || upstream.hostname !== 'dashboard' || upstream.pathname !== '/') {
  throw new Error('MUSE_DASHBOARD_UPSTREAM must be the internal dashboard service');
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const server = createServer((incoming, outgoing) => {
  if (incoming.method === 'GET' && incoming.url === '/edge-health') {
    outgoing.writeHead(200, {'content-type': 'application/json'});
    outgoing.end('{"ok":true}');
    return;
  }

  const headers: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }

  headers.host = upstream.host;

  const proxy = httpRequest({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: incoming.method,
    path: incoming.url,
    headers,
  }, proxiedResponse => {
    const responseHeaders: Record<string, string | string[] | undefined> = {};
    for (const [name, value] of Object.entries(proxiedResponse.headers)) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) {
        responseHeaders[name] = value;
      }
    }

    outgoing.writeHead(proxiedResponse.statusCode ?? 502, responseHeaders);
    proxiedResponse.pipe(outgoing);
  });

  proxy.setTimeout(30_000, () => {
    proxy.destroy(new Error('upstream timeout'));
  });

  proxy.on('error', () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
    }

    outgoing.end('{"error":"dashboard unavailable"}');
  });

  incoming.pipe(proxy);
});

server.listen(port, host, () => {
  console.log(`Muse dashboard edge listening on ${host}:${port}`);
});
