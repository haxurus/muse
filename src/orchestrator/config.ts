import {readFileSync} from 'node:fs';

export type WorkerDefinition = {
  id: string;
  label: string;
  url: string;
  secret: string;
};

type WorkerFileEntry = {
  id?: unknown;
  label?: unknown;
  url?: unknown;
  secretFile?: unknown;
};

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }

  return value;
};

const readSecret = (name: string) => {
  const direct = process.env[name]?.trim();
  if (direct) {
    return direct;
  }

  const filePath = process.env[`${name}_FILE`]?.trim();
  if (!filePath) {
    throw new Error(`Missing ${name} or ${name}_FILE`);
  }

  return readFileSync(filePath, 'utf8').trim();
};

const loadWorkers = (filePath: string): WorkerDefinition[] => {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    throw new Error('ORCHESTRATOR_WORKERS_FILE must contain between 1 and 20 workers');
  }

  const ids = new Set<string>();
  return raw.map((entry, index) => {
    const candidate = entry as WorkerFileEntry;
    if (typeof candidate.id !== 'string' || !/^[a-z0-9-]{1,32}$/u.test(candidate.id)) {
      throw new Error(`Invalid worker id at index ${index}`);
    }

    if (ids.has(candidate.id)) {
      throw new Error(`Duplicate worker id: ${candidate.id}`);
    }

    ids.add(candidate.id);

    if (typeof candidate.label !== 'string' || candidate.label.trim().length < 1 || candidate.label.length > 64) {
      throw new Error(`Invalid worker label for ${candidate.id}`);
    }

    if (typeof candidate.url !== 'string') {
      throw new Error(`Invalid worker URL for ${candidate.id}`);
    }

    const url = new URL(candidate.url);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`Worker URL for ${candidate.id} must be a plain internal http origin`);
    }

    if (typeof candidate.secretFile !== 'string' || candidate.secretFile.length === 0) {
      throw new Error(`Missing secretFile for ${candidate.id}`);
    }

    const secret = readFileSync(candidate.secretFile, 'utf8').trim();
    if (secret.length < 32) {
      throw new Error(`Control secret for ${candidate.id} must contain at least 32 characters`);
    }

    return {
      id: candidate.id,
      label: candidate.label.trim(),
      url: url.origin,
      secret,
    };
  });
};

export default class OrchestratorConfig {
  readonly PUBLIC_BASE_URL = required('ORCHESTRATOR_PUBLIC_BASE_URL').replace(/\/$/u, '');
  readonly DISCORD_CLIENT_ID = required('ORCHESTRATOR_DISCORD_CLIENT_ID');
  readonly DISCORD_CLIENT_SECRET = readSecret('ORCHESTRATOR_DISCORD_CLIENT_SECRET');
  readonly LISTEN_HOST = process.env.ORCHESTRATOR_LISTEN_HOST ?? '0.0.0.0';
  readonly LISTEN_PORT = parseInt(process.env.ORCHESTRATOR_LISTEN_PORT ?? '3000', 10);
  readonly SESSION_TTL_MS = parseInt(process.env.ORCHESTRATOR_SESSION_TTL_MS ?? '28800000', 10);
  readonly WORKERS = loadWorkers(required('ORCHESTRATOR_WORKERS_FILE'));

  constructor() {
    const publicUrl = new URL(this.PUBLIC_BASE_URL);
    if (publicUrl.protocol !== 'https:' && publicUrl.hostname !== 'localhost' && publicUrl.hostname !== '127.0.0.1') {
      throw new Error('ORCHESTRATOR_PUBLIC_BASE_URL must use HTTPS outside localhost');
    }

    if (!Number.isInteger(this.LISTEN_PORT) || this.LISTEN_PORT < 1 || this.LISTEN_PORT > 65_535) {
      throw new Error('ORCHESTRATOR_LISTEN_PORT must be between 1 and 65535');
    }

    if (!Number.isInteger(this.SESSION_TTL_MS) || this.SESSION_TTL_MS < 300_000 || this.SESSION_TTL_MS > 86_400_000) {
      throw new Error('ORCHESTRATOR_SESSION_TTL_MS must be between 5 minutes and 24 hours');
    }
  }
}
