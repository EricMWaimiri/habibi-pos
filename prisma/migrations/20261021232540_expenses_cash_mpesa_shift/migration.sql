-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
ADD COLUMN     "shiftId" TEXT;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
