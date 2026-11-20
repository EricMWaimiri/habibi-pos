BEGIN;
SET LOCAL lock_timeout = '10s';
-- Nullable additions and relaxed input nullability only. No legacy backfill.
ALTER TABLE "stock_counts"
 ADD COLUMN "baselineAt" TIMESTAMP(3), ADD COLUMN "readyAt" TIMESTAMP(3),
 ADD COLUMN "expiresAt" TIMESTAMP(3), ADD COLUMN "submittedAt" TIMESTAMP(3),
 ADD COLUMN "submittedById" TEXT, ADD COLUMN "approvedById" TEXT,
 ADD COLUMN "stockApplied" BOOLEAN;
ALTER TABLE "products" ADD COLUMN "countSessionId" TEXT;
CREATE INDEX "products_countSessionId_idx" ON "products"("countSessionId");
ALTER TABLE "stock_count_items"
 ALTER COLUMN "countedQty" DROP NOT NULL,
 ALTER COLUMN "difference" DROP NOT NULL,
 ADD COLUMN "baselineMovementCount" INTEGER,
 ADD CONSTRAINT "stock_count_items_marker_check" CHECK ("baselineMovementCount" IS NULL OR "baselineMovementCount">=0);
ALTER TABLE "stock_movements" ADD COLUMN "stockCountItemId" TEXT;
CREATE UNIQUE INDEX "stock_movements_stockCountItemId_key" ON "stock_movements"("stockCountItemId");
CREATE TABLE "stock_count_events" (
 "id" TEXT PRIMARY KEY, "stockCountId" TEXT NOT NULL, "userId" TEXT,
 "action" TEXT NOT NULL, "details" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "stock_count_events_stockCountId_idx" ON "stock_count_events"("stockCountId");
ALTER TABLE "products" ADD CONSTRAINT "products_countSessionId_fkey" FOREIGN KEY ("countSessionId") REFERENCES "stock_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_counts"
 ADD CONSTRAINT "stock_counts_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 ADD CONSTRAINT "stock_counts_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stockCountItemId_fkey" FOREIGN KEY ("stockCountItemId") REFERENCES "stock_count_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_count_events"
 ADD CONSTRAINT "stock_count_events_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "stock_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 ADD CONSTRAINT "stock_count_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;
