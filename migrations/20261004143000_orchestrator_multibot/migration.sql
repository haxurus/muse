ALTER TABLE "Setting" ADD COLUMN "enableSponsorBlock" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ManagedGuild" (
    "guildId" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "maxConcurrentPlayers" INTEGER NOT NULL DEFAULT 5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "BotGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BotGroup_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "ManagedGuild" ("guildId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "GuildWorkerAssignment" (
    "guildId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "groupId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "preferredOrder" INTEGER NOT NULL DEFAULT 100,
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("guildId", "workerId"),
    CONSTRAINT "GuildWorkerAssignment_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "ManagedGuild" ("guildId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuildWorkerAssignment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BotGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BotGroup_guildId_name_key" ON "BotGroup"("guildId", "name");
CREATE INDEX "BotGroup_guildId_idx" ON "BotGroup"("guildId");
CREATE INDEX "GuildWorkerAssignment_groupId_idx" ON "GuildWorkerAssignment"("groupId");
