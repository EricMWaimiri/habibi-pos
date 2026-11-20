-- Nullable provenance and staff-audit additions; no historical backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE sales ADD COLUMN "splitFromId" text, ADD COLUMN "splitRequestId" uuid, ADD COLUMN "commissionCapSnapshot" numeric(12,2);
ALTER TABLE sales ADD CONSTRAINT "sales_splitFromId_fkey" FOREIGN KEY ("splitFromId") REFERENCES sales(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE sales ADD CONSTRAINT "sales_commissionCapSnapshot_check" CHECK("commissionCapSnapshot" IS NULL OR "commissionCapSnapshot">=0);
CREATE UNIQUE INDEX "sales_splitRequestId_key" ON sales("splitRequestId");
ALTER TABLE sale_items ADD COLUMN "stockOriginSaleId" text;
ALTER TABLE sale_items ADD CONSTRAINT "sale_items_stockOriginSaleId_fkey" FOREIGN KEY ("stockOriginSaleId") REFERENCES sales(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE administration_events ADD COLUMN "targetUserId" text;
ALTER TABLE administration_events ADD CONSTRAINT "administration_events_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE;
-- Widen the existing scope CHECK atomically; all existing events remain valid.
ALTER TABLE administration_events DROP CONSTRAINT administration_events_scope;
ALTER TABLE administration_events ADD CONSTRAINT administration_events_scope CHECK(scope IN ('SETTINGS','PERMISSIONS','USERS'));
CREATE INDEX "administration_events_targetUserId_createdAt_idx" ON administration_events("targetUserId","createdAt");
CREATE FUNCTION protect_stock_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."stockOriginSaleId" IS NOT NULL AND NEW."stockOriginSaleId" IS DISTINCT FROM OLD."stockOriginSaleId" THEN RAISE EXCEPTION 'Original stock provenance is immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sale_items_stock_origin_immutable BEFORE UPDATE ON sale_items FOR EACH ROW EXECUTE FUNCTION protect_stock_origin();
COMMIT;
