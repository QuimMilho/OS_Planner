-- utf8mb4_unicode_ci gives every character outside the BMP the same weight, so 👍 and 😂 would count as one emoji and
-- collide in the primary key. Emoji are compared byte for byte.
ALTER TABLE `Reaction` MODIFY `emoji` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
