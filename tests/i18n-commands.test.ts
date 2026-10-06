import 'reflect-metadata';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ChatInputCommandInteraction} from 'discord.js';

const mocks = vi.hoisted(() => ({
  getGuildSettings: vi.fn(),
  settingUpdate: vi.fn(),
}));

vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: mocks.getGuildSettings,
}));

vi.mock('../src/utils/db.js', () => ({
  prisma: {
    setting: {update: mocks.settingUpdate},
    favoriteQuery: {findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn()},
  },
}));

vi.mock('../src/services/player.js', () => ({
  default: class {},
  STATUS: {PLAYING: 0, PAUSED: 1, IDLE: 2},
  MediaSource: {Youtube: 0, HLS: 1, SoundCloud: 2},
  DEFAULT_VOLUME: 100,
}));

import Clear from '../src/commands/clear.js';
import Config from '../src/commands/config.js';
import Disconnect from '../src/commands/disconnect.js';
import Favorites from '../src/commands/favorites.js';
import ForwardSeek from '../src/commands/fseek.js';
import LoopQueue from '../src/commands/loop-queue.js';
import Loop from '../src/commands/loop.js';
import Move from '../src/commands/move.js';
import Next from '../src/commands/next.js';
import NowPlaying from '../src/commands/now-playing.js';
import Pause from '../src/commands/pause.js';
import Play from '../src/commands/play.js';
import Queue from '../src/commands/queue.js';
import Remove from '../src/commands/remove.js';
import Replay from '../src/commands/replay.js';
import Resume from '../src/commands/resume.js';
import Seek from '../src/commands/seek.js';
import Shuffle from '../src/commands/shuffle.js';
import Skip from '../src/commands/skip.js';
import Stop from '../src/commands/stop.js';
import Unskip from '../src/commands/unskip.js';
import Volume from '../src/commands/volume.js';
import {getGuildLocale} from '../src/i18n/guild-locale.js';
import {UserError, localizeError} from '../src/i18n/index.js';

type SerializedNode = {
  name: string;
  description?: string;
  description_localizations?: Record<string, string> | null;
  options?: SerializedNode[];
  choices?: Array<{name: string; value: string | number}>;
};

const makeCommands = () => {
  const playerManager = {} as never;
  const addQueryToQueue = {} as never;

  return [
    new Clear(playerManager),
    new Config(),
    new Disconnect(playerManager),
    new Favorites(addQueryToQueue),
    new ForwardSeek(playerManager),
    new LoopQueue(playerManager),
    new Loop(playerManager),
    new Move(playerManager),
    new Next(playerManager),
    new NowPlaying(playerManager),
    new Pause(playerManager),
    new Play(undefined as never, {} as never, addQueryToQueue),
    new Play({spotify: {}} as never, {} as never, addQueryToQueue),
    new Queue(playerManager),
    new Remove(playerManager),
    new Replay(playerManager),
    new Resume(playerManager),
    new Seek(playerManager),
    new Shuffle(playerManager),
    new Skip(playerManager),
    new Stop(playerManager),
    new Unskip(playerManager),
    new Volume(playerManager),
  ];
};

const collectNodes = (node: SerializedNode, path: string, out: Array<[string, SerializedNode]>) => {
  out.push([path, node]);
  for (const option of node.options ?? []) {
    collectNodes(option, `${path} > ${option.name}`, out);
  }

  return out;
};

const makeInteraction = (options: {subcommand?: string; strings?: Record<string, string | null>} = {}) => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    guild: {id: 'guild'},
    options: {
      getInteger: vi.fn(() => null),
      getString: vi.fn((name: string) => options.strings?.[name] ?? null),
      getBoolean: vi.fn(() => null),
      getSubcommand: vi.fn(() => options.subcommand ?? ''),
    },
    reply,
  } as unknown as ChatInputCommandInteraction;

  return {interaction, reply};
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getGuildSettings.mockResolvedValue(undefined);
  mocks.settingUpdate.mockResolvedValue({});
});

