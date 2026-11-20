-- Additive provenance for NEW purchases; no historical inference/backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- Duplicate historical references require review, never deletion/renumbering.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM purchases WHERE "invoiceNumber" IS NOT NULL AND btrim("invoiceNumber")<>'' GROUP BY lower(btrim("supplierName")),lower(btrim("invoiceNumber")) HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Duplicate supplier invoice references require manual review before migration';
 END IF;
END $$;
ALTER TABLE purchases ADD COLUMN "clientKey" text, ADD COLUMN "requestHash" text, ADD COLUMN "invoiceDate" date, ADD COLUMN "shiftId" text, ADD COLUMN "expenseId" text;
ALTER TABLE stock_movements ADD COLUMN "purchaseItemId" text;
CREATE UNIQUE INDEX purchases_supplier_invoice_unique ON purchases(lower(btrim("supplierName")),lower(btrim("invoiceNumber"))) WHERE "invoiceNumber" IS NOT NULL AND btrim("invoiceNumber")<>'';
CREATE UNIQUE INDEX "purchases_clientKey_key" ON purchases("clientKey");
CREATE UNIQUE INDEX "purchases_expenseId_key" ON purchases("expenseId");
CREATE UNIQUE INDEX "stock_movements_purchaseItemId_key" ON stock_movements("purchaseItemId");
CREATE INDEX "purchases_invoiceDate_idx" ON purchases("invoiceDate");
CREATE INDEX "purchases_shiftId_createdAt_idx" ON purchases("shiftId","createdAt");
ALTER TABLE purchases ADD CONSTRAINT "purchases_shiftId_fkey" FOREIGN KEY("shiftId") REFERENCES shifts(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE purchases ADD CONSTRAINT "purchases_expenseId_fkey" FOREIGN KEY("expenseId") REFERENCES expenses(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE stock_movements ADD CONSTRAINT "stock_movements_purchaseItemId_fkey" FOREIGN KEY("purchaseItemId") REFERENCES purchase_items(id) ON DELETE RESTRICT ON UPDATE CASCADE;
COMMIT;
