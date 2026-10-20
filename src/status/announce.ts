import {ChannelType, EmbedBuilder, PermissionFlagsBits, type Channel, type Client} from 'discord.js';
import {HttpError} from '../control/http.js';
import {parseMentionRoleIds} from '../control/mention-roles.js';
import {isSnowflake} from '../control/snowflake.js';
import {
  isWorkerAlertKind,
  type InstallSubject,
  type StatusAnnounceError,
  type StatusAnnounceRequest,
  type StatusAnnounceResult,
  type WorkerAlertKind,
  type WorkerAlertSubject,
} from '../control/types.js';
import {t, type Locale} from '../i18n/index.js';
import {getGuildLocale} from '../i18n/guild-locale.js';

/** Left bar of the "Bot started" embed (Sentinel green). */
export const STATUS_ONLINE_COLOR = 0x3ccf8e;
/** Left bar of the super console test embed (Muse violet, the dashboard accent). */
export const STATUS_TEST_COLOR = 0xa78bfa;
/** Left bar of the "Bot offline" alert (Muse danger red). */
export const STATUS_DOWN_COLOR = 0xf2555a;
/** Left bar of the "Installation refused" notice (Muse warning amber). */
export const STATUS_WARN_COLOR = 0xf5a524;
/** Footer when MUSE_DASHBOARD_PUBLIC_URL is missing or invalid. */
export const DEFAULT_STATUS_FOOTER = 'Muse';

/** Permissions every bot needs in the status channel. */
export const STATUS_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

// Discord JSON error codes: https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
const UNKNOWN_CHANNEL = 10_003;
const MISSING_ACCESS = 50_001;
const MISSING_PERMISSIONS = 50_013;

/** Same payload as the worker control route; `workerId` is this bot's worker id. */
export type StatusMessageInput = StatusAnnounceRequest & {workerId: string};

export type StatusLocaleResolver = (guildId: string) => Promise<Locale>;

/** Hostname of the public dashboard URL (workers get the whole .env), or "Muse". */
export const statusFooter = (value: string | undefined): string => {
  try {
    const {hostname} = new URL(value ?? '');
    return hostname || DEFAULT_STATUS_FOOTER;
  } catch {
    return DEFAULT_STATUS_FOOTER;
  }
};

export type StatusEmbedInput = {
  bot: {id: string; username: string; tag: string};
  guildCount: number;
  test: boolean;
  locale: Locale;
  now: Date;
  footer: string;
};

/** Mirrors Sentinel's "Bot avviato" message: title, "connected as", action author, details, host footer, timestamp. */
export const buildStatusEmbed = (input: StatusEmbedInput): EmbedBuilder => {
  const {bot, locale} = input;
  const identity = `<@${bot.id}> · \`${bot.id}\``;
  return new EmbedBuilder()
    .setColor(input.test ? STATUS_TEST_COLOR : STATUS_ONLINE_COLOR)
    .setTitle(t(locale, input.test ? 'statusTestTitle' : 'statusOnlineTitle'))
    .setDescription(t(locale, input.test ? 'statusTestDescription' : 'statusOnlineDescription', {tag: bot.tag}))
    .addFields(
      {name: t(locale, 'statusFieldAuthor'), value: `**${bot.username}** · ${identity}`},
      {name: t(locale, 'statusFieldDetails'), value: `**Guild Count:** ${input.guildCount}\n**Bot:** ${bot.username} · ${identity}`},
    )
    .setFooter({text: input.footer})
    .setTimestamp(input.now);
};

export type WorkerAlertEmbedInput = {
  kind: WorkerAlertKind;
  worker: WorkerAlertSubject;
  locale: Locale;
  now: Date;
  footer: string;
};

/** Health alert of one bot: red when it goes down, green when it is back. The outage start is shown as a Discord time. */
export const buildWorkerAlertEmbed = (input: WorkerAlertEmbedInput): EmbedBuilder => {
  const {kind, worker, locale} = input;
  const down = kind === 'worker-down';
  const since = Math.floor(Date.parse(worker.since) / 1000);
  return new EmbedBuilder()
    .setColor(down ? STATUS_DOWN_COLOR : STATUS_ONLINE_COLOR)
    .setTitle(t(locale, down ? 'statusDownTitle' : 'statusRecoveredTitle'))
    .setDescription(t(locale, down ? 'statusDownDescription' : 'statusRecoveredDescription', {bot: worker.botName}))
    .addFields(
      {name: t(locale, 'statusFieldWorker'), value: `**${worker.botName}** · \`${worker.workerId}\``},
      {name: t(locale, 'statusFieldDownSince'), value: `<t:${since}:t>`},
    )
    .setFooter({text: input.footer})
    .setTimestamp(input.now);
};

