-- AlterTable
ALTER TABLE `Channel` MODIFY `spaceId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `Team` ADD COLUMN `allowMemberDMs` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `allowDMsFrom` VARCHAR(10) NOT NULL DEFAULT 'members';

-- CreateTable
CREATE TABLE `DirectConversation` (
    `id` CHAR(36) NOT NULL,
    `userA` CHAR(36) NULL,
    `userB` CHAR(36) NULL,
    `channelId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastMessageAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DirectConversation_channelId_key`(`channelId`),
    INDEX `DirectConversation_userB_idx`(`userB`),
    INDEX `DirectConversation_lastMessageAt_idx`(`lastMessageAt`),
    UNIQUE INDEX `DirectConversation_userA_userB_key`(`userA`, `userB`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DirectState` (
    `conversationId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `closedAt` DATETIME(3) NULL,

    INDEX `DirectState_userId_idx`(`userId`),
    PRIMARY KEY (`conversationId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserBlock` (
    `blockerId` CHAR(36) NOT NULL,
    `blockedId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `UserBlock_blockedId_idx`(`blockedId`),
    PRIMARY KEY (`blockerId`, `blockedId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DirectConversation` ADD CONSTRAINT `DirectConversation_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `Channel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DirectConversation` ADD CONSTRAINT `DirectConversation_userA_fkey` FOREIGN KEY (`userA`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DirectConversation` ADD CONSTRAINT `DirectConversation_userB_fkey` FOREIGN KEY (`userB`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DirectState` ADD CONSTRAINT `DirectState_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `DirectConversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DirectState` ADD CONSTRAINT `DirectState_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserBlock` ADD CONSTRAINT `UserBlock_blockerId_fkey` FOREIGN KEY (`blockerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserBlock` ADD CONSTRAINT `UserBlock_blockedId_fkey` FOREIGN KEY (`blockedId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
