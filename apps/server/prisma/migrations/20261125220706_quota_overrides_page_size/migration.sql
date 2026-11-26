-- AlterTable
ALTER TABLE `Page` ADD COLUMN `sizeBytes` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `QuotaOverride` (
    `id` CHAR(36) NOT NULL,
    `scope` VARCHAR(10) NOT NULL,
    `scopeId` CHAR(36) NOT NULL,
    `storageBytes` BIGINT NULL,
    `maxMembers` INTEGER NULL,
    `maxProjects` INTEGER NULL,
    `maxFileBytes` BIGINT NULL,
    `note` VARCHAR(500) NOT NULL DEFAULT '',
    `updatedBy` CHAR(36) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `QuotaOverride_scope_scopeId_key`(`scope`, `scopeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


-- Backfill: documents now count toward the quota, so usage becomes media bytes + document bytes.
-- MySQL's JSON text is slightly more spaced than JSON.stringify; the first save of a page corrects its size.
UPDATE `Page` SET `sizeBytes` = OCTET_LENGTH(CAST(`content` AS CHAR));

UPDATE `User` u SET u.`storageUsedBytes` =
    COALESCE((SELECT SUM(m.`size`) FROM `Media` m WHERE m.`userId` = u.`id`), 0) +
    COALESCE((SELECT SUM(p.`sizeBytes`) FROM `Page` p WHERE p.`userId` = u.`id`), 0);
