import {describe, expect, it} from 'vitest';
import PlaybackLeaseManager from '../src/orchestrator/playback-lease-manager.js';

describe('playback worker leases', () => {
  it('prevents one worker from serving two voice channels in the same guild', () => {
    const leases = new PlaybackLeaseManager();
    leases.reserve('123456789012345678', '111111111111111111', 'muse-01', null);

    expect(() => leases.reserve(
      '123456789012345678',
      '222222222222222222',
      'muse-01',
      null,
    )).toThrow('already reserved');
  });

  it('allows the same worker to serve different guilds', () => {
    const leases = new PlaybackLeaseManager();

    leases.reserve('123456789012345678', '111111111111111111', 'muse-01', null);
    leases.reserve('999999999999999999', '222222222222222222', 'muse-01', null);

    expect(leases.allForGuild('123456789012345678')).toHaveLength(1);
    expect(leases.allForGuild('999999999999999999')).toHaveLength(1);
  });

  it('serializes allocation work inside one guild', async () => {
    const leases = new PlaybackLeaseManager();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = leases.withGuildLock('123456789012345678', async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });

    const second = leases.withGuildLock('123456789012345678', async () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('reconciles a stale voice lease to the worker actually connected', () => {
    const leases = new PlaybackLeaseManager();

    leases.reserve('123456789012345678', '111111111111111111', 'muse-01', null);
    leases.recover('123456789012345678', '111111111111111111', 'muse-02', 'ACTIVE');

    expect(leases.get('123456789012345678', '111111111111111111')).toEqual(
      expect.objectContaining({workerId: 'muse-02', state: 'ACTIVE'}),
    );
    expect(() => leases.reserve(
      '123456789012345678',
      '222222222222222222',
      'muse-01',
      null,
    )).not.toThrow();
  });
});
