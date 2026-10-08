import {ChannelType, EmbedBuilder, PermissionFlagsBits, type Channel, type Client} from 'discord.js';
import type {StatusAnnounceError, StatusAnnounceResult} from '../control/types.js';
import {t, type Locale} from '../i18n/index.js';

/** Left bar of the "Bot started" embed (Sentinel green). */
export const STATUS_ONLINE_COLOR = 0x3ccf8e;
/** Left bar of the dashboard test embed (Muse violet, the dashboard accent). */
export const STATUS_TEST_COLOR = 0xa78bfa;
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

/** One status message of one bot in one guild. */
export type StatusMessageInput = {
  /** The guild whose setting is being used: the channel must belong to it. */
  guildId: string;
  channelId: string;
  /** Dashboard test message instead of the startup "Bot started" message. */
  test: boolean;
  /** Roles pinged by the message (0-10). */
  mentionRoleIds: readonly string[];
  /** The guild's bot language. */
  locale: Locale;
};

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
 * The channel must be a standard text or announcement channel of `guildId`, with View Channel,
 * Send Messages and Embed Links for this bot. Never throws: failures are returned as a short error code.
 */
export const postStatusMessage = async (client: Client, input: StatusMessageInput): Promise<StatusAnnounceResult> => {
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

  // A per-guild setting never posts in another server, even if the stored id was tampered with.
  if (channel.guild.id !== input.guildId) {
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
  const embed = buildStatusEmbed({
    bot: {id: user.id, username: user.username, tag: user.tag},
    guildCount: client.guilds.cache.size,
    test: input.test,
    locale: input.locale,
    now: new Date(),
    footer: statusFooter(process.env.MUSE_DASHBOARD_PUBLIC_URL),
  });

  const roles = [...new Set(input.mentionRoleIds)];
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
