/*
  Warnings:

  - You are about to drop the column `posterKey` on the `Media` table. All the data in the column will be lost.
  - You are about to drop the column `posterMime` on the `Media` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `Media` DROP COLUMN `posterKey`,
    DROP COLUMN `posterMime`;
