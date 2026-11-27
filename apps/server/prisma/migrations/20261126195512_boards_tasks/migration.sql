-- CreateTable
CREATE TABLE `Board` (
    `id` CHAR(36) NOT NULL,
    `spaceId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `description` VARCHAR(2000) NOT NULL DEFAULT '',
    `icon` VARCHAR(40) NULL,
    `color` VARCHAR(7) NULL,
    `position` VARCHAR(64) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `seq` BIGINT NOT NULL,
    `createdBy` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Board_spaceId_seq_idx`(`spaceId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BoardColumn` (
    `id` CHAR(36) NOT NULL,
    `boardId` CHAR(36) NOT NULL,
    `spaceId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `position` VARCHAR(64) NOT NULL,
    `wipLimit` INTEGER NULL,
    `kind` VARCHAR(8) NOT NULL DEFAULT 'custom',
    `color` VARCHAR(7) NULL,
    `seq` BIGINT NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `BoardColumn_boardId_idx`(`boardId`),
    INDEX `BoardColumn_spaceId_seq_idx`(`spaceId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Task` (
    `id` CHAR(36) NOT NULL,
    `boardId` CHAR(36) NOT NULL,
    `columnId` CHAR(36) NOT NULL,
    `spaceId` CHAR(36) NOT NULL,
    `parentTaskId` CHAR(36) NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` JSON NULL,
    `position` VARCHAR(64) NOT NULL,
    `priority` VARCHAR(8) NOT NULL DEFAULT 'none',
    `startAt` DATETIME(3) NULL,
    `dueAt` DATETIME(3) NULL,
    `allDay` BOOLEAN NOT NULL DEFAULT false,
    `completedAt` DATETIME(3) NULL,
    `sizeBytes` INTEGER NOT NULL DEFAULT 0,
    `commentCount` INTEGER NOT NULL DEFAULT 0,
    `attachmentCount` INTEGER NOT NULL DEFAULT 0,
    `dueNotifiedAt` DATETIME(3) NULL,
    `createdBy` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `seq` BIGINT NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Task_boardId_columnId_idx`(`boardId`, `columnId`),
    INDEX `Task_spaceId_seq_idx`(`spaceId`, `seq`),
    INDEX `Task_parentTaskId_idx`(`parentTaskId`),
    INDEX `Task_dueAt_idx`(`dueAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskAssignee` (
    `taskId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `assignedBy` CHAR(36) NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskAssignee_userId_idx`(`userId`),
    PRIMARY KEY (`taskId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Label` (
    `id` CHAR(36) NOT NULL,
    `spaceId` CHAR(36) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `color` VARCHAR(7) NOT NULL,
    `description` VARCHAR(200) NOT NULL DEFAULT '',
    `inheritable` BOOLEAN NOT NULL DEFAULT true,
    `seq` BIGINT NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Label_spaceId_seq_idx`(`spaceId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskLabel` (
    `taskId` CHAR(36) NOT NULL,
    `labelId` CHAR(36) NOT NULL,

    INDEX `TaskLabel_labelId_idx`(`labelId`),
    PRIMARY KEY (`taskId`, `labelId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChecklistItem` (
    `id` CHAR(36) NOT NULL,
    `taskId` CHAR(36) NOT NULL,
    `text` VARCHAR(300) NOT NULL,
    `done` BOOLEAN NOT NULL DEFAULT false,
    `position` VARCHAR(64) NOT NULL,

    INDEX `ChecklistItem_taskId_idx`(`taskId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskComment` (
    `id` CHAR(36) NOT NULL,
    `taskId` CHAR(36) NOT NULL,
    `authorId` CHAR(36) NULL,
    `content` TEXT NOT NULL,
    `mentions` JSON NULL,
    `sizeBytes` INTEGER NOT NULL DEFAULT 0,
    `editedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskComment_taskId_createdAt_idx`(`taskId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskAttachment` (
    `id` CHAR(36) NOT NULL,
    `taskId` CHAR(36) NOT NULL,
    `mediaId` CHAR(36) NOT NULL,
    `uploadedBy` CHAR(36) NULL,
    `name` VARCHAR(200) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TaskAttachment_mediaId_key`(`mediaId`),
    INDEX `TaskAttachment_taskId_idx`(`taskId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskActivity` (
    `id` CHAR(36) NOT NULL,
    `taskId` CHAR(36) NOT NULL,
    `actorId` CHAR(36) NULL,
    `kind` VARCHAR(24) NOT NULL,
    `data` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskActivity_taskId_createdAt_idx`(`taskId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskMove` (
    `id` CHAR(36) NOT NULL,
    `spaceId` CHAR(36) NOT NULL,
    `taskId` CHAR(36) NOT NULL,
    `seq` BIGINT NOT NULL,

    INDEX `TaskMove_spaceId_seq_idx`(`spaceId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Board` ADD CONSTRAINT `Board_spaceId_fkey` FOREIGN KEY (`spaceId`) REFERENCES `Space`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BoardColumn` ADD CONSTRAINT `BoardColumn_boardId_fkey` FOREIGN KEY (`boardId`) REFERENCES `Board`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Task` ADD CONSTRAINT `Task_boardId_fkey` FOREIGN KEY (`boardId`) REFERENCES `Board`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Task` ADD CONSTRAINT `Task_parentTaskId_fkey` FOREIGN KEY (`parentTaskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskAssignee` ADD CONSTRAINT `TaskAssignee_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskAssignee` ADD CONSTRAINT `TaskAssignee_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Label` ADD CONSTRAINT `Label_spaceId_fkey` FOREIGN KEY (`spaceId`) REFERENCES `Space`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskLabel` ADD CONSTRAINT `TaskLabel_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskLabel` ADD CONSTRAINT `TaskLabel_labelId_fkey` FOREIGN KEY (`labelId`) REFERENCES `Label`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChecklistItem` ADD CONSTRAINT `ChecklistItem_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskComment` ADD CONSTRAINT `TaskComment_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskAttachment` ADD CONSTRAINT `TaskAttachment_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskAttachment` ADD CONSTRAINT `TaskAttachment_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `Media`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskActivity` ADD CONSTRAINT `TaskActivity_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
