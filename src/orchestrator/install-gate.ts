import type {IncomingMessage} from 'node:http';
import {HttpError, readJsonBody} from '../control/http.js';
import {isSnowflake} from '../control/snowflake.js';
import type {InstallCheckResult, InstallContacts, InstallSubject} from '../control/types.js';
import {commitWithBackup, isPlainObject, isPrintable, loadWithBackup} from './durable-file.js';
import type {SettledStatus} from './plan-service.js';
import {SYSTEM_ACTOR, isSystemActor, isValidActor, type Actor, type AuditEntryInput} from './super-store.js';

/**
 * Closed access (Sentinel install gate): Muse is a self-hosted project, not a public service, so a
 * bot may stay only in an authorized server. Authorizations come from the super console (MANUAL),
 * from the super admin adding the bot (OWNER), from a server that already had a Muse bot (EXISTING)
 * and, once, from every server the bots were in when the gate was first enabled (LEGACY).
 */
export const INSTALL_GRANT_SOURCES = ['MANUAL', 'OWNER', 'EXISTING', 'LEGACY'] as const;
export type InstallGrantSource = typeof INSTALL_GRANT_SOURCES[number];

export type InstallGrant = {
  source: InstallGrantSource;
  note: string | null;
  createdAt: string;
  createdBy: Actor;
};

type InstallFile = {
  version: 1;
  /** When the servers present at the first start were authorized (LEGACY); null until then. */
  seededAt: string | null;
  guilds: Record<string, InstallGrant>;
};

export const MAX_INSTALL_NOTE_LENGTH = 200;
const MAX_GRANTS = 20_000;

/** The gate is on when MUSE_INSTALL_GATE is "true" (the production Compose file sets it). */
export const isInstallGateEnabled = (): boolean => process.env.MUSE_INSTALL_GATE === 'true';

const isIsoDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

const isValidGrant = (value: unknown): value is InstallGrant => isPlainObject(value)
  && (INSTALL_GRANT_SOURCES as readonly unknown[]).includes(value.source)
  && (value.note === null || (typeof value.note === 'string' && isPrintable(value.note, 1, MAX_INSTALL_NOTE_LENGTH)))
  && isIsoDate(value.createdAt)
  && (isValidActor(value.createdBy) || isSystemActor(value.createdBy));

const isValidInstallFile = (value: unknown): value is InstallFile => isPlainObject(value)
  && value.version === 1
  && (value.seededAt === null || isIsoDate(value.seededAt))
  && isPlainObject(value.guilds)
  && Object.keys(value.guilds).length <= MAX_GRANTS
  && Object.entries(value.guilds).every(([guildId, grant]) => isSnowflake(guildId) && isValidGrant(grant));

/** Durable server authorizations (`/state/install-grants.json`), one orchestrator per state volume. */
export class InstallGrantStore {
  private data: InstallFile;

  constructor(private readonly filePath: string) {
    this.data = loadWithBackup<InstallFile>(filePath, isValidInstallFile, () => ({version: 1, seededAt: null, guilds: {}}), 'Install grant store');
  }

  grant(guildId: string): InstallGrant | undefined {
    const grant = this.data.guilds[guildId];
    return grant === undefined ? undefined : {...grant, createdBy: {...grant.createdBy}};
  }

  /** Newest first. */
  grants(): Array<InstallGrant & {guildId: string}> {
    return Object.entries(this.data.guilds)
      .map(([guildId, grant]) => ({guildId, ...grant, createdBy: {...grant.createdBy}}))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  seededAt(): string | null {
    return this.data.seededAt;
  }

  set(guildId: string, grant: InstallGrant): void {
    this.commit({...this.data, guilds: {...this.data.guilds, [guildId]: {...grant}}});
  }

  remove(guildId: string): boolean {
    if (this.data.guilds[guildId] === undefined) {
      return false;
    }

    this.commit({...this.data, guilds: Object.fromEntries(Object.entries(this.data.guilds).filter(([id]) => id !== guildId))});
    return true;
  }

  /** Authorize `guildIds` (keeping existing grants) and mark the first start as done. */
  seed(guildIds: string[], at: string): void {
    const added = Object.fromEntries(guildIds
      .filter(guildId => this.data.guilds[guildId] === undefined)
      .map(guildId => [guildId, {source: 'LEGACY' as const, note: null, createdAt: at, createdBy: SYSTEM_ACTOR}]));
    this.commit({...this.data, seededAt: at, guilds: {...added, ...this.data.guilds}});
  }

  private commit(next: InstallFile): void {
    if (!isValidInstallFile(next)) {
      throw new HttpError(400, 'invalid install grant data', 'INVALID_GRANT');
    }

    commitWithBackup(this.filePath, this.data, next);
    this.data = next;
  }
}

export type InstallGateDeps = {
  statuses: () => Promise<SettledStatus[]>;
  /** Discord user id of the super admin (may add the bots anywhere), or null. */
  superAdminUserId: string | null;
  contacts: () => InstallContacts;
  /** Posts "installation refused" in the status channel and audits it; never throws. */
  announceRejected: (install: InstallSubject) => Promise<void>;
  /** Posts "added to a server" with the authorization; never throws. */
  announceApproved?: (install: InstallSubject) => Promise<void>;
  record: (entry: AuditEntryInput) => void;
};

const parseInstallSubject = (input: unknown, workerId: string, botName: string): InstallSubject => {
  const {guildId, guildName, memberCount, installerId}: Record<string, unknown> = isPlainObject(input) ? input : {};
  if (!isSnowflake(guildId)
    || typeof guildName !== 'string' || !isPrintable(guildName, 1, 100)
    || !Number.isSafeInteger(memberCount) || (memberCount as number) < 0
    || (installerId !== null && !isSnowflake(installerId))) {
    throw new HttpError(400, 'invalid install check', 'INVALID_BODY');
  }

  return {guildId, guildName, memberCount: memberCount as number, installerId, workerId, botName};
};

export default class InstallGate {
  private seeding?: Promise<void>;

