/*
  Warnings:

  - You are about to drop the column `table` on the `sales` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "SaleStatus" ADD VALUE 'MERGED';

-- AlterTable
ALTER TABLE "sales" DROP COLUMN "table",
ADD COLUMN     "mergedIntoId" TEXT;
