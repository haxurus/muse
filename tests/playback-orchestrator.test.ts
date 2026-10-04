import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import GuildGroupStore from '../src/orchestrator/guild-group-store.js';
import GuildRoutingStore from '../src/orchestrator/guild-routing-store.js';
import PlaybackLeaseManager from '../src/orchestrator/playback-lease-manager.js';
import PlaybackOrchestrator from '../src/orchestrator/playback-orchestrator.js';
import type WorkerClient from '../src/orchestrator/worker-client.js';
import type {WorkerStatus} from '../src/control/types.js';

const GUILD = '123456789012345678';
const VOICE_A = '111111111111111111';
const VOICE_B = '222222222222222222';
const VOICE_C = '333333333333333333';
const REQUESTER = '444444444444444444';
const TEXT = '555555555555555555';

const workerStatus = (id: string): WorkerStatus => ({
  workerId: id,
  discordReady: true,
  bot: {id: id.replace(/\D/gu, '').padEnd(18, '1'), username: id},
  guilds: [{id: GUILD, name: 'Guild'}],
  players: [],
  uptimeSeconds: 10,
});

const makeWorker = (id: string) => {
  const status = workerStatus(id);
  const playbackAction = vi.fn(async (_guildId: string, _action: string, body: Record<string, unknown>) => ({
    message: 'ok',
    playback: {
      guildId: GUILD,
      connected: true,
      voiceChannelId: String(body.voiceChannelId),
      status: 'PLAYING' as const,
      volume: 100,
      positionSeconds: 0,
      current: {
        title: 'Song',
        artist: 'Artist',
        url: 'abcdefghijk',
        length: 120,
        offset: 0,
        playlist: null,
        isLive: false,
        thumbnailUrl: null,
        source: 0,
        requestedBy: REQUESTER,
      },
      queue: [],
    },
  }));

  return {
    id,
    status: vi.fn(async () => status),
    playbackAction,
    playbackRead: vi.fn(),
    guildChannels: vi.fn(),
  } as unknown as WorkerClient;
};

const playBody = (voiceChannelId: string) => ({
  voiceChannelId,
  categoryId: null,
  textChannelId: TEXT,
  requesterId: REQUESTER,
  query: 'song',
});

describe('playback pool allocation', () => {
  it('atomically assigns different free workers to concurrent voice channels', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-pool-'));

    try {
      const groups = new GuildGroupStore(
        path.join(directory, 'groups.json'),
        new Set(['muse-01', 'muse-02']),
      );
      const routing = new GuildRoutingStore(path.join(directory, 'routing.json'));
      const group = groups.create(GUILD, {
        name: 'Main',
        workerIds: ['muse-01', 'muse-02'],
      });
      routing.update(GUILD, {defaultGroupId: group.id}, groups);

      const orchestrator = new PlaybackOrchestrator(
        [makeWorker('muse-01'), makeWorker('muse-02')],
        groups,
        routing,
        new PlaybackLeaseManager(),
      );

      const [first, second] = await Promise.all([
        orchestrator.play(GUILD, playBody(VOICE_A)),
        orchestrator.play(GUILD, playBody(VOICE_B)),
      ]);

      expect(new Set([first.lease.workerId, second.lease.workerId])).toEqual(
        new Set(['muse-01', 'muse-02']),
      );

      await expect(orchestrator.play(GUILD, playBody(VOICE_C)))
        .rejects.toThrow('no free music bot');
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  it('keeps a fresh RESERVED lease while worker state is still catching up', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-pool-'));

    try {
      const groups = new GuildGroupStore(
        path.join(directory, 'groups.json'),
        new Set(['muse-01']),
      );
      const routing = new GuildRoutingStore(path.join(directory, 'routing.json'));
      const leases = new PlaybackLeaseManager();
      leases.reserve(GUILD, VOICE_A, 'muse-01', null);

      const orchestrator = new PlaybackOrchestrator(
        [makeWorker('muse-01')],
        groups,
        routing,
        leases,
      );

      await orchestrator.reconcileGuild(GUILD);
      expect(leases.get(GUILD, VOICE_A)).toEqual(
        expect.objectContaining({workerId: 'muse-01', state: 'RESERVED'}),
      );
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  it('releases an IDLE disconnected worker after its completed queue auto-disconnects', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-pool-'));

    try {
      const groups = new GuildGroupStore(
        path.join(directory, 'groups.json'),
        new Set(['muse-01']),
      );
      const routing = new GuildRoutingStore(path.join(directory, 'routing.json'));
      const leases = new PlaybackLeaseManager();
      leases.reserve(GUILD, VOICE_A, 'muse-01', null);
      leases.setState(GUILD, VOICE_A, 'ACTIVE');

      const worker = makeWorker('muse-01') as unknown as {
        id: string;
        status: ReturnType<typeof vi.fn>;
      };
      worker.status.mockResolvedValue({
        ...workerStatus('muse-01'),
        players: [{
          guildId: GUILD,
          connected: false,
          channelId: null,
          lastChannelId: VOICE_A,
          status: 'IDLE',
          hasCurrent: true,
          queueSize: 0,
        }],
      });

      const orchestrator = new PlaybackOrchestrator(
        [worker as unknown as WorkerClient],
        groups,
        routing,
        leases,
      );

      await orchestrator.reconcileGuild(GUILD);
      expect(leases.get(GUILD, VOICE_A)).toBeUndefined();
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  it('honors a voice-channel group override instead of borrowing from another group', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-pool-'));

    try {
      const groups = new GuildGroupStore(
        path.join(directory, 'groups.json'),
        new Set(['muse-01', 'muse-05']),
      );
      const routing = new GuildRoutingStore(path.join(directory, 'routing.json'));
      const main = groups.create(GUILD, {name: 'Main', workerIds: ['muse-01']});
      const radio = groups.create(GUILD, {name: 'Radio', workerIds: ['muse-05']});
      routing.update(GUILD, {
        defaultGroupId: main.id,
        voiceChannelGroups: {[VOICE_A]: radio.id},
      }, groups);

      const orchestrator = new PlaybackOrchestrator(
        [makeWorker('muse-01'), makeWorker('muse-05')],
        groups,
        routing,
        new PlaybackLeaseManager(),
      );

      const result = await orchestrator.play(GUILD, playBody(VOICE_A));
      expect(result.lease.workerId).toBe('muse-05');
      expect(result.lease.groupId).toBe(radio.id);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
