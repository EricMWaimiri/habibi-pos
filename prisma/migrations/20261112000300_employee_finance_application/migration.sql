-- Employee-finance application integration; existing rows are preserved.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE employee_finance_operations (
 id uuid PRIMARY KEY, actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action text NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE employee_payroll_events (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE,
 draft_id uuid NOT NULL REFERENCES employee_payroll_drafts(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 6),
 status text NOT NULL CHECK(status IN ('REVIEW','APPROVE','CONFIRM_DEDUCTIONS','RECORD_PAYMENT','COMPLETE','CANCEL')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(draft_id,sequence),UNIQUE(draft_id,status)
);
CREATE TABLE employee_payroll_periods (
 employee_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 payroll_year integer NOT NULL,payroll_month integer NOT NULL,
 draft_id uuid NOT NULL UNIQUE REFERENCES employee_payroll_drafts(id) ON DELETE RESTRICT,
 PRIMARY KEY(employee_id,payroll_year,payroll_month)
);
CREATE TABLE employee_payroll_sources (
 id uuid PRIMARY KEY,draft_id uuid NOT NULL REFERENCES employee_payroll_drafts(id) ON DELETE RESTRICT,
 source_key text NOT NULL UNIQUE,amount numeric(12,2) NOT NULL,
 kind text NOT NULL CHECK(kind IN ('COMMISSION','TIP')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE employee_salary_advances (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,
 employee_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE employee_advance_recoveries (
 id uuid PRIMARY KEY,advance_id uuid NOT NULL REFERENCES employee_salary_advances(id) ON DELETE RESTRICT,
 draft_id uuid NOT NULL REFERENCES employee_payroll_drafts(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount>0),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(advance_id,draft_id)
);
CREATE TABLE employee_finance_cash (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,
 employee_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 draft_id uuid UNIQUE REFERENCES employee_payroll_drafts(id) ON DELETE RESTRICT,
 advance_id uuid UNIQUE REFERENCES employee_salary_advances(id) ON DELETE RESTRICT,
 accounting_adjustment_id text NOT NULL UNIQUE REFERENCES accounting_adjustments(id) ON DELETE RESTRICT,
 method text NOT NULL CHECK(method IN ('CASH','MPESA')),
 reference text,amount numeric(12,2) NOT NULL CHECK(amount>=0),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(draft_id,advance_id)=1),CHECK(method<>'MPESA' OR (reference IS NOT NULL AND reference ~ '^[A-Z0-9]{10}$'))
);
CREATE UNIQUE INDEX employee_finance_cash_mpesa_unique ON employee_finance_cash(reference) WHERE method='MPESA';
CREATE TABLE employee_payroll_postings (
 id uuid PRIMARY KEY,draft_id uuid NOT NULL REFERENCES employee_payroll_drafts(id) ON DELETE RESTRICT,
 accounting_adjustment_id text NOT NULL UNIQUE REFERENCES accounting_adjustments(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('PAYROLL_ACCRUAL','PAYROLL_RECOVERIES','PAYROLL_SETTLEMENT')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(draft_id,kind)
);
-- Extend the accepted journal; payroll does not maintain a competing money ledger.
ALTER TABLE accounting_adjustments ADD COLUMN payroll_id uuid REFERENCES employee_payroll_drafts(id) ON DELETE RESTRICT;
ALTER TABLE accounting_adjustments ADD COLUMN employee_advance_id uuid UNIQUE REFERENCES employee_salary_advances(id) ON DELETE RESTRICT;
ALTER TABLE accounting_adjustments DROP CONSTRAINT accounting_adjustments_kind_check;
ALTER TABLE accounting_adjustments ADD CONSTRAINT accounting_adjustments_kind_check CHECK(kind IN ('SUPPLIER_PAYMENT_REVERSAL','EXPENSE_REVERSAL','PURCHASE_CORRECTION','SUPPLIER_CREDIT_REVERSAL','PAYROLL_ACCRUAL','PAYROLL_RECOVERIES','PAYROLL_SETTLEMENT','EMPLOYEE_ADVANCE'));
ALTER TABLE accounting_adjustments DROP CONSTRAINT accounting_adjustments_check;
ALTER TABLE accounting_adjustments ADD CONSTRAINT accounting_adjustments_check CHECK(num_nonnulls(supplier_payment_id,expense_id,purchase_id,credit_note_id,payroll_id,employee_advance_id)=1);
ALTER TABLE accounting_adjustments DROP CONSTRAINT accounting_adjustments_check1;
ALTER TABLE accounting_adjustments ADD CONSTRAINT accounting_adjustments_check1 CHECK(
 (kind='SUPPLIER_PAYMENT_REVERSAL' AND supplier_payment_id IS NOT NULL)
 OR(kind='EXPENSE_REVERSAL' AND expense_id IS NOT NULL)
 OR(kind='PURCHASE_CORRECTION' AND purchase_id IS NOT NULL)
 OR(kind='SUPPLIER_CREDIT_REVERSAL' AND credit_note_id IS NOT NULL)
 OR(kind='PAYROLL_ACCRUAL' AND payroll_id IS NOT NULL AND operating_expense_delta>=0 AND payable_delta>=0 AND cash_delta=0)
 OR(kind='PAYROLL_RECOVERIES' AND payroll_id IS NOT NULL AND operating_expense_delta=0 AND payable_delta<=0 AND cash_delta=0)
 OR(kind='PAYROLL_SETTLEMENT' AND payroll_id IS NOT NULL AND operating_expense_delta=0 AND payable_delta=cash_delta AND cash_delta<=0)
 OR(kind='EMPLOYEE_ADVANCE' AND employee_advance_id IS NOT NULL AND operating_expense_delta=0 AND payable_delta=0 AND cash_delta<0));
CREATE UNIQUE INDEX employee_payroll_journal_once ON accounting_adjustments(payroll_id,kind) WHERE payroll_id IS NOT NULL;
CREATE TABLE employee_settlement_links (
 adjustment_id text PRIMARY KEY REFERENCES financial_adjustments(id) ON DELETE RESTRICT,
 allocation_id uuid UNIQUE REFERENCES employee_finance_allocations(id) ON DELETE RESTRICT,
 draft_id uuid REFERENCES employee_payroll_drafts(id) ON DELETE RESTRICT,
 sale_id text NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
 reversal_of text UNIQUE REFERENCES employee_settlement_links(adjustment_id) ON DELETE RESTRICT,
 CHECK(num_nonnulls(allocation_id,draft_id)=1)
);
CREATE UNIQUE INDEX employee_payroll_bill_once ON employee_settlement_links(draft_id,sale_id) WHERE draft_id IS NOT NULL AND reversal_of IS NULL;
ALTER TABLE financial_adjustments DROP CONSTRAINT financial_adjustment_shape;
ALTER TABLE financial_adjustments ADD CONSTRAINT financial_adjustment_shape CHECK (
 ((kind IN ('PAYMENT_VOID','RETURN','COMMISSION_RESTORE','CANCEL','REMOVE_ITEM') AND "salesDelta"<=0 AND "collectionDelta"<=0 AND "costDelta"<=0)
 OR (kind IN ('RECEIPT_ALLOCATION','ALLOCATION_REVERSAL','PAYROLL_DEDUCTION','PAYROLL_DEDUCTION_REVERSAL')
 AND "salesDelta"=0 AND "costDelta"=0 AND quantity IS NULL AND "paymentId" IS NULL AND "settlementPaymentId" IS NULL
 AND ((kind IN ('RECEIPT_ALLOCATION','PAYROLL_DEDUCTION') AND "collectionDelta">0) OR (kind IN ('ALLOCATION_REVERSAL','PAYROLL_DEDUCTION_REVERSAL') AND "collectionDelta"<0))))
 AND (quantity IS NULL OR quantity>0) AND length(btrim(reason)) BETWEEN 3 AND 200);
CREATE OR REPLACE FUNCTION phase5_cash_reconciles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text; expected numeric; actual numeric; entry financial_adjustments%ROWTYPE; link employee_settlement_links%ROWTYPE; part employee_finance_allocations%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='financial_adjustments' THEN key:=NEW.id; ELSE key:=NEW."adjustmentId"; END IF;
 SELECT * INTO entry FROM financial_adjustments WHERE id=key;
 expected:=entry."collectionDelta";
 IF entry.kind IN ('RECEIPT_ALLOCATION','ALLOCATION_REVERSAL','PAYROLL_DEDUCTION','PAYROLL_DEDUCTION_REVERSAL') THEN
  SELECT * INTO link FROM employee_settlement_links WHERE adjustment_id=key;
  IF NOT FOUND OR link.sale_id<>entry."saleId" THEN RAISE EXCEPTION 'Missing settlement provenance'; END IF;
  IF entry.kind IN ('RECEIPT_ALLOCATION','ALLOCATION_REVERSAL') THEN
   SELECT * INTO part FROM employee_finance_allocations WHERE id=link.allocation_id;
   IF NOT FOUND OR part.sale_id<>entry."saleId" OR part.kind<>(CASE WHEN entry.kind='RECEIPT_ALLOCATION' THEN 'BILL' ELSE 'BILL_REVERSAL' END) OR part.amount<>abs(entry."collectionDelta") THEN RAISE EXCEPTION 'Allocation posting mismatch'; END IF;
  ELSIF link.draft_id IS NULL THEN RAISE EXCEPTION 'Missing payroll deduction source'; END IF;
  expected:=0; -- debt settlement/reallocation, not a physical cash movement
 END IF;
 SELECT coalesce(sum(amount),0) INTO actual FROM adjustment_cash_entries WHERE "adjustmentId"=key;
 IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Financial cash entries do not reconcile'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION employee_payroll_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous employee_payroll_events%ROWTYPE; creator text;
BEGIN
 PERFORM pg_advisory_xact_lock(180029,hashtext(NEW.draft_id::text));
 SELECT actor_id INTO creator FROM employee_payroll_drafts WHERE id=NEW.draft_id;
 SELECT * INTO previous FROM employee_payroll_events WHERE draft_id=NEW.draft_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.sequence<>coalesce(previous.sequence,0)+1 THEN RAISE EXCEPTION 'Payroll revision changed'; END IF;
 IF NEW.status='CANCEL' THEN
  IF previous.status IS NOT NULL AND previous.status<>'REVIEW' THEN RAISE EXCEPTION 'Approved payroll cannot be cancelled'; END IF;
 ELSIF NEW.status IS DISTINCT FROM (CASE coalesce(previous.status,'DRAFT') WHEN 'DRAFT' THEN 'REVIEW' WHEN 'REVIEW' THEN 'APPROVE' WHEN 'APPROVE' THEN 'CONFIRM_DEDUCTIONS' WHEN 'CONFIRM_DEDUCTIONS' THEN 'RECORD_PAYMENT' WHEN 'RECORD_PAYMENT' THEN 'COMPLETE' ELSE NULL END) THEN RAISE EXCEPTION 'Invalid payroll transition';
 END IF;
 IF NEW.status='APPROVE' AND NEW.actor_id=creator THEN RAISE EXCEPTION 'Payroll requires independent approval'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_payroll_transition BEFORE INSERT ON employee_payroll_events FOR EACH ROW EXECUTE FUNCTION employee_payroll_event_guard();
CREATE FUNCTION employee_advance_recovery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; prior numeric; owner text; recipient text;
BEGIN
 PERFORM pg_advisory_xact_lock(180028,hashtext(NEW.advance_id::text));
 SELECT amount,employee_id INTO total,owner FROM employee_salary_advances WHERE id=NEW.advance_id;
 SELECT employee_id INTO recipient FROM employee_payroll_drafts WHERE id=NEW.draft_id;
 SELECT coalesce(sum(amount),0) INTO prior FROM employee_advance_recoveries WHERE advance_id=NEW.advance_id;
 IF owner IS DISTINCT FROM recipient OR total IS NULL OR prior+NEW.amount>total THEN RAISE EXCEPTION 'Advance recovery exceeds available balance'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_advance_recovery_limit BEFORE INSERT ON employee_advance_recoveries FOR EACH ROW EXECUTE FUNCTION employee_advance_recovery_guard();
CREATE FUNCTION employee_outgoing_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text;
BEGIN
 IF NEW.method::text<>'MPESA' OR NEW.reference IS NULL THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='expenses' THEN
  IF NEW."paymentStatus"<>'PAID' THEN RETURN NEW; END IF;
 END IF;
 ref:=upper(btrim(NEW.reference));
 PERFORM pg_advisory_xact_lock(180031,hashtext(ref));
 IF TG_TABLE_NAME='employee_finance_cash' THEN
  IF EXISTS(SELECT 1 FROM expenses WHERE method='MPESA' AND "paymentStatus"='PAID' AND upper(btrim(reference))=ref)
   OR EXISTS(SELECT 1 FROM accounting_expense_settlements WHERE method='MPESA' AND upper(btrim(reference))=ref)
  THEN RAISE EXCEPTION 'Outgoing payment reference already recorded' USING ERRCODE='23505'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM employee_finance_cash WHERE method='MPESA' AND reference=ref) THEN RAISE EXCEPTION 'Outgoing payment reference already recorded' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_outgoing_reference BEFORE INSERT ON employee_finance_cash FOR EACH ROW EXECUTE FUNCTION employee_outgoing_reference_guard();
CREATE TRIGGER employee_expense_reference BEFORE INSERT ON expenses FOR EACH ROW EXECUTE FUNCTION employee_outgoing_reference_guard();
CREATE TRIGGER employee_expense_settlement_reference BEFORE INSERT ON accounting_expense_settlements FOR EACH ROW EXECUTE FUNCTION employee_outgoing_reference_guard();
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['employee_finance_operations','employee_payroll_events','employee_payroll_periods','employee_payroll_sources','employee_salary_advances','employee_advance_recoveries','employee_finance_cash','employee_payroll_postings','employee_settlement_links'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_%I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION phase5_append_only()',item,item);
 END LOOP;
END $$;
COMMIT;