export type InstallRejectedEmbedInput = {
  install: InstallSubject;
  locale: Locale;
  now: Date;
  footer: string;
};

/** Sentinel's "Installazione rifiutata": which bot left which server, its size and who added the bot. */
export const buildInstallRejectedEmbed = (input: InstallRejectedEmbedInput): EmbedBuilder => {
  const {install, locale} = input;
  return new EmbedBuilder()
    .setColor(STATUS_WARN_COLOR)
    .setTitle(t(locale, 'statusInstallRejectedTitle'))
    .setDescription(t(locale, 'statusInstallRejectedDescription', {bot: install.botName, guild: install.guildName}))
    .addFields(
      {name: t(locale, 'statusFieldServer'), value: `${install.guildName}\n\`${install.guildId}\``},
      {name: t(locale, 'statusFieldMembers'), value: String(install.memberCount)},
      {
        name: t(locale, 'statusFieldInstaller'),
        value: install.installerId === null ? t(locale, 'statusInstallerUnknown') : `<@${install.installerId}>\n\`${install.installerId}\``,
      },
    )
    .setFooter({text: input.footer})
    .setTimestamp(input.now);
};

/** Message content: only the role mentions, e.g. "<@&1> <@&2>"; undefined when there are none. */
export const roleMentions = (roleIds: readonly string[]): string | undefined =>
  roleIds.length === 0 ? undefined : roleIds.map(id => `<@&${id}>`).join(' ');

const discordErrorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as {code?: unknown}).code : undefined;

const classifyDiscordError = (error: unknown): StatusAnnounceError => {
  const code = discordErrorCode(error);
  if (code === MISSING_ACCESS || code === MISSING_PERMISSIONS) {
    return 'MISSING_PERMISSIONS';
  }

  return code === UNKNOWN_CHANNEL ? 'CHANNEL_NOT_FOUND' : 'DISCORD_ERROR';
};

const failure = (error: StatusAnnounceError): StatusAnnounceResult => ({ok: false, error});

/**
 * Post the status embed in `channelId`, pinging exactly `mentionRoleIds` (never users, @everyone or @here).
 * The channel must be a standard text or announcement channel of `guildId` (when set) that this bot is in,
 * with View Channel, Send Messages and Embed Links. Never throws: failures are returned as a short error code.
 */
export const postStatusMessage = async (
  client: Client,
  input: StatusMessageInput,
  resolveLocale: StatusLocaleResolver = getGuildLocale,
): Promise<StatusAnnounceResult> => {
  if (!client.isReady()) {
    return failure('NOT_READY');
  }

  let channel: Channel | null;
  try {
    channel = await client.channels.fetch(input.channelId);
  } catch (error: unknown) {
    return failure(classifyDiscordError(error));
  }

  if (!channel) {
    return failure('CHANNEL_NOT_FOUND');
  }

  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return failure('INVALID_CHANNEL');
  }

  // The setting names its server: never post in another one, even if the stored channel id was tampered with.
  if (input.guildId !== null && channel.guild.id !== input.guildId) {
    return failure('CHANNEL_NOT_FOUND');
  }

  const {me} = channel.guild.members;
  if (!me) {
    return failure('NOT_READY');
  }

  if (!channel.permissionsFor(me).has(STATUS_CHANNEL_PERMISSIONS)) {
    return failure('MISSING_PERMISSIONS');
  }

  const {user} = client;
  const locale = await resolveLocale(channel.guild.id);
  const footer = statusFooter(process.env.MUSE_DASHBOARD_PUBLIC_URL);
  let embed: EmbedBuilder;
  if (input.kind === 'install-rejected' && input.install !== undefined) {
    embed = buildInstallRejectedEmbed({install: input.install, locale, now: new Date(), footer});
  } else if (input.kind !== undefined && input.kind !== 'install-rejected' && input.worker !== undefined) {
    embed = buildWorkerAlertEmbed({kind: input.kind, worker: input.worker, locale, now: new Date(), footer});
  } else {
    embed = buildStatusEmbed({
      bot: {id: user.id, username: user.username, tag: user.tag},
      guildCount: client.guilds.cache.size,
      test: input.test,
      locale,
      now: new Date(),
      footer,
    });
  }

  // Recoveries and refused installations are news, not emergencies: they never ping the roles.
  const roles = input.kind === 'worker-recovered' || input.kind === 'install-rejected' ? [] : [...new Set(input.mentionRoleIds)];
  const content = roleMentions(roles);
  try {
    await channel.send({
      ...(content === undefined ? {} : {content}),
      embeds: [embed],
      allowedMentions: {parse: [], roles},
    });
  } catch (error: unknown) {
    return failure(classifyDiscordError(error));
  }

  return {ok: true};
};

