-- AlterTable
ALTER TABLE "Setting" ADD COLUMN "statusChannelId" TEXT;
ALTER TABLE "Setting" ADD COLUMN "statusMentionRoleIds" TEXT NOT NULL DEFAULT '';
