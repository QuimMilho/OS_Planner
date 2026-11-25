-- Themes: room for the longest new value ("darkblue"); existing values (system, light, dark) stay valid.
-- AlterTable
ALTER TABLE `User` MODIFY `theme` VARCHAR(16) NOT NULL DEFAULT 'system';
