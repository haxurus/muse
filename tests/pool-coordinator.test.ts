import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {describe, it, vi} from 'vitest';
import {HttpError} from '../src/control/http.js';
import PoolCoordinator, {type PoolTransport} from '../src/pool/coordinator.js';
import {parsePoolCommand, RESERVATION_TTL_MS, type PlaybackEnvelope, type PlaybackReply, type PlaybackState, type PoolCommand} from '../src/pool/protocol.js';

const GUILD = '123456789012345678';
const OTHER_GUILD = '223456789012345678';
const VOICE = '323456789012345678';
const OTHER_VOICE = '423456789012345678';
const WORKERS = ['muse-01', 'muse-02'];
let sequence = 0;
const command = (overrides: Partial<PoolCommand> = {}): PoolCommand => {
  sequence++;
  const action = overrides.action ?? 'play';
  return {
    id: String(800000000000000000n + BigInt(sequence)), guildId: GUILD,
    userId: '523456789012345678', textChannelId: '623456789012345678',
    voiceChannelId: VOICE, categoryId: null, action,
    ...(action === 'play' ? {query: 'test song'} : {}),
    ...(action === 'volume' ? {volume: 50} : {}), ...overrides,
  };
};
const hasCode = (code: number) => (error: unknown) => error instanceof HttpError && error.statusCode === code;

class FakeTransport implements PoolTransport {
  readonly calls: Array<{workerId: string; envelope: PlaybackEnvelope}> = [];
  readonly claims: Array<{workerId: string; envelope: PlaybackEnvelope}> = [];
  readonly states = new Map<string, PlaybackState>();
  readonly expiry = new Map<string, number>();
  failWorker?: string;
  ambiguous = false;
  ambiguousReserve = false;

  async state(workerId: string, guildId: string): Promise<PlaybackState> {
    if (this.failWorker === workerId) throw new Error('offline');
    const key = `${guildId}/${workerId}`;
    let value = this.states.get(key);
    if (!value) {
      value = {workerId, guildId, instanceId: randomUUID(), present: true, ready: true,
        connected: false, busy: false, channelId: null, leaseId: null, status: 'IDLE'};
      this.states.set(key, value);
    }
    if (!value.connected && !value.busy && (this.expiry.get(key) ?? Infinity) <= Date.now()) {
      value.channelId = null;
      value.leaseId = null;
    }
    return {...value};
  }

  async reserve(workerId: string, envelope: PlaybackEnvelope): Promise<PlaybackState> {
    const request = envelope.command;
    await this.state(workerId, request.guildId);
    const key = `${request.guildId}/${workerId}`;
    const state = this.states.get(key)!;
    assert.equal(envelope.instanceId, state.instanceId);
    assert.ok(state.leaseId === null || state.leaseId === envelope.leaseId);
    state.channelId = request.voiceChannelId;
    state.leaseId = envelope.leaseId;
    this.expiry.set(key, Date.now() + RESERVATION_TTL_MS);
    this.claims.push({workerId, envelope});
    if (this.ambiguousReserve) throw new Error('reserve response lost');
    return {...state};
  }

  async execute(workerId: string, envelope: PlaybackEnvelope): Promise<PlaybackReply> {
    this.calls.push({workerId, envelope});
    if (this.ambiguous) throw new Error('HTTP response lost');
    const {command: request} = envelope;
    const state = this.states.get(`${request.guildId}/${workerId}`)!;
    assert.equal(envelope.instanceId, state.instanceId);
    assert.equal(envelope.leaseId, state.leaseId);
    state.busy = true;
    await new Promise(resolve => setTimeout(resolve, 5));
    state.busy = false;
    state.connected = !['stop', 'disconnect'].includes(request.action);
    state.status = request.action === 'pause' ? 'PAUSED' : 'PLAYING';
    if (!state.connected) {
      state.channelId = null;
      state.leaseId = null;
    }
    return {workerId, guildId: request.guildId, requestId: request.id, text: 'ok'};
  }
}
const fixture = () => {
  const transport = new FakeTransport();
  return {transport, pool: new PoolCoordinator(WORKERS, transport, () => WORKERS)};
};

