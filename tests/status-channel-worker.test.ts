import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {ChannelType, Collection, PermissionFlagsBits} from 'discord.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// vi.mock factories are hoisted above every declaration, so the Italian guild id is inlined.
vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: vi.fn(async (guildId: string) => ({guildId, locale: guildId === '222222222222222222' ? 'it' : 'en'})),
}));

vi.mock('../src/control/guild-settings.js', () => ({
  sanitizeGuildSettingsPatch: vi.fn((patch: unknown) => patch),
  updateGuildSettings: vi.fn(async (guildId: string) => ({guildId})),
}));

import WorkerControlServer from '../src/control/worker-server.js';
import {
  STATUS_CHANNEL_PERMISSIONS,
  STATUS_ONLINE_COLOR,
  STATUS_TEST_COLOR,
  postStatusMessage,
  roleMentions,
  statusFooter,
} from '../src/status/announce.js';
import StatusAnnouncer, {
  STATUS_ANNOUNCE_INTERVAL_MS,
  fetchWorkerPlatformConfig,
  type StatusAnnouncerDependencies,
} from '../src/status/startup-announcer.js';

const token = 'c'.repeat(32);
const botId = '666666666666666666';
const englishGuild = '111111111111111111';
const italianGuild = '222222222222222222';
const channelId = '987654321098765432';
const roleA = '555555555555555551';
const roleB = '555555555555555552';

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

const makeChannel = (overrides: Record<string, unknown> = {}) => {
  const has = vi.fn(() => true);
  const channel = {
    id: channelId,
    type: ChannelType.GuildText,
    guild: {id: englishGuild, members: {me: {id: botId}}},
    permissionsFor: vi.fn(() => ({has})),
    send: vi.fn(async (_message: SentMessage) => ({id: 'message-id'})),
    ...overrides,
  };
  return {channel, has};
};

