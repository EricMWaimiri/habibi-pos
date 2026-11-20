/*
  Warnings:

  - A unique constraint covering the columns `[expenseNumber]` on the table `expenses` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[purchaseNumber]` on the table `purchases` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `expenseNumber` to the `expenses` table without a default value. This is not possible if the table is not empty.
  - Added the required column `purchaseNumber` to the `purchases` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "expenseNumber" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "purchaseNumber" TEXT NOT NULL,
ALTER COLUMN "invoiceNumber" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "expenses_expenseNumber_key" ON "expenses"("expenseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_purchaseNumber_key" ON "purchases"("purchaseNumber");
