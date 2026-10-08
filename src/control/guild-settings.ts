import {prisma} from '../utils/db.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {
  decodeStatusMentionRoleIds,
  toGuildSettingsData,
  toGuildSettingsView,
  type GuildSettingsPatch,
  type GuildSettingsView,
} from './settings-validation.js';

export {sanitizeGuildSettingsPatch} from './settings-validation.js';
export type {GuildSettingsPatch, GuildSettingsView} from './settings-validation.js';

/** The guild's settings in control API shape (the row is created with defaults when missing). */
export const getGuildSettingsView = async (guildId: string): Promise<GuildSettingsView> =>
  toGuildSettingsView(await getGuildSettings(guildId));

export const updateGuildSettings = async (guildId: string, patch: GuildSettingsPatch): Promise<GuildSettingsView> => {
  await getGuildSettings(guildId);
  return toGuildSettingsView(await prisma.setting.update({
    where: {guildId},
    data: toGuildSettingsData(patch),
  }));
};

/** A guild where this bot posts its "Bot started" message. */
export type StatusChannelTarget = {
  guildId: string;
  channelId: string;
  mentionRoleIds: string[];
  locale: string;
};

/** Every guild of this bot's database with a status channel configured. */
export const listStatusChannelTargets = async (): Promise<StatusChannelTarget[]> => {
  const rows = await prisma.setting.findMany({
    where: {statusChannelId: {not: null}},
    select: {guildId: true, statusChannelId: true, statusMentionRoleIds: true, locale: true},
    orderBy: {guildId: 'asc'},
  });

  return rows.flatMap(row => row.statusChannelId === null
    ? []
    : [{
      guildId: row.guildId,
      channelId: row.statusChannelId,
      mentionRoleIds: decodeStatusMentionRoleIds(row.statusMentionRoleIds),
      locale: row.locale,
    }]);
};
