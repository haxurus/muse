import {ChatInputCommandInteraction, Client, GuildMember, VoiceChannel} from 'discord.js';
import Command from '../commands/index.js';

export type RemoteCommandOptionValue = string | number | boolean;

export type RemoteCommandRequest = {
  guildId: string;
  voiceChannelId: string | null;
  textChannelId: string;
  userId: string;
  commandName: string;
  options: Record<string, RemoteCommandOptionValue>;
};

export type RemoteCommandResult = {
  response: unknown;
};

const serializable = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const makeOptions = (values: Record<string, RemoteCommandOptionValue>) => ({
  getBoolean: (name: string) => typeof values[name] === 'boolean' ? values[name] as boolean : null,
  getInteger: (name: string) => typeof values[name] === 'number' && Number.isInteger(values[name])
    ? values[name] as number
    : null,
  getString: (name: string) => typeof values[name] === 'string' ? values[name] as string : null,
  getSubcommand: () => typeof values.subcommand === 'string' ? values.subcommand : '',
});

export const executeRemoteCommand = async ({
  request,
  client,
  commands,
}: {
  request: RemoteCommandRequest;
  client: Client;
  commands: ReadonlyMap<string, Command>;
}): Promise<RemoteCommandResult> => {
  const guild = client.guilds.cache.get(request.guildId);
  if (!guild) {
    throw new Error('worker is not a member of this server');
  }

  const command = commands.get(request.commandName);
  if (!command?.execute) {
    throw new Error('unsupported remote command');
  }

  let voiceChannel: VoiceChannel | null = null;
  if (request.voiceChannelId) {
    const channel = guild.channels.cache.get(request.voiceChannelId);
    if (!channel?.isVoiceBased() || channel.isThread()) {
      throw new Error('voice channel is not available to this worker');
    }

    voiceChannel = channel as VoiceChannel;
  }

  const requiresVoice = command.requiresVC instanceof Function
    ? true
    : command.requiresVC === true;
  if (requiresVoice && !voiceChannel) {
    throw new Error('join the voice channel you want to control');
  }

  let lastResponse: unknown = null;
  const capture = async (payload: unknown) => {
    lastResponse = serializable(payload);
    return undefined;
  };

  const member = {
    user: {id: request.userId},
    voice: {channel: voiceChannel},
  } as unknown as GuildMember;

  const interaction = {
    channel: {id: request.textChannelId},
    channelId: request.textChannelId,
    commandName: request.commandName,
    deferReply: async () => undefined,
    deleteReply: async () => undefined,
    editReply: capture,
    followUp: capture,
    guild,
    guildId: request.guildId,
    member,
    options: makeOptions(request.options),
    replied: false,
    reply: capture,
    user: {id: request.userId},
  } as unknown as ChatInputCommandInteraction;

  await command.execute(interaction);

  return {
    response: lastResponse ?? {content: 'command completed'},
  };
};