const makeClient = (channel: unknown, ready = true) => ({
  isReady: () => ready,
  user: {
    id: botId,
    username: 'Muse One',
    tag: 'Muse One#0420',
    displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${botId}/a.png`,
  },
  guilds: {cache: new Collection([[englishGuild, {id: englishGuild}], [italianGuild, {id: italianGuild}]])},
  channels: {fetch: vi.fn(async () => channel)},
});

const sent = (send: {mock: {calls: unknown[][]}}, index = 0): SentMessage => send.mock.calls[index][0] as SentMessage;
const sentEmbed = (send: {mock: {calls: unknown[][]}}, index = 0): EmbedJson => sent(send, index).embeds[0].toJSON();

const servers: WorkerControlServer[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('MUSE_DASHBOARD_PUBLIC_URL', 'https://music.example.test/');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

  return async (body: unknown, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status-channel/announce`, {
      method: 'POST',
      headers: {...(auth ? {authorization: `Bearer ${token}`} : {}), 'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
    return {status: response.status, body: await response.json() as Record<string, unknown>};
  };
};

describe('worker status announce route', () => {
  it('requires the control token and a valid body', async () => {
    const {channel} = makeChannel();
    const client = makeClient(channel);
    const announce = await startWorker(client);
    expect((await announce({channelId, test: true}, false)).status).toBe(401);
    expect(await announce({channelId: 'abc', test: true})).toEqual({
      status: 400,
      body: {error: 'channelId must be a Discord channel id', code: 'INVALID_CHANNEL_ID'},
    });
    expect((await announce({channelId})).body.code).toBe('INVALID_BODY');
    expect((await announce([channelId])).body.code).toBe('INVALID_BODY');
    expect((await announce({channelId, test: true, mentionRoleIds: ['@everyone']})).body.code).toBe('INVALID_ROLE_IDS');
    expect((await announce({channelId, test: true, mentionRoleIds: roleA})).body.code).toBe('INVALID_ROLE_IDS');
    const tooMany = Array.from({length: 11}, (_, index) => `5555555555555555${String(index).padStart(2, '0')}`);
    expect((await announce({channelId, test: true, mentionRoleIds: tooMany})).body.code).toBe('INVALID_ROLE_IDS');
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('posts the "Bot started" embed and pings exactly the configured roles', async () => {
    const {channel, has} = makeChannel();
    const client = makeClient(channel);
    const announce = await startWorker(client);

    const result = await announce({channelId, test: false, mentionRoleIds: [roleA, roleB, roleA]});
    expect(result).toEqual({status: 200, body: {workerId: 'muse-01', ok: true}});
    expect(client.channels.fetch).toHaveBeenCalledWith(channelId);
    expect(has).toHaveBeenCalledWith(STATUS_CHANNEL_PERMISSIONS);
    expect(STATUS_CHANNEL_PERMISSIONS).toEqual([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    expect(channel.send).toHaveBeenCalledOnce();

    const message = sent(channel.send);
    expect(message.content).toBe(`<@&${roleA}> <@&${roleB}>`);
    expect(message.allowedMentions).toEqual({parse: [], roles: [roleA, roleB]});
    expect(message.embeds).toHaveLength(1);

    const embed = sentEmbed(channel.send);
    expect(embed.title).toBe('Bot started');
    expect(embed.description).toBe('Bot connected as Muse One#0420.');
    expect(embed.color).toBe(STATUS_ONLINE_COLOR);
    expect(STATUS_ONLINE_COLOR).toBe(0x3ccf8e);
    expect(embed.fields).toEqual([
      {name: 'Action author', value: `**Muse One** · <@${botId}> · \`${botId}\``},
      {name: 'Details', value: `**Guild Count:** 2\n**Bot:** Muse One · <@${botId}> · \`${botId}\``},
    ]);
    expect(embed.footer).toEqual({text: 'music.example.test'});
    expect(Math.abs(Date.parse(embed.timestamp!) - Date.now())).toBeLessThan(10_000);
  });

  it('sends no content and allows no mentions when no role is configured', async () => {
    const {channel} = makeChannel();
    const announce = await startWorker(makeClient(channel));
    await announce({channelId, test: false});
    const message = sent(channel.send);
    expect(message.content).toBeUndefined();
    expect(message.allowedMentions).toEqual({parse: [], roles: []});
  });

  it('uses the guild locale of the channel and the violet test layout', async () => {
    const {channel} = makeChannel({guild: {id: italianGuild, members: {me: {id: botId}}}});
    const announce = await startWorker(makeClient(channel));

    expect((await announce({channelId, test: false, mentionRoleIds: [roleA]})).body).toEqual({workerId: 'muse-01', ok: true});
    const online = sentEmbed(channel.send);
    expect(online.title).toBe('Bot avviato');
    expect(online.description).toBe('Bot connesso come Muse One#0420.');
    expect(online.fields?.map(field => field.name)).toEqual(['Autore azione', 'Dettagli']);
    expect(online.fields?.[1].value).toContain('**Guild Count:** 2');

    await announce({channelId, test: true, mentionRoleIds: [roleA]});
    const test = sentEmbed(channel.send, 1);
    expect(test.title).toBe('Messaggio di prova');
    expect(test.description).toBe('Prova del canale di stato inviata da Muse One#0420.');
    expect(test.color).toBe(STATUS_TEST_COLOR);
    expect(STATUS_TEST_COLOR).toBe(0xa78bfa);
    expect(test.footer).toEqual({text: 'music.example.test'});
    // The test message pings the roles too, so the admin can check the mentions.
    expect(sent(channel.send, 1).content).toBe(`<@&${roleA}>`);
    expect(sent(channel.send, 1).allowedMentions).toEqual({parse: [], roles: [roleA]});
  });

  it('uses the English test title by default', async () => {
    const {channel} = makeChannel();
    const announce = await startWorker(makeClient(channel));
    await announce({channelId, test: true});
    expect(sentEmbed(channel.send)).toMatchObject({title: 'Test message', description: 'Status channel test sent by Muse One#0420.', color: STATUS_TEST_COLOR});
  });

  it('reports missing permissions without posting', async () => {
    const {channel, has} = makeChannel();
    has.mockReturnValue(false);
    const announce = await startWorker(makeClient(channel));

    expect(await announce({channelId, test: true})).toEqual({status: 200, body: {workerId: 'muse-01', ok: false, error: 'MISSING_PERMISSIONS'}});
    expect(channel.send).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('MISSING_PERMISSIONS'));
  });
});

describe('status message helpers', () => {
  it('uses the dashboard hostname as footer and falls back to Muse', () => {
    expect(statusFooter('https://music.example.test/it')).toBe('music.example.test');
    expect(statusFooter(undefined)).toBe('Muse');
    expect(statusFooter('')).toBe('Muse');
    expect(statusFooter('not a url')).toBe('Muse');
  });

  it('builds role mentions only', () => {
    expect(roleMentions([])).toBeUndefined();
    expect(roleMentions([roleA, roleB])).toBe(`<@&${roleA}> <@&${roleB}>`);
  });
});

describe('postStatusMessage error codes', () => {
  const input = {channelId, workerId: 'muse-01', test: false, mentionRoleIds: []};
  const english = async () => 'en' as const;

  it('reports a bot that is not connected', async () => {
    const {channel} = makeChannel();
    const client = makeClient(channel, false);
    await expect(postStatusMessage(client as never, input, english)).resolves.toEqual({ok: false, error: 'NOT_READY'});
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown channel', {code: 10_003}, 'CHANNEL_NOT_FOUND'],
    ['a channel the bot cannot see', {code: 50_001}, 'MISSING_PERMISSIONS'],
    ['any other Discord failure', new Error('socket hang up'), 'DISCORD_ERROR'],
  ])('maps a fetch failure for %s', async (_label, failure, error) => {
    const client = makeClient(null);
    client.channels.fetch.mockRejectedValueOnce(failure);
    await expect(postStatusMessage(client as never, input, english)).resolves.toEqual({ok: false, error});
  });

  it('rejects missing, non-text and DM channels', async () => {
    await expect(postStatusMessage(makeClient(null) as never, input, english)).resolves.toEqual({ok: false, error: 'CHANNEL_NOT_FOUND'});
    for (const type of [ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.DM, ChannelType.PublicThread]) {
      const {channel} = makeChannel({type});
      await expect(postStatusMessage(makeClient(channel) as never, input, english)).resolves.toEqual({ok: false, error: 'INVALID_CHANNEL'});
      expect(channel.send).not.toHaveBeenCalled();
    }
  });

  it('accepts announcement channels and maps send failures', async () => {
    const {channel} = makeChannel({type: ChannelType.GuildAnnouncement});
    await expect(postStatusMessage(makeClient(channel) as never, input, english)).resolves.toEqual({ok: true});

    channel.send.mockRejectedValueOnce({code: 50_013});
    await expect(postStatusMessage(makeClient(channel) as never, input, english)).resolves.toEqual({ok: false, error: 'MISSING_PERMISSIONS'});
  });
});

describe('startup status announcer', () => {
  const config = {WORKER_ID: 'muse-01', CONTROL_TOKEN: token};

  const setup = (overrides: Partial<StatusAnnouncerDependencies> = {}) => {
    let now = 1_000_000;
    const dependencies = {
      fetchConfig: vi.fn(async () => ({statusChannelId: channelId as string | null, mentionRoleIds: [roleA]})),
      post: vi.fn(async () => ({ok: true as const})),
      now: () => now,
      ...overrides,
    };
    const announcer = new StatusAnnouncer({} as never, config, dependencies);
    return {
      announcer,
      dependencies,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it('does nothing outside a managed worker', async () => {
    const fetchConfig = vi.fn(async () => ({statusChannelId: channelId, mentionRoleIds: []}));
    const announcer = new StatusAnnouncer({} as never, {WORKER_ID: '', CONTROL_TOKEN: ''}, {fetchConfig});
    await expect(announcer.announceOnline()).resolves.toBe('skipped');
    expect(fetchConfig).not.toHaveBeenCalled();
  });

  it('posts the online message with the configured roles, control token and worker id', async () => {
    const {announcer, dependencies} = setup();
    await expect(announcer.announceOnline()).resolves.toBe('posted');
    expect(dependencies.fetchConfig).toHaveBeenCalledWith(token);
    expect(dependencies.post).toHaveBeenCalledWith({}, {channelId, workerId: 'muse-01', test: false, mentionRoleIds: [roleA]});
  });

  it('stays quiet when no status channel is configured', async () => {
    const {announcer, dependencies} = setup({fetchConfig: vi.fn(async () => ({statusChannelId: null, mentionRoleIds: [roleA]}))});
    await expect(announcer.announceOnline()).resolves.toBe('skipped');
    expect(dependencies.post).not.toHaveBeenCalled();
  });

  it('only logs an orchestrator failure and retries on the next reconnect', async () => {
    const fetchConfig = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('timed out'), {name: 'TimeoutError'}))
      .mockResolvedValueOnce({statusChannelId: channelId, mentionRoleIds: []});
    const {announcer, dependencies} = setup({fetchConfig});
    await expect(announcer.announceOnline()).resolves.toBe('failed');
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith('Status channel: could not read the worker config from the orchestrator (TimeoutError)');
    expect(dependencies.post).not.toHaveBeenCalled();

    await expect(announcer.announceOnline()).resolves.toBe('posted');
  });

  it('announces at most once every 5 minutes, failed posts included', async () => {
    const post = vi.fn().mockResolvedValueOnce({ok: false, error: 'MISSING_PERMISSIONS'}).mockResolvedValue({ok: true});
    const {announcer, advance} = setup({post});
    await expect(announcer.announceOnline()).resolves.toBe('failed');
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(`Status channel: online message not posted in ${channelId} (MISSING_PERMISSIONS)`);

    advance(STATUS_ANNOUNCE_INTERVAL_MS - 1);
    await expect(announcer.announceOnline()).resolves.toBe('skipped');
    expect(post).toHaveBeenCalledTimes(1);

    advance(1);
    await expect(announcer.announceOnline()).resolves.toBe('posted');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('never runs two announcements at once', async () => {
    let release: (value: {statusChannelId: string; mentionRoleIds: string[]}) => void = () => undefined;
    const fetchConfig = vi.fn(async () => new Promise<{statusChannelId: string; mentionRoleIds: string[]}>(resolve => {
      release = resolve;
    }));
    const {announcer, dependencies} = setup({fetchConfig});
    const first = announcer.announceOnline();
    await expect(announcer.announceOnline()).resolves.toBe('skipped');
    release({statusChannelId: channelId, mentionRoleIds: []});
    await expect(first).resolves.toBe('posted');
    expect(dependencies.post).toHaveBeenCalledOnce();
  });
});

describe('worker config client', () => {
  it('calls MUSE_ORCHESTRATOR_URL with the control token and validates the answer', async () => {
    vi.stubEnv('MUSE_ORCHESTRATOR_URL', 'https://orchestrator.internal:9443/base/');
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({statusChannelId: channelId, mentionRoleIds: [roleA]}), {status: 200}));
    vi.stubGlobal('fetch', fetcher);

    await expect(fetchWorkerPlatformConfig(token)).resolves.toEqual({statusChannelId: channelId, mentionRoleIds: [roleA]});
    expect(fetcher.mock.calls[0][0]).toBe('https://orchestrator.internal:9443/base/v1/worker/config');
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {authorization: `Bearer ${token}`},
    });

    // An orchestrator without role mentions means no mentions.
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({statusChannelId: channelId}), {status: 200}));
    await expect(fetchWorkerPlatformConfig(token)).resolves.toEqual({statusChannelId: channelId, mentionRoleIds: []});
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({statusChannelId: 'nope', mentionRoleIds: []}), {status: 200}));
    await expect(fetchWorkerPlatformConfig(token)).rejects.toThrow('Invalid worker config');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({statusChannelId: channelId, mentionRoleIds: ['@everyone']}), {status: 200}));
    await expect(fetchWorkerPlatformConfig(token)).rejects.toThrow('Invalid worker config');
    fetcher.mockResolvedValueOnce(new Response('{}', {status: 503}));
    await expect(fetchWorkerPlatformConfig(token)).rejects.toThrow('Orchestrator answered 503');
  });
});
