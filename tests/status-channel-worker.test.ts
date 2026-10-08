import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {ChannelType, Collection, PermissionFlagsBits} from 'discord.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Worker routes read and write settings through these helpers (Prisma); the tests drive them directly.
const settingsMocks = vi.hoisted(() => ({
  getGuildSettingsView: vi.fn(),
  updateGuildSettings: vi.fn(),
  listStatusChannelTargets: vi.fn(),
}));

vi.mock('../src/control/guild-settings.js', () => settingsMocks);

import WorkerControlServer from '../src/control/worker-server.js';
import {
  STATUS_CHANNEL_PERMISSIONS,
  STATUS_ONLINE_COLOR,
  STATUS_TEST_COLOR,
  postStatusMessage,
  roleMentions,
  statusFooter,
  type StatusMessageInput,
} from '../src/status/announce.js';
import StatusAnnouncer, {
  STATUS_ANNOUNCE_INTERVAL_MS,
  STATUS_GUILD_DELAY_MS,
  type StatusAnnouncerDependencies,
} from '../src/status/startup-announcer.js';

const token = 'c'.repeat(32);
const botId = '666666666666666666';
const guildA = '111111111111111111';
const guildB = '222222222222222222';
const foreignGuild = '333333333333333333';
const categoryId = '444444444444444440';
const textChannel = '444444444444444441';
const newsChannel = '444444444444444442';
const voiceChannel = '444444444444444443';
const lockedChannel = '444444444444444444';
const topChannel = '444444444444444445';
const foreignChannel = '888888888888888881';
const roleStaff = '555555555555555551';
const roleSilent = '555555555555555552';
const roleManaged = '555555555555555553';
const foreignRole = '999999999999999991';

type EmbedJson = {
  title?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  footer?: {text: string};
  fields?: Array<{name: string; value: string; inline?: boolean}>;
};

type SentMessage = {
  content?: string;
  embeds: Array<{toJSON: () => EmbedJson}>;
  allowedMentions: unknown;
};

