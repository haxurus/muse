import {randomUUID} from 'node:crypto';
import {HttpError} from '../control/http.js';
import {isSnowflake} from '../control/snowflake.js';
import {MAX_BLOCKLIST_ENTRIES, type Blocklist} from '../control/blocklist.js';
import {commitWithBackup, isPlainObject, isPrintable, loadWithBackup} from './durable-file.js';

export type BlockKind = 'GUILD' | 'USER';

export const BLOCK_KINDS: readonly BlockKind[] = ['GUILD', 'USER'];

export const isBlockKind = (value: unknown): value is BlockKind =>
  typeof value === 'string' && (BLOCK_KINDS as readonly string[]).includes(value);

/** Identity of the dashboard user who performed an action, as asserted by the dashboard backend. */
export type Actor = {
  userId: string;
  username: string;
};

export type Block = {
  kind: BlockKind;
  subjectId: string;
  reason?: string;
  createdBy: Actor;
  createdAt: string;
};

export type AuditOutcome = 'ok' | 'partial' | 'failed';

export type AuditEntry = {
  id: string;
  at: string;
  actor: Actor;
  action: string;
  subjectType: string;
  subjectId: string;
  details: Record<string, unknown>;
  outcome: AuditOutcome;
};

type BlockFile = {
  version: 1;
  blocks: Block[];
};

type AuditFile = {
  version: 1;
  /** Oldest first. */
  entries: AuditEntry[];
};

export const MAX_REASON_LENGTH = 500;
export const MAX_ACTOR_NAME_LENGTH = 64;
export const AUDIT_RETENTION = 1000;
const MAX_AUDIT_DETAILS_BYTES = 4096;

export const isValidActor = (value: unknown): value is Actor => isPlainObject(value)
  && isSnowflake(value.userId)
  && typeof value.username === 'string'
  && isPrintable(value.username, 1, MAX_ACTOR_NAME_LENGTH);

const isValidBlock = (value: unknown): value is Block => isPlainObject(value)
  && isBlockKind(value.kind)
  && isSnowflake(value.subjectId)
  && (value.reason === undefined || (typeof value.reason === 'string' && isPrintable(value.reason, 1, MAX_REASON_LENGTH)))
  && isValidActor(value.createdBy)
  && typeof value.createdAt === 'string';

const blockKey = (kind: BlockKind, subjectId: string): string => `${kind}:${subjectId}`;

const isValidBlockFile = (value: unknown): value is BlockFile => {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.blocks)) {
    return false;
  }

  const candidates = value.blocks as unknown[];
  if (!candidates.every(block => isValidBlock(block))) {
    return false;
  }

  const blocks = candidates as Block[];
  const keys = new Set(blocks.map(block => blockKey(block.kind, block.subjectId)));
  return keys.size === blocks.length
    && BLOCK_KINDS.every(kind => blocks.filter(block => block.kind === kind).length <= MAX_BLOCKLIST_ENTRIES);
};

const OUTCOMES = new Set<unknown>(['ok', 'partial', 'failed']);

const isValidAuditEntry = (value: unknown): value is AuditEntry => isPlainObject(value)
  && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 64
  && typeof value.at === 'string'
  && isValidActor(value.actor)
  && typeof value.action === 'string' && isPrintable(value.action, 1, 64)
  && typeof value.subjectType === 'string' && isPrintable(value.subjectType, 1, 32)
  && typeof value.subjectId === 'string' && isPrintable(value.subjectId, 1, 64)
  && isPlainObject(value.details)
  && OUTCOMES.has(value.outcome);

const isValidAuditFile = (value: unknown): value is AuditFile => isPlainObject(value)
  && value.version === 1
  && Array.isArray(value.entries)
  && value.entries.length <= AUDIT_RETENTION
  && value.entries.every(entry => isValidAuditEntry(entry));

/** Optional free-text reason: trimmed, empty means none, at most 500 printable characters. */
export const normalizeReason = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new HttpError(400, 'reason must be a string', 'INVALID_REASON');
  }

  const reason = value.trim();
  if (reason.length === 0) {
    return undefined;
  }

  if (!isPrintable(reason, 1, MAX_REASON_LENGTH)) {
    throw new HttpError(400, `reason must contain at most ${MAX_REASON_LENGTH} printable characters`, 'INVALID_REASON');
  }

  return reason;
};

