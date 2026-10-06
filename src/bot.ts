import {Client, Collection, User} from 'discord.js';
import {existsSync, unlinkSync, writeFileSync} from 'node:fs';
import {inject, injectable} from 'inversify';
import ora from 'ora';
import {TYPES} from './types.js';
import container from './inversify.config.js';
import Command from './commands/index.js';
import debug from './utils/debug.js';
import handleGuildCreate from './events/guild-create.js';
import handleVoiceStateUpdate from './events/voice-state-update.js';
import errorMsg from './utils/error-msg.js';
import {isUserInVoice} from './utils/channels.js';
import Config from './services/config.js';
import {generateDependencyReport} from '@discordjs/voice';
import {REST} from '@discordjs/rest';
import {Routes} from 'discord-api-types/v10';
import registerCommandsOnGuild from './utils/register-commands-on-guild.js';
import {handlePlaybackInteraction} from './playback/controller.js';
import {blockedUserMessage, blocklist} from './control/blocklist.js';
import {DEFAULT_LOCALE, UserError, localeFromDiscord, localizeEnglishMessage, t, type Locale} from './i18n/index.js';
import {getGuildLocale} from './i18n/guild-locale.js';
import StatusAnnouncer from './status/startup-announcer.js';

const sanitizeErrorDetail = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/(["']?\b(?:api[-_]?key|key|token|authorization|cookie)["']?\s*[:=]\s*)(?:["'][^"']*["']|Bearer\s+[^,;\s]+|[^,;\s}\]]+)/gi, '$1[redacted]')
    .replace(/\b(authorization|cookie)\s*[:=]\s*[^\r\n]*/gi, '$1: [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
};

const sanitizeErrorForLog = (error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  const detail = sanitizeErrorDetail(error);

  return `${name}: ${detail || 'unknown error'}`;
};

const MAX_USER_ERROR_LENGTH = 200;

// Intentional command errors are short, plain sentences. Long or diagnostic-looking
// messages (tool stderr, database errors, stack frames, file paths) stay in the logs.
const looksInternal = (error: unknown, detail: string) => (
  detail.length > MAX_USER_ERROR_LENGTH
  || (error instanceof Error && error.name.startsWith('Prisma'))
  || /\bat \S+ \(?\S+:\d+:\d+\)?/.test(detail)
  || /(?:^|[\s'"(])(?:\/[\w.-]+){2,}/.test(detail)
  || /\b[a-z]:\\/i.test(detail)
  || /\b(?:yt-dlp|ffmpeg|ffprobe|prisma)\b/i.test(detail)
  || /\bE[A-Z]{3,}\b/.test(detail)
);

const getUserSafeErrorMessage = (error: unknown, locale: Locale = DEFAULT_LOCALE) => {
  // Intentional errors carry a message key and are rendered in the guild's language.
  if (error instanceof UserError) {
    return error.localize(locale);
  }

  const detail = sanitizeErrorDetail(error);

  return !detail || looksInternal(error, detail) ? t(locale, 'genericError') : localizeEnglishMessage(locale, detail);
};

const logListenerFailures = <Args extends unknown[]>(
  eventName: string,
  listener: (...args: Args) => Promise<void>,
) => async (...args: Args): Promise<void> => {
  try {
    await listener(...args);
  } catch (error: unknown) {
    console.error(`Discord ${eventName} handler failed: ${sanitizeErrorForLog(error)}`);
  }
};

@injectable()
export default class {
  private readonly client: Client;
  private readonly config: Config;
  private readonly shouldRegisterCommandsOnBot: boolean;
  private readonly commandsByName!: Collection<string, Command>;
  private readonly commandsByButtonId!: Collection<string, Command>;
  private hasCompletedStartup = false;
  private readonly statusAnnouncer: StatusAnnouncer;

  constructor(@inject(TYPES.Client) client: Client, @inject(TYPES.Config) config: Config) {
    this.client = client;
    this.config = config;
    this.shouldRegisterCommandsOnBot = config.REGISTER_COMMANDS_ON_BOT;
    this.commandsByName = new Collection();
    this.commandsByButtonId = new Collection();
    this.statusAnnouncer = new StatusAnnouncer(client, config);
  }

  public shutdown(): void {
    this.setReady(false);
    this.client.destroy();
  }

  public async register(): Promise<void> {
    this.setReady(false);
    // Load in commands
    for (const command of container.getAll<Command>(TYPES.Command)) {
      // Make sure we can serialize to JSON without errors
      try {
        command.slashCommand.toJSON();
      } catch (error) {
        console.error(error);
        throw new Error(`Could not serialize /${command.slashCommand.name ?? ''} to JSON`);
      }

      if (command.slashCommand.name) {
        this.commandsByName.set(command.slashCommand.name, command);
      }

      if (command.handledButtonIds) {
        for (const buttonId of command.handledButtonIds) {
          this.commandsByButtonId.set(buttonId, command);
        }
      }
    }

    // Register event handlers
    // eslint-disable-next-line complexity
    this.client.on('interactionCreate', async interaction => {
      // Read lazily: most successful interactions never need the guild's locale here.
      const resolveLocale = async (): Promise<Locale> => (
        interaction.guildId ? getGuildLocale(interaction.guildId) : localeFromDiscord(interaction.locale)
      );

      try {
        // Users blocked from the super console cannot use any command, button or autocomplete.
        if (blocklist.isUserBlocked(interaction.user.id)) {
          if (interaction.isAutocomplete()) {
            await interaction.respond([]);
          } else if (interaction.isRepliable()) {
            await interaction.reply({content: blockedUserMessage(await resolveLocale()), ephemeral: true});
          }

          return;
        }

        if (await handlePlaybackInteraction(interaction, this.config, getGuildLocale)) {
          return;
        }

        if (interaction.isCommand()) {
          const command = this.commandsByName.get(interaction.commandName);

          if (!command || !interaction.isChatInputCommand()) {
            return;
          }

          if (!interaction.guild) {
            const locale = localeFromDiscord(interaction.locale);
            await interaction.reply(errorMsg(t(locale, 'dmNotAllowed'), locale));
            return;
          }

          const requiresVC = command.requiresVC instanceof Function ? command.requiresVC(interaction) : command.requiresVC;
          if (requiresVC && interaction.member && !isUserInVoice(interaction.guild, interaction.member.user as User)) {
            const locale = await getGuildLocale(interaction.guild.id);
            await interaction.reply({content: errorMsg(t(locale, 'notInVoiceChannel'), locale), ephemeral: true});
            return;
          }

          if (command.execute) {
            await command.execute(interaction);
          }
        } else if (interaction.isButton()) {
          const command = this.commandsByButtonId.get(interaction.customId);

          if (!command) {
            return;
          }

          if (command.handleButtonInteraction) {
            await command.handleButtonInteraction(interaction);
          }
        } else if (interaction.isAutocomplete()) {
          const command = this.commandsByName.get(interaction.commandName);

          if (!command) {
            return;
          }

          if (command.handleAutocompleteInteraction) {
            await command.handleAutocompleteInteraction(interaction);
          }
        }
      } catch (error: unknown) {
        const sanitizedError = sanitizeErrorForLog(error);
        debug(sanitizedError);
        const interactionName = interaction.isCommand() || interaction.isAutocomplete()
          ? `/${interaction.commandName}`
          : interaction.isButton()
            ? `button:${interaction.customId}`
            : interaction.type.toString();
        console.error(`Discord interaction failed (${interactionName}, guild=${interaction.guildId ?? 'dm'}, channel=${interaction.channelId ?? 'unknown'}, user=${interaction.user.id}): ${sanitizedError}`);
        // This can fail if the message was deleted, and we don't want to crash the whole bot
        try {
          if (interaction.isCommand() || interaction.isButton()) {
            const locale = await resolveLocale();
            const content = errorMsg(getUserSafeErrorMessage(error, locale), locale);
            if (interaction.replied || interaction.deferred) {
              await interaction.editReply(content);
            } else {
              await interaction.reply({content, ephemeral: true});
            }
          }
        } catch {}
      }
    });

    const spinner = ora('📡 connecting to Discord...').start();

    this.client.once('ready', logListenerFailures('ready', async () => {
      debug(generateDependencyReport());

      // Update commands. A registration failure must not keep the bot from serving
      // the commands Discord already has, so failures are logged and startup continues.
      const rest = new REST({version: '10'}).setToken(this.config.DISCORD_TOKEN);
      if (this.shouldRegisterCommandsOnBot) {
        spinner.text = '📡 updating commands on bot...';
        try {
          await rest.put(
            Routes.applicationCommands(this.client.user!.id),
            {body: this.commandsByName.map(command => command.slashCommand.toJSON())},
          );
        } catch (error: unknown) {
          console.error(`Failed to register commands on bot: ${sanitizeErrorForLog(error)}`);
        }
      } else {
        spinner.text = '📡 updating commands in all guilds...';

        const guildIds = this.client.guilds.cache.map(guild => guild.id);
        const results = await Promise.allSettled([
          ...guildIds.map(async guildId => registerCommandsOnGuild({
            rest,
            guildId,
            applicationId: this.client.user!.id,
            commands: this.commandsByName.map(c => c.slashCommand),
          })),
          // Remove commands registered on bot (if they exist)
          rest.put(Routes.applicationCommands(this.client.user!.id), {body: []}),
        ]);

        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') {
            const target = index < guildIds.length ? `guild ${guildIds[index]}` : 'bot (global cleanup)';
            console.error(`Failed to update commands for ${target}: ${sanitizeErrorForLog(result.reason)}`);
          }
        }
      }

      this.client.user!.setPresence({
        activities: [
          {
            name: this.config.BOT_ACTIVITY,
            type: this.config.BOT_ACTIVITY_TYPE,
            url: this.config.BOT_ACTIVITY_URL === '' ? undefined : this.config.BOT_ACTIVITY_URL,
          },
        ],
        status: this.config.BOT_STATUS,
      });

      spinner.succeed(`Ready! Invite the bot with https://discordapp.com/oauth2/authorize?client_id=${this.client.user?.id ?? ''}&scope=bot%20applications.commands&permissions=36700160`);
      this.hasCompletedStartup = true;
      this.setReady(true);
      // Fire and forget: the status channel message must never delay or fail readiness.
      void this.statusAnnouncer.announceOnline();
    }));

    this.client.on('error', console.error);
    this.client.on('debug', debug);
    this.client.on('shardDisconnect', () => {
      this.setReady(false);
    });
    this.client.on('shardResume', () => {
      this.setReady(true);
    });
    // A reconnect that cannot resume starts a new session and emits shardReady, not shardResume.
    this.client.on('shardReady', () => {
      if (this.hasCompletedStartup) {
        this.setReady(true);
        // Rate-limited to one message per 5 minutes, so a flapping connection does not spam the channel.
        void this.statusAnnouncer.announceOnline();
      }
    });

    this.client.on('guildCreate', logListenerFailures('guildCreate', handleGuildCreate));
    this.client.on('voiceStateUpdate', logListenerFailures('voiceStateUpdate', handleVoiceStateUpdate));
    // Pass the token explicitly: without an argument discord.js only reads
    // process.env.DISCORD_TOKEN, which is empty when the token comes from DISCORD_TOKEN_FILE.
    await this.client.login(this.config.DISCORD_TOKEN);
  }

  private setReady(ready: boolean): void {
    const readyFile = this.config.READY_FILE ?? '/tmp/muse-ready';
    // The ready file is only a health signal; failing to update it must not crash the bot.
    try {
      if (ready) {
        writeFileSync(readyFile, 'ready\n', {mode: 0o600});
        return;
      }

      if (existsSync(readyFile)) {
        unlinkSync(readyFile);
      }
    } catch (error: unknown) {
      console.error(`Failed to ${ready ? 'write' : 'remove'} ready file ${readyFile}: ${sanitizeErrorForLog(error)}`);
    }
  }
}
