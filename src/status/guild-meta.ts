import {ChannelType, type Guild, type GuildBasedChannel, type NewsChannel, type TextChannel} from 'discord.js';
import {HttpError} from '../control/http.js';
import type {GuildSettingsPatch} from '../control/settings-validation.js';
import type {GuildMetaChannel, GuildMetaRole} from '../control/types.js';
import {STATUS_CHANNEL_PERMISSIONS} from './announce.js';

type StatusChannel = TextChannel | NewsChannel;

/** Only standard text and announcement channels can receive the status message. */
export const isStatusChannel = (channel: GuildBasedChannel): channel is StatusChannel =>
  channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;

const parentPosition = (channel: StatusChannel): number => channel.parent?.rawPosition ?? -1;

/** Discord sidebar order: channels without a category first, then by category, then by channel position. */
const compareChannels = (left: StatusChannel, right: StatusChannel): number =>
  parentPosition(left) - parentPosition(right)
  || (left.parentId ?? '').localeCompare(right.parentId ?? '')
  || left.rawPosition - right.rawPosition
  || left.id.localeCompare(right.id);

/**
 * Guild-membership checks of the status settings, done by the worker before saving (the shape was
 * already validated by `sanitizeGuildSettingsPatch`): the channel must be a text or announcement
 * channel of this guild; every role must be a role of this guild, neither @everyone nor managed.
 */
export const assertStatusSettingsForGuild = (guild: Guild, patch: GuildSettingsPatch): void => {
  const {statusChannelId, statusMentionRoleIds} = patch;
  if (typeof statusChannelId === 'string') {
    const channel = guild.channels.cache.get(statusChannelId);
    if (!channel || !isStatusChannel(channel)) {
      throw new HttpError(400, 'statusChannelId must be a text or announcement channel of this server', 'INVALID_STATUS_CHANNEL');
    }
  }

  for (const roleId of statusMentionRoleIds ?? []) {
    const role = guild.roles.cache.get(roleId);
    if (!role || role.id === guild.id || role.managed) {
      throw new HttpError(400, 'statusMentionRoleIds must be roles of this server (not @everyone, not managed roles)', 'INVALID_STATUS_ROLES');
    }
  }
};

/** Channels and roles the dashboard pickers offer for this guild, seen by this bot. */
export const buildGuildMeta = (guild: Guild): {channels: GuildMetaChannel[]; roles: GuildMetaRole[]} => {
  const {me} = guild.members;
  const channels = [...guild.channels.cache.values()]
    .filter(isStatusChannel)
    .sort(compareChannels)
    .map((channel): GuildMetaChannel => ({
      id: channel.id,
      name: channel.name,
      type: channel.type === ChannelType.GuildAnnouncement ? 'announcement' : 'text',
      parentName: channel.parent?.name ?? null,
      position: channel.rawPosition,
      canPost: me ? channel.permissionsFor(me).has(STATUS_CHANNEL_PERMISSIONS) : false,
    }));

  const roles = [...guild.roles.cache.values()]
    .filter(role => role.id !== guild.id && !role.managed)
    .sort((left, right) => right.position - left.position || left.id.localeCompare(right.id))
    .map((role): GuildMetaRole => ({
      id: role.id,
      name: role.name,
      color: role.color,
      mentionable: role.mentionable,
      position: role.position,
    }));

  return {channels, roles};
};
