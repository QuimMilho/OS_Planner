-- CreateTable
CREATE TABLE `Event` (
    `id` CHAR(36) NOT NULL,
    `spaceId` CHAR(36) NOT NULL,
    `ownerId` CHAR(36) NULL,
    `kind` VARCHAR(8) NOT NULL DEFAULT 'meeting',
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NOT NULL,
    `location` VARCHAR(300) NULL,
    `videoUrl` VARCHAR(500) NULL,
    `linkedChannelId` CHAR(36) NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `allDay` BOOLEAN NOT NULL DEFAULT false,
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
    `rrule` VARCHAR(400) NULL,
    `rruleUntil` DATETIME(3) NULL,
    `visibility` VARCHAR(10) NOT NULL DEFAULT 'attendees',
    `sizeBytes` INTEGER NOT NULL DEFAULT 0,
    `seq` BIGINT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Event_spaceId_seq_idx`(`spaceId`, `seq`),
    INDEX `Event_spaceId_startAt_idx`(`spaceId`, `startAt`),
    INDEX `Event_ownerId_idx`(`ownerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EventException` (
    `id` CHAR(36) NOT NULL,
    `eventId` CHAR(36) NOT NULL,
    `originalStart` DATETIME(3) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `override` JSON NULL,

    UNIQUE INDEX `EventException_eventId_originalStart_key`(`eventId`, `originalStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EventAttendee` (
    `eventId` CHAR(36) NOT NULL,
    `kind` VARCHAR(4) NOT NULL,
    `subjectId` CHAR(36) NOT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'invited',
    `respondedAt` DATETIME(3) NULL,
    `addedBy` CHAR(36) NULL,
    `optional` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EventAttendee_kind_subjectId_idx`(`kind`, `subjectId`),
    PRIMARY KEY (`eventId`, `kind`, `subjectId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EventReminder` (
    `eventId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `minutes` JSON NOT NULL,

    PRIMARY KEY (`eventId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReminderDelivery` (
    `eventId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `occurrenceStart` DATETIME(3) NOT NULL,
    `minutesBefore` INTEGER NOT NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReminderDelivery_sentAt_idx`(`sentAt`),
    PRIMARY KEY (`eventId`, `userId`, `occurrenceStart`, `minutesBefore`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserCalendarSetting` (
    `userId` CHAR(36) NOT NULL,
    `defaultTz` VARCHAR(64) NOT NULL DEFAULT 'UTC',
    `weekStart` INTEGER NOT NULL DEFAULT 1,
    `defaultReminders` JSON NOT NULL,
    `hiddenSpaces` JSON NOT NULL,
    `openInvites` BOOLEAN NOT NULL DEFAULT false,
    `emailReminders` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Event` ADD CONSTRAINT `Event_spaceId_fkey` FOREIGN KEY (`spaceId`) REFERENCES `Space`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EventException` ADD CONSTRAINT `EventException_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EventAttendee` ADD CONSTRAINT `EventAttendee_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EventReminder` ADD CONSTRAINT `EventReminder_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReminderDelivery` ADD CONSTRAINT `ReminderDelivery_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserCalendarSetting` ADD CONSTRAINT `UserCalendarSetting_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
