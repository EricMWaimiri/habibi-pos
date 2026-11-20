/*
  Warnings:

  - You are about to alter the column `quantity` on the `products` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,3)`.
  - You are about to alter the column `systemQty` on the `stock_count_items` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,3)`.
  - You are about to alter the column `countedQty` on the `stock_count_items` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,3)`.
  - You are about to alter the column `difference` on the `stock_count_items` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,3)`.
  - You are about to alter the column `quantityChange` on the `stock_movements` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,3)`.
  - You are about to alter the column `previousQty` on the `stock_movements` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,3)`.
  - You are about to alter the column `quantityAfter` on the `stock_movements` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,3)`.

*/
-- AlterTable
ALTER TABLE "products" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(12,3);

-- AlterTable
ALTER TABLE "stock_count_items" ALTER COLUMN "systemQty" SET DATA TYPE DECIMAL(12,3),
ALTER COLUMN "countedQty" SET DATA TYPE DECIMAL(12,3),
ALTER COLUMN "difference" SET DATA TYPE DECIMAL(12,3);

-- AlterTable
ALTER TABLE "stock_movements" ALTER COLUMN "quantityChange" SET DATA TYPE DECIMAL(12,3),
ALTER COLUMN "previousQty" SET DATA TYPE DECIMAL(12,3),
ALTER COLUMN "quantityAfter" SET DATA TYPE DECIMAL(12,3);
