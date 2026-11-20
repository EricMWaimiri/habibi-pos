BEGIN;
SET LOCAL lock_timeout = '10s';
-- Additive only. No legacy inference, data rewrite, deletion or default.
ALTER TABLE "sale_items"
  ADD COLUMN "stockDeductionCount" INTEGER,
  ADD COLUMN "removedAt" TIMESTAMP(3),
  ADD CONSTRAINT "sale_items_stockDeductionCount_check"
    CHECK ("stockDeductionCount" IS NULL OR "stockDeductionCount" >= 0);
ALTER TABLE "stock_movements"
  ADD COLUMN "saleItemId" TEXT,
  ADD COLUMN "reversalOfId" TEXT;
CREATE INDEX "stock_movements_saleItemId_idx" ON "stock_movements"("saleItemId");
CREATE UNIQUE INDEX "stock_movements_reversalOfId_key" ON "stock_movements"("reversalOfId");
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_saleItemId_fkey" FOREIGN KEY ("saleItemId")
    REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_movements_reversalOfId_fkey" FOREIGN KEY ("reversalOfId")
    REFERENCES "stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_movements_reversal_not_self" CHECK ("reversalOfId" IS NULL OR "reversalOfId" <> "id");
COMMIT;
