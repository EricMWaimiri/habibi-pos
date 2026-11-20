BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
  IF current_database() <> 'habibi_pos_test' OR current_user <> 'habibi_pos_test' THEN
    RAISE EXCEPTION 'Task 2.6 migration is authorized for the restricted test identity only';
  END IF;
END $$;

-- No defaults/backfill: NULL explicitly means unverified legacy attribution.
ALTER TABLE public.sales
  ADD COLUMN "accountingDate" DATE,
  ADD COLUMN "commissionRateSnapshot" DECIMAL(5,2),
  ADD COLUMN "commissionEarnedAt" TIMESTAMP(3),
  ADD COLUMN "commissionAmount" DECIMAL(12,2),
  ADD CONSTRAINT sales_commission_snapshot_check CHECK (
    ("commissionRateSnapshot" IS NULL OR "commissionRateSnapshot" BETWEEN 0 AND 100)
    AND (("commissionEarnedAt" IS NULL AND "commissionAmount" IS NULL)
      OR ("commissionEarnedAt" IS NOT NULL AND "commissionAmount" IS NOT NULL
        AND "commissionRateSnapshot" IS NOT NULL AND "commissionAmount" >= 0))
  );
CREATE TABLE public.sale_accounting_events (
  id TEXT PRIMARY KEY,
  "saleId" TEXT NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId" TEXT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  action TEXT NOT NULL,
  reason TEXT,
  details JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "sale_accounting_events_saleId_createdAt_idx" ON public.sale_accounting_events("saleId", "createdAt");
CREATE FUNCTION public.reject_accounting_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Accounting events are append-only'; END $$;
CREATE TRIGGER accounting_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON public.sale_accounting_events FOR EACH STATEMENT
  EXECUTE FUNCTION public.reject_accounting_event_mutation();
COMMIT;
