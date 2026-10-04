import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import GuildGroupStore from '../src/orchestrator/guild-group-store.js';
import GuildRoutingStore from '../src/orchestrator/guild-routing-store.js';

const GUILD = '123456789012345678';
const CATEGORY = '111111111111111111';
const VOICE = '222222222222222222';

describe('guild playback routing', () => {
  it('resolves voice > category > default group and persists independently', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-routing-'));

    try {
      const groups = new GuildGroupStore(
        path.join(directory, 'groups.json'),
        new Set(['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05']),
      );
      const routing = new GuildRoutingStore(path.join(directory, 'routing.json'));

      const defaults = groups.create(GUILD, {name: 'Default', workerIds: ['muse-01', 'muse-02']});
      const category = groups.create(GUILD, {name: 'Events', workerIds: ['muse-03', 'muse-04']});
      const voice = groups.create(GUILD, {name: 'Radio', workerIds: ['muse-05']});

      routing.update(GUILD, {
        defaultGroupId: defaults.id,
        categoryGroups: {[CATEGORY]: category.id},
        voiceChannelGroups: {[VOICE]: voice.id},
      }, groups);

      expect(routing.resolveGroupId(GUILD, VOICE, CATEGORY, groups)).toBe(voice.id);
      expect(routing.resolveGroupId(GUILD, '333333333333333333', CATEGORY, groups)).toBe(category.id);
      expect(routing.resolveGroupId(GUILD, '444444444444444444', null, groups)).toBe(defaults.id);

      const reloaded = new GuildRoutingStore(path.join(directory, 'routing.json'));
      expect(reloaded.get(GUILD).defaultGroupId).toBe(defaults.id);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  it('removes routing references when a group disappears', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'muse-routing-'));

    try {
      const groups = new GuildGroupStore(
        path.join(directory, 'groups.json'),
        new Set(['muse-01']),
      );
      const routing = new GuildRoutingStore(path.join(directory, 'routing.json'));
      const group = groups.create(GUILD, {name: 'Only', workerIds: ['muse-01']});

      routing.update(GUILD, {
        defaultGroupId: group.id,
        categoryGroups: {[CATEGORY]: group.id},
        voiceChannelGroups: {[VOICE]: group.id},
      }, groups);

      routing.removeGroupReferences(GUILD, group.id);
      expect(routing.get(GUILD)).toEqual(expect.objectContaining({
        defaultGroupId: null,
        categoryGroups: {},
        voiceChannelGroups: {},
      }));
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
