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
import BotOnePlaybackWorker from './playback/worker.js';
import {isPlaybackWorkerEnabled} from './playback/protocol.js';

const bot = container.get<Bot>(TYPES.Bot);
let shuttingDown = false;
let workerControlServer: WorkerControlServer | undefined;

const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  try {
    bot.shutdown();
    await workerControlServer?.close();
    container.get<PlayerManager>(TYPES.Managers.Player).cleanup();

    if (container.isBound(TYPES.ThirdParty)) {
      container.get<ThirdParty>(TYPES.ThirdParty).cleanup();
    }

    await prisma.$disconnect();
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

const startBot = async () => {
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
      ? new BotOnePlaybackWorker(
        client,
        players,
        container.get<AddQueryToQueue>(TYPES.Services.AddQueryToQueue),
        config.WORKER_ID,
      )
      : undefined;
    workerControlServer = new WorkerControlServer(config, client, players, playback);
    await workerControlServer.start();
  }

  installSignalHandlers();
  await bot.register();
};

export {startBot};
