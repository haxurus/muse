import {format} from 'node:util';
import {HttpError} from '../control/http.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = typeof LOG_LEVELS[number];

/** One captured console line. `message` is already redacted and truncated. */
export type LogEntry = {
  at: string;
  level: LogLevel;
  message: string;
};

/** Ring buffer size per process (workers and the orchestrator). */
export const LOG_BUFFER_CAPACITY = 1000;
export const LOG_MESSAGE_MAX_LENGTH = 2000;
export const DEFAULT_LOG_LIMIT = 200;
export const MAX_LOG_LIMIT = 1000;
/**
 * Rough budget for one `/v1/logs` answer, well under the orchestrator's 1 MB worker response cap.
 * The newest entries win when the budget runs out.
 */
export const MAX_LOG_RESPONSE_CHARS = 512 * 1024;

const PER_ENTRY_OVERHEAD = 64;

const DISCORD_TOKEN = /[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,40}/gu;
const AUTHORIZATION_HEADER = /(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s,;"'}]+/giu;
const BEARER_TOKEN = /\bbearer\s+[^\s,;"'}]+/giu;
const COOKIE_LINE = /\b((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]+/giu;
const SECRET_KEY_VALUE = /([\w.-]*(?:token|secret|password|passwd|cookie|apikey|api[_-]?key|credential)[\w.-]*["']?\s*[:=]\s*["']?)([^\s,;&"'}]+)/giu;
const URL_QUERY = /\b([a-z][\da-z+.-]*:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/giu;

/**
 * Hides Discord bot tokens, Authorization and Cookie values, `Bearer` tokens, token, secret, password
 * and key=value pairs, and URL query strings. Idempotent: redacting a redacted line changes nothing.
 */
export const redactLogText = (text: string): string => text
  .replace(COOKIE_LINE, '$1[redacted]')
  .replace(AUTHORIZATION_HEADER, '$1[redacted]')
  .replace(BEARER_TOKEN, 'Bearer [redacted]')
  .replace(DISCORD_TOKEN, '[redacted]')
  .replace(SECRET_KEY_VALUE, '$1[redacted]')
  .replace(URL_QUERY, '$1?[redacted]');

/** Caps a message at `LOG_MESSAGE_MAX_LENGTH` characters, ending with an ellipsis when cut. */
export const truncateLogMessage = (text: string): string => text.length > LOG_MESSAGE_MAX_LENGTH
  ? `${text.slice(0, LOG_MESSAGE_MAX_LENGTH - 1)}…`
  : text;

/** Same text `console.log` would print for these arguments. */
export const formatLogArguments = (args: unknown[]): string => {
  const [first, ...rest] = args;
  return args.length === 0 ? '' : format(first, ...rest);
};

const isLogLevel = (value: unknown): value is LogLevel => typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);

/** Parses `?limit=N` (1..1000, default 200); anything else is `400 INVALID_LIMIT`. */
export const parseLogLimit = (url: string | undefined): number => {
  const raw = new URL(url ?? '/', 'http://localhost').searchParams.get('limit');
  if (raw === null) {
    return DEFAULT_LOG_LIMIT;
  }

  const limit = /^\d{1,4}$/u.test(raw) ? Number(raw) : 0;
  if (limit < 1 || limit > MAX_LOG_LIMIT) {
    throw new HttpError(400, `limit must be a whole number from 1 to ${MAX_LOG_LIMIT}`, 'INVALID_LIMIT');
  }

  return limit;
};

/**
 * Re-validates log entries that came from another process (a worker answer): malformed entries are
 * dropped, and every kept message is redacted and truncated again before it is shown.
 */
export const sanitizeLogEntries = (input: unknown): LogEntry[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.slice(0, MAX_LOG_LIMIT).flatMap((value: unknown) => {
    if (typeof value !== 'object' || value === null) {
      return [];
    }

    const {at, level, message} = value as Record<string, unknown>;
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !isLogLevel(level) || typeof message !== 'string') {
      return [];
    }

    return [{at: at.slice(0, 40), level, message: truncateLogMessage(redactLogText(message))}];
  });
};

/** In-memory ring buffer of the most recent console lines. Lost on restart by design. */
export class LogBuffer {
  private entries: LogEntry[] = [];

  constructor(private readonly capacity = LOG_BUFFER_CAPACITY) {}

  /** Stores one line, redacted and truncated; the oldest line is dropped when full. */
  record(level: LogLevel, text: string, at: Date = new Date()): void {
    this.entries.push({
      at: at.toISOString(),
      level,
      message: truncateLogMessage(redactLogText(text)),
    });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /** The newest `limit` lines, oldest first, within the response size budget. */
  recent(limit = DEFAULT_LOG_LIMIT): LogEntry[] {
    const selected: LogEntry[] = [];
    let size = 0;
    for (let index = this.entries.length - 1; index >= 0 && selected.length < limit; index -= 1) {
      const entry = this.entries[index];
      size += entry.message.length + PER_ENTRY_OVERHEAD;
      if (size > MAX_LOG_RESPONSE_CHARS) {
        break;
      }

      selected.push({...entry});
    }

    return selected.reverse();
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}

/** The process-wide buffer fed by `installLogCapture()` in the worker and orchestrator entry points. */
export const logBuffer = new LogBuffer();

type ConsoleMethod = 'debug' | 'info' | 'log' | 'warn' | 'error';

const CONSOLE_LEVELS: Record<ConsoleMethod, LogLevel> = {
  debug: 'debug',
  info: 'info',
  log: 'info',
  warn: 'warn',
  error: 'error',
};

const installedTargets = new WeakSet<object>();

/**
 * Wraps the console methods so every line is also kept in `buffer`. The original methods still
 * print exactly as before. Installing twice on the same console is a no-op.
 */
export const installLogCapture = (target: Console = console, buffer: LogBuffer = logBuffer): void => {
  if (installedTargets.has(target)) {
    return;
  }

  installedTargets.add(target);
  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    const original = target[method];
    target[method] = (...args: unknown[]) => {
      try {
        buffer.record(CONSOLE_LEVELS[method], formatLogArguments(args));
      } catch {
        // Capturing must never break logging.
      }

      original.apply(target, args);
    };
  }
};
