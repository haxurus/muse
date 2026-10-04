import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {Client} from 'discord.js';
import PlayerManager from '../managers/player.js';
import Config from '../services/config.js';
import {normalizeSettingsPatch, resolveEffectiveSettings} from '../control/settings.js';
import {verifyControlRequest} from '../control/signature.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {prisma} from '../utils/db.js';

const MAX_BODY_BYTES = 64 * 1024;

const sendJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
};

const readBody = async (request: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  let size = 0;

  request.setEncoding('utf8');
  request.on('data', chunk => {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) {
      reject(new Error('request body too large'));
      request.destroy();
      return;
    }

    body += chunk;
  });
  request.once('end', () => {
    resolve(body);
  });
  request.once('error', reject);
});

const settingsResponse = async (guildId: string) => {
  const settings = await getGuildSettings(guildId);
  return {
    playlistLimit: settings.playlistLimit,
    secondsToWaitAfterQueueEmpties: settings.secondsToWaitAfterQueueEmpties,
    leaveIfNoListeners: settings.leaveIfNoListeners,
    queueAddResponseEphemeral: settings.queueAddResponseEphemeral,
    autoAnnounceNextSong: settings.autoAnnounceNextSong,
    defaultVolume: settings.defaultVolume,
    defaultQueuePageSize: settings.defaultQueuePageSize,
    turnDownVolumeWhenPeopleSpeak: settings.turnDownVolumeWhenPeopleSpeak,
    turnDownVolumeWhenPeopleSpeakTarget: settings.turnDownVolumeWhenPeopleSpeakTarget,
    enableSponsorBlock: settings.enableSponsorBlock,
  };
};

const authenticate = (
  request: IncomingMessage,
  config: Config,
  requestPath: string,
  body: string,
) => verifyControlRequest({
  secret: config.WORKER_CONTROL_SECRET,
  method: request.method ?? 'GET',
  requestPath,
  body,
  timestampHeader: typeof request.headers['x-muse-timestamp'] === 'string'
    ? request.headers['x-muse-timestamp']
    : undefined,
  signatureHeader: typeof request.headers['x-muse-signature'] === 'string'
    ? request.headers['x-muse-signature']
    : undefined,
});

export const startWorkerControlServer = ({
  config,
  client,
  playerManager,
}: {
  config: Config;
  client: Client;
  playerManager: PlayerManager;
}): Server | null => {
  if (!config.WORKER_CONTROL_ENABLED) {
    return null;
  }

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://worker.local');
      const requestPath = `${requestUrl.pathname}${requestUrl.search}`;

      if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
        sendJson(response, 200, {
          ok: true,
          workerId: config.WORKER_ID,
          discordReady: client.isReady(),
        });
        return;
      }

      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await readBody(request);
      if (!authenticate(request, config, requestPath, body)) {
        sendJson(response, 401, {error: 'unauthorized'});
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/v1/status') {
        sendJson(response, 200, {
          workerId: config.WORKER_ID,
          label: config.WORKER_LABEL,
          discordReady: client.isReady(),
          discordUserId: client.user?.id ?? null,
          guilds: client.guilds.cache.map(guild => ({
            guildId: guild.id,
            name: guild.name,
          })),
          players: playerManager.snapshot(),
        });
        return;
      }

      const settingsMatch = /^\/v1\/guilds\/(\d+)\/settings$/u.exec(requestUrl.pathname);
      if (settingsMatch && request.method === 'GET') {
        sendJson(response, 200, {settings: await settingsResponse(settingsMatch[1]), enabled: (await getGuildSettings(settingsMatch[1])).orchestratorEnabled});
        return;
      }

      if (settingsMatch && request.method === 'PUT') {
        const payload = JSON.parse(body) as {settings?: unknown; enabled?: unknown};
        const patch = normalizeSettingsPatch(payload.settings);
        const effective = resolveEffectiveSettings(patch);
        if (typeof payload.enabled !== 'undefined' && typeof payload.enabled !== 'boolean') {
          throw new Error('enabled must be a boolean');
        }

        await getGuildSettings(settingsMatch[1]);
        await prisma.setting.update({
          where: {guildId: settingsMatch[1]},
          data: {
            ...effective,
            ...(typeof payload.enabled === 'boolean' ? {orchestratorEnabled: payload.enabled} : {}),
          },
        });

        sendJson(response, 200, {settings: await settingsResponse(settingsMatch[1])});
        return;
      }

      const disconnectMatch = /^\/v1\/guilds\/(\d+)\/disconnect$/u.exec(requestUrl.pathname);
      if (disconnectMatch && request.method === 'POST') {
        const player = playerManager.getExisting(disconnectMatch[1]);
        player?.disconnect();
        sendJson(response, 200, {ok: true});
        return;
      }

      sendJson(response, 404, {error: 'not found'});
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'request failed';
      sendJson(response, 400, {error: message.slice(0, 300)});
    }
  });

  server.listen(config.WORKER_CONTROL_PORT, '0.0.0.0', () => {
    console.log(`Worker control API listening on port ${config.WORKER_CONTROL_PORT}`);
  });

  return server;
};
