import {describe, expect, it} from 'vitest';
import PoolEngine, {ReachableWorker} from '../src/orchestrator/pool-engine.js';
import type {GuildPoolConfig} from '../src/orchestrator/pool-types.js';

const GUILD = '123456789012345678';
const GENERAL = '223456789012345678';
const EVENTS = '323456789012345678';
const OTHER = '423456789012345678';

const worker = (
  id: string,
  players: ReachableWorker['status']['players'] = [],
): ReachableWorker => ({
  id,
  status: {
    workerId: id,
    discordReady: true,
    bot: {
      id: id.replace(/\D/gu, '').padEnd(18, '1'),
      username: id,
    },
    guilds: [{
      id: GUILD,
      name: 'Guild',
      voiceChannels: [
        {id: GENERAL, name: 'General'},
        {id: EVENTS, name: 'Events'},
        {id: OTHER, name: 'Other'},
      ],
    }],
    players,
    uptimeSeconds: 10,
  },
});

const config: GuildPoolConfig = {
  maxConcurrentPlayers: 5,
  groups: [
    {
      id: 'main',
      name: 'Main',
      workerIds: ['muse-01', 'muse-02', 'muse-03'],
      voiceChannelIds: [],
      maxConcurrentPlayers: 3,
      isDefault: true,
    },
    {
      id: 'events',
      name: 'Events',
      workerIds: ['muse-04', 'muse-05'],
      voiceChannelIds: [EVENTS],
      maxConcurrentPlayers: 2,
      isDefault: false,
    },
  ],
};

describe('automatic worker pool assignment', () => {
  it('uses the current worker when it is free and eligible', () => {
    const engine = new PoolEngine();
    const result = engine.assign({
      guildId: GUILD,
      voiceChannelId: GENERAL,
      currentWorkerId: 'muse-02',
      mode: 'assign',
      config,
      workers: ['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05'].map(id => worker(id)),
    });

    expect(result.workerId).toBe('muse-02');
    expect(result.groupId).toBe('main');
  });

  it('routes a mapped channel to the correct worker group', () => {
    const engine = new PoolEngine();
    const result = engine.assign({
      guildId: GUILD,
      voiceChannelId: EVENTS,
      currentWorkerId: 'muse-01',
      mode: 'assign',
      config,
      workers: ['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05'].map(id => worker(id)),
    });

    expect(['muse-04', 'muse-05']).toContain(result.workerId);
    expect(result.groupId).toBe('events');
  });

  it('keeps a reservation stable when another bot is invoked before the join', () => {
    const engine = new PoolEngine();
    const workers = ['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05'].map(id => worker(id));

    const first = engine.assign({
      guildId: GUILD,
      voiceChannelId: GENERAL,
      currentWorkerId: 'muse-01',
      mode: 'assign',
      config,
      workers,
    });

    const second = engine.assign({
      guildId: GUILD,
      voiceChannelId: GENERAL,
      currentWorkerId: 'muse-02',
      mode: 'assign',
      config,
      workers,
    });

    expect(first.workerId).toBe('muse-01');
    expect(second.workerId).toBe('muse-01');
  });

  it('enforces the guild concurrent-player quota', () => {
    const engine = new PoolEngine();
    const quotaOne = {...config, maxConcurrentPlayers: 1};
    const workers = ['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05'].map(id => worker(id));

    engine.assign({
      guildId: GUILD,
      voiceChannelId: GENERAL,
      currentWorkerId: 'muse-01',
      mode: 'assign',
      config: quotaOne,
      workers,
    });

    expect(() => engine.assign({
      guildId: GUILD,
      voiceChannelId: OTHER,
      currentWorkerId: 'muse-02',
      mode: 'assign',
      config: quotaOne,
      workers,
    })).toThrow(/server player quota reached/u);
  });

  it('routes existing commands to a disconnected worker that still owns a queue', () => {
    const engine = new PoolEngine();
    const workers = [
      worker('muse-01'),
      worker('muse-02', [{
        guildId: GUILD,
        connected: false,
        channelId: null,
        lastChannelId: GENERAL,
        hasCurrent: true,
        status: 'PAUSED',
      }]),
      worker('muse-03'),
      worker('muse-04'),
      worker('muse-05'),
    ];

    const result = engine.assign({
      guildId: GUILD,
      voiceChannelId: GENERAL,
      currentWorkerId: 'muse-01',
      mode: 'existing',
      config,
      workers,
    });

    expect(result.workerId).toBe('muse-02');
    expect(result.reserved).toBe(false);
  });
});