const WORKER_ID = /^[a-z\d][a-z\d-]{0,31}$/u;

/** The worker of an alert: a worker id, a bot name of 1-64 characters and the ISO 8601 time the outage began. */
const parseWorkerAlertSubject = (input: unknown): WorkerAlertSubject => {
  const {workerId, botName, since} = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (typeof workerId !== 'string' || !WORKER_ID.test(workerId)
    || typeof botName !== 'string' || botName.length < 1 || botName.length > 64
    || typeof since !== 'string' || since.length > 40 || Number.isNaN(Date.parse(since))) {
    throw new HttpError(400, 'worker must name the worker id, its bot name and the time it went down', 'INVALID_BODY');
  }

  return {workerId, botName, since};
};

const parseInstallSubject = (input: unknown): InstallSubject => {
  const {guildId, guildName, memberCount, installerId, workerId, botName} = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (!isSnowflake(guildId)
    || typeof guildName !== 'string' || guildName.length < 1 || guildName.length > 100
    || !Number.isSafeInteger(memberCount) || (memberCount as number) < 0
    || (installerId !== null && !isSnowflake(installerId))
    || typeof workerId !== 'string' || !WORKER_ID.test(workerId)
    || typeof botName !== 'string' || botName.length < 1 || botName.length > 64) {
    throw new HttpError(400, 'install must name the server, its member count, the installer (or null) and the bot', 'INVALID_BODY');
  }

  return {guildId, guildName, memberCount: memberCount as number, installerId, workerId, botName};
};

/** Body of the worker control route `POST /v1/status-channel/announce`. */
export const parseStatusAnnounceRequest = (input: unknown): StatusAnnounceRequest => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'request body must be an object', 'INVALID_BODY');
  }

  const {guildId, channelId, test, mentionRoleIds, kind, worker, install} = input as Record<string, unknown>;
  // Optional for settings saved before the server was stored.
  if (guildId !== undefined && guildId !== null && !isSnowflake(guildId)) {
    throw new HttpError(400, 'guildId must be a Discord server id or null', 'INVALID_GUILD_ID');
  }

  if (!isSnowflake(channelId)) {
    throw new HttpError(400, 'channelId must be a Discord channel id', 'INVALID_CHANNEL_ID');
  }

  if (typeof test !== 'boolean') {
    throw new HttpError(400, 'test must be a boolean', 'INVALID_BODY');
  }

  const request: StatusAnnounceRequest = {
    guildId: isSnowflake(guildId) ? guildId : null,
    channelId,
    test,
    // Optional for callers that predate role mentions.
    mentionRoleIds: mentionRoleIds === undefined ? [] : parseMentionRoleIds(mentionRoleIds),
  };
  if (kind === undefined) {
    return request;
  }

  // Alerts and notices are never test messages.
  if (test) {
    throw new HttpError(400, 'health alerts cannot be test messages', 'INVALID_BODY');
  }

  if (kind === 'install-rejected') {
    return {...request, kind, install: parseInstallSubject(install)};
  }

  // `worker` names the bot a health alert is about.
  if (!isWorkerAlertKind(kind)) {
    throw new HttpError(400, 'kind must be worker-down, worker-recovered or install-rejected', 'INVALID_BODY');
  }

  return {...request, kind, worker: parseWorkerAlertSubject(worker)};
};
