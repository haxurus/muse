import {Setting} from '@prisma/client';
import {prisma} from '../utils/db.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import type {GuildSettingsPatch} from './settings-validation.js';

export {sanitizeGuildSettingsPatch} from './settings-validation.js';
export type {GuildSettingsPatch} from './settings-validation.js';

export const updateGuildSettings = async (guildId: string, patch: GuildSettingsPatch): Promise<Setting> => {
  await getGuildSettings(guildId);
  return prisma.setting.update({
    where: {guildId},
    data: patch,
  });
};
