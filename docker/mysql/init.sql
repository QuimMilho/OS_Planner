-- Development only. `prisma migrate dev` replays migrations in a shadow database that must
-- already exist, and the app user may manage every database whose name starts with "notes".
CREATE DATABASE IF NOT EXISTS `notes_shadow` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON `notes%`.* TO 'notes'@'%';
FLUSH PRIVILEGES;
