import {URL} from 'node:url';

// FFmpeg protocol read/write timeouts are expressed in microseconds.
export const HTTP_STREAM_RW_TIMEOUT_MICROSECONDS = 15_000_000;
export const HTTP_STREAM_PROBE_TIMEOUT_MS = 20_000;

/**
 * FFmpeg/ffprobe input options for user-supplied HTTP(S) direct streams.
 * Restricts the protocols a playlist (e.g. HLS) can pull in, so a remote
 * manifest cannot make FFmpeg read local files or other schemes, and bounds
 * how long a stalled server can hold a read open.
 */
export const getHttpStreamInputOptions = (url: string): string[] => {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return [];
  }

  if (protocol !== 'http:' && protocol !== 'https:') {
    return [];
  }

  const protocols = ['https', 'tls', 'tcp', 'crypto', 'httpproxy'];
  if (protocol === 'http:') {
    protocols.push('http');
  }

  return [
    '-protocol_whitelist',
    protocols.join(','),
    '-rw_timeout',
    HTTP_STREAM_RW_TIMEOUT_MICROSECONDS.toString(),
  ];
};

/**
 * Keeps only plain DNS host names usable for suffix matching. Entries without a
 * dot (e.g. "com"), or with ports, paths or wildcards, would match far more
 * than intended or nothing at all.
 */
export const isValidAllowedStreamHost = (host: string): boolean => (
  host.includes('.')
  && !/[:/*\s]/.test(host)
  && !host.startsWith('.')
  && !host.endsWith('.')
);
