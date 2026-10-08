import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {HttpError} from '../control/http.js';
import DashboardAuth from './auth.js';
import type {DashboardConfig} from './config.js';
import {DashboardHttpError, describeUpstreamError, readJsonBody, redirect, send, sendJson} from './http.js';
import {LOCALES, Locale, isLocale, localizedPath, preferredLocale, renderPage} from './i18n.js';
import OrchestratorClient, {BlockKind, GuildSettingsUpdate, SuperActor} from './orchestrator-client.js';
import type {DashboardSession} from './session-store.js';

const STATIC_ROOT = path.join(process.cwd(), 'dashboard');

type StaticAsset = {
  contentType: string;
  body: Buffer;
  cacheControl: string;
};

const NO_STORE = 'no-store';
const FONT_CACHE = 'public, max-age=604800';

const staticAsset = (fileName: string, contentType: string, cacheControl = NO_STORE): StaticAsset => ({
  contentType,
  body: readFileSync(path.join(STATIC_ROOT, fileName)),
  cacheControl,
});

const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

/** HTML templates (rendered once per language at startup, see i18n.ts). */
const TEMPLATES = {
  home: readFileSync(path.join(STATIC_ROOT, 'home.html'), 'utf8'),
  app: readFileSync(path.join(STATIC_ROOT, 'index.html'), 'utf8'),
  development: readFileSync(path.join(STATIC_ROOT, 'development.html'), 'utf8'),
};

type PageName = keyof typeof TEMPLATES;

/** Path of each page after the language prefix (used by the IT/EN switcher). */
const PAGE_PATHS: Record<PageName, string> = {
  home: '',
  app: '/dashboard',
  development: '/development',
};

/** Every file the dashboard serves is loaded once at startup from this fixed allowlist. */
const STATIC_ASSETS = new Map<string, StaticAsset>([
  ['/assets/dashboard.css', staticAsset('dashboard.css', 'text/css; charset=utf-8')],
  ['/assets/dashboard.js', staticAsset('dashboard.js', 'text/javascript; charset=utf-8')],
  ['/assets/home.js', staticAsset('home.js', 'text/javascript; charset=utf-8')],
  ['/assets/i18n/it.json', staticAsset('i18n/it.json', JSON_TYPE)],
  ['/assets/i18n/en.json', staticAsset('i18n/en.json', JSON_TYPE)],
  ['/assets/fonts/Geist-Variable.woff2', staticAsset('fonts/Geist-Variable.woff2', 'font/woff2', FONT_CACHE)],
  ['/assets/fonts/GeistMono-Variable.woff2', staticAsset('fonts/GeistMono-Variable.woff2', 'font/woff2', FONT_CACHE)],
  ['/assets/fonts/OFL.txt', staticAsset('fonts/OFL.txt', 'text/plain; charset=utf-8', FONT_CACHE)],
]);

const NOINDEX = {'x-robots-tag': 'noindex, nofollow'};
const VARY_LANGUAGE = {vary: 'accept-language'};

/**
 * Path of the signed-in app (server list) below the language prefix:
 * /it/dashboard and /en/dashboard. The public home pages are /it and /en.
 */
export const DASHBOARD_PATH = '/dashboard';

/** Anchor of the super-admin "Nuovo server" invite card inside the dashboard. */
export const NEW_SERVER_ANCHOR = 'nuovo-server';

const SNOWFLAKE = /^\d{17,20}$/u;
const WORKER_ID = /^muse-\d{2}$/u;
const MAX_BLOCK_REASON_LENGTH = 500;
const MAX_SELECTED_WORKERS = 32;

/** Bot invite permissions: View Channels, Send Messages, Read Message History, Connect, Speak. */
// View Channels, Send Messages, Embed Links, Read Message History, Connect, Speak.
export const BOT_INVITE_PERMISSIONS = '3230720';

