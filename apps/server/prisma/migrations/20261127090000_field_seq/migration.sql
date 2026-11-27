-- Offline merge (phase 15): the seq at which each merge field of an entity last changed. NULL = nothing changed since it was made.
-- AlterTable
ALTER TABLE `Notebook` ADD COLUMN `fieldSeq` JSON NULL;
ALTER TABLE `Category` ADD COLUMN `fieldSeq` JSON NULL;
ALTER TABLE `Page` ADD COLUMN `fieldSeq` JSON NULL;
ALTER TABLE `Task` ADD COLUMN `fieldSeq` JSON NULL;
ALTER TABLE `Event` ADD COLUMN `fieldSeq` JSON NULL;
