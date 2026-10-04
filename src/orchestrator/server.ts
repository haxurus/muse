import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import OrchestratorConfig from './config.js';
import {
  beginDiscordLogin,
  completeDiscordLogin,
  DashboardSession,
  getSession,
  logout,
  requireCsrf,
  requireGuildAccess,
} from './auth.js';
import {renderDashboard, renderLogin} from './dashboard.js';
import {
  createGroup,
  getGuildControlState,
  getPoolSnapshot,
  patchGroup,
  patchGuildControl,
  patchWorkerAssignment,
  patchWorkersBulk,
  reconcileAllGuilds,
  reconcileGuild,
  removeGroup,
} from './store.js';
import {disconnectWorkerFromGuild} from './worker-client.js';

const MAX_BODY_BYTES = 64 * 1024;
const rateLimits = new Map<string, {windowStart: number; reads: number; writes: number}>();

const securityHeaders = (response: ServerResponse, nonce: string) => {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'`,
  );
};

const sendJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
};

const sendHtml = (response: ServerResponse, statusCode: number, html: string) => {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
};

const readBody = async (request: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
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
  request.once('error', reject);
  request.once('end', () => {
    if (body === '') {
      resolve({});
      return;
    }

    try {
      resolve(JSON.parse(body) as unknown);
    } catch {
      reject(new Error('invalid JSON body'));
    }
  });
});

const requireSession = (request: IncomingMessage): DashboardSession => {
  const session = getSession(request);
  if (!session) {
    throw new Error('unauthorized');
  }

  return session;
};

const enforceRateLimit = (session: DashboardSession, write: boolean) => {
  const now = Date.now();
  const current = rateLimits.get(session.id);
  const entry = !current || current.windowStart + 60_000 <= now
    ? {windowStart: now, reads: 0, writes: 0}
    : current;

  if (write) {
    entry.writes++;
  } else {
    entry.reads++;
  }

  rateLimits.set(session.id, entry);
  if (entry.reads > 180 || entry.writes > 60) {
    throw new Error('rate limit exceeded');
  }
};

const guildContext = (
  session: DashboardSession,
  guildId: string,
) => {
  const guild = requireGuildAccess(session, guildId);
  return {guild, guildName: guild.name};
};

const isMutation = (method: string | undefined) => !['GET', 'HEAD', 'OPTIONS'].includes(method ?? 'GET');

