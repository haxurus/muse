import {describe, expect, it} from 'vitest';
import {sanitizeGuildPoolConfig} from '../src/orchestrator/pool-store.js';

const workers = ['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05'];

describe('guild pool configuration', () => {
  it('accepts a 3+2 partition with a default group and channel routing', () => {
    expect(sanitizeGuildPoolConfig({
      maxConcurrentPlayers: 4,
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
          voiceChannelIds: ['123456789012345678'],
          maxConcurrentPlayers: 2,
          isDefault: false,
        },
      ],
    }, workers)).toMatchObject({
      maxConcurrentPlayers: 4,
      groups: [
        {id: 'main', workerIds: ['muse-01', 'muse-02', 'muse-03']},
        {id: 'events', workerIds: ['muse-04', 'muse-05']},
      ],
    });
  });

  it('rejects a worker assigned to multiple groups', () => {
    expect(() => sanitizeGuildPoolConfig({
      maxConcurrentPlayers: 5,
      groups: [
        {
          id: 'one',
          name: 'One',
          workerIds: ['muse-01'],
          voiceChannelIds: [],
          maxConcurrentPlayers: 1,
          isDefault: true,
        },
        {
          id: 'two',
          name: 'Two',
          workerIds: ['muse-01'],
          voiceChannelIds: [],
          maxConcurrentPlayers: 1,
          isDefault: false,
        },
      ],
    }, workers)).toThrow(/belongs to more than one group/u);
  });

  it('requires exactly one default group when groups exist', () => {
    expect(() => sanitizeGuildPoolConfig({
      maxConcurrentPlayers: 5,
      groups: [{
        id: 'one',
        name: 'One',
        workerIds: ['muse-01'],
        voiceChannelIds: [],
        maxConcurrentPlayers: 1,
        isDefault: false,
      }],
    }, workers)).toThrow(/exactly one group/u);
  });
});
