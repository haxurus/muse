import {readFileSync} from 'node:fs';
import path from 'node:path';

export type WorkerDefinition = {
  id: string;
  baseUrl: string;
  token: string;
};

type WorkerConfigFileEntry = {
  id: string;
  baseUrl: string;
  tokenFile: string;
};

export const MIN_TOKEN_LENGTH = 32;

const readRequiredFile = (filePath: string, label: string): string => {
  const value = readFileSync(filePath, 'utf8').trim();
  if (!value) {
    throw new Error(`${label} is empty`);
  }

  return value;
};

export const assertTokenStrength = (token: string, label: string): string => {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`${label} must be at least ${MIN_TOKEN_LENGTH} characters long`);
  }

  return token;
};

const readTokenFile = (filePath: string, label: string): string =>
  assertTokenStrength(readRequiredFile(filePath, label), label);

/** Normalize a POSIX container path and require it to stay inside `prefix` (which must end with '/'). */
export const resolveContainedPath = (value: string, prefix: string): string | undefined => {
  if (!path.posix.isAbsolute(value)) {
    return undefined;
  }

  const normalized = path.posix.normalize(value);
  return normalized.startsWith(prefix) && normalized.length > prefix.length ? normalized : undefined;
};

const validateWorkerEntry = (entry: WorkerConfigFileEntry): WorkerConfigFileEntry => {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(entry.id)) {
    throw new Error(`Invalid worker id: ${entry.id}`);
  }

  const url = new URL(entry.baseUrl);
  if (url.protocol !== 'http:' || !/^[a-z0-9][a-z0-9-]*$/u.test(url.hostname) || url.username || url.password) {
    throw new Error(`Invalid internal worker URL for ${entry.id}`);
  }

  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Worker URL for ${entry.id} must not contain a path, query, or fragment`);
  }

  const tokenFile = resolveContainedPath(entry.tokenFile, '/run/secrets/');
  if (!tokenFile) {
    throw new Error(`Worker token file for ${entry.id} must be mounted under /run/secrets`);
  }

  return {...entry, tokenFile};
};

export const loadWorkerDefinitions = (): WorkerDefinition[] => {
  const configPath = process.env.MUSE_WORKERS_FILE ?? '/config/workers.json';
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;

  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) {
    throw new Error('workers.json must contain between 1 and 16 workers');
  }

  const seen = new Set<string>();
  return parsed.map(rawEntry => {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      throw new Error('Invalid worker configuration entry');
    }

    const candidate = rawEntry as Partial<WorkerConfigFileEntry>;
    if (typeof candidate.id !== 'string' || typeof candidate.baseUrl !== 'string' || typeof candidate.tokenFile !== 'string') {
      throw new Error('Each worker entry requires id, baseUrl and tokenFile');
    }

    const entry = validateWorkerEntry({
      id: candidate.id,
      baseUrl: candidate.baseUrl,
      tokenFile: candidate.tokenFile,
    });

    if (seen.has(entry.id)) {
      throw new Error(`Duplicate worker id: ${entry.id}`);
    }

    seen.add(entry.id);
    return {
      id: entry.id,
      baseUrl: entry.baseUrl.replace(/\/$/u, ''),
      token: readTokenFile(entry.tokenFile, `control token for ${entry.id}`),
    };
  });
};

export type OrchestratorConfig = {
  host: string;
  port: number;
  apiToken: string;
  workers: WorkerDefinition[];
  groupsFile: string;
  /** Super-console block list; defaults to blocks.json next to the groups file. */
  blocksFile?: string;
  /** Super-console audit log; defaults to super-audit.json next to the groups file. */
  auditFile?: string;
  /** Blocklist reconcile period; defaults to 60 seconds. */
  blocklistReconcileIntervalMs?: number;
};

const resolveStateFile = (variable: string, fallback: string): string => {
  const resolved = resolveContainedPath(process.env[variable] ?? fallback, '/state/');
  if (!resolved) {
    throw new Error(`${variable} must be stored under /state`);
  }

  return resolved;
};

export const loadOrchestratorConfig = (): OrchestratorConfig => {
  const port = parseInt(process.env.MUSE_ORCHESTRATOR_PORT ?? '3100', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MUSE_ORCHESTRATOR_PORT must be a valid TCP port');
  }

  const tokenFile = resolveContainedPath(process.env.MUSE_ORCHESTRATOR_TOKEN_FILE ?? '', '/run/secrets/');
  if (!tokenFile) {
    throw new Error('MUSE_ORCHESTRATOR_TOKEN_FILE must point to a mounted secret');
  }

  const groupsFile = resolveStateFile('MUSE_ORCHESTRATOR_GROUPS_FILE', '/state/groups.json');
  const blocksFile = resolveStateFile('MUSE_ORCHESTRATOR_BLOCKS_FILE', '/state/blocks.json');
  const auditFile = resolveStateFile('MUSE_ORCHESTRATOR_AUDIT_FILE', '/state/super-audit.json');
  if (new Set([groupsFile, blocksFile, auditFile]).size !== 3) {
    throw new Error('Orchestrator groups, blocks and audit files must be distinct');
  }

  return {
    host: process.env.MUSE_ORCHESTRATOR_HOST ?? '127.0.0.1',
    port,
    apiToken: readTokenFile(tokenFile, 'orchestrator API token'),
    workers: loadWorkerDefinitions(),
    groupsFile,
    blocksFile,
    auditFile,
  };
};
