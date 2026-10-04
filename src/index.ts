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
import {Server} from 'node:http';
import {startWorkerControlServer} from './worker-control/server.js';

const bot = container.get<Bot>(TYPES.Bot);
let shuttingDown = false;
let workerControlServer: Server | null = null;

const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  try {
    bot.shutdown();
    container.get<PlayerManager>(TYPES.Managers.Player).cleanup();

    if (workerControlServer) {
      const server = workerControlServer;
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      workerControlServer = null;
    }

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

  workerControlServer = startWorkerControlServer({
    config,
    client: container.get<Client>(TYPES.Client),
    playerManager: container.get<PlayerManager>(TYPES.Managers.Player),
  });

  installSignalHandlers();
  await bot.register();
};

export {startBot};