export const startOrchestratorServer = (config: OrchestratorConfig) => {
  const workerIds = new Set(config.WORKERS.map(worker => worker.id));
  let reconciling = false;

  const server = createServer(async (request, response) => {
    const nonce = randomBytes(18).toString('base64');
    securityHeaders(response, nonce);

    try {
      const requestUrl = new URL(request.url ?? '/', config.PUBLIC_BASE_URL);

      if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
        sendJson(response, 200, {ok: true, workersConfigured: config.WORKERS.length});
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/auth/login') {
        beginDiscordLogin(response, config);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/auth/callback') {
        await completeDiscordLogin(response, config, requestUrl);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/auth/logout') {
        logout(request, response, config);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/') {
        const session = getSession(request);
        sendHtml(response, 200, session ? renderDashboard(nonce) : renderLogin(nonce));
        return;
      }

      if (!requestUrl.pathname.startsWith('/api/')) {
        sendJson(response, 404, {error: 'not found'});
        return;
      }

      const session = requireSession(request);
      const mutation = isMutation(request.method);
      enforceRateLimit(session, mutation);
      if (mutation) {
        requireCsrf(request, session);
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/me') {
        sendJson(response, 200, {
          user: session.user,
          guilds: session.guilds,
          csrfToken: session.csrfToken,
        });
        return;
      }

      const guildRootMatch = /^\/api\/guilds\/(\d+)$/u.exec(requestUrl.pathname);
      if (guildRootMatch && request.method === 'GET') {
        const {guildName} = guildContext(session, guildRootMatch[1]);
        const [state, pool] = await Promise.all([
          getGuildControlState(guildRootMatch[1], guildName, config.WORKERS),
          getPoolSnapshot(guildRootMatch[1], guildName, config.WORKERS),
        ]);
        sendJson(response, 200, {state, pool});
        return;
      }

      if (guildRootMatch && request.method === 'PATCH') {
        const {guildName} = guildContext(session, guildRootMatch[1]);
        await getGuildControlState(guildRootMatch[1], guildName, config.WORKERS);
        const body = await readBody(request) as {settings?: unknown; maxConcurrentPlayers?: unknown};
        await patchGuildControl({
          guildId: guildRootMatch[1],
          settings: body.settings,
          maxConcurrentPlayers: body.maxConcurrentPlayers,
          workerCount: config.WORKERS.length,
        });
        const results = await reconcileGuild(guildRootMatch[1], guildName, config.WORKERS);
        sendJson(response, 200, {ok: true, results});
        return;
      }

      const groupsRootMatch = /^\/api\/guilds\/(\d+)\/groups$/u.exec(requestUrl.pathname);
      if (groupsRootMatch && request.method === 'POST') {
        const {guildName} = guildContext(session, groupsRootMatch[1]);
        await getGuildControlState(groupsRootMatch[1], guildName, config.WORKERS);
        const body = await readBody(request) as {name?: unknown; settings?: unknown};
        const group = await createGroup(groupsRootMatch[1], body.name, body.settings);
        const results = await reconcileGuild(groupsRootMatch[1], guildName, config.WORKERS);
        sendJson(response, 201, {group, results});
        return;
      }

      const groupMatch = /^\/api\/guilds\/(\d+)\/groups\/([^/]+)$/u.exec(requestUrl.pathname);
      if (groupMatch && request.method === 'PATCH') {
        const {guildName} = guildContext(session, groupMatch[1]);
        const body = await readBody(request) as {name?: unknown; settings?: unknown};
        await patchGroup(groupMatch[1], groupMatch[2], body);
        const results = await reconcileGuild(groupMatch[1], guildName, config.WORKERS);
        sendJson(response, 200, {ok: true, results});
        return;
      }

      if (groupMatch && request.method === 'DELETE') {
        const {guildName} = guildContext(session, groupMatch[1]);
        await removeGroup(groupMatch[1], groupMatch[2]);
        const results = await reconcileGuild(groupMatch[1], guildName, config.WORKERS);
        sendJson(response, 200, {ok: true, results});
        return;
      }

      const workerMatch = /^\/api\/guilds\/(\d+)\/workers\/([a-z0-9-]+)$/u.exec(requestUrl.pathname);
      if (workerMatch && request.method === 'PATCH') {
        const {guildName} = guildContext(session, workerMatch[1]);
        await getGuildControlState(workerMatch[1], guildName, config.WORKERS);
        const body = await readBody(request) as {
          enabled?: unknown;
          preferredOrder?: unknown;
          groupId?: unknown;
          settings?: unknown;
        };
        await patchWorkerAssignment({
          guildId: workerMatch[1],
          workerId: workerMatch[2],
          workerIds,
          input: body,
        });
        const results = await reconcileGuild(workerMatch[1], guildName, config.WORKERS);
        sendJson(response, 200, {ok: true, results});
        return;
      }

      const bulkMatch = /^\/api\/guilds\/(\d+)\/workers\/bulk$/u.exec(requestUrl.pathname);
      if (bulkMatch && request.method === 'PATCH') {
        const {guildName} = guildContext(session, bulkMatch[1]);
        await getGuildControlState(bulkMatch[1], guildName, config.WORKERS);
        const body = await readBody(request) as {
          workerIds?: unknown;
          input?: {
            enabled?: unknown;
            preferredOrder?: unknown;
            groupId?: unknown;
            settings?: unknown;
          };
        };
        await patchWorkersBulk({
          guildId: bulkMatch[1],
          workerIds: body.workerIds,
          knownWorkerIds: workerIds,
          input: body.input ?? {},
        });
        const results = await reconcileGuild(bulkMatch[1], guildName, config.WORKERS);
        sendJson(response, 200, {ok: true, results});
        return;
      }

      const syncMatch = /^\/api\/guilds\/(\d+)\/sync$/u.exec(requestUrl.pathname);
      if (syncMatch && request.method === 'POST') {
        const {guildName} = guildContext(session, syncMatch[1]);
        const results = await reconcileGuild(syncMatch[1], guildName, config.WORKERS);
        sendJson(response, 200, {ok: true, results});
        return;
      }

      const disconnectMatch = /^\/api\/guilds\/(\d+)\/workers\/([a-z0-9-]+)\/disconnect$/u.exec(requestUrl.pathname);
      if (disconnectMatch && request.method === 'POST') {
        guildContext(session, disconnectMatch[1]);
        const worker = config.WORKERS.find(candidate => candidate.id === disconnectMatch[2]);
        if (!worker) {
          throw new Error('unknown worker');
        }

        await disconnectWorkerFromGuild(worker, disconnectMatch[1]);
        sendJson(response, 200, {ok: true});
        return;
      }

      sendJson(response, 404, {error: 'not found'});
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'request failed';
      const status = message === 'unauthorized'
        ? 401
        : message === 'forbidden'
          ? 403
          : message === 'rate limit exceeded'
            ? 429
            : 400;
      sendJson(response, status, {error: message.slice(0, 300)});
    }
  });

  const reconcileTimer = setInterval(() => {
    if (reconciling) {
      return;
    }

    reconciling = true;
    void reconcileAllGuilds(config.WORKERS)
      .catch(error => {
        console.error('Orchestrator reconciliation failed:', error);
      })
      .finally(() => {
        reconciling = false;
      });
  }, 60_000);
  reconcileTimer.unref();

  server.listen(config.LISTEN_PORT, config.LISTEN_HOST, () => {
    console.log(`Muse orchestrator listening on ${config.LISTEN_HOST}:${config.LISTEN_PORT}`);
  });

  return {
    server,
    close: async () => {
      clearInterval(reconcileTimer);
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
};

export type OrchestratorServer = ReturnType<typeof startOrchestratorServer>;
