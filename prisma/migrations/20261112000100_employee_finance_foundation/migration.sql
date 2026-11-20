-- Additive employee-finance storage. No historical row changes or stock partitions.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE employee_finance_receipts (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 original_sale_id text NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
 shift_id text REFERENCES shifts(id) ON DELETE RESTRICT,
 method text NOT NULL CHECK(method IN ('CASH','MPESA')),
 reference text, submitted_reference text,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(method<>'CASH' OR shift_id IS NOT NULL),
 CHECK(method<>'MPESA' OR (reference IS NOT NULL AND reference ~ '^[A-Z0-9]{10}$'))
);
CREATE UNIQUE INDEX employee_finance_mpesa_reference_unique ON employee_finance_receipts(reference) WHERE method='MPESA';
CREATE TABLE employee_finance_allocations (
 id uuid PRIMARY KEY,
 receipt_id uuid NOT NULL REFERENCES employee_finance_receipts(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('BILL','TIP','BILL_REVERSAL','TIP_REVERSAL')),
 sale_id text REFERENCES sales(id) ON DELETE RESTRICT,
 employee_id text REFERENCES users(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 reversal_of uuid UNIQUE REFERENCES employee_finance_allocations(id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind IN ('BILL','BILL_REVERSAL') AND sale_id IS NOT NULL AND employee_id IS NULL) OR (kind IN ('TIP','TIP_REVERSAL') AND employee_id IS NOT NULL AND sale_id IS NULL)),
 CHECK((kind IN ('BILL_REVERSAL','TIP_REVERSAL'))=(reversal_of IS NOT NULL))
);
CREATE INDEX employee_finance_allocations_receipt ON employee_finance_allocations(receipt_id);
CREATE INDEX employee_finance_allocations_sale ON employee_finance_allocations(sale_id);
CREATE INDEX employee_finance_allocations_employee ON employee_finance_allocations(employee_id);
CREATE TABLE employee_payroll_drafts (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE,
 employee_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 payroll_year integer NOT NULL CHECK(payroll_year BETWEEN 1900 AND 9999),
 payroll_month integer NOT NULL CHECK(payroll_month BETWEEN 1 AND 12),
 calendar_days integer NOT NULL CHECK(calendar_days BETWEEN 28 AND 31),
 missed_days numeric(8,4) NOT NULL CHECK(missed_days>=0 AND missed_days<=calendar_days),
 payable_days numeric(8,4) NOT NULL CHECK(payable_days=calendar_days-missed_days),
 monthly_basic numeric(12,2) NOT NULL CHECK(monthly_basic>=0),
 adjusted_basic numeric(12,2) NOT NULL CHECK(adjusted_basic>=0),
 net_before_statutory numeric(12,2) NOT NULL CHECK(net_before_statutory>=0),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(calendar_days=EXTRACT(day FROM (make_date(payroll_year,payroll_month,1)+interval '1 month - 1 day'))::integer),
 CHECK(adjusted_basic=round(monthly_basic*payable_days/calendar_days,2))
);
CREATE INDEX employee_payroll_drafts_employee_period ON employee_payroll_drafts(employee_id,payroll_year,payroll_month);
CREATE TABLE employee_finance_events (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(length(btrim(action)) BETWEEN 1 AND 100),
 target_type text NOT NULL CHECK(target_type IN ('RECEIPT','ALLOCATION','PAYROLL_DRAFT')),
 target_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Immutable drafts are calculation versions, not confirmed deductions or payouts.
CREATE TRIGGER immutable_employee_receipt BEFORE UPDATE OR DELETE ON employee_finance_receipts FOR EACH ROW EXECUTE FUNCTION phase5_append_only();
CREATE TRIGGER immutable_employee_allocation BEFORE UPDATE OR DELETE ON employee_finance_allocations FOR EACH ROW EXECUTE FUNCTION phase5_append_only();
CREATE TRIGGER immutable_employee_payroll_draft BEFORE UPDATE OR DELETE ON employee_payroll_drafts FOR EACH ROW EXECUTE FUNCTION phase5_append_only();
CREATE TRIGGER immutable_employee_finance_event BEFORE UPDATE OR DELETE ON employee_finance_events FOR EACH ROW EXECUTE FUNCTION phase5_append_only();
CREATE FUNCTION employee_finance_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE received numeric; allocated numeric; original employee_finance_allocations%ROWTYPE;
BEGIN
 SELECT amount INTO received FROM employee_finance_receipts WHERE id=NEW.receipt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown receipt' USING ERRCODE='23503'; END IF;
 IF NEW.reversal_of IS NOT NULL THEN
  SELECT * INTO original FROM employee_finance_allocations WHERE id=NEW.reversal_of;
  IF NOT FOUND OR original.receipt_id<>NEW.receipt_id OR original.kind NOT IN ('BILL','TIP') OR NEW.kind<>original.kind||'_REVERSAL' OR original.amount<>NEW.amount OR NEW.sale_id IS DISTINCT FROM original.sale_id OR NEW.employee_id IS DISTINCT FROM original.employee_id THEN
   RAISE EXCEPTION 'Invalid allocation reversal' USING ERRCODE='23514';
  END IF;
 END IF;
 SELECT coalesce(sum(CASE WHEN kind IN ('BILL','TIP') THEN amount ELSE -amount END),0) INTO allocated FROM employee_finance_allocations WHERE receipt_id=NEW.receipt_id;
 allocated:=allocated+CASE WHEN NEW.kind IN ('BILL','TIP') THEN NEW.amount ELSE -NEW.amount END;
 IF allocated<0 OR allocated>received THEN RAISE EXCEPTION 'Receipt allocation exceeds available funds' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_finance_allocation_conservation BEFORE INSERT ON employee_finance_allocations FOR EACH ROW EXECUTE FUNCTION employee_finance_allocation_guard();
-- A canonical reference cannot be reused through the legacy or new receipt path.
CREATE FUNCTION employee_finance_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text;
BEGIN
 IF NEW.method::text<>'MPESA' OR NEW.reference IS NULL THEN RETURN NEW; END IF;
 ref:=upper(btrim(NEW.reference));
 PERFORM pg_advisory_xact_lock(180025,hashtext(ref));
 IF TG_TABLE_NAME='employee_finance_receipts' THEN
  IF EXISTS(SELECT 1 FROM payments WHERE method::text='MPESA' AND upper(btrim(reference))=ref) THEN RAISE EXCEPTION 'Payment reference already recorded' USING ERRCODE='23505'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM employee_finance_receipts WHERE method='MPESA' AND reference=ref) THEN RAISE EXCEPTION 'Payment reference already recorded' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_finance_receipt_reference BEFORE INSERT ON employee_finance_receipts FOR EACH ROW EXECUTE FUNCTION employee_finance_reference_guard();
CREATE TRIGGER employee_finance_legacy_reference BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION employee_finance_reference_guard();
COMMIT;
