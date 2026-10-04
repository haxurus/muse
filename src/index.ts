import makeDir from 'make-dir';
import path from 'path';
import container from './inversify.config.js';
import {TYPES} from './types.js';
import Bot from './bot.js';
import Config from './services/config.js';
import FileCacheProvider from './services/file-cache.js';
import PlayerManager from './managers/player.js';
import ThirdParty from './services/third-party.js';
import AddQueryToQueue from './services/add-query-to-queue.js';
import prepareYtDlp from './utils/prepare-yt-dlp.js';
import {prisma} from './utils/db.js';
import {Client} from 'discord.js';
import WorkerControlServer from './control/worker-server.js';
import PoolWorker from './pool/worker.js';
import PoolDiscordGateway from './pool/discord-gateway.js';
import {poolRole} from './pool/runtime.js';

let bot: Bot | PoolDiscordGateway = container.get<Bot>(TYPES.Bot);
let shuttingDown = false;
let workerControlServer: WorkerControlServer | undefined;
let poolWorker: PoolWorker | undefined;

const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  try {
    poolWorker?.close();
    await bot.shutdown();
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
  const config = container.get<Config>(TYPES.Config);
  await makeDir(config.DATA_DIR);
  await makeDir(config.CACHE_DIR);
  await makeDir(path.join(config.CACHE_DIR, 'tmp'));
  await container.get<FileCacheProvider>(TYPES.FileCache).cleanup();
  await prepareYtDlp(config);

  if (poolRole() !== 'off') {
    if (!config.WORKER_ID || !config.CONTROL_TOKEN) {
      throw new Error('Pool mode requires a managed worker identity and control token');
    }

    const client = container.get<Client>(TYPES.Client);
    poolWorker = new PoolWorker(config.WORKER_ID, {
      client,
      players: container.get<PlayerManager>(TYPES.Managers.Player),
      media: container.get<AddQueryToQueue>(TYPES.Services.AddQueryToQueue),
    });
    bot = new PoolDiscordGateway(config, client, guildId => {
      poolWorker!.invalidate(guildId);
    });
  }

  if (config.WORKER_ID) {
    workerControlServer = new WorkerControlServer(
      config,
      container.get<Client>(TYPES.Client),
      container.get<PlayerManager>(TYPES.Managers.Player),
      poolWorker,
    );
    await workerControlServer.start();
  }

  installSignalHandlers();
  await bot.register();
};

export {startBot};
