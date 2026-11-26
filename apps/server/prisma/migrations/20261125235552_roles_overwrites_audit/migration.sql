/*
  Roles, overwrites and the audit log (phase 4).

  `Team.everyonePermissions` becomes the "@everyone" row of `Role`: the data step below copies it for every team
  BEFORE the column is dropped (at the end of this file). Existing members get no extra roles; owners are unchanged.
*/

-- CreateTable
CREATE TABLE `Role` (
    `id` CHAR(36) NOT NULL,
    `teamId` CHAR(36) NOT NULL,
    `projectId` CHAR(36) NULL,
    `name` VARCHAR(40) NOT NULL,
    `color` VARCHAR(7) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `permissions` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `hoist` BOOLEAN NOT NULL DEFAULT false,
    `mentionable` BOOLEAN NOT NULL DEFAULT false,
    `isEveryone` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Role_teamId_projectId_idx`(`teamId`, `projectId`),
    INDEX `Role_projectId_idx`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MemberRole` (
    `userId` CHAR(36) NOT NULL,
    `roleId` CHAR(36) NOT NULL,

    INDEX `MemberRole_roleId_idx`(`roleId`),
    PRIMARY KEY (`userId`, `roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Overwrite` (
    `id` CHAR(36) NOT NULL,
    `targetKind` VARCHAR(10) NOT NULL,
    `targetId` CHAR(36) NOT NULL,
    `subjectKind` VARCHAR(10) NOT NULL,
    `subjectId` CHAR(36) NOT NULL,
    `allow` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `deny` BIGINT UNSIGNED NOT NULL DEFAULT 0,

    INDEX `Overwrite_targetKind_targetId_idx`(`targetKind`, `targetId`),
    INDEX `Overwrite_subjectKind_subjectId_idx`(`subjectKind`, `subjectId`),
    UNIQUE INDEX `Overwrite_targetKind_targetId_subjectKind_subjectId_key`(`targetKind`, `targetId`, `subjectKind`, `subjectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `teamId` CHAR(36) NOT NULL,
    `actorId` CHAR(36) NULL,
    `action` VARCHAR(40) NOT NULL,
    `targetKind` VARCHAR(20) NOT NULL,
    `targetId` VARCHAR(36) NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `reason` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_teamId_createdAt_idx`(`teamId`, `createdAt`),
    INDEX `AuditLog_teamId_id_idx`(`teamId`, `id`),
    INDEX `AuditLog_actorId_idx`(`actorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Role` ADD CONSTRAINT `Role_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Role` ADD CONSTRAINT `Role_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MemberRole` ADD CONSTRAINT `MemberRole_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MemberRole` ADD CONSTRAINT `MemberRole_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Data: every team gets its @everyone role carrying the permissions it had (one row per team, position 0).
INSERT INTO `Role` (`id`, `teamId`, `projectId`, `name`, `color`, `position`, `permissions`, `hoist`, `mentionable`, `isEveryone`)
SELECT UUID(), `id`, NULL, '@everyone', NULL, 0, `everyonePermissions`, false, false, true FROM `Team`;

-- AlterTable
ALTER TABLE `Team` DROP COLUMN `everyonePermissions`;
