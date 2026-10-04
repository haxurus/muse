import {prisma} from '../utils/db.js';
import {
  GuildSettingsPatch,
  normalizeSettingsPatch,
  parseStoredSettingsPatch,
  resolveEffectiveSettings,
  updateStoredSettingsPatch,
} from '../control/settings.js';
import {WorkerDefinition} from './config.js';
import {
  disconnectWorkerFromGuild,
  getWorkerStatus,
  putWorkerGuildSettings,
} from './worker-client.js';

const parseJsonPatch = (value: string) => parseStoredSettingsPatch(value);
const stringifyPatch = (value: GuildSettingsPatch) => JSON.stringify(value);

const normalizeGroupName = (name: unknown) => {
  if (typeof name !== 'string') {
    throw new Error('group name must be a string');
  }

  const normalized = name.trim();
  if (normalized.length < 1 || normalized.length > 64) {
    throw new Error('group name must contain between 1 and 64 characters');
  }

  return normalized;
};

const ensureGuild = async (guildId: string, name: string | null, workers: WorkerDefinition[]) => {
  await prisma.managedGuild.upsert({
    where: {guildId},
    create: {guildId, name},
    update: name ? {name} : {},
  });

  await Promise.all(workers.map(async (worker, index) => {
    await prisma.guildWorkerAssignment.upsert({
      where: {guildId_workerId: {guildId, workerId: worker.id}},
      create: {
        guildId,
        workerId: worker.id,
        preferredOrder: index + 1,
      },
      update: {},
    });
  }));
};

export const getGuildControlState = async (
  guildId: string,
  name: string | null,
  workers: WorkerDefinition[],
) => {
  await ensureGuild(guildId, name, workers);

  const guild = await prisma.managedGuild.findUniqueOrThrow({
    where: {guildId},
    include: {
      groups: true,
      assignments: true,
    },
  });

  const groupById = new Map(guild.groups.map(group => [group.id, group]));
  const guildPatch = parseJsonPatch(guild.configJson);

  return {
    guild: {
      guildId: guild.guildId,
      name: guild.name,
      maxConcurrentPlayers: guild.maxConcurrentPlayers,
      settings: guildPatch,
    },
    groups: guild.groups.map(group => ({
      id: group.id,
      name: group.name,
      settings: parseJsonPatch(group.configJson),
    })),
    workers: workers.map(worker => {
      const assignment = guild.assignments.find(candidate => candidate.workerId === worker.id)!;
      const group = assignment.groupId ? groupById.get(assignment.groupId) : undefined;
      const override = parseJsonPatch(assignment.configJson);

      return {
        id: worker.id,
        label: worker.label,
        enabled: assignment.enabled,
        groupId: assignment.groupId,
        preferredOrder: assignment.preferredOrder,
        settings: override,
        effectiveSettings: resolveEffectiveSettings(
          guildPatch,
          group ? parseJsonPatch(group.configJson) : {},
          override,
        ),
      };
    }),
  };
};

export const patchGuildControl = async ({
  guildId,
  settings,
  maxConcurrentPlayers,
  workerCount,
}: {
  guildId: string;
  settings?: unknown;
  maxConcurrentPlayers?: unknown;
  workerCount: number;
}) => {
  const guild = await prisma.managedGuild.findUniqueOrThrow({where: {guildId}});
  const data: {configJson?: string; maxConcurrentPlayers?: number} = {};

  if (typeof settings !== 'undefined') {
    const patch = normalizeSettingsPatch(settings);
    data.configJson = stringifyPatch(updateStoredSettingsPatch(parseJsonPatch(guild.configJson), patch));
  }

  if (typeof maxConcurrentPlayers !== 'undefined') {
    if (typeof maxConcurrentPlayers !== 'number'
      || !Number.isInteger(maxConcurrentPlayers)
      || maxConcurrentPlayers < 1
      || maxConcurrentPlayers > workerCount) {
      throw new Error(`maxConcurrentPlayers must be between 1 and ${workerCount}`);
    }

    data.maxConcurrentPlayers = maxConcurrentPlayers;
  }

  return prisma.managedGuild.update({where: {guildId}, data});
};

