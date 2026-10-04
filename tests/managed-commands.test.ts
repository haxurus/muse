import {describe, expect, it} from 'vitest';
import {commandVisibleForRole, CONTROLLER_COMMAND_NAMES} from '../src/control/managed-commands.js';
import type Command from '../src/commands/index.js';
import type Config from '../src/services/config.js';

const command = (name: string) => ({
  slashCommand: {
    name,
    toJSON: () => ({name}),
  },
  execute: async () => undefined,
}) as unknown as Command;

describe('managed bot command roles', () => {
  it('keeps secondary workers commandless', () => {
    expect(commandVisibleForRole({BOT_ROLE: 'worker'} as Config, command('play'))).toBe(false);
  });

  it('exposes only pool-safe commands on the controller', () => {
    for (const name of CONTROLLER_COMMAND_NAMES) {
      expect(commandVisibleForRole({BOT_ROLE: 'controller'} as Config, command(name))).toBe(true);
    }

    expect(commandVisibleForRole({BOT_ROLE: 'controller'} as Config, command('move'))).toBe(false);
    expect(commandVisibleForRole({BOT_ROLE: 'controller'} as Config, command('config'))).toBe(false);
  });

  it('preserves all upstream commands in standalone mode', () => {
    expect(commandVisibleForRole({BOT_ROLE: 'standalone'} as Config, command('move'))).toBe(true);
  });
});