export const botInviteUrl = (botId: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(botId)}&scope=bot+applications.commands&permissions=${BOT_INVITE_PERMISSIONS}`;

const sendAsset = (response: ServerResponse, asset: StaticAsset, extraHeaders: Record<string, string> = {}): void => {
  send(response, 200, asset.contentType, asset.body, {'cache-control': asset.cacheControl, ...extraHeaders});
};

const avatarUrl = (userId: string, avatar?: string | null): string | null =>
  avatar ? `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=128` : null;

const guildIconUrl = (guildId: string, icon?: string | null): string | null =>
  icon ? `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=128` : null;

const routeSegments = (request: IncomingMessage, publicUrl: URL): string[] =>
  new URL(request.url ?? '/', publicUrl).pathname.split('/').filter(Boolean);

/** App views below a language prefix: dashboard, super, server/:snowflake (exact segments). */
const isAppRoute = (segments: string[]): boolean =>
  (segments.length === 1 && (segments[0] === 'dashboard' || segments[0] === 'super'))
  || (segments.length === 2 && segments[0] === 'server' && SNOWFLAKE.test(segments[1]));

const isDevelopmentRoute = (segments: string[]): boolean =>
  segments.length === 1 && segments[0] === 'development';

/** `?lang=it|en` when valid, otherwise the Accept-Language preference. */
export const requestLocale = (request: IncomingMessage, url: URL): Locale => {
  const lang = url.searchParams.get('lang');
  return isLocale(lang) ? lang : preferredLocale(request.headers['accept-language']);
};

type MutationResult = {
  statusCode: number;
  body: unknown;
};

type MutationAudit = {
  action: string;
  guildId?: string;
  groupId?: string;
  workerIds?: string[];
  subjectKind?: BlockKind;
  subjectId?: string;
};

type GuildMutationAudit = MutationAudit & {guildId: string};

const auditMutation = (session: DashboardSession, audit: MutationAudit, outcome: string): void => {
  console.log(JSON.stringify({
    event: 'dashboard_mutation',
    timestamp: new Date().toISOString(),
    userId: session.user.id,
    guildId: audit.guildId ?? null,
    action: audit.action,
    ...(audit.groupId === undefined ? {} : {groupId: audit.groupId}),
    ...(audit.subjectKind === undefined ? {} : {subjectKind: audit.subjectKind}),
    ...(audit.subjectId === undefined ? {} : {subjectId: audit.subjectId}),
    workerCount: audit.workerIds?.length ?? null,
    workerIds: audit.workerIds ?? null,
    outcome,
  }));
};

const superActor = (session: DashboardSession): SuperActor => ({
  userId: session.user.id,
  username: session.user.username,
});

const readBlockReason = async (request: IncomingMessage): Promise<string | undefined> => {
  const input = await readJsonBody(request);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'request body must be an object');
  }

  const {reason} = input as {reason?: unknown};
  if (reason === undefined || reason === null) {
    return undefined;
  }

  if (typeof reason !== 'string' || reason.length > MAX_BLOCK_REASON_LENGTH) {
    throw new HttpError(400, `reason must be a string of at most ${MAX_BLOCK_REASON_LENGTH} characters`);
  }

  const trimmed = reason.trim();
  return trimmed === '' ? undefined : trimmed;
};

const unauthorized = (): DashboardHttpError =>
  new DashboardHttpError(401, 'authentication required', {code: 'UNAUTHORIZED'});

export type DashboardServerDependencies = {
  auth?: DashboardAuth;
  orchestrator?: OrchestratorClient;
};

export default class DashboardServer {
  private server?: Server;
  private readonly auth: DashboardAuth;
  private readonly orchestrator: OrchestratorClient;
  private readonly pages: Record<PageName, Record<Locale, Buffer>>;

  constructor(private readonly config: DashboardConfig, dependencies: DashboardServerDependencies = {}) {
    this.orchestrator = dependencies.orchestrator ?? new OrchestratorClient(config);
    this.auth = dependencies.auth ?? new DashboardAuth(config, {
      isUserBlocked: async userId => this.orchestrator.isUserBlocked(userId),
    });

    const {origin} = config.publicUrl;
    const render = (page: PageName): Record<Locale, Buffer> => {
      const rendered: Partial<Record<Locale, Buffer>> = {};
      for (const locale of LOCALES) {
        rendered[locale] = Buffer.from(renderPage(TEMPLATES[page], locale, PAGE_PATHS[page], {origin}), 'utf8');
      }

      return rendered as Record<Locale, Buffer>;
    };

    this.pages = {
      home: render('home'),
      app: render('app'),
      development: render('development'),
    };
  }

  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : undefined;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    console.log(`Muse dashboard listening on ${this.config.host}:${this.config.port}`);
  }

  async close(): Promise<void> {
    this.auth.close();
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close(error => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.config.publicUrl);
    const {pathname} = url;

    try {
      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, {ok: true});
        return;
      }

      if (request.method === 'GET' && await this.handlePage(request, response, url)) {
        return;
      }

      if (request.method === 'GET' && pathname === '/auth/discord') {
        this.auth.begin(response, requestLocale(request, url));
        return;
      }

      if (request.method === 'GET' && pathname === '/auth/discord/callback') {
        await this.auth.callback(request, response);
        return;
      }

      if (request.method === 'POST' && pathname === '/auth/logout') {
        await this.auth.logout(request, response, requestLocale(request, url));
        return;
      }

      if (request.method === 'GET' && pathname === '/api/session') {
        await this.sessionResponse(request, response);
        return;
      }

      const segments = routeSegments(request, this.config.publicUrl);
      if (segments[0] === 'api' && segments[1] === 'super') {
        await this.handleSuper(request, response, segments.slice(2));
        return;
      }

      if (segments[0] === 'api' && segments[1] === 'guilds') {
        const guildId = segments[2];

        if (segments.length === 3 && request.method === 'GET') {
          await this.guildResponse(request, response, guildId);
          return;
        }

        if (segments.length === 3 && request.method === 'PATCH') {
          await this.updateGuild(request, response, guildId);
          return;
        }

        if (segments.length === 4 && segments[3] === 'meta' && request.method === 'GET') {
          await this.guildMetaResponse(request, response, guildId);
          return;
        }

        if (segments.length === 5 && segments[3] === 'status-channel' && segments[4] === 'test' && request.method === 'POST') {
          await this.testStatusChannel(request, response, guildId);
          return;
        }

        if (segments.length === 4 && segments[3] === 'groups' && request.method === 'POST') {
          await this.createGroup(request, response, guildId);
          return;
        }

        if (segments.length === 5 && segments[3] === 'groups' && request.method === 'PATCH') {
          await this.updateGroup(request, response, guildId, segments[4]);
          return;
        }

        if (segments.length === 5 && segments[3] === 'groups' && request.method === 'DELETE') {
          await this.deleteGroup(request, response, guildId, segments[4]);
          return;
        }
      }

      sendJson(response, 404, {error: 'not found'});
    } catch (error: unknown) {
      this.sendError(request, response, pathname, error);
    }
  }

  private sendError(request: IncomingMessage, response: ServerResponse, pathname: string, error: unknown): void {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof HttpError ? error.message : 'request failed';
    const details = error instanceof DashboardHttpError ? error.details : {};

    if (statusCode >= 500) {
      // Log only the error class and upstream HTTP status, never messages that may echo secrets.
      const failure = describeUpstreamError(error);
      const causeName = details.causeName ?? failure.name;
      const causeStatus = details.causeStatus ?? failure.statusCode;
      console.error(`Dashboard request failed: ${request.method ?? 'UNKNOWN'} ${pathname} status=${statusCode} error=${causeName} upstreamStatus=${causeStatus === undefined ? 'none' : causeStatus}`);
    }

    if (response.headersSent) {
      response.destroy();
      return;
    }

    sendJson(
      response,
      statusCode,
      details.code === undefined ? {error: message} : {error: message, code: details.code},
      details.retryAfterSeconds === undefined ? {} : {'retry-after': String(details.retryAfterSeconds)},
    );
  }

  private async sessionResponse(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.auth.requireSession(request);
    const [discordGuilds, orchestratorGuilds] = await Promise.all([
      this.auth.manageableGuilds(session),
      this.orchestrator.guilds(),
    ]);

    const availableById = new Map(orchestratorGuilds.guilds.map(guild => [guild.id, guild]));
    const guilds = discordGuilds
      .filter(guild => availableById.has(guild.id))
      .map(guild => ({
        id: guild.id,
        name: guild.name,
        iconUrl: guildIconUrl(guild.id, guild.icon),
        owner: guild.owner,
        availableWorkers: availableById.get(guild.id)!.availableWorkers,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    sendJson(response, 200, {
      user: {
        id: session.user.id,
        username: session.user.username,
        displayName: session.user.global_name ?? session.user.username,
        avatarUrl: avatarUrl(session.user.id, session.user.avatar),
      },
      csrfToken: session.csrfToken,
      superAdmin: this.auth.isSuperAdmin(session),
      expiresAt: new Date(session.expiresAt).toISOString(),
      guilds,
    });
  }

  private sendPage(response: ServerResponse, page: PageName, locale: Locale): void {
    send(response, 200, HTML, this.pages[page][locale], {
      'cache-control': NO_STORE,
      'content-language': locale,
      ...(page === 'home' ? {} : NOINDEX),
    });
  }

  /** Redirect chosen from Accept-Language (or ?lang=), so caches must vary on it. */
  private redirectLocalized(response: ServerResponse, target: string): void {
    redirect(response, new URL(target, this.config.publicUrl).toString(), [], VARY_LANGUAGE);
  }

  /**
   * Serves the HTML views and the allowlisted static assets. Returns false when the path is not a page.
   * Views live under /it and /en; "/" and the old unprefixed paths redirect by language.
   */
  private async handlePage(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const {pathname} = url;
    const asset = STATIC_ASSETS.get(pathname);
    if (asset) {
      sendAsset(response, asset);
      return true;
    }

    if (pathname === '/') {
      this.redirectLocalized(response, localizedPath(preferredLocale(request.headers['accept-language'])));
      return true;
    }

    // Exact segments: "/it/" or "/it/dashboard/" are not views.
    const segments = pathname.slice(1).split('/');
    const [first, ...rest] = segments;
    if (isLocale(first)) {
      return this.handleLocalizedPage(response, first, rest);
    }

    if (isAppRoute(segments) || isDevelopmentRoute(segments)) {
      // Pre-i18n bookmarks and links: keep the query (?login=...) and add the language prefix.
      this.redirectLocalized(response, `${localizedPath(requestLocale(request, url), pathname)}${url.search}`);
      return true;
    }

    if (pathname === '/add') {
      this.add(request, response, requestLocale(request, url));
      return true;
    }

    if (segments.length === 2 && segments[0] === 'invite') {
      await this.invite(request, response, segments[1], requestLocale(request, url));
      return true;
    }

    return false;
  }

  private handleLocalizedPage(response: ServerResponse, locale: Locale, rest: string[]): boolean {
    if (rest.length === 0) {
      // The public home pages are the only indexable HTML views.
      this.sendPage(response, 'home', locale);
      return true;
    }

    if (isAppRoute(rest)) {
      this.sendPage(response, 'app', locale);
      return true;
    }

    if (isDevelopmentRoute(rest)) {
      this.sendPage(response, 'development', locale);
      return true;
    }

    return false;
  }

  /**
   * "Add to Discord" from the public home page. Only the super admin can add the
   * bots to new servers, so they land on the dashboard invite card; everybody else
   * (anonymous or signed in) sees the development notice.
   */
  private add(request: IncomingMessage, response: ServerResponse, locale: Locale): void {
    const session = this.auth.currentSession(request);
    const superAdmin = session !== undefined && this.auth.isSuperAdmin(session);
    const target = superAdmin
      ? `${localizedPath(locale, DASHBOARD_PATH)}#${NEW_SERVER_ANCHOR}`
      : localizedPath(locale, '/development');
    redirect(response, new URL(target, this.config.publicUrl).toString());
  }

  /**
   * Bot invite links. Anonymous visitors start the Discord login, signed-in users who
   * are not the super admin see the development notice, and the super admin is sent
   * to Discord's bot authorization page for the requested worker's application.
   */
  private async invite(request: IncomingMessage, response: ServerResponse, workerId: string, locale: Locale): Promise<void> {
    const session = this.auth.currentSession(request);
    if (!session) {
      redirect(response, new URL(`/auth/discord?lang=${locale}`, this.config.publicUrl).toString());
      return;
    }

    if (!this.auth.isSuperAdmin(session)) {
      redirect(response, new URL(localizedPath(locale, '/development'), this.config.publicUrl).toString());
      return;
    }

    if (!WORKER_ID.test(workerId)) {
      throw new HttpError(404, 'unknown bot');
    }

    const {workers} = await this.orchestrator.workers();
    const worker = workers.find(candidate => candidate.workerId === workerId);
    if (!worker) {
      throw new HttpError(404, 'unknown bot');
    }

    const botId = worker.ok ? worker.value?.bot?.id : undefined;
    if (typeof botId !== 'string' || !SNOWFLAKE.test(botId)) {
      throw new DashboardHttpError(503, 'bot is offline, retry shortly');
    }

    redirect(response, botInviteUrl(botId));
  }

  /** Session + super-admin gate for every /api/super endpoint. */
  private requireSuperAdmin(request: IncomingMessage): DashboardSession {
    const session = this.auth.currentSession(request);
    if (!session) {
      throw unauthorized();
    }

    this.assertSuperAdmin(session);
    return session;
  }

  private assertSuperAdmin(session: DashboardSession): void {
    if (!this.auth.isSuperAdmin(session)) {
      throw new DashboardHttpError(403, 'super admin required', {code: 'SUPER_ADMIN_REQUIRED'});
    }
  }

  private async handleSuper(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const route = segments.join('/');

    if (request.method === 'GET' && route === 'overview') {
      const session = this.requireSuperAdmin(request);
      sendJson(response, 200, await this.orchestrator.superOverview(superActor(session)));
      return;
    }

    if (request.method === 'GET' && route === 'bots') {
      this.requireSuperAdmin(request);
      sendJson(response, 200, {bots: await this.superBots()});
      return;
    }

    if (request.method === 'POST' && segments.length === 3 && segments[0] === 'guilds' && segments[2] === 'leave') {
      await this.superLeave(request, response, segments[1]);
      return;
    }

    if (segments.length === 3 && segments[0] === 'blocks' && (request.method === 'PUT' || request.method === 'DELETE')) {
      await this.superBlock(request, response, request.method, segments[1], segments[2]);
      return;
    }

    this.requireSuperAdmin(request);
    sendJson(response, 404, {error: 'not found'});
  }

  private async superBots() {
    const {workers} = await this.orchestrator.workers();
    return workers
      .filter(worker => WORKER_ID.test(worker.workerId))
      .map(worker => {
        const bot = worker.ok ? worker.value?.bot ?? null : null;
        return {
          workerId: worker.workerId,
          ready: worker.ok && worker.value?.discordReady === true,
          bot: bot ? {id: bot.id, username: bot.username} : null,
        };
      });
  }

  /**
   * Super-admin mutations: session, super admin, Origin + CSRF, then the shared
   * mutation budget. Every attempt by an authenticated user is audited like guild mutations.
   */
  private async superMutate(
    request: IncomingMessage,
    response: ServerResponse,
    audit: MutationAudit,
    execute: (actor: SuperActor) => Promise<MutationResult>,
  ): Promise<void> {
    const session = this.auth.currentSession(request);
    if (!session) {
      throw unauthorized();
    }

    let outcome = 'failed';
    try {
      this.assertSuperAdmin(session);
      this.auth.assertCsrf(request, session);
      this.auth.assertMutationAllowed(session);
      const result = await execute(superActor(session));
      sendJson(response, result.statusCode, result.body);
      outcome = 'ok';
    } catch (error: unknown) {
      outcome = error instanceof HttpError ? `rejected_${error.statusCode}` : 'failed';
      throw error;
    } finally {
      auditMutation(session, audit, outcome);
    }
  }

  private async superLeave(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    const audit: MutationAudit = {action: 'super.guild.leave', guildId: SNOWFLAKE.test(guildId) ? guildId : undefined};
    await this.superMutate(request, response, audit, async actor => {
      if (!SNOWFLAKE.test(guildId)) {
        throw new HttpError(400, 'invalid Discord server id');
      }

      const input = await readJsonBody(request);
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new HttpError(400, 'request body must be an object');
      }

      const {workerIds} = input as {workerIds?: unknown};
      if (workerIds !== undefined
        && (!Array.isArray(workerIds)
          || workerIds.length > MAX_SELECTED_WORKERS
          || workerIds.some(workerId => typeof workerId !== 'string' || !WORKER_ID.test(workerId)))) {
        throw new HttpError(400, 'workerIds must be an array of worker ids');
      }

      const selected = workerIds === undefined ? undefined : [...new Set(workerIds as string[])];
      audit.workerIds = selected;

      return {
        statusCode: 200,
        body: await this.orchestrator.superLeaveGuild(guildId, selected === undefined ? {} : {workerIds: selected}, actor),
      };
    });
  }

  private async superBlock(
    request: IncomingMessage,
    response: ServerResponse,
    method: 'PUT' | 'DELETE',
    kind: string,
    subjectId: string,
  ): Promise<void> {
    const audit: MutationAudit = {action: method === 'PUT' ? 'super.block.put' : 'super.block.delete'};
    await this.superMutate(request, response, audit, async actor => {
      if (kind !== 'GUILD' && kind !== 'USER') {
        throw new HttpError(400, 'block kind must be GUILD or USER');
      }

      if (!SNOWFLAKE.test(subjectId)) {
        throw new HttpError(400, 'invalid Discord id');
      }

      audit.subjectKind = kind;
      audit.subjectId = subjectId;
      if (kind === 'GUILD') {
        audit.guildId = subjectId;
      }

      if (method === 'DELETE') {
        return {
          statusCode: 200,
          body: await this.orchestrator.superDeleteBlock(kind, subjectId, actor),
        };
      }

      const reason = await readBlockReason(request);
      return {
        statusCode: 200,
        body: await this.orchestrator.superPutBlock(kind, subjectId, reason === undefined ? {} : {reason}, actor),
      };
    });
  }

  private async assertGuildAccess(session: DashboardSession, guildId: string, forceRefresh: boolean) {
    const guilds = await this.auth.manageableGuilds(session, forceRefresh);
    const guild = guilds.find(candidate => candidate.id === guildId);
    if (!guild) {
      throw new HttpError(403, 'you cannot manage this Discord server');
    }

    const orchestratorGuilds = await this.orchestrator.guilds();
    if (!orchestratorGuilds.guilds.some(candidate => candidate.id === guildId)) {
      throw new HttpError(404, 'Muse is not available in this Discord server');
    }

    return guild;
  }

  /**
   * Runs a mutation with checks ordered cheapest-first: session, Origin + CSRF,
   * mutation rate budget, then a forced Discord permission refresh. Every attempt by
   * an authenticated user is written to stdout as a structured audit line.
   */
  private async mutate(
    request: IncomingMessage,
    response: ServerResponse,
    audit: GuildMutationAudit,
    execute: (entry: GuildMutationAudit) => Promise<MutationResult>,
  ): Promise<void> {
    const session = this.auth.requireSession(request);
    let outcome = 'failed';

    try {
      this.auth.assertCsrf(request, session);
      this.auth.assertMutationAllowed(session);
      await this.assertGuildAccess(session, audit.guildId, true);
      const result = await execute(audit);
      sendJson(response, result.statusCode, result.body);
      outcome = 'ok';
    } catch (error: unknown) {
      outcome = error instanceof HttpError ? `rejected_${error.statusCode}` : 'failed';
      throw error;
    } finally {
      auditMutation(session, audit, outcome);
    }
  }

  private async guildResponse(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    const session = this.auth.requireSession(request);
    const guild = await this.assertGuildAccess(session, guildId, false);
    const details = await this.orchestrator.guildWorkers(guildId);

    sendJson(response, 200, {
      guild: {
        id: guild.id,
        name: guild.name,
        iconUrl: guildIconUrl(guild.id, guild.icon),
      },
      ...details,
    });
  }

  /** Channels and roles for the "Log" tab pickers: read-only, same access rule as the guild view. */
  private async guildMetaResponse(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    const session = this.auth.requireSession(request);
    await this.assertGuildAccess(session, guildId, false);
    sendJson(response, 200, await this.orchestrator.guildMeta(guildId));
  }

  /** "Invia messaggio di prova": every selected bot posts the test message with its saved status setting. */
  private async testStatusChannel(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    await this.mutate(request, response, {action: 'status_channel.test', guildId}, async audit => {
      const input = await readJsonBody(request);
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new HttpError(400, 'request body must be an object');
      }

      const {workerIds} = input as {workerIds?: unknown};
      if (workerIds !== undefined
        && (!Array.isArray(workerIds)
          || workerIds.length === 0
          || workerIds.length > MAX_SELECTED_WORKERS
          || workerIds.some(workerId => typeof workerId !== 'string' || !WORKER_ID.test(workerId)))) {
        throw new HttpError(400, 'workerIds must be a non-empty array of worker ids');
      }

      const selected = workerIds === undefined ? undefined : [...new Set(workerIds as string[])];
      audit.workerIds = selected;

      return {
        statusCode: 200,
        body: await this.orchestrator.testGuildStatusChannel(guildId, selected === undefined ? {} : {workerIds: selected}),
      };
    });
  }

  private async createGroup(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    await this.mutate(request, response, {action: 'group.create', guildId}, async audit => {
      const input = await readJsonBody(request);
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new HttpError(400, 'group body must be an object');
      }

      const body = input as {name?: unknown; workerIds?: unknown};
      if (typeof body.name !== 'string'
        || !Array.isArray(body.workerIds)
        || body.workerIds.some(workerId => typeof workerId !== 'string')) {
        throw new HttpError(400, 'group requires a name and workerIds string array');
      }

      const workerIds = body.workerIds as string[];
      audit.workerIds = workerIds;

      return {
        statusCode: 201,
        body: await this.orchestrator.createGuildGroup(guildId, {
          name: body.name,
          workerIds,
        }),
      };
    });
  }

  private async updateGroup(
    request: IncomingMessage,
    response: ServerResponse,
    guildId: string,
    groupId: string,
  ): Promise<void> {
    await this.mutate(request, response, {action: 'group.update', guildId, groupId}, async audit => {
      const input = await readJsonBody(request);
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new HttpError(400, 'group body must be an object');
      }

      const body = input as {name?: unknown; workerIds?: unknown};
      if (body.name !== undefined && typeof body.name !== 'string') {
        throw new HttpError(400, 'group name must be a string');
      }

      if (body.workerIds !== undefined
        && (!Array.isArray(body.workerIds)
          || body.workerIds.some(workerId => typeof workerId !== 'string'))) {
        throw new HttpError(400, 'workerIds must be a string array');
      }

      const workerIds = body.workerIds as string[] | undefined;
      audit.workerIds = workerIds;

      return {
        statusCode: 200,
        body: await this.orchestrator.updateGuildGroup(guildId, groupId, {
          ...(body.name === undefined ? {} : {name: body.name}),
          ...(workerIds === undefined ? {} : {workerIds}),
        }),
      };
    });
  }

  private async deleteGroup(
    request: IncomingMessage,
    response: ServerResponse,
    guildId: string,
    groupId: string,
  ): Promise<void> {
    await this.mutate(request, response, {action: 'group.delete', guildId, groupId}, async () => ({
      statusCode: 200,
      body: await this.orchestrator.deleteGuildGroup(guildId, groupId),
    }));
  }

  private async updateGuild(request: IncomingMessage, response: ServerResponse, guildId: string): Promise<void> {
    await this.mutate(request, response, {action: 'settings.update', guildId}, async audit => {
      const input = await readJsonBody(request);
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new HttpError(400, 'request body must be an object');
      }

      const candidate = input as {workerIds?: unknown; settings?: unknown};
      if (candidate.workerIds !== undefined
        && (!Array.isArray(candidate.workerIds)
          || candidate.workerIds.some(workerId => typeof workerId !== 'string'))) {
        throw new HttpError(400, 'workerIds must be an array of strings');
      }

      if (typeof candidate.settings !== 'object' || candidate.settings === null || Array.isArray(candidate.settings)) {
        throw new HttpError(400, 'settings must be an object');
      }

      const workerIds = candidate.workerIds as string[] | undefined;
      audit.workerIds = workerIds;

      const body: GuildSettingsUpdate = {
        ...(workerIds === undefined ? {} : {workerIds}),
        settings: candidate.settings as Record<string, unknown>,
      };

      return {
        statusCode: 200,
        body: await this.orchestrator.updateGuildSettings(guildId, body),
      };
    });
  }
}
