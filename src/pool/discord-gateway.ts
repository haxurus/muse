import {existsSync, unlinkSync, writeFileSync} from 'node:fs';
import {Client, Guild, ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits, VoiceChannel} from 'discord.js';
import Config from '../services/config.js';
import handleVoiceStateUpdate from '../events/voice-state-update.js';
import {HttpError} from '../control/http.js';
import {poolRole, poolSecret} from './runtime.js';
import {ACTIONS, type PoolAction, type PoolCommand} from './protocol.js';
import {postPoolJson} from './transport.js';

export const poolCommands = () => ACTIONS.map(name => {
  const descriptions: Record<PoolAction, string> = {
    join: 'Assegna un music bot libero alla tua vocale',
    play: 'Aggiungi musica al player della tua vocale',
    pause: 'Metti in pausa il player della tua vocale',
    resume: 'Riprendi il player della tua vocale',
    skip: 'Salta il brano corrente nella tua vocale',
    stop: 'Svuota la coda e libera il player',
    disconnect: 'Disconnetti e libera il player della tua vocale',
    queue: 'Mostra la coda della tua vocale',
    volume: 'Imposta il volume della sessione corrente',
    players: 'Mostra la disponibilita dei music bot in questo server',
  };
  const command = new SlashCommandBuilder().setName(name).setDescription(descriptions[name]).setDMPermission(false);
  if (name === 'play') {
    command.addStringOption(option => option.setName('query').setDescription('Titolo o URL').setRequired(true).setMaxLength(500));
  }

  if (name === 'volume') {
    command.addIntegerOption(option => option.setName('level').setDescription('Volume 0-100').setRequired(true).setMinValue(0).setMaxValue(100));
  }

  return command;
});

export default class PoolDiscordGateway {
  private readonly role = poolRole();
  private readonly token = this.role === 'controller' ? poolSecret() : '';
  private readonly budgets = new Map<string, {start: number; count: number}>();
  private initialized = false;

  constructor(private readonly config: Config, private readonly client: Client, private readonly invalidate: (guildId: string) => void) {}

  async register(): Promise<void> {
    this.setReady(false);
    this.client.on('interactionCreate', interaction => {
      if (interaction.isChatInputCommand()) {
        void this.command(interaction);
      } else if (interaction.isAutocomplete()) {
        void interaction.respond([]).catch(() => undefined);
      } else if (interaction.isButton()) {
        void interaction.reply({content: 'Usa i comandi del bot principale.', ephemeral: true}).catch(() => undefined);
      }
    });
    this.client.on('voiceStateUpdate', (oldState, newState) => {
      if (newState.id === this.client.user?.id && oldState.channelId && oldState.channelId !== newState.channelId) {
        // Administrative moves terminate the old lease rather than moving a
        // private room's queue into another channel.
        this.invalidate(newState.guild.id);
      }

      void handleVoiceStateUpdate(oldState, newState).catch(() => {
        console.warn('Pool voice-state handling failed');
      });
    });
    this.client.on('guildCreate', guild => {
      void this.registerGuild(guild).catch(() => {
        console.warn('Pool guild command registration failed');
      });
    });
    this.client.on('guildDelete', guild => {
      this.invalidate(guild.id);
    });
    this.client.on('shardDisconnect', () => {
      this.setReady(false);
    });
    this.client.on('shardResume', () => {
      this.setReady(this.initialized && this.client.isReady());
    });
    this.client.on('error', () => {
      console.warn('Pool Discord client error');
    });

    const ready = new Promise<void>((resolve, reject) => {
      this.client.once('ready', () => {
        void this.initialize().then(resolve, reject);
      });
    });
    await this.client.login(this.config.DISCORD_TOKEN);
    await ready;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    this.setReady(false);
    await this.client.destroy();
  }

  private async initialize(): Promise<void> {
    const definitions = this.role === 'controller' && this.config.REGISTER_COMMANDS_ON_BOT ? poolCommands().map(command => command.toJSON()) : [];
    await this.client.application!.commands.set(definitions);
    for (const guild of this.client.guilds.cache.values()) {
      await this.registerGuild(guild);
    }

    this.client.user!.setPresence({
      activities: [{name: this.config.BOT_ACTIVITY, type: this.config.BOT_ACTIVITY_TYPE}],
      status: this.config.BOT_STATUS,
    });
    this.initialized = true;
    this.setReady(true);
    console.log(`Pool ${this.role} ready: ${this.config.WORKER_ID}`);
  }

  private async registerGuild(guild: Guild): Promise<void> {
    const commands = this.role === 'controller' && !this.config.REGISTER_COMMANDS_ON_BOT ? poolCommands().map(command => command.toJSON()) : [];
    // This also removes legacy worker-specific slash commands.
    await guild.commands.set(commands);
  }

  private budget(key: string): void {
    const now = Date.now();
    for (const [id, value] of this.budgets) {
      if (now - value.start >= 60_000) {
        this.budgets.delete(id);
      }
    }

    const current = this.budgets.get(key) ?? {start: now, count: 0};
    if (current.count >= 10 || this.budgets.size >= 4096) {
      throw new HttpError(429, 'Troppi comandi. Riprova tra poco.');
    }

    current.count++;
    this.budgets.set(key, current);
  }

  private async command(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ephemeral: true});
      if (this.role !== 'controller' || !this.initialized || !interaction.guild
        || !ACTIONS.some(action => action === interaction.commandName)) {
        throw new HttpError(400, 'Usa i comandi del bot principale in un server.');
      }

      this.budget(`${interaction.guildId}/${interaction.user.id}`);
      const guild = interaction.guild;
      const member = await guild.members.fetch(interaction.user.id);
      const voice = guild.voiceStates.cache.get(member.id)?.channel;
      if (!(voice instanceof VoiceChannel)
        || !voice.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
        throw new HttpError(403, 'Entra in una vocale che puoi utilizzare.');
      }

      const action = interaction.commandName as PoolAction;
      const command: PoolCommand = {
        id: interaction.id, guildId: guild.id, userId: member.id,
        textChannelId: interaction.channelId, voiceChannelId: voice.id,
        categoryId: voice.parentId, action,
        ...(action === 'play' ? {query: interaction.options.getString('query', true)} : {}),
        ...(action === 'volume' ? {volume: interaction.options.getInteger('level', true)} : {}),
      };
      const reply = await postPoolJson('http://orchestrator:3100/v1/pool/commands', this.token, command);
      if (reply.requestId !== interaction.id || reply.guildId !== guild.id) {
        throw new Error('Invalid pool response scope');
      }

      await interaction.editReply({content: reply.text, allowedMentions: {parse: []}});
    } catch (error: unknown) {
      const content = error instanceof HttpError ? error.message : 'Pool non raggiungibile. Verifica /players prima di ripetere /play.';
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({content, allowedMentions: {parse: []}});
        } else {
          await interaction.reply({content, ephemeral: true, allowedMentions: {parse: []}});
        }
      } catch {}
    }
  }

  private setReady(value: boolean): void {
    if (value) {
      writeFileSync(this.config.READY_FILE, 'ready\n', {mode: 0o600});
    } else if (existsSync(this.config.READY_FILE)) {
      unlinkSync(this.config.READY_FILE);
    }
  }
}
