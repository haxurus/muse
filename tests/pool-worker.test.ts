import {randomUUID} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {VoiceChannel} from 'discord.js';
import PoolWorker from '../src/pool/worker.js';
import type {PlaybackEnvelope, PoolAction} from '../src/pool/protocol.js';

vi.mock('../src/services/player.js', () => ({STATUS: {PLAYING: 0, PAUSED: 1, IDLE: 2}}));
vi.mock('../src/utils/get-guild-settings.js', () => ({getGuildSettings: vi.fn(async () => ({defaultVolume: 70, playlistLimit: 50}))}));

const GUILD = '123456789012345678';
const VOICE = '223456789012345678';
const TEXT = '323456789012345678';
const USER = '423456789012345678';
let sequence = 0;
const fixture = () => {
  const songs: Array<{title: string}> = [];
  const player = {
    voiceConnection: null as null | {joinConfig: {channelId: string}},
    status: 1, loopCurrentSong: true, loopCurrentQueue: true, volume: 90,
    stop: vi.fn(() => { player.voiceConnection = null; songs.length = 0; }),
    connect: vi.fn(async () => { player.voiceConnection = {joinConfig: {channelId: VOICE}}; }),
    ensureVoiceConnectionReady: vi.fn(async () => undefined),
    play: vi.fn(async () => { player.status = 0; }),
    pause: vi.fn(() => { player.status = 1; }),
    forward: vi.fn(async () => undefined),
    setVolume: vi.fn((value: number) => { player.volume = value; }),
    getCurrent: () => songs[0] ?? null,
    getQueue: () => songs.slice(1),
    queueSize: () => Math.max(0, songs.length - 1),
    add: (song: {title: string}) => { songs.push(song); },
  };
  const voice = Object.assign(Object.create(VoiceChannel.prototype), {
    id: VOICE, parentId: null,
    permissionsFor: vi.fn(() => ({has: () => true})),
  });
  const member = {id: USER, user: {bot: false}};
  const guild = {
    voiceStates: {cache: new Map([[USER, {channelId: VOICE}]])},
    channels: {cache: new Map<string, unknown>([[VOICE, voice], [TEXT, {
      isTextBased: () => true, permissionsFor: () => ({has: () => true}),
    }]])},
    members: {fetch: vi.fn(async () => member), me: {id: '523456789012345678'}},
  };
  const client = {
    user: {id: '523456789012345678'},
    isReady: () => true, guilds: {cache: new Map([[GUILD, guild]])},
  };
  const players = {
    get: () => player,
    snapshot: () => [{guildId: GUILD, connected: player.voiceConnection !== null,
      channelId: player.voiceConnection?.joinConfig.channelId ?? null,
      status: ['PLAYING', 'PAUSED', 'IDLE'][player.status]}],
  };
  const media = {resolveForPool: vi.fn(async () => [{title: 'Test song', url: 'abcdefghijk'}])};
  const worker = new PoolWorker('muse-01', {client, players, media} as never);
  const envelope = (action: PoolAction = 'join', leaseId = randomUUID()): PlaybackEnvelope => ({
    instanceId: worker.state(GUILD).instanceId, leaseId, deadline: Date.now() + 180_000,
    command: {id: String(800000000000000000n + BigInt(++sequence)), guildId: GUILD,
      userId: USER, voiceChannelId: VOICE, textChannelId: TEXT, categoryId: null, action,
      ...(action === 'play' ? {query: 'test'} : {}),
      ...(action === 'volume' ? {volume: 35} : {}),
    },
  });
  return {worker, player, guild, media, envelope, songs};
};

afterEach(() => vi.restoreAllMocks());

describe('worker reservation and playback lifecycle', () => {
  it('reserves without starting audio and rejects execute without a reservation', async () => {
    const {worker, player, envelope} = fixture();
    await expect(worker.execute(envelope())).rejects.toMatchObject({statusCode: 409});
    const request = envelope();
    const claim = await worker.reserve(request);
    expect(claim).toMatchObject({channelId: VOICE, connected: false, busy: false, leaseId: request.leaseId});
    expect(player.connect).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
  });
  it('starts music after join rather than leaving the empty player paused', async () => {
    const {worker, player, envelope, songs} = fixture();
    const join = envelope();
    await worker.reserve(join);
    await worker.execute(join);
    const play = envelope('play', join.leaseId);
    await worker.reserve(play);
    await worker.execute(play);
    expect(player.play).toHaveBeenCalledOnce();
    expect(songs).toHaveLength(1);
    expect(player.volume).toBe(70);
    expect(player.loopCurrentQueue).toBe(false);
  });
  it('does not duplicate an acknowledged play interaction', async () => {
    const {worker, media, envelope, songs} = fixture();
    const play = envelope('play');
    await worker.reserve(play);
    await Promise.all([worker.execute(play), worker.execute(play)]);
    expect(media.resolveForPool).toHaveBeenCalledOnce();
    expect(songs).toHaveLength(1);
  });
  it('expires an orphan claim and rejects delayed playback or reserve renewal', async () => {
    const {worker, envelope, player} = fixture();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const request = envelope('play');
    await worker.reserve(request);
    now += 31_000;
    expect(worker.state(GUILD).leaseId).toBeNull();
    await worker.reserve(request);
    expect(worker.state(GUILD).leaseId).toBeNull();
    await expect(worker.execute(request)).rejects.toMatchObject({statusCode: 409});
    expect(player.play).not.toHaveBeenCalled();
  });
  it('rejects stale worker epochs', async () => {
    const {worker, envelope} = fixture();
    const request = {...envelope(), instanceId: randomUUID()};
    await expect(worker.reserve(request)).rejects.toMatchObject({statusCode: 409});
  });
  it('rechecks user voice membership after reservation', async () => {
    const {worker, envelope, guild, player} = fixture();
    const request = envelope('play');
    await worker.reserve(request);
    guild.voiceStates.cache.get(USER)!.channelId = '623456789012345678';
    await expect(worker.execute(request)).rejects.toMatchObject({statusCode: 409});
    expect(player.play).not.toHaveBeenCalled();
    expect(worker.state(GUILD).leaseId).toBeNull();
  });
  it('requires the same lease and channel for controls', async () => {
    const {worker, envelope} = fixture();
    const request = envelope('play');
    await worker.reserve(request);
    await worker.execute(request);
    await expect(worker.reserve(envelope('pause'))).rejects.toMatchObject({statusCode: 409});
    const otherRoom = envelope('pause', request.leaseId);
    otherRoom.command.voiceChannelId = '623456789012345678';
    await expect(worker.reserve(otherRoom)).rejects.toMatchObject({statusCode: 409});
  });
  it('releases the lease and queue on disconnect', async () => {
    const {worker, envelope, songs} = fixture();
    const play = envelope('play');
    await worker.reserve(play);
    await worker.execute(play);
    const stop = envelope('disconnect', play.leaseId);
    await worker.reserve(stop);
    await worker.execute(stop);
    expect(songs).toHaveLength(0);
    expect(worker.state(GUILD)).toMatchObject({connected: false, busy: false, leaseId: null, channelId: null});
  });
});
