import got from 'got';
import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import Config from './config.js';
import type {PoolAssignment, PoolAssignmentMode} from '../orchestrator/pool-types.js';

@injectable()
export default class PoolAssignmentClient {
  constructor(@inject(TYPES.Config) private readonly config: Config) {}

  async assign(
    guildId: string,
    voiceChannelId: string,
    mode: PoolAssignmentMode,
  ): Promise<PoolAssignment> {
    try {
      return await got.post(this.config.ORCHESTRATOR_URL + '/v1/pool/assign', {
        headers: {
          authorization: 'Bearer ' + this.config.CONTROL_TOKEN,
        },
        json: {
          guildId,
          voiceChannelId,
          mode,
        },
        retry: {
          limit: 0,
        },
        timeout: {
          request: 4000,
        },
      }).json<PoolAssignment>();
    } catch (error: unknown) {
      const responseBody = typeof error === 'object'
        && error !== null
        && 'response' in error
        && typeof error.response === 'object'
        && error.response !== null
        && 'body' in error.response
        ? error.response.body
        : undefined;

      if (typeof responseBody === 'string') {
        try {
          const parsed = JSON.parse(responseBody) as {error?: unknown};
          if (typeof parsed.error === 'string') {
            throw new Error(parsed.error);
          }
        } catch (parseError: unknown) {
          if (parseError instanceof Error && parseError.message !== 'Unexpected end of JSON input') {
            throw parseError;
          }
        }
      }

      throw new Error('music pool is temporarily unavailable');
    }
  }
}
