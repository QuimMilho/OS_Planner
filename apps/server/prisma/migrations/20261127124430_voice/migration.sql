-- AlterTable
ALTER TABLE `Channel` ADD COLUMN `quality` VARCHAR(10) NULL,
    ADD COLUMN `userLimit` INTEGER NULL;

-- AlterTable
ALTER TABLE `QuotaOverride` ADD COLUMN `maxVoiceParticipants` INTEGER NULL;

-- CreateTable
CREATE TABLE `VoiceParticipant` (
    `channelId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `sid` VARCHAR(64) NOT NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `mutedByModerator` BOOLEAN NOT NULL DEFAULT false,
    `grants` INTEGER NOT NULL DEFAULT 0,
    `eventAt` BIGINT NOT NULL DEFAULT 0,

    INDEX `VoiceParticipant_userId_idx`(`userId`),
    PRIMARY KEY (`channelId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `VoiceParticipant` ADD CONSTRAINT `VoiceParticipant_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `Channel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VoiceParticipant` ADD CONSTRAINT `VoiceParticipant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
