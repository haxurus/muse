import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MAX_BANNER_CHARS, MAX_NICKNAME_LENGTH, sanitizeBrandingProfile} from '../src/plans/branding.js';
import {PlanStore} from '../src/orchestrator/plan-store.js';
import PlanService, {type SettledStatus} from '../src/orchestrator/plan-service.js';
import type {AuditEntryInput} from '../src/orchestrator/super-store.js';
import type WorkerClient from '../src/orchestrator/worker-client.js';

const actor = {userId: '123456789012345678', username: 'Admin'};
const guildA = '111111111111111111';
const BANNER = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const tempFile = (name: string): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'muse-branding-'));
  cleanups.push(() => {
    rmSync(directory, {recursive: true, force: true});
  });
  return path.join(directory, name);
};

const status = (workerId: string, guildIds: string[], botNumber: number): SettledStatus => ({
  workerId,
  ok: true,
  value: {
    workerId,
    discordReady: true,
    bot: {id: `90000000000000000${botNumber}`, username: workerId},
    guilds: guildIds.map(id => ({id, name: id})),
    players: [],
    uptimeSeconds: 1,
  },
});

const statuses = [status('muse-01', [guildA], 1), status('muse-02', [guildA], 2), status('muse-03', [], 3)];

const makeService = (filePath = tempFile('plans.json')) => {
  const workers = ['muse-01', 'muse-02', 'muse-03'].map(id => ({
    id,
    pushEntitlements: vi.fn(async () => ({ok: true})),
    setBranding: vi.fn(async (guildId: string) => ({workerId: id, guildId, ok: true})),
  }));
  const records: AuditEntryInput[] = [];
  const service = new PlanService(workers as unknown as WorkerClient[], new PlanStore(filePath), entry => {
    records.push(entry);
  }, async () => statuses);
  return {service, workers, records, filePath};
};

describe('branding profile validation', () => {
  it('trims nicknames, accepts data URI banners and null resets', () => {
    expect(sanitizeBrandingProfile({nick: '  Radio Lounge  '})).toEqual({nick: 'Radio Lounge'});
    expect(sanitizeBrandingProfile({nick: null, banner: null})).toEqual({nick: null, banner: null});
    expect(sanitizeBrandingProfile({banner: BANNER})).toEqual({banner: BANNER});
  });

  it.each([
    [{}],
    [{nick: ''}],
    [{nick: 'x'.repeat(MAX_NICKNAME_LENGTH + 1)}],
    [{nick: 'bad\nname'}],
    [{nick: 7}],
    [{banner: 'https://example.test/banner.png'}],
    [{banner: 'data:image/svg+xml;base64,PHN2Zz4='}],
    [{banner: `data:image/png;base64,${'A'.repeat(MAX_BANNER_CHARS)}`}],
    [[]],
  ])('rejects %j', body => {
    expect(() => sanitizeBrandingProfile(body)).toThrow(expect.objectContaining({statusCode: 400, code: 'INVALID_BRANDING'}));
  });
});

describe('Brand plan', () => {
  it('requires the Brand plan', async () => {
    const {service, workers} = makeService();
    await service.changeGuildPlan(guildA, {tier: 'TIER2'}, actor, new Set([guildA]));
    await expect(service.updateBranding(guildA, {workerId: 'muse-01', nickname: 'Radio'}, statuses))
      .rejects.toMatchObject({statusCode: 403, code: 'PLAN_REQUIRED'});
    expect(workers[0].setBranding).not.toHaveBeenCalled();
  });

  it('sets one bot\'s name and banner, remembers only the flags and persists them', async () => {
    const {service, workers, filePath} = makeService();
    await service.changeGuildPlan(guildA, {tier: 'TIER3', billing: 'YEARLY'}, actor, new Set([guildA]));

    expect(await service.updateBranding(guildA, {workerId: 'muse-02', nickname: ' Radio ', banner: BANNER}, statuses))
      .toEqual({workerId: 'muse-02', nickname: 'Radio', bannerSet: true});
    expect(workers[1].setBranding).toHaveBeenCalledWith(guildA, {nick: 'Radio', banner: BANNER});

    await service.updateBranding(guildA, {workerId: 'muse-02', banner: null}, statuses);
    expect(service.branding(guildA)).toEqual({'muse-02': {nickname: 'Radio', bannerSet: false}});
    expect(new PlanStore(filePath).branding(guildA)).toEqual({'muse-02': {nickname: 'Radio', bannerSet: false}});

    // Both fields back to the default: the profile is forgotten.
    await service.updateBranding(guildA, {workerId: 'muse-02', nickname: null}, statuses);
    expect(service.branding(guildA)).toEqual({});
  });

  it('refuses bots that are not in the server and reports Discord refusals', async () => {
    const {service, workers} = makeService();
    await service.changeGuildPlan(guildA, {tier: 'TIER3'}, actor, new Set([guildA]));

    await expect(service.updateBranding(guildA, {workerId: 'muse-03', nickname: 'Radio'}, statuses))
      .rejects.toMatchObject({statusCode: 404, code: 'WORKER_NOT_IN_GUILD'});
    await expect(service.updateBranding(guildA, {workerId: 'muse-01', nickname: ''}, statuses))
      .rejects.toMatchObject({statusCode: 400, code: 'INVALID_BRANDING'});

    workers[0].setBranding.mockResolvedValueOnce({workerId: 'muse-01', guildId: guildA, ok: false, error: 'MISSING_PERMISSION', discordStatus: 403} as never);
    await expect(service.updateBranding(guildA, {workerId: 'muse-01', nickname: 'Radio'}, statuses))
      .rejects.toMatchObject({statusCode: 422, code: 'BRANDING_MISSING_PERMISSION'});
    workers[0].setBranding.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.updateBranding(guildA, {workerId: 'muse-01', nickname: 'Radio'}, statuses))
      .rejects.toMatchObject({statusCode: 503, code: 'WORKER_UNAVAILABLE'});
    expect(service.branding(guildA)).toEqual({});
  });

  it('resets every bot on a downgrade and on expiry, with an audit entry', async () => {
    const {service, workers, records} = makeService();
    await service.changeGuildPlan(guildA, {tier: 'TIER3'}, actor, new Set([guildA]));
    await service.updateBranding(guildA, {workerId: 'muse-01', nickname: 'One'}, statuses);
    await service.updateBranding(guildA, {workerId: 'muse-02', banner: BANNER}, statuses);

    await service.changeGuildPlan(guildA, {tier: 'TIER2'}, actor, new Set([guildA]));
    expect(workers[0].setBranding).toHaveBeenLastCalledWith(guildA, {nick: null, banner: null});
    expect(workers[1].setBranding).toHaveBeenLastCalledWith(guildA, {nick: null, banner: null});
    expect(service.branding(guildA)).toEqual({});
    expect(records.find(entry => entry.action === 'branding.reset')).toMatchObject({actor, subjectId: guildA, outcome: 'ok'});

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await service.changeGuildPlan(guildA, {tier: 'TIER3', expiresAt}, actor, new Set([guildA]));
    await service.updateBranding(guildA, {workerId: 'muse-01', nickname: 'One'}, statuses);
    workers[0].setBranding.mockRejectedValueOnce(new Error('down'));
    expect(await service.sweepExpired(new Date(Date.now() + 120_000))).toEqual([guildA]);
    expect(service.branding(guildA)).toEqual({});
    expect(records.filter(entry => entry.action === 'branding.reset').at(-1)).toMatchObject({actor: {userId: 'system'}, outcome: 'failed'});
  });
});
