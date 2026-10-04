import path from 'node:path';
import makeDir from 'make-dir';
import {execa, ExecaError} from 'execa';

const dataDir = path.resolve(process.env.ORCHESTRATOR_DATA_DIR ?? '/control');
process.env.DATABASE_URL = process.env.DATABASE_URL ?? `file:${path.join(dataDir, 'db.sqlite')}`;

const main = async () => {
  await makeDir(dataDir);

  try {
    await execa('prisma', ['migrate', 'deploy'], {preferLocal: true});
  } catch (error: unknown) {
    const detail = (error as ExecaError).stderr ?? (error instanceof Error ? error.message : String(error));
    console.error('Failed to apply orchestrator database migrations:', detail);
    process.exit(1);
  }

  const [{default: OrchestratorConfig}, {startOrchestratorServer}, {prisma}] = await Promise.all([
    import('../orchestrator/config.js'),
    import('../orchestrator/server.js'),
    import('../utils/db.js'),
  ]);

  const config = new OrchestratorConfig();
  const orchestrator = startOrchestratorServer(config);
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}, shutting down orchestrator...`);

    try {
      await orchestrator.close();
      await prisma.$disconnect();
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
};

void main().catch(error => {
  console.error('Orchestrator startup failed:', error);
  process.exit(1);
});
