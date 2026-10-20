import {Guild} from 'discord.js';
import {recordGuildDeparture} from '../services/data-retention.js';

/**
 * The bot was removed from a server (or left it): settings and favorites are kept and the
 * departure time starts the retention period (see services/data-retention.ts).
 */
export default async (guild: Guild): Promise<void> => {
  await recordGuildDeparture(guild.id, new Date());
};
