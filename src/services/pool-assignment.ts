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
    return got.post(this.config.ORCHESTRATOR_URL + '/v1/pool/assign', {
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
  }
}
