import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {HttpError} from '../src/control/http.js';
import GuildGroupStore from '../src/orchestrator/guild-group-store.js';

const withStore = (run: (store: GuildGroupStore, filePath: string) => void): void => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-groups-'));
  const filePath = path.join(directory, 'groups.json');

  try {
    run(new GuildGroupStore(filePath, new Set(['muse-01', 'muse-02', 'muse-03', 'muse-04', 'muse-05'])), filePath);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
};

describe('guild worker groups', () => {
  it('stores independent X+Y layouts per Discord server', () => {
    withStore((store, filePath) => {
      const main = store.create('123456789012345678', {
        name: 'Main',
        workerIds: ['muse-03', 'muse-01', 'muse-02'],
      });
      const extra = store.create('123456789012345678', {
        name: 'Extra',
        workerIds: ['muse-04', 'muse-05'],
      });
      store.create('999999999999999999', {
        name: 'Different server',
        workerIds: ['muse-01', 'muse-05'],
      });

      expect(store.list('123456789012345678')).toEqual([
        expect.objectContaining({id: extra.id, name: 'Extra', workerIds: ['muse-04', 'muse-05']}),
        expect.objectContaining({id: main.id, name: 'Main', workerIds: ['muse-01', 'muse-02', 'muse-03']}),
      ]);
      expect(store.list('999999999999999999')).toHaveLength(1);
      expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1);
    });
  });

  it('allows overlapping groups but rejects unknown workers and duplicate names', () => {
    withStore(store => {
      store.create('123456789012345678', {
        name: 'Events',
        workerIds: ['muse-01', 'muse-02'],
      });

      expect(() => store.create('123456789012345678', {
        name: 'events',
        workerIds: ['muse-02', 'muse-03'],
      })).toThrowError(HttpError);

      expect(() => store.create('123456789012345678', {
        name: 'Bad',
        workerIds: ['muse-99'],
      })).toThrowError(HttpError);

      expect(store.create('123456789012345678', {
        name: 'Overlap',
        workerIds: ['muse-02', 'muse-03'],
      }).workerIds).toEqual(['muse-02', 'muse-03']);
    });
  });

  it('updates and deletes a group without affecting other guilds', () => {
    withStore(store => {
      const group = store.create('123456789012345678', {
        name: 'Main',
        workerIds: ['muse-01'],
      });
      store.create('999999999999999999', {
        name: 'Other',
        workerIds: ['muse-05'],
      });

      expect(store.update('123456789012345678', group.id, {
        name: 'Primary',
        workerIds: ['muse-01', 'muse-02', 'muse-03'],
      })).toEqual(expect.objectContaining({
        name: 'Primary',
        workerIds: ['muse-01', 'muse-02', 'muse-03'],
      }));

      store.delete('123456789012345678', group.id);
      expect(store.list('123456789012345678')).toEqual([]);
      expect(store.list('999999999999999999')).toHaveLength(1);
    });
  });
});
