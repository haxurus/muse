import {closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync} from 'node:fs';
import path from 'node:path';

export type LoadResult<T> = {status: 'ok'; data: T} | {status: 'missing'} | {status: 'invalid'};

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when the string has `min`-`max` characters and no ASCII control characters. */
export const isPrintable = (value: string, min: number, max: number): boolean => {
  const characters = [...value];
  const hasControlCharacter = characters.some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });

  return value.length >= min && value.length <= max && !hasControlCharacter;
};

export const serializeJson = (data: unknown): string => `${JSON.stringify(data, null, 2)}\n`;

/** Write via temp file + fsync + rename, then fsync the directory where the platform supports it. */
export const writeDurably = (target: string, content: string): void => {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.tmp`);
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temporary, target);
  try {
    const directoryFd = openSync(directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    // Directory fsync is not supported on every platform (for example Windows).
  }
};

export const readValidated = <T>(filePath: string, isValid: (value: unknown) => value is T): LoadResult<T> => {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {status: 'missing'};
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValid(parsed) ? {status: 'ok', data: parsed} : {status: 'invalid'};
  } catch {
    return {status: 'invalid'};
  }
};

/**
 * Load `filePath`, falling back to `filePath.bak` when the primary is missing or invalid.
 * A missing primary without a backup yields `empty()`; an invalid one without a valid backup throws.
 */
export const loadWithBackup = <T>(
  filePath: string,
  isValid: (value: unknown) => value is T,
  empty: () => T,
  label: string,
): T => {
  mkdirSync(path.dirname(filePath), {recursive: true, mode: 0o700});
  const backupPath = `${filePath}.bak`;

  const primary = readValidated(filePath, isValid);
  if (primary.status === 'ok') {
    return primary.data;
  }

  const backup = readValidated(backupPath, isValid);
  if (backup.status === 'ok') {
    console.warn(`${label} ${filePath} is ${primary.status}; recovered from ${backupPath}`);
    return backup.data;
  }

  if (primary.status === 'missing') {
    return empty();
  }

  throw new Error(`${label} ${filePath} is unreadable or has an invalid schema, and no valid backup exists at ${backupPath}. Restore it from a backup before starting the orchestrator.`);
};

/**
 * Persist `next` durably after saving `previous` (the last good state) as `filePath.bak`.
 * Callers only update memory after this returns.
 */
export const commitWithBackup = (filePath: string, previous: unknown, next: unknown): void => {
  writeDurably(`${filePath}.bak`, serializeJson(previous));
  writeDurably(filePath, serializeJson(next));
};
