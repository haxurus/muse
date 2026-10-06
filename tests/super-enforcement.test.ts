import 'reflect-metadata';
import {Collection} from 'discord.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
  const spinner = {start: vi.fn(), succeed: vi.fn(), text: ''};
  spinner.start.mockReturnValue(spinner);
  return {
    containerGet: vi.fn(),
    containerGetAll: vi.fn(),
    login: vi.fn(),
    restPut: vi.fn(),
    settingUpsert: vi.fn(),
    spinner,
  };
});

vi.mock('ora', () => ({default: vi.fn(() => mocks.spinner)}));

vi.mock('@discordjs/rest', () => ({
  REST: class {
    setToken() {
      return this;
    }

    put(route: string, options: unknown) {
      return mocks.restPut(route, options);
    }
  },
}));

vi.mock('@discordjs/voice', () => ({generateDependencyReport: vi.fn(() => '')}));

vi.mock('../src/inversify.config.js', () => ({
  default: {get: mocks.containerGet, getAll: mocks.containerGetAll},
}));

vi.mock('../src/utils/db.js', () => ({
  prisma: {setting: {upsert: mocks.settingUpsert}},
}));

vi.mock('../src/utils/debug.js', () => ({default: vi.fn()}));

vi.mock('../src/events/voice-state-update.js', () => ({default: vi.fn()}));

import Bot from '../src/bot.js';
import handleGuildCreate from '../src/events/guild-create.js';
import {BLOCKED_USER_MESSAGE, blocklist} from '../src/control/blocklist.js';
import {TYPES} from '../src/types.js';

type Handler = (...args: never[]) => unknown;

const blockedUser = '444444444444444444';
const blockedGuild = '222222222222222222';

const config = {
  BOT_ACTIVITY: 'music',
  BOT_ACTIVITY_TYPE: 0,
  BOT_ACTIVITY_URL: '',
  BOT_STATUS: 'online' as const,
  DISCORD_TOKEN: 'fake-token',
  REGISTER_COMMANDS_ON_BOT: true,
};

const command = {
  execute: vi.fn(),
  handleAutocompleteInteraction: vi.fn(),
  handleButtonInteraction: vi.fn(),
  handledButtonIds: ['button-id'],
  slashCommand: {name: 'play', toJSON: () => ({name: 'play', description: 'play'})},
};

const registerBot = async () => {
  const handlers = new Map<string, Handler>();
  const client = {
    guilds: {cache: new Collection()},
    login: mocks.login,
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return client;
    }),
    once: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return client;
    }),
    user: {id: 'application-id', setPresence: vi.fn()},
  };
  mocks.containerGetAll.mockReturnValue([command]);
  mocks.containerGet.mockImplementation(type => {
    if (type === TYPES.Config) {
      return config;
    }

    if (type === TYPES.Client) {
      return client;
    }

    throw new Error('unexpected container lookup');
  });
  await new Bot(client as never, config as never).register();
  return handlers;
};

const makeInteraction = (userId: string, kind: 'command' | 'autocomplete' | 'button') => ({
  channelId: 'channel-id',
  commandName: 'play',
  customId: 'button-id',
  deferred: false,
  guild: {channels: {cache: new Collection()}},
  guildId: 'guild-id',
  isAutocomplete: () => kind === 'autocomplete',
  isButton: () => kind === 'button',
  isChatInputCommand: () => kind === 'command',
  isCommand: () => kind === 'command',
  isRepliable: () => kind !== 'autocomplete',
  member: {user: {id: userId}},
  replied: false,
  reply: vi.fn().mockResolvedValue(undefined),
  respond: vi.fn().mockResolvedValue(undefined),
  type: 2,
  user: {id: userId},
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.login.mockResolvedValue(undefined);
  mocks.settingUpsert.mockResolvedValue({});
  mocks.spinner.start.mockReturnValue(mocks.spinner);
  blocklist.set({guildIds: [blockedGuild], userIds: [blockedUser]});
});

afterEach(() => {
  blocklist.set({guildIds: [], userIds: []});
});

describe('blocked users', () => {
  it.each(['command', 'button'] as const)('get an ephemeral refusal for a %s interaction', async kind => {
    const handlers = await registerBot();
    const interaction = makeInteraction(blockedUser, kind);
    await handlers.get('interactionCreate')!(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({content: BLOCKED_USER_MESSAGE, ephemeral: true});
    expect(BLOCKED_USER_MESSAGE).toBe('Non puoi usare questo bot.');
    expect(command.execute).not.toHaveBeenCalled();
    expect(command.handleButtonInteraction).not.toHaveBeenCalled();
  });

  it('get empty autocomplete suggestions', async () => {
    const handlers = await registerBot();
    const interaction = makeInteraction(blockedUser, 'autocomplete');
    await handlers.get('interactionCreate')!(interaction as never);

    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(command.handleAutocompleteInteraction).not.toHaveBeenCalled();
  });

  it('does not affect other users', async () => {
    const handlers = await registerBot();
    const interaction = makeInteraction('999999999999999999', 'command');
    await handlers.get('interactionCreate')!(interaction as never);

    expect(command.execute).toHaveBeenCalledWith(interaction);
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe('blocked guilds', () => {
  it('are left on guildCreate before settings, commands or the welcome DM', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const guild = {id: blockedGuild, leave: vi.fn().mockResolvedValue(undefined), fetchOwner: vi.fn()};
    await handleGuildCreate(guild as never);

    expect(guild.leave).toHaveBeenCalledOnce();
    expect(mocks.settingUpsert).not.toHaveBeenCalled();
    expect(guild.fetchOwner).not.toHaveBeenCalled();
    consoleLog.mockRestore();
  });

  it('do not affect onboarding of other guilds', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mocks.containerGet.mockImplementation(() => config);
    const guild = {id: '111111111111111111', leave: vi.fn(), fetchOwner: vi.fn().mockResolvedValue({send})};
    await handleGuildCreate(guild as never);

    expect(guild.leave).not.toHaveBeenCalled();
    expect(mocks.settingUpsert).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });
});
