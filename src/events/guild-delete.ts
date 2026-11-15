import {Guild} from 'discord.js';
import container from '../inversify.config.js';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import {recordGuildDeparture} from '../services/data-retention.js';

/**
 * The bot was removed from a server (or left it): its player is released, settings and favorites
 * are kept and the departure time starts the retention period (see services/data-retention.ts).
 */
export default async (guild: Guild): Promise<void> => {
  container.get<PlayerManager>(TYPES.Managers.Player).remove(guild.id);
  await recordGuildDeparture(guild.id, new Date());
};
