import type {PoolAssignmentMode} from '../orchestrator/pool-types.js';

const ASSIGN_COMMANDS = new Set([
  'play',
]);

const EXISTING_COMMANDS = new Set([
  'clear',
  'disconnect',
  'fseek',
  'loop-queue',
  'loop',
  'move',
  'next',
  'now-playing',
  'pause',
  'queue',
  'remove',
  'replay',
  'resume',
  'seek',
  'shuffle',
  'skip',
  'stop',
  'unskip',
  'volume',
]);

export const getPoolCommandMode = (commandName: string): PoolAssignmentMode | null => {
  if (ASSIGN_COMMANDS.has(commandName)) {
    return 'assign';
  }

  if (EXISTING_COMMANDS.has(commandName)) {
    return 'existing';
  }

  return null;
};
