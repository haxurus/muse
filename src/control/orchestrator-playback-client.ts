import got from 'got';
import type {PlaybackActionResult} from './playback-types.js';
import type Config from '../services/config.js';

export type OrchestratedPlaybackResult = PlaybackActionResult & {
  lease?: {
    guildId: string;
    voiceChannelId: string;
    workerId: string;
    groupId: string | null;
    state: string;
  };
};

const extractErrorMessage = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as {response?: {body?: unknown}}).response;
    if (typeof response?.body === 'string') {
      try {
        const parsed = JSON.parse(response.body) as {error?: unknown};
        if (typeof parsed.error === 'string') {
          return parsed.error;
        }
      } catch {}
    }
  }

  return error instanceof Error ? error.message : 'playback request failed';
};

export default class OrchestratorPlaybackClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: Config) {
    this.baseUrl = config.ORCHESTRATOR_URL.replace(/\/$/u, '');
    this.token = config.ORCHESTRATOR_TOKEN;
  }

  async action(
    guildId: string,
    action: 'play' | 'pause' | 'resume' | 'skip' | 'stop' | 'disconnect' | 'volume',
    body: Record<string, unknown>,
  ): Promise<OrchestratedPlaybackResult> {
    try {
      return await got.post(
        `${this.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/playback/${action}`,
        {
          headers: {authorization: `Bearer ${this.token}`},
          json: body,
          retry: {limit: 0},
          timeout: {request: action === 'play' ? 65_000 : 12_000},
        },
      ).json<OrchestratedPlaybackResult>();
    } catch (error: unknown) {
      throw new Error(extractErrorMessage(error));
    }
  }

  async read(
    guildId: string,
    action: 'queue' | 'now-playing',
    voiceChannelId: string | null,
  ): Promise<OrchestratedPlaybackResult> {
    try {
      const url = new URL(
        `${this.baseUrl}/v1/guilds/${encodeURIComponent(guildId)}/playback/${action}`,
      );
      if (voiceChannelId) {
        url.searchParams.set('voiceChannelId', voiceChannelId);
      }

      return await got.get(url.toString(), {
        headers: {authorization: `Bearer ${this.token}`},
        retry: {limit: 0},
        timeout: {request: 12_000},
      }).json<OrchestratedPlaybackResult>();
    } catch (error: unknown) {
      throw new Error(extractErrorMessage(error));
    }
  }
}
