-- AlterTable
ALTER TABLE `Channel` ADD COLUMN `redactPreviews` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Message` ADD COLUMN `mentions` JSON NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `quietHours` JSON NULL;

-- CreateTable
CREATE TABLE `NotificationSetting` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `scopeKind` VARCHAR(10) NOT NULL,
    `scopeId` VARCHAR(36) NOT NULL DEFAULT '',
    `level` VARCHAR(10) NOT NULL DEFAULT 'inherit',
    `suppressEveryone` BOOLEAN NULL,
    `suppressRoles` BOOLEAN NULL,
    `suppressDirect` BOOLEAN NULL,
    `mutedUntil` DATETIME(3) NULL,
    `email` VARCHAR(10) NOT NULL DEFAULT 'inherit',
    `emailOnlyWhenAway` BOOLEAN NULL,
    `push` BOOLEAN NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NotificationSetting_scopeKind_scopeId_idx`(`scopeKind`, `scopeId`),
    UNIQUE INDEX `NotificationSetting_userId_scopeKind_scopeId_key`(`userId`, `scopeKind`, `scopeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `actorId` CHAR(36) NULL,
    `spaceId` CHAR(36) NULL,
    `channelId` CHAR(36) NULL,
    `messageId` CHAR(36) NULL,
    `targetKind` VARCHAR(16) NULL,
    `targetId` CHAR(36) NULL,
    `summary` VARCHAR(300) NOT NULL,
    `redacted` BOOLEAN NOT NULL DEFAULT false,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Notification_userId_readAt_createdAt_idx`(`userId`, `readAt`, `createdAt`),
    INDEX `Notification_userId_channelId_readAt_idx`(`userId`, `channelId`, `readAt`),
    INDEX `Notification_messageId_idx`(`messageId`),
    INDEX `Notification_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PushSubscription` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `endpoint` TEXT NOT NULL,
    `endpointHash` CHAR(64) NOT NULL,
    `p256dh` VARCHAR(200) NOT NULL,
    `auth` VARCHAR(100) NOT NULL,
    `userAgent` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PushSubscription_endpointHash_key`(`endpointHash`),
    INDEX `PushSubscription_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailDigestState` (
    `userId` CHAR(36) NOT NULL,
    `scopeKind` VARCHAR(10) NOT NULL,
    `scopeId` CHAR(36) NOT NULL,
    `lastEmailedAt` DATETIME(3) NULL,
    `pendingCount` INTEGER NOT NULL DEFAULT 0,
    `pendingIds` JSON NULL,
    `pendingSince` DATETIME(3) NULL,

    INDEX `EmailDigestState_pendingCount_idx`(`pendingCount`),
    PRIMARY KEY (`userId`, `scopeKind`, `scopeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `NotificationSetting` ADD CONSTRAINT `NotificationSetting_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PushSubscription` ADD CONSTRAINT `PushSubscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailDigestState` ADD CONSTRAINT `EmailDigestState_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
