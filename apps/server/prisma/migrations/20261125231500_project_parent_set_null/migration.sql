-- MySQL stops a cascading delete at 15 levels, and projects may nest 16 deep: deleting a team must not walk the parent chain.
-- Purging deletes every project of the team (or the whole subtree) explicitly, so SET NULL is only a safety net.
-- DropForeignKey
ALTER TABLE `Project` DROP FOREIGN KEY `Project_parentId_fkey`;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
