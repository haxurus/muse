import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

const MAX_CLOCK_SKEW_MS = 30_000;

const bodyDigest = (body: string) => createHash('sha256').update(body).digest('hex');

export const signControlRequest = (
  secret: string,
  method: string,
  requestPath: string,
  body: string,
  timestamp = Date.now(),
) => {
  const canonical = [
    timestamp.toString(),
    method.toUpperCase(),
    requestPath,
    bodyDigest(body),
  ].join('\n');

  return {
    timestamp: timestamp.toString(),
    signature: createHmac('sha256', secret).update(canonical).digest('hex'),
  };
};

export const verifyControlRequest = ({
  secret,
  method,
  requestPath,
  body,
  timestampHeader,
  signatureHeader,
  now = Date.now(),
}: {
  secret: string;
  method: string;
  requestPath: string;
  body: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  now?: number;
}): boolean => {
  if (!timestampHeader || !signatureHeader || !/^\d+$/u.test(timestampHeader) || !/^[a-f0-9]{64}$/u.test(signatureHeader)) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    return false;
  }

  const expected = signControlRequest(secret, method, requestPath, body, timestamp).signature;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(signatureHeader, 'hex');

  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
};
