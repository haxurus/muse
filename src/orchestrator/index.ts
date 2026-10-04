import OrchestratorServer from './server.js';
import {loadOrchestratorConfig} from './config.js';

const server = new OrchestratorServer(loadOrchestratorConfig());
let shuttingDown = false;

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down orchestrator...`);

  try {
    await server.close();
  } catch (error: unknown) {
    console.error('Orchestrator shutdown failed:', error);
    process.exitCode = 1;
  }
};

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit());
  });
}

void server.start().catch((error: unknown) => {
  console.error('Failed to start orchestrator:', error);
  process.exit(1);
});
