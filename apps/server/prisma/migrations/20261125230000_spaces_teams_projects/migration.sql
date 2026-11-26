-- Spaces: every container of content (a person, a team, a project) owns a Space with its own sync cursor and storage counter.
-- This migration keeps all data: each user gets a personal space, and every notebook, category, page and media row is attached to it.

-- CreateTable
CREATE TABLE `Space` (
    `id` CHAR(36) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `userId` CHAR(36) NULL,
    `teamId` CHAR(36) NULL,
    `projectId` CHAR(36) NULL,
    `changeSeq` BIGINT NOT NULL DEFAULT 0,
    `storageUsedBytes` BIGINT NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Space_userId_key`(`userId`),
    UNIQUE INDEX `Space_teamId_key`(`teamId`),
    UNIQUE INDEX `Space_projectId_key`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Team` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `slug` VARCHAR(60) NOT NULL,
    `icon` VARCHAR(40) NULL,
    `color` VARCHAR(7) NULL,
    `description` VARCHAR(500) NOT NULL DEFAULT '',
    `ownerId` CHAR(36) NULL,
    `isPublic` BOOLEAN NOT NULL DEFAULT false,
    `joinPolicy` VARCHAR(10) NOT NULL DEFAULT 'request',
    `spaceId` CHAR(36) NOT NULL,
    `everyonePermissions` BIGINT UNSIGNED NOT NULL DEFAULT 545391488,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Team_slug_key`(`slug`),
    UNIQUE INDEX `Team_spaceId_key`(`spaceId`),
    INDEX `Team_ownerId_idx`(`ownerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TeamMember` (
    `teamId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `nickname` VARCHAR(80) NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TeamMember_userId_idx`(`userId`),
    PRIMARY KEY (`teamId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Project` (
    `id` CHAR(36) NOT NULL,
    `teamId` CHAR(36) NOT NULL,
    `parentId` CHAR(36) NULL,
    `name` VARCHAR(80) NOT NULL,
    `description` VARCHAR(500) NOT NULL DEFAULT '',
    `icon` VARCHAR(40) NULL,
    `color` VARCHAR(7) NULL,
    `position` VARCHAR(64) NOT NULL,
    `spaceId` CHAR(36) NOT NULL,
    `path` VARCHAR(1024) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Project_spaceId_key`(`spaceId`),
    INDEX `Project_teamId_idx`(`teamId`),
    INDEX `Project_parentId_idx`(`parentId`),
    INDEX `Project_path_idx`(`path`(191)),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectMember` (
    `projectId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProjectMember_userId_idx`(`userId`),
    PRIMARY KEY (`projectId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PendingOwner` (
    `id` CHAR(36) NOT NULL,
    `teamId` CHAR(36) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PendingOwner_email_idx`(`email`),
    UNIQUE INDEX `PendingOwner_teamId_email_key`(`teamId`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One personal space per user. The change counter and the storage usage move here from the user row.
INSERT INTO `Space` (`id`, `kind`, `userId`, `changeSeq`, `storageUsedBytes`, `createdAt`)
SELECT UUID(), 'personal', u.`id`, u.`changeSeq`, u.`storageUsedBytes`, CURRENT_TIMESTAMP(3) FROM `User` u;

-- Notebook: nullable first, filled from the owner personal space, then required
ALTER TABLE `Notebook` ADD COLUMN `spaceId` CHAR(36) NULL;
UPDATE `Notebook` t JOIN `Space` s ON s.`userId` = t.`userId` SET t.`spaceId` = s.`id`;
ALTER TABLE `Notebook` MODIFY `spaceId` CHAR(36) NOT NULL;

-- Category: nullable first, filled from the owner personal space, then required
ALTER TABLE `Category` ADD COLUMN `spaceId` CHAR(36) NULL;
UPDATE `Category` t JOIN `Space` s ON s.`userId` = t.`userId` SET t.`spaceId` = s.`id`;
ALTER TABLE `Category` MODIFY `spaceId` CHAR(36) NOT NULL;

-- Page: nullable first, filled from the owner personal space, then required
ALTER TABLE `Page` ADD COLUMN `spaceId` CHAR(36) NULL;
UPDATE `Page` t JOIN `Space` s ON s.`userId` = t.`userId` SET t.`spaceId` = s.`id`;
ALTER TABLE `Page` MODIFY `spaceId` CHAR(36) NOT NULL;

-- Media: nullable first, filled from the owner personal space, then required
ALTER TABLE `Media` ADD COLUMN `spaceId` CHAR(36) NULL;
UPDATE `Media` t JOIN `Space` s ON s.`userId` = t.`userId` SET t.`spaceId` = s.`id`;
ALTER TABLE `Media` MODIFY `spaceId` CHAR(36) NOT NULL;

-- CreateIndex
CREATE INDEX `Category_spaceId_seq_idx` ON `Category`(`spaceId`, `seq`);

-- CreateIndex
CREATE INDEX `Media_spaceId_idx` ON `Media`(`spaceId`);

-- CreateIndex
CREATE INDEX `Notebook_spaceId_seq_idx` ON `Notebook`(`spaceId`, `seq`);

-- CreateIndex
CREATE INDEX `Page_spaceId_seq_idx` ON `Page`(`spaceId`, `seq`);

-- AddForeignKey
ALTER TABLE `Notebook` ADD CONSTRAINT `Notebook_spaceId_fkey` FOREIGN KEY (`spaceId`) REFERENCES `Space`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Category` ADD CONSTRAINT `Category_spaceId_fkey` FOREIGN KEY (`spaceId`) REFERENCES `Space`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Page` ADD CONSTRAINT `Page_spaceId_fkey` FOREIGN KEY (`spaceId`) REFERENCES `Space`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Media` ADD CONSTRAINT `Media_spaceId_fkey` FOREIGN KEY (`spaceId`) REFERENCES `Space`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Space` ADD CONSTRAINT `Space_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Space` ADD CONSTRAINT `Space_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Space` ADD CONSTRAINT `Space_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Team` ADD CONSTRAINT `Team_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TeamMember` ADD CONSTRAINT `TeamMember_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TeamMember` ADD CONSTRAINT `TeamMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectMember` ADD CONSTRAINT `ProjectMember_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectMember` ADD CONSTRAINT `ProjectMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PendingOwner` ADD CONSTRAINT `PendingOwner_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- The counter now lives on the space (User.changeSeq stays and is mirrored for clients that sync with `since`).
ALTER TABLE `User` DROP COLUMN `storageUsedBytes`;
