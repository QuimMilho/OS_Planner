-- Phase 17: the inbox lists a person's notifications newest first, read and unread together; (userId, readAt, createdAt) cannot order that.
CREATE INDEX `Notification_userId_createdAt_idx` ON `Notification`(`userId`, `createdAt`);
