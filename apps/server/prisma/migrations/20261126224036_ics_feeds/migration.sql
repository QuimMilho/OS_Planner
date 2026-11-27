-- AlterTable
ALTER TABLE `Event` ADD COLUMN `icsUid` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `CalendarFeed` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `tokenHint` VARCHAR(6) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `include` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `rotatedAt` DATETIME(3) NULL,
    `lastFetchedAt` DATETIME(3) NULL,
    `fetchCount` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `CalendarFeed_tokenHash_key`(`tokenHash`),
    INDEX `CalendarFeed_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExternalCalendar` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `url` TEXT NOT NULL,
    `color` VARCHAR(7) NOT NULL,
    `etag` VARCHAR(255) NULL,
    `lastModified` VARCHAR(64) NULL,
    `lastSyncAt` DATETIME(3) NULL,
    `lastError` VARCHAR(40) NULL,
    `failureCount` INTEGER NOT NULL DEFAULT 0,
    `failingSince` DATETIME(3) NULL,
    `nextSyncAt` DATETIME(3) NOT NULL,
    `syncEveryMinutes` INTEGER NOT NULL DEFAULT 60,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `disabledReason` VARCHAR(30) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ExternalCalendar_userId_idx`(`userId`),
    INDEX `ExternalCalendar_enabled_nextSyncAt_idx`(`enabled`, `nextSyncAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExternalEvent` (
    `id` CHAR(36) NOT NULL,
    `calendarId` CHAR(36) NOT NULL,
    `uid` VARCHAR(255) NOT NULL,
    `recurrenceId` VARCHAR(30) NOT NULL DEFAULT '',
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `allDay` BOOLEAN NOT NULL DEFAULT false,
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NOT NULL,
    `location` VARCHAR(300) NULL,
    `url` VARCHAR(500) NULL,
    `rrule` VARCHAR(400) NULL,
    `rruleUntil` DATETIME(3) NULL,
    `exdates` JSON NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'confirmed',
    `sequence` INTEGER NOT NULL DEFAULT 0,
    `sizeBytes` INTEGER NOT NULL DEFAULT 0,

    INDEX `ExternalEvent_calendarId_startAt_idx`(`calendarId`, `startAt`),
    UNIQUE INDEX `ExternalEvent_calendarId_uid_recurrenceId_key`(`calendarId`, `uid`, `recurrenceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Event_spaceId_icsUid_idx` ON `Event`(`spaceId`, `icsUid`);

-- AddForeignKey
ALTER TABLE `CalendarFeed` ADD CONSTRAINT `CalendarFeed_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExternalCalendar` ADD CONSTRAINT `ExternalCalendar_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExternalEvent` ADD CONSTRAINT `ExternalEvent_calendarId_fkey` FOREIGN KEY (`calendarId`) REFERENCES `ExternalCalendar`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
