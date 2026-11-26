/*
  Joining teams (phase 5): invites (by email and by link), people who registered with an invite, join requests, bans, and
  the directory listing of a team (blurb and tags). Nothing existing changes; forward-only.
*/

-- AlterTable
ALTER TABLE `Team` ADD COLUMN `listingBlurb` VARCHAR(200) NOT NULL DEFAULT '',
    ADD COLUMN `listingTags` JSON NULL;

-- CreateTable
CREATE TABLE `Invite` (
    `id` CHAR(36) NOT NULL,
    `teamId` CHAR(36) NOT NULL,
    `projectId` CHAR(36) NULL,
    `kind` VARCHAR(5) NOT NULL,
    `email` VARCHAR(254) NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `roleIds` JSON NOT NULL,
    `invitedBy` CHAR(36) NULL,
    `maxUses` INTEGER NULL,
    `uses` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acceptedBy` CHAR(36) NULL,
    `acceptedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Invite_tokenHash_key`(`tokenHash`),
    INDEX `Invite_teamId_createdAt_idx`(`teamId`, `createdAt`),
    INDEX `Invite_invitedBy_idx`(`invitedBy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PendingInvite` (
    `userId` CHAR(36) NOT NULL,
    `inviteId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PendingInvite_inviteId_idx`(`inviteId`),
    PRIMARY KEY (`userId`, `inviteId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JoinRequest` (
    `id` CHAR(36) NOT NULL,
    `teamId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `message` VARCHAR(500) NOT NULL DEFAULT '',
    `status` VARCHAR(10) NOT NULL DEFAULT 'pending',
    `pending` INTEGER NULL DEFAULT 1,
    `decidedBy` CHAR(36) NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JoinRequest_teamId_status_idx`(`teamId`, `status`),
    INDEX `JoinRequest_userId_idx`(`userId`),
    UNIQUE INDEX `JoinRequest_teamId_userId_pending_key`(`teamId`, `userId`, `pending`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Ban` (
    `teamId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `reason` VARCHAR(500) NOT NULL DEFAULT '',
    `bannedBy` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Ban_userId_idx`(`userId`),
    PRIMARY KEY (`teamId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Invite` ADD CONSTRAINT `Invite_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Invite` ADD CONSTRAINT `Invite_invitedBy_fkey` FOREIGN KEY (`invitedBy`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PendingInvite` ADD CONSTRAINT `PendingInvite_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PendingInvite` ADD CONSTRAINT `PendingInvite_inviteId_fkey` FOREIGN KEY (`inviteId`) REFERENCES `Invite`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JoinRequest` ADD CONSTRAINT `JoinRequest_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JoinRequest` ADD CONSTRAINT `JoinRequest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Ban` ADD CONSTRAINT `Ban_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Ban` ADD CONSTRAINT `Ban_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
