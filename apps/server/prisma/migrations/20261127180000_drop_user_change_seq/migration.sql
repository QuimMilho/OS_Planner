-- Phase 17: the personal space's own counter (Space.changeSeq) is the only sync cursor; the copy kept on the user for clients
-- that synced with a single `since` cursor goes (every client syncs with per-space cursors since phase 3).
ALTER TABLE `User` DROP COLUMN `changeSeq`;
