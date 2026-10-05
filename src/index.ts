import makeDir from 'make-dir';
import path from 'path';
import container from './inversify.config.js';
import {TYPES} from './types.js';
import Bot from './bot.js';
import Config from './services/config.js';
import FileCacheProvider from './services/file-cache.js';
import PlayerManager from './managers/player.js';
import ThirdParty from './services/third-party.js';
import prepareYtDlp from './utils/prepare-yt-dlp.js';
import {prisma} from './utils/db.js';
import {Client} from 'discord.js';
import WorkerControlServer from './control/worker-server.js';
import AddQueryToQueue from './services/add-query-to-queue.js';
import PlaybackWorker from './playback/worker.js';
import {isPlaybackWorkerEnabled} from './playback/protocol.js';

const bot = container.get<Bot>(TYPES.Bot);
let shuttingDown = false;
let workerControlServer: WorkerControlServer | undefined;

// Docker's stop grace period is 30s for workers; leave room for Prisma to disconnect.
const CONTROL_DRAIN_TIMEOUT_MS = 5000;
const PRISMA_DISCONNECT_TIMEOUT_MS = 3000;

const settleWithin = async (promise: Promise<unknown>, timeoutMs: number) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });

  try {
    await Promise.race([promise.catch((error: unknown) => {
      console.error('Shutdown step failed:', error);
    }), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  try {
    // Stop accepting control requests first; in-flight playback gets a short drain window
    // instead of holding shutdown until Docker sends SIGKILL.
    if (workerControlServer) {
      await settleWithin(workerControlServer.close(), CONTROL_DRAIN_TIMEOUT_MS);
    }

    bot.shutdown();
    container.get<PlayerManager>(TYPES.Managers.Player).cleanup();

    if (container.isBound(TYPES.ThirdParty)) {
      container.get<ThirdParty>(TYPES.ThirdParty).cleanup();
    }

    await settleWithin(prisma.$disconnect(), PRISMA_DISCONNECT_TIMEOUT_MS);
  } catch (error: unknown) {
    console.error('Graceful shutdown failed:', error);
    process.exitCode = 1;
  }
};

const installSignalHandlers = () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(signal).finally(() => process.exit());
    });
  }
};

const installUnhandledRejectionLogger = () => {
  // Keep this idempotent across repeated module loads (tests reset modules).
  const marker = globalThis as typeof globalThis & {museUnhandledRejectionLoggerInstalled?: boolean};
  if (marker.museUnhandledRejectionLoggerInstalled) {
    return;
  }

  marker.museUnhandledRejectionLoggerInstalled = true;
  // A stray rejection from an event listener should be visible, not crash every guild's playback.
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled promise rejection:', reason);
  });
};

const startBot = async () => {
  installUnhandledRejectionLogger();
  // Install before slow startup steps (yt-dlp preparation can take minutes) so SIGTERM still cleans up.
  installSignalHandlers();

  // Create data directories if necessary
  const config = container.get<Config>(TYPES.Config);

  await makeDir(config.DATA_DIR);
  await makeDir(config.CACHE_DIR);
  await makeDir(path.join(config.CACHE_DIR, 'tmp'));

  await container.get<FileCacheProvider>(TYPES.FileCache).cleanup();
  await prepareYtDlp(config);

  if (config.WORKER_ID) {
    const client = container.get<Client>(TYPES.Client);
    const players = container.get<PlayerManager>(TYPES.Managers.Player);
    const playback = isPlaybackWorkerEnabled(config.WORKER_ID)
      ? new PlaybackWorker(
        client,
        players,
        container.get<AddQueryToQueue>(TYPES.Services.AddQueryToQueue),
        config.WORKER_ID,
      )
      : undefined;
    workerControlServer = new WorkerControlServer(config, client, players, playback);
    await workerControlServer.start();
  }

  await bot.register();
};

export {startBot};
