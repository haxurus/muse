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

const readRequiredFile = (filePath: string, label: string): string => {
  const value = readFileSync(filePath, 'utf8').trim();
  if (!value) {
    throw new Error(`${label} is empty`);
  }

  return value;
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

  if (!entry.tokenFile.startsWith('/run/secrets/')) {
    throw new Error(`Worker token file for ${entry.id} must be mounted under /run/secrets`);
  }

  return entry;
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
      token: readRequiredFile(entry.tokenFile, `control token for ${entry.id}`),
    };
  });
};

export type OrchestratorConfig = {
  host: string;
  port: number;
  apiToken: string;
  workers: WorkerDefinition[];
  dataDir: string;
  poolStorePath: string;
};

export const loadOrchestratorConfig = (): OrchestratorConfig => {
  const port = parseInt(process.env.MUSE_ORCHESTRATOR_PORT ?? '3100', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MUSE_ORCHESTRATOR_PORT must be a valid TCP port');
  }

  const tokenFile = process.env.MUSE_ORCHESTRATOR_TOKEN_FILE;
  if (!tokenFile?.startsWith('/run/secrets/')) {
    throw new Error('MUSE_ORCHESTRATOR_TOKEN_FILE must point to a mounted secret');
  }

  const dataDir = path.resolve(process.env.MUSE_ORCHESTRATOR_DATA_DIR ?? './orchestrator-data');

  return {
    host: process.env.MUSE_ORCHESTRATOR_HOST ?? '127.0.0.1',
    port,
    apiToken: readRequiredFile(tokenFile, 'orchestrator API token'),
    workers: loadWorkerDefinitions(),
    dataDir,
    poolStorePath: path.join(dataDir, 'pool-config.json'),
  };
};
