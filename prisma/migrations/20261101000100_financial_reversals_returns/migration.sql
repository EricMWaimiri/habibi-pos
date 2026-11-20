-- Additive, portable Phase 5 ledger. No historical financial/account backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- AlterTable
ALTER TABLE "products" ADD COLUMN     "returnsAllowed" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "returnEligible" BOOLEAN;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "returnPortionId" TEXT;

-- CreateTable
CREATE TABLE "financial_requests" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "paymentId" TEXT,
    "saleItemId" TEXT,
    "quantity" DECIMAL(12,6),
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "financial_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_adjustments" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "saleId" TEXT NOT NULL,
    "paymentId" TEXT,
    "settlementPaymentId" TEXT,
    "saleItemId" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" DECIMAL(12,6),
    "salesDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "collectionDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "costDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "commissionDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shiftId" TEXT,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustment_cash_entries" (
    "id" TEXT NOT NULL,
    "adjustmentId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "externalReference" TEXT,
    "manualExternal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "adjustment_cash_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_return_portions" (
    "id" TEXT NOT NULL,
    "adjustmentId" TEXT NOT NULL,
    "originalMovementId" TEXT NOT NULL,
    "quantity" DECIMAL(12,6) NOT NULL,

    CONSTRAINT "stock_return_portions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financial_requests_status_createdAt_idx" ON "financial_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "financial_requests_saleId_idx" ON "financial_requests"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "financial_adjustments_requestId_key" ON "financial_adjustments"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "financial_adjustments_paymentId_key" ON "financial_adjustments"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "financial_adjustments_settlementPaymentId_key" ON "financial_adjustments"("settlementPaymentId");

-- CreateIndex
CREATE INDEX "financial_adjustments_saleId_createdAt_idx" ON "financial_adjustments"("saleId", "createdAt");

-- CreateIndex
CREATE INDEX "financial_adjustments_shiftId_createdAt_idx" ON "financial_adjustments"("shiftId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "adjustment_cash_entries_adjustmentId_method_key" ON "adjustment_cash_entries"("adjustmentId", "method");

-- CreateIndex
CREATE INDEX "stock_return_portions_originalMovementId_idx" ON "stock_return_portions"("originalMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_return_portions_adjustmentId_originalMovementId_key" ON "stock_return_portions"("adjustmentId", "originalMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_returnPortionId_key" ON "stock_movements"("returnPortionId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_returnPortionId_fkey" FOREIGN KEY ("returnPortionId") REFERENCES "stock_return_portions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_requests" ADD CONSTRAINT "financial_requests_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_requests" ADD CONSTRAINT "financial_requests_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_requests" ADD CONSTRAINT "financial_requests_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_requests" ADD CONSTRAINT "financial_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_requests" ADD CONSTRAINT "financial_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "financial_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_settlementPaymentId_fkey" FOREIGN KEY ("settlementPaymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment_cash_entries" ADD CONSTRAINT "adjustment_cash_entries_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "financial_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_return_portions" ADD CONSTRAINT "stock_return_portions_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "financial_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_return_portions" ADD CONSTRAINT "stock_return_portions_originalMovementId_fkey" FOREIGN KEY ("originalMovementId") REFERENCES "stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE financial_requests ADD CONSTRAINT financial_request_shape CHECK (
 kind IN ('PAYMENT_VOID','RETURN','CANCEL','REMOVE_ITEM') AND status IN ('PENDING','APPROVED','REJECTED')
 AND length(btrim(reason)) BETWEEN 3 AND 200
 AND (quantity IS NULL OR quantity>0)
 AND ((status='PENDING' AND "reviewedById" IS NULL AND "decidedAt" IS NULL) OR (status<>'PENDING' AND "reviewedById" IS NOT NULL AND "decidedAt" IS NOT NULL)));
ALTER TABLE financial_adjustments ADD CONSTRAINT financial_adjustment_shape CHECK (
 kind IN ('PAYMENT_VOID','RETURN','COMMISSION_RESTORE','CANCEL','REMOVE_ITEM')
 AND "salesDelta"<=0 AND "collectionDelta"<=0 AND "costDelta"<=0
 AND (quantity IS NULL OR quantity>0)
 AND length(btrim(reason)) BETWEEN 3 AND 200);
ALTER TABLE adjustment_cash_entries ADD CONSTRAINT financial_cash_negative CHECK(amount<0);
ALTER TABLE stock_return_portions ADD CONSTRAINT return_portion_positive CHECK(quantity>0);
CREATE FUNCTION public.phase5_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial reversal audit records are append-only'; END $$;
CREATE TRIGGER immutable_financial_adjustments BEFORE UPDATE OR DELETE ON financial_adjustments FOR EACH ROW EXECUTE FUNCTION public.phase5_append_only();
CREATE TRIGGER immutable_adjustment_cash_entries BEFORE UPDATE OR DELETE ON adjustment_cash_entries FOR EACH ROW EXECUTE FUNCTION public.phase5_append_only();
CREATE TRIGGER immutable_stock_return_portions BEFORE UPDATE OR DELETE ON stock_return_portions FOR EACH ROW EXECUTE FUNCTION public.phase5_append_only();
CREATE FUNCTION public.phase5_request_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Requests cannot be deleted'; END IF;
 IF OLD.status<>'PENDING' OR NEW.status='PENDING' OR
  (to_jsonb(NEW)-ARRAY['status','reviewedById','decisionReason','decidedAt']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['status','reviewedById','decisionReason','decidedAt'])
 THEN RAISE EXCEPTION 'Only one audited request decision is permitted'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_financial_request BEFORE UPDATE OR DELETE ON financial_requests FOR EACH ROW EXECUTE FUNCTION public.phase5_request_decision();
CREATE FUNCTION public.phase5_validate_portion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original stock_movements%ROWTYPE; restored numeric;
BEGIN
 SELECT * INTO original FROM stock_movements WHERE id=NEW."originalMovementId" FOR UPDATE;
 SELECT coalesce(sum(quantity),0) INTO restored FROM stock_return_portions WHERE "originalMovementId"=original.id;
 IF original.id IS NULL OR original.type<>'SALE' OR original."quantityChange">=0 OR original."saleItemId" IS NULL
 OR EXISTS(SELECT 1 FROM stock_movements WHERE "reversalOfId"=original.id)
 OR restored+NEW.quantity > -original."quantityChange"
 THEN RAISE EXCEPTION 'Return exceeds verifiable original deduction'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_stock_return_portion BEFORE INSERT ON stock_return_portions FOR EACH ROW EXECUTE FUNCTION public.phase5_validate_portion();
CREATE FUNCTION public.phase5_cash_reconciles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text; expected numeric; actual numeric;
BEGIN
 IF TG_TABLE_NAME='financial_adjustments' THEN key:=NEW.id; ELSE key:=NEW."adjustmentId"; END IF;
 SELECT "collectionDelta" INTO expected FROM financial_adjustments WHERE id=key;
 SELECT coalesce(sum(amount),0) INTO actual FROM adjustment_cash_entries WHERE "adjustmentId"=key;
 IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Financial cash entries do not reconcile'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER adjustment_cash_reconciles AFTER INSERT ON financial_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.phase5_cash_reconciles();
CREATE CONSTRAINT TRIGGER adjustment_cash_entry_reconciles AFTER INSERT ON adjustment_cash_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.phase5_cash_reconciles();
ALTER TABLE financial_requests ADD COLUMN "clientKey" TEXT NOT NULL;
CREATE UNIQUE INDEX "financial_requests_clientKey_key" ON financial_requests("clientKey");
ALTER TABLE financial_adjustments ADD COLUMN "clientKey" TEXT;
CREATE UNIQUE INDEX "financial_adjustments_clientKey_key" ON financial_adjustments("clientKey");
COMMIT;
