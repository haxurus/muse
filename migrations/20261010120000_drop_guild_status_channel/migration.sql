-- The bot status channel is a single platform setting of the super console again;
-- the per-server columns added by 20261008120000_add_guild_status_channel are unused.
-- AlterTable
ALTER TABLE "Setting" DROP COLUMN "statusChannelId";
ALTER TABLE "Setting" DROP COLUMN "statusMentionRoleIds";