type FakeChannel = {
  id: string;
  name: string;
  type: ChannelType;
  rawPosition: number;
  parent: {id: string; name: string; rawPosition: number} | null;
  parentId: string | null;
  guild: FakeGuild;
  permissionsFor: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

type FakeGuild = {
  id: string;
  members: {me: {id: string} | null};
  channels: {cache: Collection<string, FakeChannel>};
  roles: {cache: Collection<string, {id: string; name: string; color: number; mentionable: boolean; managed: boolean; position: number}>};
};

const makeGuild = (id: string) => {
  const guild: FakeGuild = {
    id,
    members: {me: {id: botId}},
    channels: {cache: new Collection()},
    roles: {cache: new Collection()},
  };
  const category = {id: categoryId, name: 'Logs', rawPosition: 2};
  const has = new Map<string, boolean>();
  const channel = (channelId: string, name: string, type: ChannelType, rawPosition: number, parent: typeof category | null): FakeChannel => ({
    id: channelId,
    name,
    type,
    rawPosition,
    parent,
    parentId: parent?.id ?? null,
    guild,
    permissionsFor: vi.fn(() => ({has: vi.fn(() => has.get(channelId) ?? true)})),
    send: vi.fn(async (_message: SentMessage) => ({id: 'message-id'})),
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

  has.set(lockedChannel, false);
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

const makeClient = (guilds: FakeGuild[], ready = true) => {
  const channels = new Map<string, FakeChannel>();
  for (const guild of guilds) {
    for (const channel of guild.channels.cache.values()) {
      // Every fake guild reuses the same channel ids; the first guild (the one under test) owns them.
      if (!channels.has(channel.id)) {
        channels.set(channel.id, channel);
      }
    }
  }

  return {
    isReady: () => ready,
    user: {
      id: botId,
      username: 'Muse One',
      tag: 'Muse One#0420',
      displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${botId}/a.png`,
    },
    guilds: {cache: new Collection(guilds.map(guild => [guild.id, guild]))},
    channels: {fetch: vi.fn(async (channelId: string) => channels.get(channelId) ?? null)},
  };
};

const settingsView = (guildId: string, overrides: Record<string, unknown> = {}) => ({
  guildId,
  locale: 'en',
  defaultVolume: 100,
  statusChannelId: null,
  statusMentionRoleIds: [],
  ...overrides,
});

const sent = (send: {mock: {calls: unknown[][]}}, index = 0): SentMessage => send.mock.calls[index][0] as SentMessage;
const sentEmbed = (send: {mock: {calls: unknown[][]}}, index = 0): EmbedJson => sent(send, index).embeds[0].toJSON();

const servers: WorkerControlServer[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('MUSE_DASHBOARD_PUBLIC_URL', 'https://music.example.test/');
  settingsMocks.getGuildSettingsView.mockReset().mockImplementation(async (guildId: string) => settingsView(guildId));
  settingsMocks.updateGuildSettings.mockReset().mockImplementation(async (guildId: string, patch: Record<string, unknown>) => settingsView(guildId, patch));
  settingsMocks.listStatusChannelTargets.mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

const startWorker = async (client: ReturnType<typeof makeClient>) => {
  const config = {WORKER_ID: 'muse-01', CONTROL_HOST: '127.0.0.1', CONTROL_PORT: 0, CONTROL_TOKEN: token};
  const playerManager = {snapshot: () => []};
  const server = new WorkerControlServer(config as never, client as never, playerManager as never);
  await server.start();
  servers.push(server);
  const {port} = (server as unknown as {server: Server}).server.address() as AddressInfo;

  return async (method: string, path: string, body?: unknown, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(auth ? {authorization: `Bearer ${token}`} : {}),
        ...(body === undefined ? {} : {'content-type': 'application/json'}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, body: await response.json() as Record<string, any>};
  };
};

describe('worker settings route: status channel guild checks', () => {
  const patch = async (body: unknown) => {
    const guild = makeGuild(guildA);
    const other = makeGuild(foreignGuild);
    const call = await startWorker(makeClient([guild, other]));
    return call('PATCH', `/v1/guilds/${guildA}/settings`, body);
  };

  it.each([
    ['a channel of another server', {statusChannelId: foreignChannel}, 'INVALID_STATUS_CHANNEL'],
    ['a voice channel', {statusChannelId: voiceChannel}, 'INVALID_STATUS_CHANNEL'],
    ['a category', {statusChannelId: categoryId}, 'INVALID_STATUS_CHANNEL'],
    ['a malformed channel id', {statusChannelId: 'general'}, 'INVALID_STATUS_CHANNEL'],
    ['the @everyone role', {statusMentionRoleIds: [guildA]}, 'INVALID_STATUS_ROLES'],
    ['a managed role', {statusMentionRoleIds: [roleStaff, roleManaged]}, 'INVALID_STATUS_ROLES'],
    ['a role of another server', {statusMentionRoleIds: [foreignRole]}, 'INVALID_STATUS_ROLES'],
    ['more than 10 roles', {statusMentionRoleIds: Array.from({length: 11}, (_, index) => `5555555555555555${String(index).padStart(2, '0')}`)}, 'INVALID_STATUS_ROLES'],
  ])('rejects %s with 400 before saving', async (_label, body, code) => {
    const result = await patch(body);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe(code);
    expect(settingsMocks.updateGuildSettings).not.toHaveBeenCalled();
  });

  it('saves a text or announcement channel and deduplicated roles of the guild', async () => {
    const result = await patch({statusChannelId: textChannel, statusMentionRoleIds: [roleStaff, roleSilent, roleStaff]});
    expect(result.status).toBe(200);
    expect(settingsMocks.updateGuildSettings).toHaveBeenCalledWith(guildA, {statusChannelId: textChannel, statusMentionRoleIds: [roleStaff, roleSilent]});
    expect(result.body).toMatchObject({statusChannelId: textChannel, statusMentionRoleIds: [roleStaff, roleSilent]});

    expect((await patch({statusChannelId: newsChannel})).status).toBe(200);
  });

  it('clears the setting with null and []', async () => {
    const result = await patch({statusChannelId: null, statusMentionRoleIds: []});
    expect(result.status).toBe(200);
    expect(settingsMocks.updateGuildSettings).toHaveBeenCalledWith(guildA, {statusChannelId: null, statusMentionRoleIds: []});
  });

  it('returns the settings with the roles as a list and refuses guilds the bot is not in', async () => {
    settingsMocks.getGuildSettingsView.mockResolvedValueOnce(settingsView(guildA, {statusChannelId: textChannel, statusMentionRoleIds: [roleStaff]}));
    const call = await startWorker(makeClient([makeGuild(guildA)]));
    expect(await call('GET', `/v1/guilds/${guildA}/settings`)).toEqual({
      status: 200,
      body: settingsView(guildA, {statusChannelId: textChannel, statusMentionRoleIds: [roleStaff]}),
    });
    expect(await call('PATCH', `/v1/guilds/${guildB}/settings`, {statusChannelId: textChannel})).toEqual({
      status: 404,
      body: {error: 'worker is not a member of that guild', code: 'NOT_IN_GUILD'},
    });
    expect(settingsMocks.updateGuildSettings).not.toHaveBeenCalled();
  });
});

describe('worker guild meta route', () => {
  it('lists postable channels in sidebar order and mentionable-candidate roles', async () => {
    const call = await startWorker(makeClient([makeGuild(guildA), makeGuild(guildB)]));
    const result = await call('GET', `/v1/guilds/${guildA}/meta`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
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
    });
  });

  it('checks the post permissions of this bot', async () => {
    const guild = makeGuild(guildA);
    const call = await startWorker(makeClient([guild]));
    await call('GET', `/v1/guilds/${guildA}/meta`);
    const channel = guild.channels.cache.get(textChannel)!;
    expect(channel.permissionsFor).toHaveBeenCalledWith(guild.members.me);
    const [{value: permissions}] = channel.permissionsFor.mock.results as Array<{value: {has: ReturnType<typeof vi.fn>}}>;
    expect(permissions.has).toHaveBeenCalledWith(STATUS_CHANNEL_PERMISSIONS);
  });

  it('requires the control token, a guild of this bot and a ready client', async () => {
    const call = await startWorker(makeClient([makeGuild(guildA)]));
    expect((await call('GET', `/v1/guilds/${guildA}/meta`, undefined, false)).status).toBe(401);
    expect((await call('GET', `/v1/guilds/${guildB}/meta`)).body).toEqual({error: 'worker is not a member of that guild', code: 'NOT_IN_GUILD'});
    expect((await call('GET', '/v1/guilds/nope/meta')).status).toBe(400);

    const offline = await startWorker(makeClient([makeGuild(guildA)], false));
    expect(await offline('GET', `/v1/guilds/${guildA}/meta`)).toEqual({status: 503, body: {error: 'worker is not connected to Discord', code: 'NOT_READY'}});
  });
});

describe('worker status test route', () => {
  const testPath = `/v1/guilds/${guildA}/status-channel/test`;

  it('reports NOT_CONFIGURED when this bot has no status channel for the guild', async () => {
    const guild = makeGuild(guildA);
    const client = makeClient([guild]);
    const call = await startWorker(client);
    expect(await call('POST', testPath)).toEqual({status: 200, body: {workerId: 'muse-01', ok: false, error: 'NOT_CONFIGURED'}});
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('posts the violet test message with the saved roles in the guild language', async () => {
    settingsMocks.getGuildSettingsView.mockResolvedValue(settingsView(guildA, {locale: 'it', statusChannelId: textChannel, statusMentionRoleIds: [roleStaff, roleSilent]}));
    const guild = makeGuild(guildA);
    const call = await startWorker(makeClient([guild, makeGuild(guildB)]));

    expect(await call('POST', testPath)).toEqual({status: 200, body: {workerId: 'muse-01', ok: true}});
    const channel = guild.channels.cache.get(textChannel)!;
    const message = sent(channel.send);
    expect(message.content).toBe(`<@&${roleStaff}> <@&${roleSilent}>`);
    expect(message.allowedMentions).toEqual({parse: [], roles: [roleStaff, roleSilent]});
    const embed = sentEmbed(channel.send);
    expect(embed).toMatchObject({title: 'Messaggio di prova', description: 'Prova del canale di stato inviata da Muse One#0420.', color: STATUS_TEST_COLOR});
    expect(embed.fields?.map(field => field.name)).toEqual(['Autore azione', 'Dettagli']);
    expect(embed.fields?.[1].value).toContain('**Guild Count:** 2');
    expect(embed.footer).toEqual({text: 'music.example.test'});
  });

  it('reports missing permissions, foreign channels and a disconnected bot', async () => {
    settingsMocks.getGuildSettingsView.mockResolvedValue(settingsView(guildA, {statusChannelId: lockedChannel}));
    const guild = makeGuild(guildA);
    const call = await startWorker(makeClient([guild, makeGuild(foreignGuild)]));
    expect((await call('POST', testPath)).body).toEqual({workerId: 'muse-01', ok: false, error: 'MISSING_PERMISSIONS'});
    expect(guild.channels.cache.get(lockedChannel)!.send).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('MISSING_PERMISSIONS'));

    // A stored id that points to another server is never used.
    settingsMocks.getGuildSettingsView.mockResolvedValue(settingsView(guildA, {statusChannelId: foreignChannel}));
    expect((await call('POST', testPath)).body).toEqual({workerId: 'muse-01', ok: false, error: 'CHANNEL_NOT_FOUND'});

    const offline = await startWorker(makeClient([makeGuild(guildA)], false));
    expect((await offline('POST', testPath)).body).toEqual({workerId: 'muse-01', ok: false, error: 'NOT_READY'});
    expect((await call('POST', `/v1/guilds/${guildB}/status-channel/test`)).status).toBe(404);
    expect((await call('POST', testPath, undefined, false)).status).toBe(401);
  });

  it('no longer serves the platform-wide announce route', async () => {
    const call = await startWorker(makeClient([makeGuild(guildA)]));
    expect((await call('POST', '/v1/status-channel/announce', {channelId: textChannel, test: true})).status).toBe(404);
  });
});

describe('status message', () => {
  const input = (overrides: Partial<StatusMessageInput> = {}): StatusMessageInput => ({
    guildId: guildA,
    channelId: textChannel,
    test: false,
    mentionRoleIds: [],
    locale: 'en',
    ...overrides,
  });

  it('posts the green "Bot started" embed and pings exactly the configured roles', async () => {
    const guild = makeGuild(guildA);
    const client = makeClient([guild]);
    await expect(postStatusMessage(client as never, input({mentionRoleIds: [roleStaff, roleSilent, roleStaff]}))).resolves.toEqual({ok: true});

    const channel = guild.channels.cache.get(textChannel)!;
    const message = sent(channel.send);
    expect(message.content).toBe(`<@&${roleStaff}> <@&${roleSilent}>`);
    expect(message.allowedMentions).toEqual({parse: [], roles: [roleStaff, roleSilent]});
    const embed = sentEmbed(channel.send);
    expect(embed.title).toBe('Bot started');
    expect(embed.description).toBe('Bot connected as Muse One#0420.');
    expect(embed.color).toBe(STATUS_ONLINE_COLOR);
    expect(STATUS_ONLINE_COLOR).toBe(0x3c_cf_8e);
    expect(embed.fields).toEqual([
      {name: 'Action author', value: `**Muse One** · <@${botId}> · \`${botId}\``},
      {name: 'Details', value: `**Guild Count:** 1\n**Bot:** Muse One · <@${botId}> · \`${botId}\``},
    ]);
    expect(embed.footer).toEqual({text: 'music.example.test'});
    expect(Math.abs(Date.parse(embed.timestamp!) - Date.now())).toBeLessThan(10_000);
    expect(STATUS_CHANNEL_PERMISSIONS).toEqual([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  });

  it('sends no content and allows no mentions without roles', async () => {
    const guild = makeGuild(guildA);
    await postStatusMessage(makeClient([guild]) as never, input());
    const message = sent(guild.channels.cache.get(textChannel)!.send);
    expect(message.content).toBeUndefined();
    expect(message.allowedMentions).toEqual({parse: [], roles: []});
  });

  it('maps every failure to a short code and never throws', async () => {
    const guild = makeGuild(guildA);
    const client = makeClient([guild, makeGuild(foreignGuild)]);
    await expect(postStatusMessage(makeClient([guild], false) as never, input())).resolves.toEqual({ok: false, error: 'NOT_READY'});
    await expect(postStatusMessage(client as never, input({channelId: '123456789012345678'}))).resolves.toEqual({ok: false, error: 'CHANNEL_NOT_FOUND'});
    await expect(postStatusMessage(client as never, input({channelId: voiceChannel}))).resolves.toEqual({ok: false, error: 'INVALID_CHANNEL'});
    await expect(postStatusMessage(client as never, input({channelId: foreignChannel}))).resolves.toEqual({ok: false, error: 'CHANNEL_NOT_FOUND'});
    await expect(postStatusMessage(client as never, input({channelId: lockedChannel}))).resolves.toEqual({ok: false, error: 'MISSING_PERMISSIONS'});
    await expect(postStatusMessage(client as never, input({channelId: newsChannel}))).resolves.toEqual({ok: true});

    client.channels.fetch.mockRejectedValueOnce({code: 10_003});
    await expect(postStatusMessage(client as never, input())).resolves.toEqual({ok: false, error: 'CHANNEL_NOT_FOUND'});
    client.channels.fetch.mockRejectedValueOnce({code: 50_001});
    await expect(postStatusMessage(client as never, input())).resolves.toEqual({ok: false, error: 'MISSING_PERMISSIONS'});
    guild.channels.cache.get(textChannel)!.send.mockRejectedValueOnce({code: 50_013});
    await expect(postStatusMessage(client as never, input())).resolves.toEqual({ok: false, error: 'MISSING_PERMISSIONS'});
    guild.channels.cache.get(textChannel)!.send.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(postStatusMessage(client as never, input())).resolves.toEqual({ok: false, error: 'DISCORD_ERROR'});
  });

  it('uses the dashboard hostname as footer and builds role mentions only', () => {
    expect(statusFooter('https://music.example.test/it')).toBe('music.example.test');
    expect(statusFooter(undefined)).toBe('Muse');
    expect(statusFooter('')).toBe('Muse');
    expect(statusFooter('not a url')).toBe('Muse');
    expect(roleMentions([])).toBeUndefined();
    expect(roleMentions([roleStaff, roleSilent])).toBe(`<@&${roleStaff}> <@&${roleSilent}>`);
  });
});

describe('startup status announcer', () => {
  const target = (guildId: string, overrides: Record<string, unknown> = {}) => ({
    guildId,
    channelId: textChannel,
    mentionRoleIds: [] as string[],
    locale: 'en',
    ...overrides,
  });

  const setup = (overrides: Partial<StatusAnnouncerDependencies> = {}, guildIds = [guildA, guildB]) => {
    let now = 1_000_000;
    const order: string[] = [];
    const dependencies = {
      listTargets: vi.fn(async () => [target(guildA, {mentionRoleIds: [roleStaff], locale: 'it'}), target(guildB)]),
      post: vi.fn(async (_client: unknown, input: StatusMessageInput) => {
        order.push(`post:${input.guildId}`);
        return {ok: true as const};
      }),
      now: () => now,
      delay: vi.fn(async (ms: number) => {
        order.push(`delay:${ms}`);
      }),
      ...overrides,
    };
    const client = {guilds: {cache: new Collection(guildIds.map(id => [id, {id}]))}};
    const announcer = new StatusAnnouncer(client as never, {WORKER_ID: 'muse-01'}, dependencies);
    return {
      announcer,
      client,
      dependencies,
      order,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it('does nothing outside a managed worker', async () => {
    const listTargets = vi.fn(async () => [target(guildA)]);
    const announcer = new StatusAnnouncer({} as never, {WORKER_ID: ''}, {listTargets});
    await expect(announcer.announceOnline()).resolves.toMatchObject({outcome: 'skipped'});
    expect(listTargets).not.toHaveBeenCalled();
  });

  it('posts in every configured guild, one at a time, with its locale and roles', async () => {
    const {announcer, client, dependencies, order} = setup();
    await expect(announcer.announceOnline()).resolves.toEqual({outcome: 'done', posted: [guildA, guildB], failed: []});
    expect(dependencies.post.mock.calls).toEqual([
      [client, {guildId: guildA, channelId: textChannel, test: false, mentionRoleIds: [roleStaff], locale: 'it'}],
      [client, {guildId: guildB, channelId: textChannel, test: false, mentionRoleIds: [], locale: 'en'}],
    ]);
    expect(order).toEqual([`post:${guildA}`, `delay:${STATUS_GUILD_DELAY_MS}`, `post:${guildB}`]);
  });

  it('skips guilds this bot has left and unknown locales fall back to English', async () => {
    const {announcer, dependencies} = setup({
      listTargets: vi.fn(async () => [target(foreignGuild), target(guildA, {locale: 'fr'})]),
    });
    await expect(announcer.announceOnline()).resolves.toMatchObject({posted: [guildA]});
    expect(dependencies.post).toHaveBeenCalledOnce();
    expect(dependencies.post.mock.calls[0][1]).toMatchObject({guildId: guildA, locale: 'en'});
  });

  it('stays quiet without configured guilds and retries on the next reconnect', async () => {
    const listTargets = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([target(guildA)]);
    const {announcer, dependencies} = setup({listTargets});
    await expect(announcer.announceOnline()).resolves.toMatchObject({outcome: 'skipped'});
    expect(dependencies.post).not.toHaveBeenCalled();
    // Nothing was posted, so the rate limit did not start.
    await expect(announcer.announceOnline()).resolves.toMatchObject({outcome: 'done', posted: [guildA]});
  });

  it('logs a failed guild concisely and keeps going', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ok: false, error: 'MISSING_PERMISSIONS'})
      .mockRejectedValueOnce(new TypeError('boom'))
      .mockResolvedValueOnce({ok: true});
    const {announcer} = setup({
      post,
      listTargets: vi.fn(async () => [target(guildA), target(guildB), target(guildA, {channelId: newsChannel})]),
    });
    await expect(announcer.announceOnline()).resolves.toEqual({
      outcome: 'done',
      posted: [guildA],
      failed: [{guildId: guildA, error: 'MISSING_PERMISSIONS'}, {guildId: guildB, error: 'TypeError'}],
    });
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(`Status channel: online message not posted in guild ${guildA} (MISSING_PERMISSIONS)`);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(`Status channel: online message not posted in guild ${guildB} (TypeError)`);
    expect(vi.mocked(console.log)).toHaveBeenCalledWith('Status channel: online message posted in 1/3 guilds');
  });

  it('only logs a settings read failure and retries on the next reconnect', async () => {
    const listTargets = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('database is locked'), {name: 'PrismaClientUnknownRequestError'}))
      .mockResolvedValueOnce([target(guildA)]);
    const {announcer, dependencies} = setup({listTargets});
    await expect(announcer.announceOnline()).resolves.toMatchObject({outcome: 'failed'});
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith('Status channel: could not read the status channel settings (PrismaClientUnknownRequestError)');
    expect(dependencies.post).not.toHaveBeenCalled();
    await expect(announcer.announceOnline()).resolves.toMatchObject({outcome: 'done'});
  });

  it('announces at most once every 5 minutes, failed posts included', async () => {
    const post = vi.fn().mockResolvedValueOnce({ok: false, error: 'MISSING_PERMISSIONS'}).mockResolvedValue({ok: true});
    const {announcer, advance} = setup({post, listTargets: vi.fn(async () => [target(guildA)])});
    await expect(announcer.announceOnline()).resolves.toMatchObject({outcome: 'done', posted: []});

    advance(STATUS_ANNOUNCE_INTERVAL_MS - 1);
    await expect(announcer.announceOnline()).resolves.toMatchObject({outcome: 'skipped'});
    expect(post).toHaveBeenCalledTimes(1);

    advance(1);
    await expect(announcer.announceOnline()).resolves.toMatchObject({outcome: 'done', posted: [guildA]});
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('never runs two announcements at once', async () => {
    let release: (value: Array<ReturnType<typeof target>>) => void = () => undefined;
    const listTargets = vi.fn(async () => new Promise<Array<ReturnType<typeof target>>>(resolve => {
      release = resolve;
    }));
    const {announcer, dependencies} = setup({listTargets});
    const first = announcer.announceOnline();
    await expect(announcer.announceOnline()).resolves.toMatchObject({outcome: 'skipped'});
    release([target(guildA)]);
    await expect(first).resolves.toMatchObject({outcome: 'done', posted: [guildA]});
    expect(dependencies.post).toHaveBeenCalledOnce();
  });
});
