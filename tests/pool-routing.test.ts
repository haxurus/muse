import {describe, expect, it, vi} from 'vitest';
import {executeRemoteCommand} from '../src/worker-control/commands.js';
import {validatePoolIngressRequest} from '../src/orchestrator/pool-router.js';

const validPoolRequest = {
  guildId: '123456789012345678',
  guildName: 'Test Guild',
  guildOwnerId: '223456789012345678',
  voiceChannelId: '323456789012345678',
  textChannelId: '423456789012345678',
  userId: '523456789012345678',
  commandName: 'play',
  options: {
    query: 'test song',
    shuffle: false,
  },
};

describe('pool ingress validation', () => {
  it('accepts a normalized player command request', () => {
    expect(validatePoolIngressRequest(validPoolRequest)).toEqual(validPoolRequest);
  });

  it('rejects unsupported commands and non-primitive options', () => {
    expect(() => validatePoolIngressRequest({...validPoolRequest, commandName: 'config'})).toThrow();
    expect(() => validatePoolIngressRequest({
      ...validPoolRequest,
      options: {query: {nested: true}},
    })).toThrow();
  });
});

describe('remote worker command execution', () => {
  it('executes an existing command against the requested guild and voice channel', async () => {
    const voiceChannel = {
      id: validPoolRequest.voiceChannelId,
      isThread: () => false,
      isVoiceBased: () => true,
    };
    const guild = {
      id: validPoolRequest.guildId,
      channels: {
        cache: new Map([[validPoolRequest.voiceChannelId, voiceChannel]]),
      },
    };
    const client = {
      guilds: {
        cache: new Map([[validPoolRequest.guildId, guild]]),
      },
    };
    const execute = vi.fn(async interaction => {
      expect(interaction.guild.id).toBe(validPoolRequest.guildId);
      expect(interaction.member.voice.channel.id).toBe(validPoolRequest.voiceChannelId);
      expect(interaction.options.getString('query')).toBe('test song');
      await interaction.reply('remote ok');
    });
    const commands = new Map([[
      'play',
      {
        requiresVC: true,
        execute,
      },
    ]]);

    const result = await executeRemoteCommand({
      request: validPoolRequest,
      client: client as never,
      commands: commands as never,
    });

    expect(result.response).toBe('remote ok');
    expect(execute).toHaveBeenCalledOnce();
  });
});
