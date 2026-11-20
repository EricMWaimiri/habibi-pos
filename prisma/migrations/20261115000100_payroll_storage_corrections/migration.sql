-- REVIEW ONLY. No execution authorized. Portable proposed successor to migration28.

-- Do not place in prisma/migrations or execute until exact package approval.

BEGIN;

SET LOCAL lock_timeout='5s';

SET LOCAL statement_timeout='60s';

ALTER TABLE public.employee_payroll_drafts
 ADD COLUMN eligible_days numeric(8,4),
 ADD COLUMN salary_segments jsonb,
 ADD COLUMN manual_basic_adjustment numeric(12,2) NOT NULL DEFAULT 0;

CREATE FUNCTION public.core_payroll_segments_valid(
 segments jsonb, year integer, month integer, calendar integer,
 eligible numeric, payable numeric, missed numeric, adjusted numeric,
 manual_delta numeric, draft_snapshot jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $body$
DECLARE part jsonb; first_day date; last_day date; cursor_day date;
 occupied date[] := ARRAY[]::date[]; segment_days integer;
 total_eligible numeric := 0; total_payable numeric := 0;
 weighted_numerator numeric := 0; rate numeric; paid numeric;
BEGIN
 IF segments IS NULL OR jsonb_typeof(segments) IS DISTINCT FROM 'array'
 OR jsonb_array_length(segments) NOT BETWEEN 1 AND 31
 OR eligible IS NULL OR payable IS NULL OR missed IS NULL
 OR eligible < 0 OR eligible > calendar OR payable < 0 OR payable > eligible
 OR missed IS DISTINCT FROM eligible - payable
 OR draft_snapshot->'calculation'->>'salaryBasis' IS DISTINCT FROM 'DAILY_EFFECTIVE_SEGMENTS'
 OR draft_snapshot->'calculation'->'segments' IS DISTINCT FROM segments
 THEN RETURN false; END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(segments) LOOP
  IF jsonb_typeof(part) IS DISTINCT FROM 'object'
  OR part->>'revision' IS NULL OR (part->>'revision')::integer < 1
  OR part->>'profileId' IS NULL THEN RETURN false; END IF;
  first_day := (part->>'from')::date; last_day := (part->>'to')::date;
  IF first_day IS NULL OR last_day IS NULL OR first_day > last_day
  OR first_day < make_date(year,month,1)
  OR last_day >= make_date(year,month,1) + interval '1 month'
  THEN RETURN false; END IF;
  segment_days := last_day - first_day + 1;
  IF (part->>'eligibleDays')::numeric IS DISTINCT FROM segment_days THEN RETURN false; END IF;
  rate := (part->>'monthlyBasic')::numeric; paid := (part->>'payableDays')::numeric;
  IF rate IS NULL OR paid IS NULL OR rate < 0 OR rate > 9999999999.99
  OR rate <> round(rate,2) OR paid < 0 OR paid > segment_days
  OR paid <> round(paid,4) THEN RETURN false; END IF;
  FOR cursor_day IN SELECT generate_series(first_day,last_day,interval '1 day')::date LOOP
   IF cursor_day = ANY(occupied) THEN RETURN false; END IF;
   occupied := array_append(occupied,cursor_day);
  END LOOP;
  total_eligible := total_eligible + segment_days;
  total_payable := total_payable + paid;
  weighted_numerator := weighted_numerator + rate * paid;
 END LOOP;
 IF total_eligible IS DISTINCT FROM eligible OR total_payable IS DISTINCT FROM payable
 OR adjusted IS DISTINCT FROM round(weighted_numerator/calendar + manual_delta,2)
 THEN RETURN false; END IF;
 IF manual_delta <> 0 AND (
  length(btrim(coalesce(draft_snapshot->'salaryProfileSnapshot'->'manualBasicAdjustment'->>'reason',''))) NOT BETWEEN 3 AND 200
  OR (draft_snapshot->'salaryProfileSnapshot'->'manualBasicAdjustment'->>'amount')::numeric IS DISTINCT FROM manual_delta
 ) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR division_by_zero OR numeric_value_out_of_range THEN
 RETURN false;
END $body$;

-- Existing immutable rows retain both original formula invariants in the legacy arm.
-- These legacy constraint names must be reverified by external read-only preflight.
ALTER TABLE public.employee_payroll_drafts
 DROP CONSTRAINT employee_payroll_drafts_check1,
 DROP CONSTRAINT employee_payroll_drafts_check3;
ALTER TABLE public.employee_payroll_drafts ADD CONSTRAINT core_payroll_salary_basis CHECK (
 (salary_segments IS NULL AND eligible_days IS NULL AND manual_basic_adjustment = 0
  AND payable_days = calendar_days - missed_days
  AND adjusted_basic = round(monthly_basic * payable_days / calendar_days,2))
 OR
 (salary_segments IS NOT NULL AND public.core_payroll_segments_valid(
  salary_segments,payroll_year,payroll_month,calendar_days,
  eligible_days,payable_days,missed_days,adjusted_basic,
  manual_basic_adjustment,snapshot) IS TRUE)
);
-- No record updates, backfills, journal edits, privilege grants or historical SQL changes.


ALTER TABLE employee_payroll_drafts ADD COLUMN attendance_snapshot jsonb CHECK(attendance_snapshot IS NULL OR jsonb_typeof(attendance_snapshot)='array');

CREATE TABLE public.payroll_draft_revisions (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE,
 original_draft_id uuid NOT NULL UNIQUE,
 replacement_draft_id uuid NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('EDIT','RETURN_TO_DRAFT')),
 actor_id text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payroll_corrections (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE,
 root_draft_id uuid NOT NULL,
 basis_draft_id uuid NOT NULL,
 replacement_draft_id uuid UNIQUE,
 expected_version integer NOT NULL CHECK(expected_version>=0),
 mode text NOT NULL CHECK(mode IN ('REVERSE_UNPAID','REPLACE_UNPAID','ADJUST')),
 actor_id text NOT NULL,
 accounting_date date NOT NULL,
 preview_fingerprint text NOT NULL CHECK(preview_fingerprint ~ '^[0-9a-f]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payroll_correction_events (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE,
 correction_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 3),
 status text NOT NULL CHECK(status IN ('REQUESTED','APPROVED','REJECTED','CANCELLED','APPLIED')),
 actor_id text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
 preview_fingerprint text NOT NULL CHECK(preview_fingerprint ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payroll_correction_applications (
 correction_id uuid PRIMARY KEY,
 root_draft_id uuid NOT NULL,
 effective_draft_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payroll_source_releases (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL,
 correction_id uuid NOT NULL,
 amount numeric(12,2) NOT NULL CHECK(amount<>0),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payroll_advance_reversals (
 id uuid PRIMARY KEY,
 recovery_id uuid NOT NULL,
 correction_id uuid NOT NULL,
 accounting_adjustment_id text NOT NULL,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payroll_overpayment_claims (
 id uuid PRIMARY KEY,
 correction_id uuid NOT NULL UNIQUE,
 root_draft_id uuid NOT NULL,
 employee_id text NOT NULL,
 accounting_adjustment_id text NOT NULL UNIQUE,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payroll_overpayment_recoveries (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE,
 claim_id uuid NOT NULL,
 accounting_adjustment_id text NOT NULL UNIQUE,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 method text NOT NULL CHECK(method IN ('CASH','MPESA','PAYROLL_AUTHORIZED')),
 recovery_draft_id uuid ,
 actor_id text NOT NULL,
 approved_by_id text NOT NULL,
 authorization_reference text NOT NULL CHECK(length(btrim(authorization_reference)) BETWEEN 3 AND 200),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.accounting_closed_periods (
 period_start date PRIMARY KEY CHECK(extract(day FROM period_start)=1),
 request_id uuid NOT NULL UNIQUE,
 actor_id text NOT NULL,
 approved_by_id text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
 created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_draft_revisions ADD CONSTRAINT payroll_draft_revisions_original_draft_id_fk FOREIGN KEY (original_draft_id) REFERENCES public.employee_payroll_drafts(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_draft_revisions ADD CONSTRAINT payroll_draft_revisions_replacement_draft_id_fk FOREIGN KEY (replacement_draft_id) REFERENCES public.employee_payroll_drafts(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_draft_revisions ADD CONSTRAINT payroll_draft_revisions_actor_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_corrections ADD CONSTRAINT payroll_corrections_root_draft_id_fk FOREIGN KEY (root_draft_id) REFERENCES public.employee_payroll_drafts(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_corrections ADD CONSTRAINT payroll_corrections_basis_draft_id_fk FOREIGN KEY (basis_draft_id) REFERENCES public.employee_payroll_drafts(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_corrections ADD CONSTRAINT payroll_corrections_replacement_draft_id_fk FOREIGN KEY (replacement_draft_id) REFERENCES public.employee_payroll_drafts(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_corrections ADD CONSTRAINT payroll_corrections_actor_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_correction_events ADD CONSTRAINT payroll_correction_events_correction_id_fk FOREIGN KEY (correction_id) REFERENCES public.payroll_corrections(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_correction_events ADD CONSTRAINT payroll_correction_events_actor_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_correction_applications ADD CONSTRAINT payroll_correction_applications_correction_id_fk FOREIGN KEY (correction_id) REFERENCES public.payroll_corrections(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_correction_applications ADD CONSTRAINT payroll_correction_applications_root_draft_id_fk FOREIGN KEY (root_draft_id) REFERENCES public.employee_payroll_drafts(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_correction_applications ADD CONSTRAINT payroll_correction_applications_effective_draft_id_fk FOREIGN KEY (effective_draft_id) REFERENCES public.employee_payroll_drafts(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_correction_applications ADD CONSTRAINT payroll_correction_applications_actor_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_source_releases ADD CONSTRAINT payroll_source_releases_source_id_fk FOREIGN KEY (source_id) REFERENCES public.employee_payroll_sources(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_advance_reversals ADD CONSTRAINT payroll_advance_reversals_recovery_id_fk FOREIGN KEY (recovery_id) REFERENCES public.employee_advance_recoveries(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_advance_reversals ADD CONSTRAINT payroll_advance_reversals_accounting_adjustment_id_fk FOREIGN KEY (accounting_adjustment_id) REFERENCES public.accounting_adjustments(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_overpayment_claims ADD CONSTRAINT payroll_overpayment_claims_root_draft_id_fk FOREIGN KEY (root_draft_id) REFERENCES public.employee_payroll_drafts(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_overpayment_claims ADD CONSTRAINT payroll_overpayment_claims_employee_id_fk FOREIGN KEY (employee_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_overpayment_claims ADD CONSTRAINT payroll_overpayment_claims_accounting_adjustment_id_fk FOREIGN KEY (accounting_adjustment_id) REFERENCES public.accounting_adjustments(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_overpayment_recoveries ADD CONSTRAINT payroll_overpayment_recoveries_claim_id_fk FOREIGN KEY (claim_id) REFERENCES public.payroll_overpayment_claims(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_overpayment_recoveries ADD CONSTRAINT payroll_overpayment_recoveries_accounting_adjustment_id_fk FOREIGN KEY (accounting_adjustment_id) REFERENCES public.accounting_adjustments(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_overpayment_recoveries ADD CONSTRAINT payroll_overpayment_recoveries_recovery_draft_id_fk FOREIGN KEY (recovery_draft_id) REFERENCES public.employee_payroll_drafts(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_overpayment_recoveries ADD CONSTRAINT payroll_overpayment_recoveries_actor_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.payroll_overpayment_recoveries ADD CONSTRAINT payroll_overpayment_recoveries_approved_by_id_fk FOREIGN KEY (approved_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.accounting_closed_periods ADD CONSTRAINT accounting_closed_periods_actor_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.accounting_closed_periods ADD CONSTRAINT accounting_closed_periods_approved_by_id_fk FOREIGN KEY (approved_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE payroll_draft_revisions ADD CHECK(original_draft_id<>replacement_draft_id);

ALTER TABLE payroll_corrections ADD CHECK((mode='REPLACE_UNPAID')=(replacement_draft_id IS NOT NULL));

ALTER TABLE payroll_correction_events ADD UNIQUE(correction_id,sequence), ADD UNIQUE(correction_id,status);

ALTER TABLE payroll_correction_applications ADD UNIQUE(root_draft_id,version);

ALTER TABLE payroll_source_releases ADD UNIQUE(source_id,correction_id);

ALTER TABLE payroll_advance_reversals ADD UNIQUE(recovery_id,correction_id);

ALTER TABLE payroll_overpayment_recoveries ADD CHECK(actor_id<>approved_by_id), ADD CHECK((method='PAYROLL_AUTHORIZED')=(recovery_draft_id IS NOT NULL));

ALTER TABLE accounting_closed_periods ADD CHECK(actor_id<>approved_by_id);

ALTER TABLE payroll_source_releases ADD CONSTRAINT payroll_source_releases_applied_fk FOREIGN KEY(correction_id) REFERENCES payroll_correction_applications(correction_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE payroll_advance_reversals ADD CONSTRAINT payroll_advance_reversals_applied_fk FOREIGN KEY(correction_id) REFERENCES payroll_correction_applications(correction_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE payroll_overpayment_claims ADD CONSTRAINT payroll_overpayment_claims_applied_fk FOREIGN KEY(correction_id) REFERENCES payroll_correction_applications(correction_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE accounting_adjustments ADD COLUMN payroll_correction_id uuid REFERENCES payroll_correction_applications(correction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE employee_payroll_postings ADD COLUMN payroll_correction_id uuid REFERENCES payroll_correction_applications(correction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE employee_payroll_sources ADD COLUMN payroll_correction_id uuid REFERENCES payroll_correction_applications(correction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE employee_advance_recoveries ADD COLUMN payroll_correction_id uuid REFERENCES payroll_correction_applications(correction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE employee_settlement_links ADD COLUMN payroll_correction_id uuid REFERENCES payroll_correction_applications(correction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE employee_finance_cash ADD COLUMN payroll_correction_id uuid REFERENCES payroll_correction_applications(correction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE accounting_adjustments ADD COLUMN employee_receivable_delta numeric(12,2);

ALTER TABLE accounting_adjustments ADD COLUMN employee_advance_delta numeric(12,2);

ALTER TABLE accounting_adjustments ADD COLUMN employee_overpayment_delta numeric(12,2);

ALTER TABLE accounting_adjustments ADD COLUMN employee_tip_liability_delta numeric(12,2);

ALTER TABLE accounting_adjustments ADD COLUMN other_recovery_liability_delta numeric(12,2);

ALTER TABLE accounting_adjustments ADD COLUMN reverses_adjustment_id text UNIQUE REFERENCES accounting_adjustments(id) ON DELETE RESTRICT;

ALTER TABLE employee_finance_cash ADD COLUMN overpayment_recovery_id uuid UNIQUE REFERENCES payroll_overpayment_recoveries(id) ON DELETE RESTRICT, ADD COLUMN direction text NOT NULL DEFAULT 'OUT' CHECK(direction IN ('IN','OUT'));

ALTER TABLE employee_finance_cash DROP CONSTRAINT employee_finance_cash_draft_id_key, DROP CONSTRAINT employee_finance_cash_check;

ALTER TABLE employee_finance_cash ADD CONSTRAINT payroll_cash_source CHECK(num_nonnulls(draft_id,advance_id,overpayment_recovery_id)=1 AND (direction='OUT' OR overpayment_recovery_id IS NOT NULL));

ALTER TABLE employee_payroll_events DROP CONSTRAINT employee_payroll_events_sequence_check, DROP CONSTRAINT employee_payroll_events_status_check, DROP CONSTRAINT employee_payroll_events_draft_id_status_key;

ALTER TABLE employee_payroll_events ADD CHECK(sequence>0), ADD CHECK(status IN ('REVIEW','APPROVE','CONFIRM_DEDUCTIONS','PARTIALLY_PAID','RECORD_PAYMENT','COMPLETE','CANCEL'));

ALTER TABLE employee_payroll_sources DROP CONSTRAINT employee_payroll_sources_source_key_key;

CREATE INDEX payroll_sources_key ON employee_payroll_sources(source_key);

ALTER TABLE employee_advance_recoveries DROP CONSTRAINT employee_advance_recoveries_advance_id_draft_id_key;

CREATE UNIQUE INDEX payroll_legacy_advance_once ON employee_advance_recoveries(advance_id,draft_id) WHERE payroll_correction_id IS NULL;

DROP INDEX employee_payroll_bill_once;

CREATE UNIQUE INDEX employee_payroll_bill_once ON employee_settlement_links(draft_id,sale_id) WHERE draft_id IS NOT NULL AND reversal_of IS NULL AND payroll_correction_id IS NULL;

ALTER TABLE employee_payroll_postings DROP CONSTRAINT employee_payroll_postings_draft_id_kind_key;

DROP INDEX employee_payroll_journal_once;

ALTER TABLE accounting_adjustments DROP CONSTRAINT accounting_adjustments_kind_check, DROP CONSTRAINT accounting_adjustments_check1;

ALTER TABLE accounting_adjustments ADD CONSTRAINT accounting_adjustments_kind_check CHECK(kind IN ('SUPPLIER_PAYMENT_REVERSAL','EXPENSE_REVERSAL','PURCHASE_CORRECTION','SUPPLIER_CREDIT_REVERSAL','PAYROLL_ACCRUAL','PAYROLL_RECOVERIES','PAYROLL_SETTLEMENT','EMPLOYEE_ADVANCE','PAYROLL_ACCRUAL_REVERSAL','PAYROLL_CORRECTION','PAYROLL_RECOVERY_REVERSAL','PAYROLL_CORRECTION_RECOVERY','PAYROLL_INSTALLMENT','PAYROLL_OVERPAYMENT','PAYROLL_OVERPAYMENT_RECOVERY','PAYROLL_OVERPAYMENT_ADJUSTMENT'));

ALTER TABLE employee_payroll_postings DROP CONSTRAINT employee_payroll_postings_kind_check;

ALTER TABLE employee_payroll_postings ADD CONSTRAINT employee_payroll_postings_kind_check CHECK(kind IN ('PAYROLL_ACCRUAL','PAYROLL_RECOVERIES','PAYROLL_SETTLEMENT','PAYROLL_ACCRUAL_REVERSAL','PAYROLL_CORRECTION','PAYROLL_RECOVERY_REVERSAL','PAYROLL_CORRECTION_RECOVERY','PAYROLL_INSTALLMENT','PAYROLL_OVERPAYMENT','PAYROLL_OVERPAYMENT_RECOVERY','PAYROLL_OVERPAYMENT_ADJUSTMENT'));

CREATE UNIQUE INDEX employee_payroll_journal_once ON accounting_adjustments(payroll_id,kind) WHERE payroll_id IS NOT NULL AND kind IN ('PAYROLL_ACCRUAL','PAYROLL_RECOVERIES','PAYROLL_SETTLEMENT');

CREATE UNIQUE INDEX payroll_original_posting_once ON employee_payroll_postings(draft_id,kind) WHERE kind IN ('PAYROLL_ACCRUAL','PAYROLL_RECOVERIES','PAYROLL_SETTLEMENT');

ALTER TABLE accounting_adjustments ADD CONSTRAINT accounting_adjustments_check1 CHECK(((kind='SUPPLIER_PAYMENT_REVERSAL' AND supplier_payment_id IS NOT NULL)
 OR(kind='EXPENSE_REVERSAL' AND expense_id IS NOT NULL)
 OR(kind='PURCHASE_CORRECTION' AND purchase_id IS NOT NULL)
 OR(kind='SUPPLIER_CREDIT_REVERSAL' AND credit_note_id IS NOT NULL)
 OR(kind='PAYROLL_ACCRUAL' AND payroll_id IS NOT NULL AND operating_expense_delta>=0 AND payable_delta>=0 AND cash_delta=0)
 OR(kind='PAYROLL_RECOVERIES' AND payroll_id IS NOT NULL AND operating_expense_delta=0 AND payable_delta<=0 AND cash_delta=0)
 OR(kind='PAYROLL_SETTLEMENT' AND payroll_id IS NOT NULL AND operating_expense_delta=0 AND payable_delta=cash_delta AND cash_delta<=0)
 OR(kind='EMPLOYEE_ADVANCE' AND employee_advance_id IS NOT NULL AND operating_expense_delta=0 AND payable_delta=0 AND cash_delta<0)) OR (kind IN ('PAYROLL_ACCRUAL_REVERSAL','PAYROLL_CORRECTION','PAYROLL_RECOVERY_REVERSAL','PAYROLL_CORRECTION_RECOVERY','PAYROLL_INSTALLMENT','PAYROLL_OVERPAYMENT','PAYROLL_OVERPAYMENT_RECOVERY','PAYROLL_OVERPAYMENT_ADJUSTMENT') AND payroll_id IS NOT NULL));

CREATE INDEX payroll_corrections_review_lookup ON payroll_corrections(root_draft_id,created_at,id);

CREATE INDEX payroll_correction_events_review_lookup ON payroll_correction_events(correction_id,sequence);

CREATE INDEX payroll_source_releases_review_lookup ON payroll_source_releases(source_id);

CREATE INDEX payroll_advance_reversals_review_lookup ON payroll_advance_reversals(recovery_id);

CREATE INDEX payroll_overpayment_recoveries_review_lookup ON payroll_overpayment_recoveries(claim_id);

CREATE INDEX employee_finance_cash_review_lookup ON employee_finance_cash(draft_id);

CREATE INDEX accounting_adjustments_review_lookup ON accounting_adjustments(payroll_correction_id);

-- Shared guards use invoker rights, fixed search_path, no credentials/roles/hostnames.
CREATE FUNCTION public.payroll_root(draft uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $f$
 SELECT coalesce((SELECT root_draft_id FROM public.payroll_correction_applications
 WHERE effective_draft_id=draft ORDER BY version DESC LIMIT 1),draft)
$f$;
CREATE FUNCTION public.payroll_lock(draft uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE root uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(180030,1); -- same gate as accepted payroll mutations
 root:=public.payroll_root(draft);
 PERFORM pg_advisory_xact_lock(180043,hashtext(root::text));
 RETURN root;
END $f$;
CREATE FUNCTION public.payroll_open_date(posted date) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
BEGIN
 PERFORM pg_advisory_xact_lock(180044,1);
 IF posted IS NULL OR posted>(now() AT TIME ZONE 'Africa/Nairobi')::date
 OR EXISTS(SELECT 1 FROM public.accounting_closed_periods WHERE period_start=date_trunc('month',posted)::date)
 THEN RAISE EXCEPTION 'Payroll posting date is future, missing or closed' USING ERRCODE='23514'; END IF;
END $f$;
CREATE FUNCTION public.payroll_period_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
BEGIN
 PERFORM pg_advisory_xact_lock(180030,1);
 PERFORM pg_advisory_xact_lock(180044,1);
 IF NEW.actor_id=NEW.approved_by_id OR NEW.period_start+interval '1 month'>(now() AT TIME ZONE 'Africa/Nairobi')::date+1
 OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=NEW.approved_by_id AND role='MANAGER' AND "isActive")
 THEN RAISE EXCEPTION 'Period closure requires independent management and a completed month' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_close_period BEFORE INSERT ON accounting_closed_periods FOR EACH ROW EXECUTE FUNCTION payroll_period_guard();

CREATE FUNCTION public.payroll_draft_revision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE old public.employee_payroll_drafts%ROWTYPE; fresh public.employee_payroll_drafts%ROWTYPE; status text;
BEGIN
 PERFORM public.payroll_lock(NEW.original_draft_id);
 SELECT * INTO old FROM public.employee_payroll_drafts WHERE id=NEW.original_draft_id;
 SELECT * INTO fresh FROM public.employee_payroll_drafts WHERE id=NEW.replacement_draft_id;
 SELECT e.status INTO status FROM public.employee_payroll_events e WHERE e.draft_id=old.id ORDER BY sequence DESC LIMIT 1;
 IF old.employee_id IS DISTINCT FROM fresh.employee_id OR old.payroll_year IS DISTINCT FROM fresh.payroll_year
 OR old.payroll_month IS DISTINCT FROM fresh.payroll_month
 OR coalesce(status,'DRAFT') NOT IN ('DRAFT','REVIEW')
 OR (NEW.kind='RETURN_TO_DRAFT' AND status IS DISTINCT FROM 'REVIEW')
 OR EXISTS(SELECT 1 FROM public.employee_payroll_events WHERE draft_id=fresh.id)
 THEN RAISE EXCEPTION 'Only an unapproved payroll may be replaced by a fresh draft' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_revision_guard BEFORE INSERT ON payroll_draft_revisions FOR EACH ROW EXECUTE FUNCTION payroll_draft_revision_guard();

CREATE FUNCTION public.payroll_correction_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE request public.payroll_corrections%ROWTYPE; prior public.payroll_correction_events%ROWTYPE; recipient text;
BEGIN
 SELECT * INTO request FROM public.payroll_corrections WHERE id=NEW.correction_id;
 PERFORM public.payroll_lock(request.root_draft_id);
 SELECT employee_id INTO recipient FROM public.employee_payroll_drafts WHERE id=request.basis_draft_id;
 SELECT * INTO prior FROM public.payroll_correction_events WHERE correction_id=NEW.correction_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.sequence<>coalesce(prior.sequence,0)+1 OR NEW.preview_fingerprint IS DISTINCT FROM request.preview_fingerprint
 OR NOT ((prior.status IS NULL AND NEW.status='REQUESTED' AND NEW.actor_id=request.actor_id)
  OR (prior.status='REQUESTED' AND NEW.status IN ('APPROVED','REJECTED','CANCELLED'))
  OR (prior.status='APPROVED' AND NEW.status IN ('APPLIED','CANCELLED')))
 THEN RAISE EXCEPTION 'Invalid correction event/version/preview' USING ERRCODE='23514'; END IF;
 IF NEW.status IN ('APPROVED','APPLIED') AND
 (NEW.actor_id IN (request.actor_id,recipient) OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=NEW.actor_id AND role='MANAGER' AND "isActive"))
 THEN RAISE EXCEPTION 'Independent active manager required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_correction_transition BEFORE INSERT ON payroll_correction_events FOR EACH ROW EXECUTE FUNCTION payroll_correction_event_guard();

CREATE FUNCTION public.payroll_application_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE request public.payroll_corrections%ROWTYPE; version_now integer; employee text; target public.employee_payroll_drafts%ROWTYPE;
BEGIN
 SELECT * INTO request FROM public.payroll_corrections WHERE id=NEW.correction_id;
 PERFORM public.payroll_lock(request.root_draft_id);
 SELECT coalesce(max(version),0) INTO version_now FROM public.payroll_correction_applications WHERE root_draft_id=request.root_draft_id;
 SELECT employee_id INTO employee FROM public.employee_payroll_drafts WHERE id=request.root_draft_id;
 SELECT * INTO target FROM public.employee_payroll_drafts WHERE id=NEW.effective_draft_id;
 IF NEW.root_draft_id IS DISTINCT FROM request.root_draft_id OR request.expected_version<>version_now
 OR NEW.version<>version_now+1 OR target.employee_id IS DISTINCT FROM employee
 OR (request.mode='REPLACE_UNPAID' AND (NEW.effective_draft_id IS DISTINCT FROM request.replacement_draft_id OR EXISTS(SELECT 1 FROM public.employee_payroll_events WHERE draft_id=request.replacement_draft_id)))
 OR (request.mode<>'REPLACE_UNPAID' AND NEW.effective_draft_id IS DISTINCT FROM request.basis_draft_id)
 OR public.payroll_root(request.basis_draft_id) IS DISTINCT FROM request.root_draft_id
 OR request.basis_draft_id IS DISTINCT FROM coalesce((SELECT effective_draft_id FROM public.payroll_correction_applications WHERE root_draft_id=request.root_draft_id ORDER BY version DESC LIMIT 1),request.root_draft_id)
 OR (target.payroll_year,target.payroll_month) IS DISTINCT FROM (SELECT ROW(payroll_year,payroll_month) FROM public.employee_payroll_drafts WHERE id=request.root_draft_id)
 OR NOT EXISTS(SELECT 1 FROM public.employee_payroll_events WHERE draft_id=request.basis_draft_id AND status='APPROVE')
 OR NOT EXISTS(SELECT 1 FROM public.payroll_correction_events WHERE correction_id=request.id AND status='APPROVED')
 THEN RAISE EXCEPTION 'Correction basis/version/approval changed' USING ERRCODE='23514'; END IF;
 PERFORM public.payroll_open_date(request.accounting_date);
 IF request.mode IN ('REVERSE_UNPAID','REPLACE_UNPAID') AND (
 EXISTS(SELECT 1 FROM public.employee_payroll_events WHERE draft_id=request.basis_draft_id AND status IN ('CONFIRM_DEDUCTIONS','PARTIALLY_PAID','RECORD_PAYMENT','COMPLETE'))
 OR EXISTS(SELECT 1 FROM public.employee_finance_cash WHERE public.payroll_root(draft_id)=request.root_draft_id)
 OR EXISTS(SELECT 1 FROM public.employee_advance_recoveries WHERE public.payroll_root(draft_id)=request.root_draft_id)
 OR EXISTS(SELECT 1 FROM public.employee_settlement_links WHERE public.payroll_root(draft_id)=request.root_draft_id))
 THEN RAISE EXCEPTION 'Unpaid reversal cannot reverse confirmed recovery or payment' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_application BEFORE INSERT ON payroll_correction_applications FOR EACH ROW EXECUTE FUNCTION payroll_application_guard();

CREATE FUNCTION public.payroll_source_capacity(key text,employee text) RETURNS numeric
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $f$
DECLARE capacity numeric;
BEGIN
 IF left(key,5)='SALE:' THEN
  SELECT "commissionAmount" INTO capacity FROM public.sales WHERE id=substring(key FROM 6) AND "waiterId"=employee AND "commissionEarnedAt" IS NOT NULL;
 ELSIF left(key,11)='COMMISSION:' THEN
  SELECT a."commissionDelta" INTO capacity FROM public.financial_adjustments a JOIN public.sales s ON s.id=a."saleId" WHERE a.id=substring(key FROM 12) AND s."waiterId"=employee;
 ELSIF left(key,4)='TIP:' THEN
  SELECT a.amount INTO capacity FROM public.employee_finance_allocations a WHERE a.id::text=substring(key FROM 5) AND a.employee_id=employee AND a.kind='TIP' AND NOT EXISTS(SELECT 1 FROM public.employee_finance_allocations r WHERE r.reversal_of=a.id);
 END IF;
 IF capacity IS NULL THEN RAISE EXCEPTION 'Unverifiable payroll earning source' USING ERRCODE='23514'; END IF;
 RETURN capacity;
END $f$;
CREATE FUNCTION public.payroll_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE source public.employee_payroll_sources%ROWTYPE; key text; employee text; capacity numeric; claimed numeric; released numeric;
BEGIN
 IF TG_TABLE_NAME='employee_payroll_sources' THEN source:=NEW;
 ELSE SELECT * INTO source FROM public.employee_payroll_sources WHERE id=NEW.source_id; END IF;
 PERFORM public.payroll_lock(source.draft_id);
 key:=source.source_key;PERFORM pg_advisory_xact_lock(180042,hashtext(key));
 SELECT employee_id INTO employee FROM public.employee_payroll_drafts WHERE id=source.draft_id;
 capacity:=public.payroll_source_capacity(key,employee);
 IF TG_TABLE_NAME='payroll_source_releases' AND NOT EXISTS(SELECT 1 FROM public.payroll_corrections WHERE id=NEW.correction_id AND root_draft_id=public.payroll_root(source.draft_id)) THEN RAISE EXCEPTION 'Source release correction belongs to another payroll' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(s.amount),0) INTO claimed FROM public.employee_payroll_sources s WHERE s.source_key=key;
 SELECT coalesce(sum(r.amount),0) INTO released FROM public.payroll_source_releases r JOIN public.employee_payroll_sources s ON s.id=r.source_id WHERE s.source_key=key;
 IF TG_TABLE_NAME='employee_payroll_sources' THEN
  IF source.kind IS DISTINCT FROM (CASE WHEN left(key,4)='TIP:' THEN 'TIP' ELSE 'COMMISSION' END)
  OR sign(source.amount)<>sign(capacity) OR abs(claimed-released+source.amount)>abs(capacity)
  THEN RAISE EXCEPTION 'Earning source already consumed or wrong sign/kind' USING ERRCODE='23514'; END IF;
 ELSE
  IF sign(NEW.amount)<>sign(source.amount) OR abs(NEW.amount)+abs((SELECT coalesce(sum(amount),0) FROM public.payroll_source_releases WHERE source_id=source.id))>abs(source.amount)
  THEN RAISE EXCEPTION 'Source release exceeds original claim' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_source_claim BEFORE INSERT ON employee_payroll_sources FOR EACH ROW EXECUTE FUNCTION payroll_source_guard();
CREATE TRIGGER payroll_source_release BEFORE INSERT ON payroll_source_releases FOR EACH ROW EXECUTE FUNCTION payroll_source_guard();

CREATE OR REPLACE FUNCTION public.employee_advance_recovery_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE total numeric; prior numeric; owner text; recipient text;
BEGIN
 PERFORM public.payroll_lock(NEW.draft_id);
 PERFORM pg_advisory_xact_lock(180028,hashtext(NEW.advance_id::text));
 SELECT amount,employee_id INTO total,owner FROM public.employee_salary_advances WHERE id=NEW.advance_id FOR UPDATE;
 SELECT employee_id INTO recipient FROM public.employee_payroll_drafts WHERE id=NEW.draft_id;
 SELECT coalesce(sum(r.amount),0)-(SELECT coalesce(sum(v.amount),0) FROM public.payroll_advance_reversals v JOIN public.employee_advance_recoveries r2 ON r2.id=v.recovery_id WHERE r2.advance_id=NEW.advance_id) INTO prior FROM public.employee_advance_recoveries r WHERE r.advance_id=NEW.advance_id;
 IF owner IS DISTINCT FROM recipient OR total IS NULL OR prior<0 OR prior+NEW.amount>total
 THEN RAISE EXCEPTION 'Advance recovery exceeds available balance' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE FUNCTION public.payroll_advance_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE original public.employee_advance_recoveries%ROWTYPE; restored numeric;
BEGIN
 SELECT * INTO original FROM public.employee_advance_recoveries WHERE id=NEW.recovery_id;
 PERFORM public.payroll_lock(original.draft_id);
 PERFORM pg_advisory_xact_lock(180028,hashtext(original.advance_id::text));
 SELECT coalesce(sum(amount),0) INTO restored FROM public.payroll_advance_reversals WHERE recovery_id=original.id;
 IF NOT EXISTS(SELECT 1 FROM public.payroll_corrections WHERE id=NEW.correction_id AND root_draft_id=public.payroll_root(original.draft_id)) OR restored+NEW.amount>original.amount OR NOT EXISTS(SELECT 1 FROM public.accounting_adjustments WHERE id=NEW.accounting_adjustment_id AND kind='PAYROLL_RECOVERY_REVERSAL' AND payroll_correction_id=NEW.correction_id)
 THEN RAISE EXCEPTION 'Invalid advance recovery reversal' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_advance_reversal BEFORE INSERT ON payroll_advance_reversals FOR EACH ROW EXECUTE FUNCTION payroll_advance_reversal_guard();

CREATE FUNCTION public.payroll_journal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE original public.accounting_adjustments%ROWTYPE;
BEGIN
 IF NEW.payroll_id IS NULL THEN RETURN NEW; END IF;
 PERFORM public.payroll_lock(NEW.payroll_id);PERFORM public.payroll_open_date(NEW.posting_date);
 IF NEW.kind IN ('PAYROLL_ACCRUAL','PAYROLL_RECOVERIES','PAYROLL_SETTLEMENT') THEN RETURN NEW; END IF;
 IF num_nonnulls(NEW.employee_receivable_delta,NEW.employee_advance_delta,NEW.employee_overpayment_delta,NEW.employee_tip_liability_delta,NEW.other_recovery_liability_delta)<>5
 OR NEW.operating_expense_delta+NEW.cash_delta+NEW.employee_receivable_delta+NEW.employee_advance_delta+NEW.employee_overpayment_delta
 IS DISTINCT FROM NEW.payable_delta+NEW.employee_tip_liability_delta+NEW.other_recovery_liability_delta
 THEN RAISE EXCEPTION 'Payroll correction journal does not balance' USING ERRCODE='23514'; END IF;
 IF NEW.kind='PAYROLL_INSTALLMENT' THEN
  IF NEW.cash_delta>=0 OR NEW.payable_delta<>NEW.cash_delta OR NEW.operating_expense_delta<>0 OR NEW.employee_receivable_delta<>0 OR NEW.employee_advance_delta<>0 OR NEW.employee_overpayment_delta<>0 OR NEW.employee_tip_liability_delta<>0 OR NEW.other_recovery_liability_delta<>0 OR NEW.payment_method IS NULL
  THEN RAISE EXCEPTION 'Invalid salary installment' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='PAYROLL_ACCRUAL_REVERSAL' THEN
  SELECT * INTO original FROM public.accounting_adjustments WHERE id=NEW.reverses_adjustment_id;
  IF original.kind IS DISTINCT FROM 'PAYROLL_ACCRUAL' OR original.payroll_id IS DISTINCT FROM NEW.payroll_id OR NEW.operating_expense_delta IS DISTINCT FROM -original.operating_expense_delta OR NEW.payable_delta IS DISTINCT FROM -original.payable_delta OR NEW.cash_delta<>0 OR NEW.employee_receivable_delta<>0 OR NEW.employee_advance_delta<>0 OR NEW.employee_overpayment_delta<>0 OR NEW.other_recovery_liability_delta<>0
  THEN RAISE EXCEPTION 'Accrual reversal must exactly negate original' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='PAYROLL_CORRECTION' THEN
  IF NEW.cash_delta<>0 OR NEW.employee_receivable_delta<>0 OR NEW.employee_advance_delta<>0 OR NEW.employee_overpayment_delta<>0 OR NEW.other_recovery_liability_delta<>0 THEN RAISE EXCEPTION 'Earnings correction cannot fabricate asset/cash changes' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind IN ('PAYROLL_RECOVERY_REVERSAL','PAYROLL_CORRECTION_RECOVERY') THEN
  IF NEW.cash_delta<>0 OR NEW.operating_expense_delta<>0 OR NEW.employee_tip_liability_delta<>0 OR (NEW.kind='PAYROLL_RECOVERY_REVERSAL' AND (NEW.payable_delta<=0 OR NEW.employee_receivable_delta<0 OR NEW.employee_advance_delta<0)) OR (NEW.kind='PAYROLL_CORRECTION_RECOVERY' AND NEW.payable_delta>=0)
  THEN RAISE EXCEPTION 'Invalid noncash recovery correction' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='PAYROLL_OVERPAYMENT' THEN
  IF NEW.operating_expense_delta<>0 OR NEW.cash_delta<>0 OR NEW.employee_overpayment_delta<=0 OR NEW.payable_delta<>NEW.employee_overpayment_delta OR NEW.employee_receivable_delta<>0 OR NEW.employee_advance_delta<>0 OR NEW.employee_tip_liability_delta<>0 OR NEW.other_recovery_liability_delta<>0 THEN RAISE EXCEPTION 'Invalid overpayment reclassification' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='PAYROLL_OVERPAYMENT_ADJUSTMENT' THEN
  IF NEW.operating_expense_delta<>0 OR NEW.cash_delta<>0 OR NEW.employee_overpayment_delta=0 OR NEW.payable_delta<>NEW.employee_overpayment_delta OR NEW.employee_receivable_delta<>0 OR NEW.employee_advance_delta<>0 OR NEW.employee_tip_liability_delta<>0 OR NEW.other_recovery_liability_delta<>0 THEN RAISE EXCEPTION 'Invalid approved overpayment claim adjustment' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='PAYROLL_OVERPAYMENT_RECOVERY' THEN
  IF NEW.operating_expense_delta<>0 OR NEW.employee_overpayment_delta>=0 OR NEW.employee_receivable_delta<>0 OR NEW.employee_advance_delta<>0 OR NEW.employee_tip_liability_delta<>0 OR NEW.other_recovery_liability_delta<>0 OR NOT ((NEW.cash_delta=-NEW.employee_overpayment_delta AND NEW.payable_delta=0) OR (NEW.cash_delta=0 AND NEW.payable_delta=NEW.employee_overpayment_delta)) THEN RAISE EXCEPTION 'Invalid authorized overpayment recovery' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.kind<>'PAYROLL_INSTALLMENT' AND NEW.payroll_correction_id IS NULL AND NEW.kind<>'PAYROLL_OVERPAYMENT_RECOVERY'
 THEN RAISE EXCEPTION 'Correction provenance is required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_journal BEFORE INSERT ON accounting_adjustments FOR EACH ROW EXECUTE FUNCTION payroll_journal_guard();

CREATE FUNCTION public.payroll_overpayment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE claim public.payroll_overpayment_claims%ROWTYPE; recovered numeric; journal public.accounting_adjustments%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='payroll_overpayment_claims' THEN claim:=NEW;
 ELSE SELECT * INTO claim FROM public.payroll_overpayment_claims WHERE id=NEW.claim_id; END IF;
 PERFORM public.payroll_lock(claim.root_draft_id);
 SELECT * INTO journal FROM public.accounting_adjustments WHERE id=NEW.accounting_adjustment_id;
 IF TG_TABLE_NAME='payroll_overpayment_claims' THEN
  IF NOT EXISTS(SELECT 1 FROM public.employee_payroll_drafts WHERE id=claim.root_draft_id AND employee_id=claim.employee_id) OR public.payroll_root(journal.payroll_id) IS DISTINCT FROM claim.root_draft_id OR journal.kind IS DISTINCT FROM 'PAYROLL_OVERPAYMENT' OR journal.employee_overpayment_delta IS DISTINCT FROM NEW.amount OR journal.payroll_correction_id IS DISTINCT FROM NEW.correction_id
  THEN RAISE EXCEPTION 'Overpayment claim lacks matching journal' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT coalesce(sum(amount),0) INTO recovered FROM public.payroll_overpayment_recoveries WHERE claim_id=claim.id;
  IF NOT EXISTS(SELECT 1 FROM public.employee_payroll_drafts WHERE id=journal.payroll_id AND employee_id=claim.employee_id) OR NEW.approved_by_id=claim.employee_id OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=NEW.approved_by_id AND role='MANAGER' AND "isActive") OR recovered+NEW.amount>claim.amount+(SELECT coalesce(sum(amount),0) FROM public.payroll_overpayment_claim_adjustments WHERE claim_id=claim.id) OR journal.kind IS DISTINCT FROM 'PAYROLL_OVERPAYMENT_RECOVERY' OR journal.employee_overpayment_delta IS DISTINCT FROM -NEW.amount
  OR (NEW.method='PAYROLL_AUTHORIZED' AND (journal.payroll_id IS DISTINCT FROM NEW.recovery_draft_id OR journal.cash_delta<>0 OR journal.payable_delta<>-NEW.amount))
  OR (NEW.method<>'PAYROLL_AUTHORIZED' AND (journal.cash_delta<>NEW.amount OR journal.payable_delta<>0))
  THEN RAISE EXCEPTION 'Overpayment recovery exceeds claim or lacks authorized posting' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_overpayment_claim BEFORE INSERT ON payroll_overpayment_claims FOR EACH ROW EXECUTE FUNCTION payroll_overpayment_guard();
CREATE TRIGGER payroll_overpayment_recovery BEFORE INSERT ON payroll_overpayment_recoveries FOR EACH ROW EXECUTE FUNCTION payroll_overpayment_guard();

CREATE OR REPLACE FUNCTION public.employee_payroll_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE previous public.employee_payroll_events%ROWTYPE; creator text; recipient text; root uuid; active uuid; liability numeric;
BEGIN
 root:=public.payroll_lock(NEW.draft_id);
 IF EXISTS(SELECT 1 FROM public.payroll_draft_revisions WHERE original_draft_id=NEW.draft_id)
 OR EXISTS(SELECT 1 FROM public.payroll_correction_applications a JOIN public.payroll_corrections c ON c.id=a.correction_id WHERE a.root_draft_id=root AND c.mode='REVERSE_UNPAID' AND a.version=(SELECT max(version) FROM public.payroll_correction_applications WHERE root_draft_id=root))
 THEN RAISE EXCEPTION 'Payroll has been replaced or reversed' USING ERRCODE='23514'; END IF;
 SELECT effective_draft_id INTO active FROM public.payroll_correction_applications WHERE root_draft_id=root ORDER BY version DESC LIMIT 1;
 IF active IS NOT NULL AND active<>NEW.draft_id THEN RAISE EXCEPTION 'Use current corrected payroll version' USING ERRCODE='23514'; END IF;
 SELECT actor_id,employee_id INTO creator,recipient FROM public.employee_payroll_drafts WHERE id=NEW.draft_id;
 SELECT * INTO previous FROM public.employee_payroll_events WHERE draft_id=NEW.draft_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.sequence<>coalesce(previous.sequence,0)+1 OR NOT (
 (coalesce(previous.status,'DRAFT')='DRAFT' AND NEW.status IN ('REVIEW','CANCEL'))
 OR(previous.status='REVIEW' AND NEW.status IN ('APPROVE','CANCEL'))
 OR(previous.status='APPROVE' AND NEW.status='CONFIRM_DEDUCTIONS')
 OR(previous.status IN ('CONFIRM_DEDUCTIONS','PARTIALLY_PAID') AND NEW.status IN ('PARTIALLY_PAID','RECORD_PAYMENT'))
 OR(previous.status='RECORD_PAYMENT' AND NEW.status='COMPLETE')
 OR(previous.status IN ('RECORD_PAYMENT','COMPLETE') AND NEW.status IN ('PARTIALLY_PAID','RECORD_PAYMENT') AND (NEW.metadata->>'correctionVersion')::integer>(coalesce(previous.metadata->>'correctionVersion','0'))::integer AND (NEW.metadata->>'correctionVersion')::integer=(SELECT max(version) FROM public.payroll_correction_applications WHERE root_draft_id=root)))
 THEN RAISE EXCEPTION 'Invalid payroll transition/version' USING ERRCODE='23514'; END IF;
 IF NEW.status='APPROVE' AND NEW.actor_id IN (creator,recipient) THEN RAISE EXCEPTION 'Independent payroll approval required' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(payable_delta),0) INTO liability FROM public.accounting_adjustments WHERE payroll_id IS NOT NULL AND public.payroll_root(payroll_id)=root;
 IF (NEW.status IN ('RECORD_PAYMENT','COMPLETE') AND liability<>0) OR (NEW.status='PARTIALLY_PAID' AND liability<=0) THEN RAISE EXCEPTION 'Payroll payout status does not reconcile' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;

-- Existing journals remain the only monetary source of truth. Deferred checks see
-- all rows in the atomic operation and reject orphan payouts/claims/applications.
CREATE FUNCTION public.payroll_commit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE root uuid; liability numeric; correction uuid; request public.payroll_corrections%ROWTYPE; journal public.accounting_adjustments%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='payroll_correction_applications' THEN
  correction:=NEW.correction_id;root:=NEW.root_draft_id;
  SELECT * INTO request FROM public.payroll_corrections WHERE id=correction;
  IF NOT EXISTS(SELECT 1 FROM public.payroll_correction_events WHERE correction_id=correction AND status='APPLIED')
  OR (NOT EXISTS(SELECT 1 FROM public.accounting_adjustments WHERE payroll_correction_id=correction) AND NOT (request.mode='REPLACE_UNPAID' AND EXISTS(SELECT 1 FROM public.payroll_correction_applications a JOIN public.payroll_corrections c ON c.id=a.correction_id WHERE a.root_draft_id=root AND a.version=request.expected_version AND c.mode='REVERSE_UNPAID')))
  THEN RAISE EXCEPTION 'Incomplete correction application' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='accounting_adjustments' THEN
  IF NEW.payroll_id IS NULL THEN RETURN NULL; END IF;
  root:=public.payroll_root(NEW.payroll_id);journal:=NEW;
  IF NEW.kind IN ('PAYROLL_INSTALLMENT','PAYROLL_SETTLEMENT','PAYROLL_OVERPAYMENT_RECOVERY') AND NEW.cash_delta<>0 AND NOT EXISTS(SELECT 1 FROM public.employee_finance_cash WHERE accounting_adjustment_id=NEW.id)
  THEN RAISE EXCEPTION 'Journal lacks actual cash provenance' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO journal FROM public.accounting_adjustments WHERE id=NEW.accounting_adjustment_id;
  root:=public.payroll_root(journal.payroll_id);
  IF journal.cash_delta IS DISTINCT FROM (CASE WHEN NEW.direction='IN' THEN NEW.amount ELSE -NEW.amount END)
  OR journal.payment_method::text IS DISTINCT FROM NEW.method
  OR journal.shift_id IS DISTINCT FROM NEW.shift_id
  OR (NEW.overpayment_recovery_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_overpayment_recoveries WHERE id=NEW.overpayment_recovery_id AND accounting_adjustment_id=journal.id AND method=NEW.method))
  THEN RAISE EXCEPTION 'Cash provenance does not reconcile' USING ERRCODE='23514'; END IF;
 END IF;
 PERFORM public.payroll_lock(root);
 SELECT coalesce(sum(payable_delta),0) INTO liability FROM public.accounting_adjustments WHERE payroll_id IS NOT NULL AND public.payroll_root(payroll_id)=root;
 IF liability<0 THEN RAISE EXCEPTION 'Payroll liability negative; record an authorized recoverable overpayment' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $f$;
CREATE CONSTRAINT TRIGGER payroll_application_complete AFTER INSERT ON payroll_correction_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_commit_guard();
CREATE CONSTRAINT TRIGGER payroll_journal_complete AFTER INSERT ON accounting_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_commit_guard();
CREATE CONSTRAINT TRIGGER payroll_cash_complete AFTER INSERT ON employee_finance_cash DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_commit_guard();

-- All new records are immutable. No original snapshot or journal is rewritten.
DO $f$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['payroll_draft_revisions','payroll_corrections','payroll_correction_events','payroll_correction_applications','payroll_source_releases','payroll_advance_reversals','payroll_overpayment_claims','payroll_overpayment_recoveries','accounting_closed_periods'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_%I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.phase5_append_only()',name,name);
 END LOOP;
END $f$;

CREATE FUNCTION public.payroll_attendance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE entry jsonb; segment jsonb; d date; days date[]:=ARRAY[]::date[];
 unpaid numeric:=0; part_unpaid numeric; fraction numeric; profile public.employee_salary_profiles%ROWTYPE;
BEGIN
 IF NEW.salary_segments IS NULL THEN
  IF NEW.attendance_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Attendance requires segmented snapshot' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 PERFORM 1 FROM public.users WHERE id=NEW.employee_id FOR SHARE;
 IF NEW.attendance_snapshot IS DISTINCT FROM NEW.snapshot->'salaryProfileSnapshot'->'attendance'
 AND NOT (NEW.attendance_snapshot IS NULL AND NEW.snapshot->'salaryProfileSnapshot'->'attendance'='null'::jsonb)
 THEN RAISE EXCEPTION 'Attendance snapshot mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.attendance_snapshot IS NULL AND NEW.missed_days>0 AND
 (jsonb_array_length(NEW.salary_segments)<>1 OR NEW.eligible_days<>NEW.calendar_days)
 THEN RAISE EXCEPTION 'Date missed/unpaid days in a segmented month' USING ERRCODE='23514'; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(coalesce(NEW.attendance_snapshot,'[]'::jsonb)) LOOP
  d:=(entry->>'date')::date;fraction:=(entry->>'fraction')::numeric;
  IF d IS NULL OR d=ANY(days) OR fraction IS NULL OR fraction<=0 OR fraction>1 OR fraction<>round(fraction,4)
  OR entry->>'kind' IS NULL OR entry->>'kind' NOT IN ('MISSED','UNPAID_LEAVE','PAID_LEAVE')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.salary_segments) x WHERE d BETWEEN (x->>'from')::date AND (x->>'to')::date)
  THEN RAISE EXCEPTION 'Invalid/duplicate attendance day' USING ERRCODE='23514'; END IF;
  days:=array_append(days,d);IF entry->>'kind'<>'PAID_LEAVE' THEN unpaid:=unpaid+fraction; END IF;
 END LOOP;
 IF NEW.attendance_snapshot IS NOT NULL AND unpaid<>NEW.missed_days THEN RAISE EXCEPTION 'Unpaid attendance total mismatch' USING ERRCODE='23514'; END IF;
 FOR segment IN SELECT value FROM jsonb_array_elements(NEW.salary_segments) LOOP
  SELECT coalesce(sum((x->>'fraction')::numeric),0) INTO part_unpaid FROM jsonb_array_elements(coalesce(NEW.attendance_snapshot,'[]'::jsonb)) x WHERE x->>'kind'<>'PAID_LEAVE' AND (x->>'date')::date BETWEEN (segment->>'from')::date AND (segment->>'to')::date;
  IF NEW.attendance_snapshot IS NOT NULL AND (segment->>'payableDays')::numeric IS DISTINCT FROM (segment->>'eligibleDays')::numeric-part_unpaid THEN RAISE EXCEPTION 'Segment attendance does not reconcile' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOR d IN SELECT generate_series(make_date(NEW.payroll_year,NEW.payroll_month,1),make_date(NEW.payroll_year,NEW.payroll_month,1)+interval '1 month - 1 day',interval '1 day')::date LOOP
  SELECT * INTO profile FROM public.employee_salary_profiles WHERE employee_id=NEW.employee_id AND effective_date<=d ORDER BY effective_date DESC,revision DESC LIMIT 1;
  SELECT value INTO segment FROM jsonb_array_elements(NEW.salary_segments) WHERE d BETWEEN (value->>'from')::date AND (value->>'to')::date;
  IF profile.id IS NOT NULL AND d>=profile.employment_start AND (profile.employment_end IS NULL OR d<=profile.employment_end) THEN
   IF segment IS NULL OR segment->>'profileId' IS DISTINCT FROM profile.id::text OR (segment->>'revision')::integer IS DISTINCT FROM profile.revision OR (segment->>'monthlyBasic')::numeric IS DISTINCT FROM profile.monthly_basic THEN RAISE EXCEPTION 'Salary segment differs from effective history' USING ERRCODE='23514'; END IF;
  ELSIF segment IS NOT NULL THEN RAISE EXCEPTION 'Segment contains non-employed day' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_attendance BEFORE INSERT ON employee_payroll_drafts FOR EACH ROW EXECUTE FUNCTION payroll_attendance_guard();

-- Overpayment receipt references share the established incoming/outgoing locks.
-- This adds collision checks, without changing existing reference guards/indexes.
CREATE FUNCTION public.payroll_reference_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE ref text;
BEGIN
 IF NEW.method::text<>'MPESA' OR NEW.reference IS NULL THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='expenses' AND to_jsonb(NEW)->>'paymentStatus'<>'PAID' THEN RETURN NEW; END IF;
 ref:=upper(btrim(NEW.reference));
 PERFORM pg_advisory_xact_lock(180025,hashtext(ref));
 PERFORM pg_advisory_xact_lock(180031,hashtext(ref));
 IF TG_TABLE_NAME='employee_finance_cash' AND to_jsonb(NEW)->>'direction'='IN' THEN
  IF EXISTS(SELECT 1 FROM public.payments WHERE method='MPESA' AND upper(btrim(reference))=ref)
  OR EXISTS(SELECT 1 FROM public.employee_finance_receipts WHERE method='MPESA' AND reference=ref)
  OR EXISTS(SELECT 1 FROM public.expenses WHERE method='MPESA' AND "paymentStatus"='PAID' AND upper(btrim(reference))=ref)
  OR EXISTS(SELECT 1 FROM public.accounting_expense_settlements WHERE method='MPESA' AND upper(btrim(reference))=ref)
  THEN RAISE EXCEPTION 'Overpayment recovery reference already recorded' USING ERRCODE='23505'; END IF;
 ELSIF EXISTS(SELECT 1 FROM public.employee_finance_cash WHERE method='MPESA' AND direction='IN' AND reference=ref) THEN
  RAISE EXCEPTION 'Reference belongs to an overpayment recovery' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $f$;
DO $f$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payments','employee_finance_receipts','employee_finance_cash','expenses','accounting_expense_settlements'] LOOP
  EXECUTE format('CREATE TRIGGER a_payroll_reference_gate BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_reference_gate()',t);
 END LOOP;
END $f$;

-- No role-specific privileges are embedded in canonical DDL. Review exact
-- runtime EXECUTE and SELECT/INSERT grants in the separate DEV/TEST files.

REVOKE EXECUTE ON FUNCTION public.core_payroll_segments_valid(jsonb,integer,integer,integer,numeric,numeric,numeric,numeric,numeric,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.payroll_root(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.payroll_lock(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.payroll_open_date(date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.payroll_source_capacity(text,text) FROM PUBLIC;

-- Corrections can adjust a previously established overpayment claim without
-- deleting it, inventing a receipt, or recovering future wages automatically.
CREATE TABLE payroll_overpayment_claim_adjustments (
 id uuid PRIMARY KEY,
 claim_id uuid NOT NULL REFERENCES payroll_overpayment_claims(id) ON DELETE RESTRICT,
 correction_id uuid NOT NULL REFERENCES payroll_correction_applications(correction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 accounting_adjustment_id text NOT NULL UNIQUE REFERENCES accounting_adjustments(id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount<>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(claim_id,correction_id)
);
CREATE INDEX payroll_claim_adjustments_claim ON payroll_overpayment_claim_adjustments(claim_id);
CREATE FUNCTION public.payroll_claim_adjustment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE claim public.payroll_overpayment_claims%ROWTYPE; remaining numeric; journal public.accounting_adjustments%ROWTYPE;
BEGIN
 SELECT * INTO claim FROM public.payroll_overpayment_claims WHERE id=NEW.claim_id;
 PERFORM public.payroll_lock(claim.root_draft_id);
 SELECT claim.amount+coalesce(sum(amount),0)-(SELECT coalesce(sum(amount),0) FROM public.payroll_overpayment_recoveries WHERE claim_id=claim.id) INTO remaining FROM public.payroll_overpayment_claim_adjustments WHERE claim_id=claim.id;
 SELECT * INTO journal FROM public.accounting_adjustments WHERE id=NEW.accounting_adjustment_id;
 IF remaining+NEW.amount<0 OR journal.kind IS DISTINCT FROM 'PAYROLL_OVERPAYMENT_ADJUSTMENT' OR journal.employee_overpayment_delta IS DISTINCT FROM NEW.amount OR journal.payroll_correction_id IS DISTINCT FROM NEW.correction_id OR NOT EXISTS(SELECT 1 FROM public.payroll_corrections WHERE id=NEW.correction_id AND root_draft_id=claim.root_draft_id)
 THEN RAISE EXCEPTION 'Claim correction exceeds unrecovered balance or lacks matching journal' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER payroll_claim_adjustment BEFORE INSERT ON payroll_overpayment_claim_adjustments FOR EACH ROW EXECUTE FUNCTION payroll_claim_adjustment_guard();
CREATE TRIGGER immutable_payroll_claim_adjustment BEFORE UPDATE OR DELETE ON payroll_overpayment_claim_adjustments FOR EACH ROW EXECUTE FUNCTION phase5_append_only();

CREATE FUNCTION public.payroll_correction_reconciles() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $f$
DECLARE correction uuid; root uuid; actual numeric; expected numeric;
BEGIN
 IF TG_TABLE_NAME='payroll_correction_events' AND to_jsonb(NEW)->>'status'<>'APPLIED' THEN RETURN NULL; END IF;
 correction:=NEW.correction_id;
 SELECT root_draft_id INTO root FROM public.payroll_corrections WHERE id=correction;
 PERFORM public.payroll_lock(root);
 IF NOT EXISTS(SELECT 1 FROM public.payroll_correction_applications WHERE correction_id=correction)
 OR NOT EXISTS(SELECT 1 FROM public.accounting_audit_events WHERE target_id=correction::text AND action='PAYROLL_CORRECTION_APPLIED')
 THEN RAISE EXCEPTION 'Applied correction lacks application/audit' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(employee_receivable_delta),0) INTO actual FROM public.accounting_adjustments WHERE payroll_correction_id=correction;
 SELECT -coalesce(sum(a."collectionDelta"),0) INTO expected FROM public.financial_adjustments a JOIN public.employee_settlement_links l ON l.adjustment_id=a.id WHERE l.payroll_correction_id=correction;
 IF actual<>expected THEN RAISE EXCEPTION 'Corrected bill assets do not reconcile' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(employee_advance_delta),0) INTO actual FROM public.accounting_adjustments WHERE payroll_correction_id=correction;
 SELECT (SELECT coalesce(sum(amount),0) FROM public.payroll_advance_reversals WHERE correction_id=correction)-(SELECT coalesce(sum(amount),0) FROM public.employee_advance_recoveries WHERE payroll_correction_id=correction) INTO expected;
 IF actual<>expected THEN RAISE EXCEPTION 'Corrected advances do not reconcile' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(employee_tip_liability_delta),0) INTO actual FROM public.accounting_adjustments WHERE payroll_correction_id=correction;
 SELECT (SELECT coalesce(sum(r.amount),0) FROM public.payroll_source_releases r JOIN public.employee_payroll_sources c ON c.id=r.source_id WHERE r.correction_id=correction AND c.kind='TIP')-(SELECT coalesce(sum(amount),0) FROM public.employee_payroll_sources WHERE payroll_correction_id=correction AND kind='TIP') INTO expected;
 IF actual<>expected THEN RAISE EXCEPTION 'Corrected tips do not reconcile' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(employee_overpayment_delta),0) INTO actual FROM public.accounting_adjustments WHERE payroll_correction_id=correction;
 SELECT (SELECT coalesce(sum(amount),0) FROM public.payroll_overpayment_claims WHERE correction_id=correction)+(SELECT coalesce(sum(amount),0) FROM public.payroll_overpayment_claim_adjustments WHERE correction_id=correction)-(SELECT coalesce(sum(r.amount),0) FROM public.payroll_overpayment_recoveries r JOIN public.accounting_adjustments j ON j.id=r.accounting_adjustment_id WHERE j.payroll_correction_id=correction) INTO expected;
 IF actual<>expected THEN RAISE EXCEPTION 'Corrected overpayments do not reconcile' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $f$;
CREATE CONSTRAINT TRIGGER payroll_application_reconciles AFTER INSERT ON payroll_correction_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_correction_reconciles();
CREATE CONSTRAINT TRIGGER payroll_event_reconciles AFTER INSERT ON payroll_correction_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_correction_reconciles();
ALTER TABLE accounting_adjustments ADD CHECK(employee_receivable_delta IS NULL OR employee_receivable_delta BETWEEN -9999999999.99 AND 9999999999.99);
ALTER TABLE accounting_adjustments ADD CHECK(employee_advance_delta IS NULL OR employee_advance_delta BETWEEN -9999999999.99 AND 9999999999.99);
ALTER TABLE accounting_adjustments ADD CHECK(employee_overpayment_delta IS NULL OR employee_overpayment_delta BETWEEN -9999999999.99 AND 9999999999.99);
ALTER TABLE accounting_adjustments ADD CHECK(employee_tip_liability_delta IS NULL OR employee_tip_liability_delta BETWEEN -9999999999.99 AND 9999999999.99);
ALTER TABLE accounting_adjustments ADD CHECK(other_recovery_liability_delta IS NULL OR other_recovery_liability_delta BETWEEN -9999999999.99 AND 9999999999.99);
ALTER TABLE payroll_source_releases ADD CHECK(amount BETWEEN -9999999999.99 AND 9999999999.99);
ALTER TABLE payroll_advance_reversals ADD CHECK(amount BETWEEN -9999999999.99 AND 9999999999.99);
ALTER TABLE payroll_overpayment_claims ADD CHECK(amount BETWEEN -9999999999.99 AND 9999999999.99);
ALTER TABLE payroll_overpayment_recoveries ADD CHECK(amount BETWEEN -9999999999.99 AND 9999999999.99);
ALTER TABLE payroll_overpayment_claim_adjustments ADD CHECK(amount BETWEEN -9999999999.99 AND 9999999999.99);

ALTER TABLE accounting_adjustments ADD CONSTRAINT payroll_legacy_typed_shape CHECK (
 kind NOT IN ('SUPPLIER_PAYMENT_REVERSAL','EXPENSE_REVERSAL','PURCHASE_CORRECTION','SUPPLIER_CREDIT_REVERSAL','PAYROLL_ACCRUAL','PAYROLL_RECOVERIES','PAYROLL_SETTLEMENT','EMPLOYEE_ADVANCE')
 OR (num_nonnulls(employee_receivable_delta,employee_advance_delta,employee_overpayment_delta,employee_tip_liability_delta,other_recovery_liability_delta,reverses_adjustment_id,payroll_correction_id)=0)
);
ALTER TABLE employee_payroll_drafts ADD CHECK(manual_basic_adjustment BETWEEN -9999999999.99 AND 9999999999.99);
COMMIT;