describe('slash command localizations', () => {
  it('give every command, subcommand and option an Italian description within Discord limits', () => {
    for (const command of makeCommands()) {
      const json = command.slashCommand.toJSON() as unknown as SerializedNode;
      for (const [path, node] of collectNodes(json, `/${json.name}`, [])) {
        const italian = node.description_localizations?.it;
        expect(italian, path).toBeTypeOf('string');
        expect(italian!.length, path).toBeGreaterThan(0);
        expect(italian!.length, path).toBeLessThanOrEqual(100);
        expect(node.description_localizations, path).not.toHaveProperty('en');
      }
    }
  });

  it('keeps command names English and offers the language choices', () => {
    const json = new Config().slashCommand.toJSON() as unknown as SerializedNode;
    const setLanguage = json.options?.find(option => option.name === 'set-language');
    expect(setLanguage?.description).toBe('set the language of bot messages');
    expect(setLanguage?.options?.[0]).toMatchObject({
      name: 'language',
      choices: [{name: 'English', value: 'en'}, {name: 'Italiano', value: 'it'}],
    });
  });
});

describe('guild locale', () => {
  it('defaults to English for a fresh guild row, a missing row and a failed lookup', async () => {
    mocks.getGuildSettings.mockResolvedValueOnce({guildId: 'guild', locale: 'en'});
    await expect(getGuildLocale('guild')).resolves.toBe('en');

    mocks.getGuildSettings.mockResolvedValueOnce({guildId: 'guild'});
    await expect(getGuildLocale('guild')).resolves.toBe('en');

    mocks.getGuildSettings.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(getGuildLocale('guild')).resolves.toBe('en');

    await expect(getGuildLocale(null)).resolves.toBe('en');
  });

  it('reads Italian from the settings row', async () => {
    mocks.getGuildSettings.mockResolvedValueOnce({guildId: 'guild', locale: 'it'});
    await expect(getGuildLocale('guild')).resolves.toBe('it');
  });
});

describe('command replies', () => {
  it('reply in English by default', async () => {
    const {interaction, reply} = makeInteraction();
    await new Clear({get: () => ({clear: vi.fn()})} as never).execute(interaction);
    expect(reply).toHaveBeenCalledWith('clearer than a field after a fresh harvest');
  });

  it('reply in Italian when the guild locale is it', async () => {
    mocks.getGuildSettings.mockResolvedValue({locale: 'it'});
    const {interaction, reply} = makeInteraction();
    await new Shuffle({get: () => ({isQueueEmpty: () => false, shuffle: vi.fn()})} as never).execute(interaction);
    expect(reply).toHaveBeenCalledWith('coda mescolata');
  });

  it('throw errors that keep their English message and render in Italian', async () => {
    const {interaction} = makeInteraction();
    const failure = new Disconnect({get: () => ({voiceConnection: null})} as never).execute(interaction);
    await expect(failure).rejects.toThrow('not connected');
    const error: unknown = await failure.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(UserError);
    expect(localizeError('it', error)).toBe('non sono connesso');
  });

  it('show /config get labels in Italian', async () => {
    mocks.getGuildSettings.mockResolvedValue({
      locale: 'it',
      playlistLimit: 20,
      secondsToWaitAfterQueueEmpties: 0,
      leaveIfNoListeners: true,
      autoAnnounceNextSong: false,
      queueAddResponseEphemeral: true,
      defaultVolume: 80,
      defaultQueuePageSize: 10,
      turnDownVolumeWhenPeopleSpeak: true,
      turnDownVolumeWhenPeopleSpeakTarget: 23,
    });
    const {interaction, reply} = makeInteraction({subcommand: 'get'});

    await new Config().execute(interaction);

    const response = reply.mock.calls[0][0] as {embeds: Array<{toJSON: () => {title?: string; description?: string}}>};
    const embed = response.embeds[0].toJSON();
    expect(embed.title).toBe('Configurazione');
    expect(embed.description).toContain('**Attesa prima di uscire a coda vuota**: non uscire mai');
    expect(embed.description).toContain('**Esci se non ci sono ascoltatori**: sì');
    expect(embed.description).toContain('**Lingua del bot**: Italiano');
  });

  it('store the language with /config set-language and confirm in that language', async () => {
    const {interaction, reply} = makeInteraction({subcommand: 'set-language', strings: {language: 'it'}});

    await new Config().execute(interaction);

    expect(mocks.settingUpdate).toHaveBeenCalledWith({where: {guildId: 'guild'}, data: {locale: 'it'}});
    expect(reply).toHaveBeenCalledWith('👍 lingua del bot impostata su italiano');
  });

  it('reject an unsupported language without storing it', async () => {
    const {interaction} = makeInteraction({subcommand: 'set-language', strings: {language: 'fr'}});

    await expect(new Config().execute(interaction)).rejects.toThrow('unsupported language');
    expect(mocks.settingUpdate).not.toHaveBeenCalled();
  });
});
