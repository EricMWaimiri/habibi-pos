-- Proposed migration31: portable; execute only in a separately authorized frozen TEST bundle.
-- No privileges, functions, keys, immutable triggers, records or historical migrations changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.financial_adjustments DROP CONSTRAINT financial_adjustment_shape;
ALTER TABLE public.financial_adjustments ADD CONSTRAINT financial_adjustment_shape CHECK (
((((kind = ANY (ARRAY['PAYMENT_VOID'::text, 'RETURN'::text, 'COMMISSION_RESTORE'::text, 'CANCEL'::text, 'REMOVE_ITEM'::text])) AND ("salesDelta" <= (0)::numeric) AND ("collectionDelta" <= (0)::numeric) AND ("costDelta" <= (0)::numeric)) OR ((kind = ANY (ARRAY['RECEIPT_ALLOCATION'::text, 'ALLOCATION_REVERSAL'::text, 'PAYROLL_DEDUCTION'::text, 'PAYROLL_DEDUCTION_REVERSAL'::text])) AND ("salesDelta" = (0)::numeric) AND ("costDelta" = (0)::numeric) AND (quantity IS NULL) AND ("paymentId" IS NULL) AND ("settlementPaymentId" IS NULL) AND (((kind = ANY (ARRAY['RECEIPT_ALLOCATION'::text, 'PAYROLL_DEDUCTION'::text])) AND ("collectionDelta" > (0)::numeric)) OR ((kind = ANY (ARRAY['ALLOCATION_REVERSAL'::text, 'PAYROLL_DEDUCTION_REVERSAL'::text])) AND ("collectionDelta" < (0)::numeric))))) AND ((quantity IS NULL) OR (quantity > (0)::numeric)) AND ((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 200)))
 OR (kind IN ('SALE_DISCOUNT','SALE_PRICE_CHANGE')
 AND "requestId" IS NOT NULL AND "clientKey" IS NOT NULL
 AND "paymentId" IS NULL AND "settlementPaymentId" IS NULL AND quantity IS NULL
 AND "costDelta" = 0 AND "collectionDelta" <= 0
 AND "collectionDelta" >= LEAST("salesDelta",0)
 AND (kind <> 'SALE_DISCOUNT' OR "salesDelta" <= 0)
 AND length(btrim(reason)) BETWEEN 3 AND 200));
ALTER TABLE public.financial_requests DROP CONSTRAINT financial_request_shape;
ALTER TABLE public.financial_requests ADD CONSTRAINT financial_request_shape CHECK (
((kind = ANY (ARRAY['PAYMENT_VOID'::text, 'RETURN'::text, 'CANCEL'::text, 'REMOVE_ITEM'::text, 'SALE_DISCOUNT'::text, 'SALE_PRICE_CHANGE'::text])) AND (status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])) AND ((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 200)) AND ((quantity IS NULL) OR (quantity > (0)::numeric)) AND (((status = 'PENDING'::text) AND ("reviewedById" IS NULL) AND ("decidedAt" IS NULL)) OR ((status <> 'PENDING'::text) AND ("reviewedById" IS NOT NULL) AND ("decidedAt" IS NOT NULL))))
 AND (kind NOT IN ('SALE_DISCOUNT','SALE_PRICE_CHANGE') OR ("paymentId" IS NULL AND quantity IS NULL))
);
COMMIT;
