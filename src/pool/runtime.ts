import {readFileSync} from 'node:fs';
import path from 'node:path';

export type PoolRole = 'off' | 'controller' | 'worker';

export const poolRole = (): PoolRole => {
  if (process.env.MUSE_POOL_ENABLED !== 'true') {
    return 'off';
  }

  const role = process.env.MUSE_POOL_ROLE;
  if (role !== 'controller' && role !== 'worker') {
    throw new Error('MUSE_POOL_ROLE must be controller or worker when the pool is enabled');
  }

  return role;
};

export const poolSecret = (): string => {
  const file = process.env.MUSE_POOL_CLIENT_TOKEN_FILE;
  if (!file || !path.resolve(file).startsWith('/run/secrets/')) {
    throw new Error('MUSE_POOL_CLIENT_TOKEN_FILE must reference a mounted secret');
  }

  const token = readFileSync(file, 'utf8').trim();
  if (!/^[\da-f]{64}$/u.test(token)) {
    throw new Error('Pool client token must contain 32 random bytes encoded as hex');
  }

  return token;
};
