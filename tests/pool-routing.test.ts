import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {describe, it} from 'vitest';
import PoolRoutingStore from '../src/pool/routing-store.js';
import type {PoolCommand} from '../src/pool/protocol.js';

const GUILD = '123456789012345678';
const VOICE = '323456789012345678';
const CATEGORY = '423456789012345678';
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const command: PoolCommand = {id: '823456789012345678', guildId: GUILD, userId: '523456789012345678',
  voiceChannelId: VOICE, textChannelId: '623456789012345678', categoryId: CATEGORY, action: 'play', query: 'test'};
const groups = [{id: A, workerIds: ['muse-01']}, {id: B, workerIds: ['muse-02']}, {id: C, workerIds: ['muse-03']}];

describe('per-guild pool routing', () => {
  it('uses channel > category > default priority and persists across restart', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-pool-'));
    try {
      const file = path.join(directory, 'pool-routes.json');
      const store = new PoolRoutingStore(file, () => groups, ['muse-01', 'muse-02', 'muse-03']);
      store.set(GUILD, {defaultGroupId: A, categoryGroups: {[CATEGORY]: B}, channelGroups: {[VOICE]: C}});
      assert.deepEqual(store.eligible(command), ['muse-03']);
      assert.deepEqual(store.eligible({...command, voiceChannelId: '723456789012345678'}), ['muse-02']);
      assert.deepEqual(store.eligible({...command, voiceChannelId: '723456789012345678', categoryId: null}), ['muse-01']);
      assert.equal(store.referenced(GUILD, C), true);
      const reloaded = new PoolRoutingStore(file, () => groups, ['muse-01', 'muse-02', 'muse-03']);
      assert.deepEqual(reloaded.get(GUILD), store.get(GUILD));
      assert.deepEqual(reloaded.get('923456789012345678'), {defaultGroupId: null, channelGroups: {}, categoryGroups: {}});
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
  it('rejects groups from another server and unknown fields without changing state', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-pool-'));
    try {
      const store = new PoolRoutingStore(path.join(directory, 'pool-routes.json'), id => id === GUILD ? groups : [], ['muse-01']);
      store.set(GUILD, {defaultGroupId: A});
      assert.throws(() => store.set('923456789012345678', {defaultGroupId: A}));
      assert.throws(() => store.set(GUILD, {defaultGroupId: randomUUID()}));
      assert.throws(() => store.set(GUILD, {command: 'exec'}));
      assert.equal(store.get(GUILD).defaultGroupId, A);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
  it('does not silently expand access when a referenced group disappears', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-pool-'));
    try {
      let current = groups;
      const store = new PoolRoutingStore(path.join(directory, 'pool-routes.json'), () => current, ['muse-01', 'muse-02']);
      store.set(GUILD, {defaultGroupId: A});
      current = [];
      assert.throws(() => store.eligible(command));
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