const copyBlock = (block: Block): Block => ({...block, createdBy: {...block.createdBy}});

/**
 * Durable super-console block list (`/state/blocks.json`), unique by (kind, subjectId).
 * Single-process store like GuildGroupStore: exactly one orchestrator per state volume.
 */
export class BlockStore {
  private data: BlockFile;

  constructor(private readonly filePath: string) {
    this.data = loadWithBackup<BlockFile>(filePath, isValidBlockFile, () => ({version: 1, blocks: []}), 'Block store');
  }

  /** Newest first. */
  list(): Block[] {
    return this.data.blocks
      .map(block => copyBlock(block))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  isBlocked(kind: BlockKind, subjectId: string): boolean {
    return this.data.blocks.some(block => block.kind === kind && block.subjectId === subjectId);
  }

  blocklist(): Blocklist {
    return {
      guildIds: this.data.blocks.filter(block => block.kind === 'GUILD').map(block => block.subjectId).sort(),
      userIds: this.data.blocks.filter(block => block.kind === 'USER').map(block => block.subjectId).sort(),
    };
  }

  /** Create a block, or replace the reason of an existing one (creator and creation time are kept). */
  upsert(kind: BlockKind, subjectId: string, reason: string | undefined, actor: Actor): {block: Block; created: boolean} {
    const index = this.data.blocks.findIndex(block => block.kind === kind && block.subjectId === subjectId);
    const next = [...this.data.blocks];

    let block: Block;
    if (index >= 0) {
      const existing = next[index];
      block = {
        kind: existing.kind,
        subjectId: existing.subjectId,
        ...(reason === undefined ? {} : {reason}),
        createdBy: {...existing.createdBy},
        createdAt: existing.createdAt,
      };
      next[index] = block;
    } else {
      if (this.data.blocks.filter(candidate => candidate.kind === kind).length >= MAX_BLOCKLIST_ENTRIES) {
        throw new HttpError(409, `at most ${MAX_BLOCKLIST_ENTRIES} ${kind} blocks are supported`, 'BLOCKLIST_FULL');
      }

      block = {
        kind,
        subjectId,
        ...(reason === undefined ? {} : {reason}),
        createdBy: {...actor},
        createdAt: new Date().toISOString(),
      };
      next.push(block);
    }

    this.commit(next);
    return {block: copyBlock(block), created: index < 0};
  }

  remove(kind: BlockKind, subjectId: string): Block {
    const existing = this.data.blocks.find(block => block.kind === kind && block.subjectId === subjectId);
    if (!existing) {
      throw new HttpError(404, 'block not found', 'BLOCK_NOT_FOUND');
    }

    this.commit(this.data.blocks.filter(block => block !== existing));
    return copyBlock(existing);
  }

  private commit(blocks: Block[]): void {
    const next: BlockFile = {version: 1, blocks};
    // The in-memory state always equals the last good file, so it is the backup copy.
    commitWithBackup(this.filePath, this.data, next);
    this.data = next;
  }
}

const boundDetails = (details: Record<string, unknown>): Record<string, unknown> => {
  const serialized = JSON.stringify(details);
  return Buffer.byteLength(serialized) <= MAX_AUDIT_DETAILS_BYTES
    ? JSON.parse(serialized) as Record<string, unknown>
    : {truncated: true};
};

/** Durable ring buffer of the last 1000 super-console actions (`/state/super-audit.json`). */
export class AuditStore {
  private data: AuditFile;

  constructor(private readonly filePath: string) {
    this.data = loadWithBackup<AuditFile>(filePath, isValidAuditFile, () => ({version: 1, entries: []}), 'Audit store');
  }

  /** Newest first. */
  list(limit = AUDIT_RETENTION): AuditEntry[] {
    return this.data.entries.slice(-limit).reverse().map(entry => ({
      ...entry,
      actor: {...entry.actor},
      details: JSON.parse(JSON.stringify(entry.details)) as Record<string, unknown>,
    }));
  }

  append(input: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: {...input.actor},
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      details: boundDetails(input.details),
      outcome: input.outcome,
    };

    const next: AuditFile = {version: 1, entries: [...this.data.entries, entry].slice(-AUDIT_RETENTION)};
    commitWithBackup(this.filePath, this.data, next);
    this.data = next;
    return entry;
  }
}