  constructor(private readonly store: InstallGrantStore, private readonly deps: InstallGateDeps) {}

  /**
   * First start with the gate: every server a reachable bot is in stays authorized (LEGACY).
   * Retried on the next call while no bot answers.
   */
  async seedOnce(): Promise<void> {
    if (this.store.seededAt() !== null) {
      return;
    }

    this.seeding ??= (async () => {
      const reachable = (await this.deps.statuses()).filter(result => result.ok);
      if (reachable.length > 0 && this.store.seededAt() === null) {
        const guildIds = [...new Set(reachable.flatMap(result => result.ok ? result.value.guilds.map(guild => guild.id) : []))];
        this.store.seed(guildIds, new Date().toISOString());
        console.log(`Install gate: authorized the ${guildIds.length} servers the bots are already in`);
      }
    })().finally(() => {
      this.seeding = undefined;
    });
    return this.seeding;
  }

  /** `POST /v1/worker/install-check` from a bot that was just added to a server. */
  async check(callerId: string, input: unknown): Promise<InstallCheckResult> {
    const statuses = await this.deps.statuses();
    const caller = statuses.find(result => result.workerId === callerId);
    const botName = caller?.ok && caller.value.bot ? caller.value.bot.username : callerId;
    const install = parseInstallSubject(input, callerId, botName);
    await this.seedOnce();

    const existing = this.store.grant(install.guildId);
    let source: InstallGrantSource | undefined = existing?.source;
    if (source === undefined && install.installerId !== null && install.installerId === this.deps.superAdminUserId) {
      source = 'OWNER';
    }

    // Another Muse bot already serves this server: adding more bots is not a new installation.
    if (source === undefined && statuses.some(result => result.ok && result.workerId !== callerId
      && result.value.guilds.some(guild => guild.id === install.guildId))) {
      source = 'EXISTING';
    }

    if (source === undefined) {
      await this.deps.announceRejected(install);
      return {approved: false, source: null, contacts: this.deps.contacts()};
    }

    if (!existing) {
      this.store.set(install.guildId, {source, note: null, createdAt: new Date().toISOString(), createdBy: SYSTEM_ACTOR});
    }

    await this.deps.announceApproved?.({...install, source});

    return {approved: true, source, contacts: this.deps.contacts()};
  }

  grants(): Array<InstallGrant & {guildId: string}> {
    return this.store.grants();
  }

  /** `PUT /v1/super/install-grants/:guildId {note?}`: authorize a server before its owner adds the bots. */
  async authorize(guildId: string, request: IncomingMessage, actor: Actor): Promise<InstallGrant & {guildId: string}> {
    if (!isSnowflake(guildId)) {
      throw new HttpError(400, 'guild id must be a Discord server id', 'INVALID_GUILD_ID');
    }

    const body = await readJsonBody(request);
    const rawNote = isPlainObject(body) ? body.note : undefined;
    const note = typeof rawNote === 'string' && rawNote.trim() !== '' ? rawNote.trim() : null;
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') {
      throw new HttpError(400, 'note must be a string', 'INVALID_GRANT');
    }

    if (note !== null && !isPrintable(note, 1, MAX_INSTALL_NOTE_LENGTH)) {
      throw new HttpError(400, `note must have at most ${MAX_INSTALL_NOTE_LENGTH} printable characters`, 'INVALID_GRANT');
    }

    const grant: InstallGrant = {source: 'MANUAL', note, createdAt: new Date().toISOString(), createdBy: actor};
    this.store.set(guildId, grant);
    this.deps.record({actor, action: 'install.grant', subjectType: 'GUILD', subjectId: guildId, details: {note}, outcome: 'ok'});
    return {guildId, ...grant};
  }

  /** `DELETE /v1/super/install-grants/:guildId`: the bots already there stay, a new installation is refused. */
  revoke(guildId: string, actor: Actor): {guildId: string; revoked: boolean} {
    if (!isSnowflake(guildId)) {
      throw new HttpError(400, 'guild id must be a Discord server id', 'INVALID_GUILD_ID');
    }

    const revoked = this.store.remove(guildId);
    if (!revoked) {
      throw new HttpError(404, 'that server is not authorized', 'GRANT_NOT_FOUND');
    }

    this.deps.record({actor, action: 'install.revoke', subjectType: 'GUILD', subjectId: guildId, details: {}, outcome: 'ok'});
    return {guildId, revoked};
  }
}
