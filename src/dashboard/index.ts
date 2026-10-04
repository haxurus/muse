import DashboardServer from './server.js';
import {loadDashboardConfig} from './config.js';

const server = new DashboardServer(loadDashboardConfig());
let shuttingDown = false;

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down dashboard...`);

  try {
    await server.close();
  } catch {
    console.error('Dashboard shutdown failed');
    process.exitCode = 1;
  }
};

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit());
  });
}

void server.start().catch(() => {
  console.error('Failed to start dashboard');
  process.exit(1);
});
