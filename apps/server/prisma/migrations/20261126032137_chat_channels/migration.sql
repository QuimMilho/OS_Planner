-- CreateTable
CREATE TABLE `Channel` (
    `id` CHAR(36) NOT NULL,
    `spaceId` CHAR(36) NOT NULL,
    `parentId` CHAR(36) NULL,
    `kind` VARCHAR(10) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `topic` VARCHAR(500) NOT NULL DEFAULT '',
    `position` VARCHAR(64) NOT NULL,
    `nsfw` BOOLEAN NOT NULL DEFAULT false,
    `slowmodeSeconds` INTEGER NOT NULL DEFAULT 0,
    `archivedAt` DATETIME(3) NULL,
    `lastSeq` BIGINT NOT NULL DEFAULT 0,
    `createdBy` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Channel_spaceId_idx`(`spaceId`),
    INDEX `Channel_parentId_idx`(`parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Message` (
    `id` CHAR(36) NOT NULL,
    `channelId` CHAR(36) NOT NULL,
    `threadId` CHAR(36) NULL,
    `authorId` CHAR(36) NULL,
    `content` TEXT NOT NULL,
    `sizeBytes` INTEGER NOT NULL DEFAULT 0,
    `replyToId` CHAR(36) NULL,
    `editedAt` DATETIME(3) NULL,
    `deletedAt` DATETIME(3) NULL,
    `pinnedAt` DATETIME(3) NULL,
    `pinnedBy` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `seq` BIGINT NOT NULL,

    INDEX `Message_channelId_id_idx`(`channelId`, `id`),
    INDEX `Message_channelId_seq_idx`(`channelId`, `seq`),
    INDEX `Message_threadId_id_idx`(`threadId`, `id`),
    INDEX `Message_authorId_idx`(`authorId`),
    FULLTEXT INDEX `Message_content_idx`(`content`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Attachment` (
    `id` CHAR(36) NOT NULL,
    `channelId` CHAR(36) NOT NULL,
    `messageId` CHAR(36) NULL,
    `mediaId` CHAR(36) NOT NULL,
    `uploadedBy` CHAR(36) NULL,
    `name` VARCHAR(200) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Attachment_mediaId_key`(`mediaId`),
    INDEX `Attachment_messageId_idx`(`messageId`),
    INDEX `Attachment_channelId_idx`(`channelId`),
    INDEX `Attachment_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Reaction` (
    `messageId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `emoji` VARCHAR(32) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Reaction_userId_idx`(`userId`),
    PRIMARY KEY (`messageId`, `userId`, `emoji`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Thread` (
    `id` CHAR(36) NOT NULL,
    `channelId` CHAR(36) NOT NULL,
    `rootMessageId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdBy` CHAR(36) NULL,
    `lastMessageAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Thread_rootMessageId_key`(`rootMessageId`),
    INDEX `Thread_channelId_idx`(`channelId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChannelRead` (
    `userId` CHAR(36) NOT NULL,
    `channelId` CHAR(36) NOT NULL,
    `lastReadMessageId` CHAR(36) NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ChannelRead_channelId_idx`(`channelId`),
    PRIMARY KEY (`userId`, `channelId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Channel` ADD CONSTRAINT `Channel_spaceId_fkey` FOREIGN KEY (`spaceId`) REFERENCES `Space`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Channel` ADD CONSTRAINT `Channel_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Channel`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `Channel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Attachment` ADD CONSTRAINT `Attachment_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Attachment` ADD CONSTRAINT `Attachment_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `Media`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Reaction` ADD CONSTRAINT `Reaction_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Reaction` ADD CONSTRAINT `Reaction_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Thread` ADD CONSTRAINT `Thread_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `Channel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChannelRead` ADD CONSTRAINT `ChannelRead_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChannelRead` ADD CONSTRAINT `ChannelRead_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `Channel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
