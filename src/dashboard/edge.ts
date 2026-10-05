import {createServer} from 'node:http';
import {createEdgeHandler} from './edge-proxy.js';

const host = process.env.MUSE_DASHBOARD_EDGE_HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.MUSE_DASHBOARD_EDGE_PORT ?? '8080', 10);
const upstream = new URL(process.env.MUSE_DASHBOARD_UPSTREAM ?? 'http://dashboard:3000');
const SHUTDOWN_GRACE_MS = 10_000;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('MUSE_DASHBOARD_EDGE_PORT must be a valid TCP port');
}

if (upstream.protocol !== 'http:' || upstream.hostname !== 'dashboard' || upstream.pathname !== '/') {
  throw new Error('MUSE_DASHBOARD_UPSTREAM must be the internal dashboard service');
}

const server = createServer(createEdgeHandler(upstream));
let shuttingDown = false;

const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down dashboard edge...`);

  const forceExit = setTimeout(() => {
    console.error('Dashboard edge shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  server.close(error => {
    if (error) {
      console.error(`Dashboard edge shutdown failed: ${error.name}`);
      process.exit(1);
    }

    process.exit(0);
  });
};

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal);
  });
}

server.listen(port, host, () => {
  console.log(`Muse dashboard edge listening on ${host}:${port}`);
});
