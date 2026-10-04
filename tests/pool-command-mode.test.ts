import {describe, expect, it} from 'vitest';
import {getPoolCommandMode} from '../src/utils/pool-command-mode.js';

describe('pool command routing modes', () => {
  it('allocates a worker for a new play request', () => {
    expect(getPoolCommandMode('play')).toBe('assign');
  });

  it.each(['pause', 'skip', 'queue', 'resume', 'volume', 'disconnect'])(
    'routes %s to the existing voice session',
    command => {
      expect(getPoolCommandMode(command)).toBe('existing');
    },
  );

  it('keeps administrative commands outside the voice pool', () => {
    expect(getPoolCommandMode('config')).toBeNull();
  });
});
