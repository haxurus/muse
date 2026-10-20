import {Client, Guild} from 'discord.js';
import container from '../inversify.config.js';
import Command from '../commands/index.js';
import {TYPES} from '../types.js';
import Config from '../services/config.js';
import {prisma} from '../utils/db.js';
import {REST} from '@discordjs/rest';
import {Setting} from '@prisma/client';
import registerCommandsOnGuild from '../utils/register-commands-on-guild.js';
import {blocklist} from '../control/blocklist.js';
import {explainRejection, findInstaller, isInstallGateEnabled, requestInstallCheck} from '../control/install-check.js';
import {localeFromDiscord, t} from '../i18n/index.js';

export async function createGuildSettings(guildId: string): Promise<Setting> {
  return prisma.setting.upsert({
    where: {
      guildId,
    },
    create: {
      guildId,
    },
    update: {},
  });
}

export default async (guild: Guild): Promise<void> => {
  // A blocked guild is left immediately: no settings row, no commands, no welcome DM.
  if (blocklist.isGuildBlocked(guild.id)) {
    await guild.leave();
    console.log(`Left blocked guild ${guild.id} right after being added`);
    return;
  }

  const config = container.get<Config>(TYPES.Config);

  // Closed access: the bot stays only in a server the orchestrator authorizes (fails closed).
  if (isInstallGateEnabled() && config.WORKER_ID) {
    const client = container.get<Client>(TYPES.Client);
    const installerId = await findInstaller(guild, client);
    const verdict = await requestInstallCheck(config.CONTROL_TOKEN, {
      guildId: guild.id,
      guildName: guild.name.slice(0, 100) || guild.id,
      memberCount: guild.memberCount,
      installerId,
    });
    if (!verdict.approved) {
      await explainRejection(guild, client, installerId, verdict.contacts);
      await guild.leave();
      console.log(`Left guild ${guild.id}: installation not authorized`);
      return;
    }
  }

  await createGuildSettings(guild.id);

  // Setup slash commands
  if (!config.REGISTER_COMMANDS_ON_BOT) {
    const client = container.get<Client>(TYPES.Client);

    const rest = new REST({version: '10'}).setToken(config.DISCORD_TOKEN);

    await registerCommandsOnGuild({
      rest,
      applicationId: client.user!.id,
      guildId: guild.id,
      commands: container.getAll<Command>(TYPES.Command).map(command => command.slashCommand),
    });
  }

  // The welcome DM is best-effort: owners commonly have DMs closed.
  try {
    const owner = await guild.fetchOwner();
    // No locale setting exists yet for a new guild: follow the server's Discord language.
    await owner.send(t(localeFromDiscord(guild.preferredLocale), 'welcomeOwner'));
  } catch (error: unknown) {
    console.warn(`Could not send the welcome message to the owner of guild ${guild.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
};
