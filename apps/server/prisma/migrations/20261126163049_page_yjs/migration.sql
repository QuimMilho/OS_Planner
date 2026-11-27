-- CreateTable
CREATE TABLE `PageYDoc` (
    `pageId` CHAR(36) NOT NULL,
    `state` LONGBLOB NOT NULL,
    `stateVector` BLOB NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`pageId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PageYSnapshot` (
    `id` CHAR(36) NOT NULL,
    `pageId` CHAR(36) NOT NULL,
    `state` LONGBLOB NOT NULL,
    `byUserId` CHAR(36) NULL,
    `reason` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PageYSnapshot_pageId_createdAt_idx`(`pageId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PageYDoc` ADD CONSTRAINT `PageYDoc_pageId_fkey` FOREIGN KEY (`pageId`) REFERENCES `Page`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PageYSnapshot` ADD CONSTRAINT `PageYSnapshot_pageId_fkey` FOREIGN KEY (`pageId`) REFERENCES `Page`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