export const createGroup = async (guildId: string, name: unknown, settings: unknown) => {
  const normalizedName = normalizeGroupName(name);
  const patch = typeof settings === 'undefined' ? {} : normalizeSettingsPatch(settings);

  return prisma.botGroup.create({
    data: {
      guildId,
      name: normalizedName,
      configJson: stringifyPatch(updateStoredSettingsPatch({}, patch)),
    },
  });
};

export const patchGroup = async (
  guildId: string,
  groupId: string,
  input: {name?: unknown; settings?: unknown},
) => {
  const group = await prisma.botGroup.findFirst({where: {id: groupId, guildId}});
  if (!group) {
    throw new Error('group not found');
  }

  const data: {name?: string; configJson?: string} = {};
  if (typeof input.name !== 'undefined') {
    data.name = normalizeGroupName(input.name);
  }

  if (typeof input.settings !== 'undefined') {
    const patch = normalizeSettingsPatch(input.settings);
    data.configJson = stringifyPatch(updateStoredSettingsPatch(parseJsonPatch(group.configJson), patch));
  }

  return prisma.botGroup.update({where: {id: groupId}, data});
};

export const removeGroup = async (guildId: string, groupId: string) => {
  const group = await prisma.botGroup.findFirst({where: {id: groupId, guildId}});
  if (!group) {
    throw new Error('group not found');
  }

  await prisma.botGroup.delete({where: {id: groupId}});
};

export const patchWorkerAssignment = async ({
  guildId,
  workerId,
  workerIds,
  input,
}: {
  guildId: string;
  workerId: string;
  workerIds: Set<string>;
  input: {
    enabled?: unknown;
    preferredOrder?: unknown;
    groupId?: unknown;
    settings?: unknown;
  };
}) => {
  if (!workerIds.has(workerId)) {
    throw new Error('unknown worker');
  }

  const current = await prisma.guildWorkerAssignment.findUniqueOrThrow({
    where: {guildId_workerId: {guildId, workerId}},
  });

  const data: {
    enabled?: boolean;
    preferredOrder?: number;
    groupId?: string | null;
    configJson?: string;
  } = {};

  if (typeof input.enabled !== 'undefined') {
    if (typeof input.enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }

    data.enabled = input.enabled;
  }

  if (typeof input.preferredOrder !== 'undefined') {
    if (typeof input.preferredOrder !== 'number'
      || !Number.isInteger(input.preferredOrder)
      || input.preferredOrder < 1
      || input.preferredOrder > 1000) {
      throw new Error('preferredOrder must be an integer between 1 and 1000');
    }

    data.preferredOrder = input.preferredOrder;
  }

  if (typeof input.groupId !== 'undefined') {
    if (input.groupId !== null && typeof input.groupId !== 'string') {
      throw new Error('groupId must be a string or null');
    }

    if (typeof input.groupId === 'string') {
      const group = await prisma.botGroup.findFirst({where: {id: input.groupId, guildId}});
      if (!group) {
        throw new Error('group not found');
      }
    }

    data.groupId = input.groupId;
  }

  if (typeof input.settings !== 'undefined') {
    const patch = normalizeSettingsPatch(input.settings);
    data.configJson = stringifyPatch(updateStoredSettingsPatch(parseJsonPatch(current.configJson), patch));
  }

  return prisma.guildWorkerAssignment.update({
    where: {guildId_workerId: {guildId, workerId}},
    data,
  });
};

