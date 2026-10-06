import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {HttpError} from '../src/control/http.js';
import {AUDIT_RETENTION, AuditStore, BlockStore, normalizeReason} from '../src/orchestrator/super-store.js';
import {loadOrchestratorConfig} from '../src/orchestrator/config.js';

const actor = {userId: '123456789012345678', username: 'Admin'};
const guildId = '222222222222222222';
const userId = '333333333333333333';
const directories: string[] = [];

const tempFile = (name: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-super-store-'));
  directories.push(directory);
  return path.join(directory, name);
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('block store', () => {
  it('starts empty, upserts uniquely by kind and subject, and persists', () => {
    const filePath = tempFile('blocks.json');
    const store = new BlockStore(filePath);
    expect(store.list()).toEqual([]);

    const first = store.upsert('GUILD', guildId, 'spam', actor);
    expect(first.created).toBe(true);
    expect(first.block).toEqual({kind: 'GUILD', subjectId: guildId, reason: 'spam', createdBy: actor, createdAt: expect.any(String)});

    const second = store.upsert('GUILD', guildId, undefined, {userId: '999999999999999999', username: 'Other'});
    expect(second.created).toBe(false);
    expect(second.block).toEqual({kind: 'GUILD', subjectId: guildId, createdBy: actor, createdAt: first.block.createdAt});

    // The same id may be blocked as a different kind.
    store.upsert('USER', guildId, undefined, actor);
    store.upsert('USER', userId, 'abuse', actor);
    expect(store.list()).toHaveLength(3);
    expect(store.blocklist()).toEqual({guildIds: [guildId], userIds: [guildId, userId]});

    const reloaded = new BlockStore(filePath);
    expect(reloaded.isBlocked('USER', userId)).toBe(true);
    expect(reloaded.isBlocked('GUILD', userId)).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1);
  });

  it('removes blocks and 404s for unknown ones', () => {
    const store = new BlockStore(tempFile('blocks.json'));
    store.upsert('USER', userId, undefined, actor);
    expect(store.remove('USER', userId)).toMatchObject({kind: 'USER', subjectId: userId});
    let failure: unknown;
    try {
      store.remove('USER', userId);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({statusCode: 404, code: 'BLOCK_NOT_FOUND'});
  });

  it('keeps memory unchanged when persisting fails', () => {
    const filePath = tempFile('blocks.json');
    const store = new BlockStore(filePath);
    store.upsert('USER', userId, undefined, actor);
    mkdirSync(path.join(path.dirname(filePath), `.blocks.json.${process.pid}.tmp`));

    expect(() => store.upsert('GUILD', guildId, undefined, actor)).toThrow();
    expect(store.isBlocked('GUILD', guildId)).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  it('recovers from the .bak file when the primary is corrupt', () => {
    const filePath = tempFile('blocks.json');
    const store = new BlockStore(filePath);
    store.upsert('USER', userId, undefined, actor);
    store.upsert('GUILD', guildId, undefined, actor);
    writeFileSync(filePath, '{"version": 1, "blocks": [');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recovered = new BlockStore(filePath);
    expect(warn).toHaveBeenCalledOnce();
    expect(recovered.isBlocked('USER', userId)).toBe(true);
    expect(recovered.isBlocked('GUILD', guildId)).toBe(false);
  });

  it.each([
    ['unparsable JSON', '{nope'],
    ['an unknown kind', JSON.stringify({version: 1, blocks: [{kind: 'guild', subjectId: guildId, createdBy: actor, createdAt: 'x'}]})],
    ['a bad subject id', JSON.stringify({version: 1, blocks: [{kind: 'USER', subjectId: '../x', createdBy: actor, createdAt: 'x'}]})],
    ['a duplicate block', JSON.stringify({version: 1, blocks: [
      {kind: 'USER', subjectId: userId, createdBy: actor, createdAt: 'x'},
      {kind: 'USER', subjectId: userId, createdBy: actor, createdAt: 'y'},
    ]})],
    ['a control character in the reason', JSON.stringify({version: 1, blocks: [{kind: 'USER', subjectId: userId, reason: 'a\u0007', createdBy: actor, createdAt: 'x'}]})],
  ])('refuses to start on %s without a valid backup', (_label, content) => {
    const filePath = tempFile('blocks.json');
    writeFileSync(filePath, content);
    expect(() => new BlockStore(filePath)).toThrow(/invalid schema.*no valid backup/);
  });

  it('validates reasons', () => {
    expect(normalizeReason(undefined)).toBeUndefined();
    expect(normalizeReason('   ')).toBeUndefined();
    expect(normalizeReason('  spam bot  ')).toBe('spam bot');
    expect(normalizeReason('x'.repeat(500))).toHaveLength(500);
    for (const value of ['x'.repeat(501), 'line\nbreak', 42]) {
      expect(() => normalizeReason(value)).toThrowError(HttpError);
    }
  });
});

describe('audit store', () => {
  it('appends durably, lists newest first and keeps only the last 1000 entries', () => {
    const filePath = tempFile('super-audit.json');
    // Seed a full log directly; appending 1000 entries one by one would fsync ~300 MB.
    const seeded = Array.from({length: AUDIT_RETENTION}, (_, index) => ({
      id: `seed-${index}`,
      at: new Date(0).toISOString(),
      actor,
      action: 'block.upsert',
      subjectType: 'USER',
      subjectId: `${index}`,
      details: {index},
      outcome: 'ok',
    }));
    writeFileSync(filePath, JSON.stringify({version: 1, entries: seeded}));
    const store = new AuditStore(filePath);
    for (let index = AUDIT_RETENTION; index < AUDIT_RETENTION + 5; index++) {
      store.append({actor, action: 'block.upsert', subjectType: 'USER', subjectId: `${index}`, details: {index}, outcome: 'ok'});
    }

    const entries = store.list();
    expect(entries).toHaveLength(AUDIT_RETENTION);
    expect(entries[0].subjectId).toBe(`${AUDIT_RETENTION + 4}`);
    expect(entries.at(-1)!.subjectId).toBe('5');
    expect(entries[0].id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(store.list(2).map(entry => entry.subjectId)).toEqual([`${AUDIT_RETENTION + 4}`, `${AUDIT_RETENTION + 3}`]);

    const reloaded = new AuditStore(filePath);
    expect(reloaded.list()).toHaveLength(AUDIT_RETENTION);
    expect(reloaded.list()[0].subjectId).toBe(`${AUDIT_RETENTION + 4}`);
  });

  it('truncates oversized details', () => {
    const store = new AuditStore(tempFile('super-audit.json'));
    const entry = store.append({actor, action: 'guild.leave', subjectType: 'GUILD', subjectId: guildId, details: {blob: 'x'.repeat(10_000)}, outcome: 'failed'});
    expect(entry.details).toEqual({truncated: true});
  });

  it('recovers from the .bak file and rejects invalid entries without one', () => {
    const filePath = tempFile('super-audit.json');
    const store = new AuditStore(filePath);
    store.append({actor, action: 'block.upsert', subjectType: 'USER', subjectId: userId, details: {}, outcome: 'ok'});
    store.append({actor, action: 'block.delete', subjectType: 'USER', subjectId: userId, details: {}, outcome: 'ok'});
    writeFileSync(filePath, JSON.stringify({version: 1, entries: [{id: 'x'}]}));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(new AuditStore(filePath).list().map(entry => entry.action)).toEqual(['block.upsert']);

    const other = tempFile('super-audit.json');
    writeFileSync(other, JSON.stringify({version: 1, entries: [{...store.list()[0], outcome: 'maybe'}]}));
    expect(() => new AuditStore(other)).toThrow(/invalid schema/);
  });
});

describe('super-console state paths', () => {
  it('defaults to /state and rejects paths outside it', () => {
    vi.stubEnv('MUSE_ORCHESTRATOR_TOKEN_FILE', '/run/secrets/orchestrator_api_token');
    vi.stubEnv('MUSE_ORCHESTRATOR_BLOCKS_FILE', '/state/../etc/blocks.json');
    expect(() => loadOrchestratorConfig()).toThrow(/MUSE_ORCHESTRATOR_BLOCKS_FILE must be stored under \/state/);

    vi.stubEnv('MUSE_ORCHESTRATOR_BLOCKS_FILE', '/state/blocks.json');
    vi.stubEnv('MUSE_ORCHESTRATOR_AUDIT_FILE', '/tmp/audit.json');
    expect(() => loadOrchestratorConfig()).toThrow(/MUSE_ORCHESTRATOR_AUDIT_FILE must be stored under \/state/);

    vi.stubEnv('MUSE_ORCHESTRATOR_AUDIT_FILE', '/state/groups.json');
    expect(() => loadOrchestratorConfig()).toThrow(/must be distinct/);
  });
});
