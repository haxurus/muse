import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {ChannelType, Collection} from 'discord.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The worker control server imports the settings helpers (Prisma); the meta route never uses them.
vi.mock('../src/control/guild-settings.js', () => ({
  sanitizeGuildSettingsPatch: vi.fn((patch: unknown) => patch),
  updateGuildSettings: vi.fn(),
}));

import WorkerControlServer from '../src/control/worker-server.js';
import {STATUS_CHANNEL_PERMISSIONS} from '../src/status/announce.js';

const token = 'c'.repeat(32);
const botId = '666666666666666666';
const guildA = '111111111111111111';
const guildB = '222222222222222222';
const categoryId = '444444444444444440';
const textChannel = '444444444444444441';
const newsChannel = '444444444444444442';
const voiceChannel = '444444444444444443';
const lockedChannel = '444444444444444444';
const topChannel = '444444444444444445';
const roleStaff = '555555555555555551';
const roleSilent = '555555555555555552';
const roleManaged = '555555555555555553';

type FakeChannel = {
  id: string;
  name: string;
  type: ChannelType;
  rawPosition: number;
  parent: {id: string; name: string; rawPosition: number} | null;
  parentId: string | null;
  permissionsFor: ReturnType<typeof vi.fn>;
};

type FakeGuild = {
  id: string;
  members: {me: {id: string} | null};
  channels: {cache: Collection<string, FakeChannel>};
  roles: {cache: Collection<string, {id: string; name: string; color: number; mentionable: boolean; managed: boolean; position: number}>};
};

const makeGuild = (id: string): FakeGuild => {
  const guild: FakeGuild = {
    id,
    members: {me: {id: botId}},
    channels: {cache: new Collection()},
    roles: {cache: new Collection()},
  };
  const category = {id: categoryId, name: 'Logs', rawPosition: 2};
  const channel = (channelId: string, name: string, type: ChannelType, rawPosition: number, parent: typeof category | null): FakeChannel => ({
    id: channelId,
    name,
    type,
    rawPosition,
    parent,
    parentId: parent?.id ?? null,
    permissionsFor: vi.fn(() => ({has: vi.fn(() => channelId !== lockedChannel)})),
  });

  for (const entry of [
    channel(lockedChannel, 'locked', ChannelType.GuildText, 1, category),
    channel(textChannel, 'bot-log', ChannelType.GuildText, 0, category),
    channel(newsChannel, 'news', ChannelType.GuildAnnouncement, 3, null),
    channel(voiceChannel, 'Voice', ChannelType.GuildVoice, 4, null),
    channel(topChannel, 'general', ChannelType.GuildText, 0, null),
  ]) {
    guild.channels.cache.set(entry.id, entry);
  }

  for (const role of [
    {id, name: '@everyone', color: 0, mentionable: true, managed: false, position: 0},
    {id: roleSilent, name: 'Silent', color: 0, mentionable: false, managed: false, position: 1},
    {id: roleManaged, name: 'Muse One', color: 0, mentionable: false, managed: true, position: 2},
    {id: roleStaff, name: 'Staff', color: 0x3c_cf_8e, mentionable: true, managed: false, position: 5},
  ]) {
    guild.roles.cache.set(role.id, role);
  }

  return guild;
};

const makeClient = (guilds: FakeGuild[], ready = true) => ({
  isReady: () => ready,
  guilds: {cache: new Collection(guilds.map(guild => [guild.id, guild]))},
});

const servers: WorkerControlServer[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

const startWorker = async (client: ReturnType<typeof makeClient>) => {
  const config = {WORKER_ID: 'muse-01', CONTROL_HOST: '127.0.0.1', CONTROL_PORT: 0, CONTROL_TOKEN: token};
  const server = new WorkerControlServer(config as never, client as never, {snapshot: () => []} as never);
  await server.start();
  servers.push(server);
  const {port} = (server as unknown as {server: Server}).server.address() as AddressInfo;

  return async (url: string, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {headers: auth ? {authorization: `Bearer ${token}`} : {}});
    return {status: response.status, body: await response.json() as Record<string, unknown>};
  };
};

describe('worker guild meta route', () => {
  it('lists postable channels in sidebar order and mentionable-candidate roles', async () => {
    const call = await startWorker(makeClient([makeGuild(guildA), makeGuild(guildB)]));
    expect(await call(`/v1/guilds/${guildA}/meta`)).toEqual({status: 200, body: {
      workerId: 'muse-01',
      guildId: guildA,
      channels: [
        {id: topChannel, name: 'general', type: 'text', parentName: null, position: 0, canPost: true},
        {id: newsChannel, name: 'news', type: 'announcement', parentName: null, position: 3, canPost: true},
        {id: textChannel, name: 'bot-log', type: 'text', parentName: 'Logs', position: 0, canPost: true},
        {id: lockedChannel, name: 'locked', type: 'text', parentName: 'Logs', position: 1, canPost: false},
      ],
      roles: [
        {id: roleStaff, name: 'Staff', color: 0x3c_cf_8e, mentionable: true, position: 5},
        {id: roleSilent, name: 'Silent', color: 0, mentionable: false, position: 1},
      ],
    }});
  });

  it('checks the post permissions of this bot', async () => {
    const guild = makeGuild(guildA);
    const call = await startWorker(makeClient([guild]));
    await call(`/v1/guilds/${guildA}/meta`);
    const channel = guild.channels.cache.get(textChannel)!;
    expect(channel.permissionsFor).toHaveBeenCalledWith(guild.members.me);
    const [{value: permissions}] = channel.permissionsFor.mock.results as Array<{value: {has: ReturnType<typeof vi.fn>}}>;
    expect(permissions.has).toHaveBeenCalledWith(STATUS_CHANNEL_PERMISSIONS);
  });

  it('requires the control token, a guild of this bot and a ready client', async () => {
    const call = await startWorker(makeClient([makeGuild(guildA)]));
    expect((await call(`/v1/guilds/${guildA}/meta`, false)).status).toBe(401);
    expect(await call(`/v1/guilds/${guildB}/meta`)).toEqual({status: 404, body: {error: 'worker is not a member of that guild', code: 'NOT_IN_GUILD'}});
    expect((await call('/v1/guilds/nope/meta')).status).toBe(400);

    const offline = await startWorker(makeClient([makeGuild(guildA)], false));
    expect(await offline(`/v1/guilds/${guildA}/meta`)).toEqual({status: 503, body: {error: 'worker is not connected to Discord', code: 'NOT_READY'}});
  });
});
