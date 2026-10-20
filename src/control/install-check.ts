import {AuditLogEvent, PermissionFlagsBits, type Client, type Guild} from 'discord.js';
import {isSnowflake} from './snowflake.js';
import type {InstallCheckResult, InstallContacts} from './types.js';
import {resolveOrchestratorUrl} from '../playback/protocol.js';
import {localeFromDiscord, t} from '../i18n/index.js';

/** Self-hosting guide shown to whoever tried to add a bot. */
export const SELF_HOST_GUIDE_URL = 'https://github.com/haxurus/muse/blob/main/docs/DEPLOYMENT.md';
const ISSUES_URL = 'https://github.com/haxurus/muse/issues';
const INSTALL_CHECK_TIMEOUT_MS = 5000;
/** The audit log entry of the bot being added is looked for within this window. */
const INSTALLER_WINDOW_MS = 60_000;

/** Closed access: bots added to a server ask the orchestrator first (`MUSE_INSTALL_GATE=true`). */
export const isInstallGateEnabled = (): boolean => process.env.MUSE_INSTALL_GATE === 'true';

const NO_CONTACTS: InstallContacts = {email: null, discord: null, url: null};

const contactOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\p{Cc}]/u.test(value) ? value : null;

/**
 * `POST /v1/worker/install-check` with this worker's control token. Fails closed: an unreachable or
 * invalid orchestrator answer refuses the installation.
 */
export const requestInstallCheck = async (
  token: string,
  body: {guildId: string; guildName: string; memberCount: number; installerId: string | null},
  url: string = resolveOrchestratorUrl('/v1/worker/install-check'),
): Promise<InstallCheckResult> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(INSTALL_CHECK_TIMEOUT_MS),
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Orchestrator answered ${response.status}`);
    }

    const payload = await response.json() as Record<string, unknown>;
    const contacts = (typeof payload.contacts === 'object' && payload.contacts !== null ? payload.contacts : {}) as Record<string, unknown>;
    return {
      approved: payload.approved === true,
      source: typeof payload.source === 'string' ? payload.source : null,
      contacts: {email: contactOrNull(contacts.email), discord: contactOrNull(contacts.discord), url: contactOrNull(contacts.url)},
    };
  } catch (error: unknown) {
    console.warn(`Install check failed, refusing the installation: ${error instanceof Error ? error.message : String(error)}`);
    return {approved: false, source: null, contacts: NO_CONTACTS};
  }
};

/** Who added this bot, from the audit log (needs View Audit Log); null when unknown. */
export const findInstaller = async (guild: Guild, client: Client): Promise<string | null> => {
  const {me} = guild.members;
  if (!client.user || !me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    return null;
  }

  try {
    const logs = await guild.fetchAuditLogs({type: AuditLogEvent.BotAdd, limit: 5});
    const entry = logs.entries.find(candidate => candidate.targetId === client.user?.id
      && Date.now() - candidate.createdTimestamp <= INSTALLER_WINDOW_MS);
    const executorId = entry?.executorId;
    return isSnowflake(executorId) ? executorId : null;
  } catch {
    return null;
  }
};

/** The explanation sent to whoever tried to add the bot: why Muse is closed, how to self-host, whom to contact. */
export const installRejectedMessage = (guildName: string, contacts: InstallContacts, locale: string | null | undefined): string => {
  const lines = [
    `**${t(locale, 'installRejectedTitle', {guild: guildName})}**`,
    '',
    t(locale, 'installRejectedReason'),
    '',
    t(locale, 'installRejectedSelfHost', {url: SELF_HOST_GUIDE_URL}),
    '',
    t(locale, 'installRejectedContact'),
    ...(contacts.email ? [`• Email: ${contacts.email}`] : []),
    ...(contacts.discord ? [`• Discord: ${contacts.discord}`] : []),
    ...(contacts.url ? [`• Web: ${contacts.url}`] : []),
    `• GitHub: ${ISSUES_URL}`,
    '',
    t(locale, 'installRejectedLeft'),
  ];
  return lines.join('\n').slice(0, 2000);
};

/**
 * Best effort: a DM to the installer (or the owner when the installer is unknown), else the server's
 * system channel. Never throws.
 */
export const explainRejection = async (guild: Guild, client: Client, installerId: string | null, contacts: InstallContacts): Promise<void> => {
  const content = installRejectedMessage(guild.name, contacts, localeFromDiscord(guild.preferredLocale));
  try {
    const recipient = installerId === null ? (await guild.fetchOwner()).user : await client.users.fetch(installerId);
    await recipient.send({content, allowedMentions: {parse: []}});
    return;
  } catch {}

  try {
    const channel = guild.systemChannel;
    const {me} = guild.members;
    if (channel && me && channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      await channel.send({content, allowedMentions: {parse: []}});
    }
  } catch (error: unknown) {
    console.warn(`Could not explain the refused installation in guild ${guild.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
};