describe('pool allocation and playback boundary', () => {
  it('reserves different workers for simultaneous voice channels in the same guild', async () => {
    const {pool, transport} = fixture();
    const results = await Promise.all([pool.execute(command()), pool.execute(command({voiceChannelId: OTHER_VOICE}))]);
    assert.equal(new Set(results.map(result => result.workerId)).size, 2);
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.claims.length, 2);
  });
  it('serializes the same voice channel and reuses its worker and lease', async () => {
    const {pool, transport} = fixture();
    await Promise.all([pool.execute(command()), pool.execute(command())]);
    assert.equal(transport.calls[0].workerId, transport.calls[1].workerId);
    assert.equal(transport.calls[0].envelope.leaseId, transport.calls[1].envelope.leaseId);
  });
  it('allows the same bot to serve different guilds simultaneously', async () => {
    const {pool} = fixture();
    const results = await Promise.all([pool.execute(command()), pool.execute(command({guildId: OTHER_GUILD}))]);
    assert.equal(results[0].workerId, 'muse-01');
    assert.equal(results[1].workerId, 'muse-01');
  });
  it('deduplicates an interaction without replaying play or skip', async () => {
    const {pool, transport} = fixture();
    const request = command();
    await Promise.all([pool.execute(request), pool.execute(request)]);
    const skip = command({action: 'skip'});
    await Promise.all([pool.execute(skip), pool.execute(skip)]);
    assert.equal(transport.calls.length, 2);
    await assert.rejects(pool.execute({...request, query: 'different'}), hasCode(409));
  });
  it('keeps a paused player occupied and never steals it for another room', async () => {
    const {pool} = fixture();
    await pool.execute(command());
    await pool.execute(command({action: 'pause'}));
    assert.equal((await pool.execute(command({voiceChannelId: OTHER_VOICE}))).workerId, 'muse-02');
  });
  it('releases a disconnected worker and never creates a player for skip', async () => {
    const {pool, transport} = fixture();
    await assert.rejects(pool.execute(command({action: 'skip'})), hasCode(404));
    assert.equal(transport.calls.length, 0);
    await pool.execute(command());
    await pool.execute(command({action: 'disconnect'}));
    assert.equal((await pool.execute(command({voiceChannelId: OTHER_VOICE}))).workerId, 'muse-01');
  });
  it('blocks a second assignment after an ambiguous timeout until expiry and confirmed idle', async () => {
    const {pool, transport} = fixture();
    let time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    try {
      transport.ambiguous = true;
      await assert.rejects(pool.execute(command()), hasCode(503));
      transport.ambiguous = false;
      await assert.rejects(pool.execute(command()), hasCode(409));
      assert.equal(transport.calls.length, 1);
      time += 200_000;
      await pool.execute(command());
      assert.equal(transport.calls.length, 2);
    } finally {
      clock.mockRestore();
    }
  });
  it('does not send audio when the reservation acknowledgement is lost', async () => {
    const {pool, transport} = fixture();
    transport.ambiguousReserve = true;
    await assert.rejects(pool.execute(command()), hasCode(503));
    assert.equal(transport.calls.length, 0);
    const restarted = new PoolCoordinator(WORKERS, transport, () => WORKERS);
    transport.ambiguousReserve = false;
    await assert.rejects(restarted.execute(command()), hasCode(409));
    assert.equal(transport.claims.length, 1);
  });
  it('does not allocate while an unreachable worker may still own a channel', async () => {
    const {pool, transport} = fixture();
    transport.failWorker = 'muse-02';
    await assert.rejects(pool.execute(command()), hasCode(503));
    assert.equal(transport.calls.length, 0);
  });
  it('recovers a live lease after orchestrator restart rather than allocating another bot', async () => {
    const {pool, transport} = fixture();
    await pool.execute(command());
    const restarted = new PoolCoordinator(WORKERS, transport, () => WORKERS);
    assert.equal((await restarted.execute(command({action: 'pause'}))).workerId, 'muse-01');
    assert.equal(transport.calls[0].envelope.leaseId, transport.calls[1].envelope.leaseId);
  });
  it('fails closed on group exhaustion without falling back to another group', async () => {
    const transport = new FakeTransport();
    const pool = new PoolCoordinator(WORKERS, transport, () => ['muse-01']);
    await pool.execute(command());
    await assert.rejects(pool.execute(command({voiceChannelId: OTHER_VOICE})), hasCode(409));
    assert.equal(transport.calls.length, 1);
  });
  it('does not leak another voice channel ID in /players', async () => {
    const {pool} = fixture();
    await pool.execute(command({voiceChannelId: OTHER_VOICE}));
    const result = await pool.execute(command({action: 'players'}));
    assert.ok(!result.text.includes(OTHER_VOICE));
    assert.ok(result.text.includes('PLAYING'));
  });
  it('validates the command allowlist, guild IDs, volume and unknown fields', () => {
    for (const input of [command({action: 'shell' as never}), command({guildId: '../x'}),
      command({action: 'volume', volume: 101}), {...command(), token: 'not-accepted'}]) {
      assert.throws(() => parsePoolCommand(input), hasCode(400));
    }
  });
});
