-- AlterTable
ALTER TABLE `Team` ADD COLUMN `allowPublicLinks` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `NotebookShare` (
    `id` CHAR(36) NOT NULL,
    `notebookId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `access` VARCHAR(5) NOT NULL,
    `linkId` CHAR(36) NULL,
    `createdBy` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `NotebookShare_userId_idx`(`userId`),
    INDEX `NotebookShare_linkId_idx`(`linkId`),
    UNIQUE INDEX `NotebookShare_notebookId_userId_key`(`notebookId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShareLink` (
    `id` CHAR(36) NOT NULL,
    `notebookId` CHAR(36) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `access` VARCHAR(5) NOT NULL,
    `passwordHash` VARCHAR(255) NULL,
    `showAuthors` BOOLEAN NOT NULL DEFAULT false,
    `expiresAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdBy` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUsedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ShareLink_tokenHash_key`(`tokenHash`),
    INDEX `ShareLink_notebookId_idx`(`notebookId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PendingShare` (
    `id` CHAR(36) NOT NULL,
    `notebookId` CHAR(36) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `access` VARCHAR(5) NOT NULL,
    `createdBy` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PendingShare_email_idx`(`email`),
    UNIQUE INDEX `PendingShare_notebookId_email_key`(`notebookId`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotebookMove` (
    `id` CHAR(36) NOT NULL,
    `spaceId` CHAR(36) NOT NULL,
    `notebookId` CHAR(36) NOT NULL,
    `seq` BIGINT NOT NULL,

    INDEX `NotebookMove_spaceId_seq_idx`(`spaceId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `NotebookShare` ADD CONSTRAINT `NotebookShare_notebookId_fkey` FOREIGN KEY (`notebookId`) REFERENCES `Notebook`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NotebookShare` ADD CONSTRAINT `NotebookShare_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NotebookShare` ADD CONSTRAINT `NotebookShare_linkId_fkey` FOREIGN KEY (`linkId`) REFERENCES `ShareLink`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShareLink` ADD CONSTRAINT `ShareLink_notebookId_fkey` FOREIGN KEY (`notebookId`) REFERENCES `Notebook`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PendingShare` ADD CONSTRAINT `PendingShare_notebookId_fkey` FOREIGN KEY (`notebookId`) REFERENCES `Notebook`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