export const patchWorkersBulk = async ({
  guildId,
  workerIds,
  knownWorkerIds,
  input,
}: {
  guildId: string;
  workerIds: unknown;
  knownWorkerIds: Set<string>;
  input: {
    enabled?: unknown;
    preferredOrder?: unknown;
    groupId?: unknown;
    settings?: unknown;
  };
}) => {
  if (!Array.isArray(workerIds) || workerIds.length === 0) {
    throw new Error('workerIds must be a non-empty array');
  }

  const uniqueIds = [...new Set(workerIds)];
  if (uniqueIds.some(workerId => typeof workerId !== 'string' || !knownWorkerIds.has(workerId))) {
    throw new Error('workerIds contains an unknown worker');
  }

  const typedIds = uniqueIds.filter((workerId): workerId is string => typeof workerId === 'string');
  await Promise.all(typedIds.map(async workerId => patchWorkerAssignment({
    guildId,
    workerId,
    workerIds: knownWorkerIds,
    input,
  })));
};

export const reconcileGuild = async (
  guildId: string,
  guildName: string | null,
  workers: WorkerDefinition[],
) => {
  const state = await getGuildControlState(guildId, guildName, workers);

  const results = await Promise.all(state.workers.map(async workerState => {
    const worker = workers.find(candidate => candidate.id === workerState.id)!;

    try {
      await putWorkerGuildSettings(
        worker,
        guildId,
        workerState.effectiveSettings,
        workerState.enabled,
      );

      if (!workerState.enabled) {
        await disconnectWorkerFromGuild(worker, guildId);
      }

      return {workerId: worker.id, ok: true as const};
    } catch (error: unknown) {
      return {
        workerId: worker.id,
        ok: false as const,
        error: error instanceof Error ? error.message.slice(0, 300) : 'worker request failed',
      };
    }
  }));

  return results;
};

export const getPoolSnapshot = async (
  guildId: string,
  guildName: string | null,
  workers: WorkerDefinition[],
) => {
  const state = await getGuildControlState(guildId, guildName, workers);
  const statuses = await Promise.all(workers.map(async worker => {
    try {
      return {workerId: worker.id, status: await getWorkerStatus(worker), error: null};
    } catch (error: unknown) {
      return {
        workerId: worker.id,
        status: null,
        error: error instanceof Error ? error.message.slice(0, 300) : 'worker unavailable',
      };
    }
  }));

  return {
    maxConcurrentPlayers: state.guild.maxConcurrentPlayers,
    workers: state.workers.map(worker => {
      const live = statuses.find(candidate => candidate.workerId === worker.id)!;
      const player = live.status?.players.find(candidate => candidate.guildId === guildId) ?? null;
      const membership = live.status?.guilds.find(candidate => candidate.guildId === guildId) ?? null;

      return {
        ...worker,
        online: live.status?.discordReady ?? false,
        inGuild: Boolean(membership),
        player,
        error: live.error,
      };
    }),
  };
};

export const selectAvailableWorker = async ({
  guildId,
  guildName,
  workers,
  groupId,
  voiceChannelId,
}: {
  guildId: string;
  guildName: string | null;
  workers: WorkerDefinition[];
  groupId?: string | null;
  voiceChannelId?: string | null;
}) => {
  const pool = await getPoolSnapshot(guildId, guildName, workers);
  const active = pool.workers.filter(worker => worker.player?.voiceChannelId).length;

  const sameChannel = voiceChannelId
    ? pool.workers.find(worker => worker.enabled && worker.player?.voiceChannelId === voiceChannelId)
    : undefined;
  if (sameChannel) {
    return sameChannel;
  }

  if (active >= pool.maxConcurrentPlayers) {
    return null;
  }

  return pool.workers
    .filter(worker => worker.enabled
      && worker.online
      && worker.inGuild
      && !worker.player?.voiceChannelId
      && (typeof groupId === 'undefined' || groupId === null || worker.groupId === groupId))
    .sort((a, b) => a.preferredOrder - b.preferredOrder)[0] ?? null;
};

export const reconcileAllGuilds = async (workers: WorkerDefinition[]) => {
  const guilds = await prisma.managedGuild.findMany();
  await Promise.all(guilds.map(async guild => reconcileGuild(guild.guildId, guild.name, workers)));
};
