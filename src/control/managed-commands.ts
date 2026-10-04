import type Command from '../commands/index.js';
import type Config from '../services/config.js';

export const CONTROLLER_COMMAND_NAMES = new Set([
  'play',
  'pause',
  'resume',
  'skip',
  'next',
  'stop',
  'disconnect',
  'queue',
  'volume',
  'now-playing',
]);

export const commandVisibleForRole = (config: Config, command: Command): boolean => {
  if (config.BOT_ROLE === 'worker') {
    return false;
  }

  if (config.BOT_ROLE === 'controller') {
    return command.slashCommand.name !== undefined
      && CONTROLLER_COMMAND_NAMES.has(command.slashCommand.name);
  }

  return true;
};
