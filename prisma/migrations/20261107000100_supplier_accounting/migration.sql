-- REVIEW ONLY: proposed migration23, 20261107000100_supplier_accounting.
-- NOT installed in a Prisma migration directory; NOT approved for execution.
-- Portable PostgreSQL SQL. Identity/role/checksum checks belong in the runner.
-- No historical links, balances, categories, permission grants or data backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE TABLE suppliers (
 id text PRIMARY KEY,
 reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 80),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 160),
 contact_name text, email text, phone text, address text,
 is_active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 created_by_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_reference_unique ON suppliers(lower(btrim(reference)));
CREATE INDEX suppliers_name_lookup ON suppliers(lower(name),id);

CREATE TABLE expense_categories (
 id text PRIMARY KEY,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 80),
 kind text NOT NULL CHECK(kind IN ('OPERATING','INVENTORY_ACQUISITION')),
 is_active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 created_by_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- Inactive names remain reserved: deactivation cannot defeat duplicate checks.
CREATE UNIQUE INDEX expense_categories_name_unique ON expense_categories(lower(btrim(name)));
ALTER TABLE expenses ADD COLUMN "categoryId" text REFERENCES expense_categories(id) ON DELETE RESTRICT,
 ADD COLUMN "categoryKindSnapshot" text CHECK("categoryKindSnapshot" IN ('OPERATING','INVENTORY_ACQUISITION'));
ALTER TABLE expenses ADD CONSTRAINT expenses_category_snapshot_pair CHECK(("categoryId" IS NULL)=("categoryKindSnapshot" IS NULL));
CREATE INDEX expenses_category_id_date ON expenses("categoryId","createdAt",id);
-- Existing Expense.category remains the original name snapshot, never renamed.

ALTER TABLE purchases ADD COLUMN "supplierId" text REFERENCES suppliers(id) ON DELETE RESTRICT,
 ADD COLUMN "settlementMode" text CHECK("settlementMode" IN ('PAID_AT_ENTRY','ON_ACCOUNT'));
-- Both fields remain NULL for all existing purchases. No inferred supplier debt.
CREATE INDEX purchases_supplier_date ON purchases("supplierId","createdAt",id);

CREATE TABLE accounting_write_receipts (
 id uuid PRIMARY KEY,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 operation text NOT NULL CHECK(length(operation) BETWEEN 1 AND 64),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 result_ids jsonb NOT NULL CHECK(jsonb_typeof(result_ids)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Results contain IDs only, not cached sensitive response projections or PINs.

CREATE TABLE accounting_approval_requests (
 id text PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE,
 requester_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN ('SUPPLIER_PAYMENT_REVERSE','SUPPLIER_CREDIT','SUPPLIER_CREDIT_REVERSE','PURCHASE_CORRECT','EXPENSE_REVERSE')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 reason text NOT NULL CHECK(length(btrim(reason))>=3),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
 decided_by_id text REFERENCES users(id) ON DELETE RESTRICT,
 decision_reason text, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
 CHECK((status='PENDING' AND decided_by_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
   OR(status<>'PENDING' AND decided_by_id IS NOT NULL AND decided_by_id<>requester_id AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND length(btrim(decision_reason))>=3))
);
CREATE INDEX accounting_approval_pending ON accounting_approval_requests(status,created_at,id);

CREATE TABLE accounting_purchase_postings (
 purchase_id text PRIMARY KEY REFERENCES purchases(id) ON DELETE RESTRICT,
 supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 due_date date NOT NULL,
 posting_date date NOT NULL,
 provenance text NOT NULL CHECK(provenance='VERIFIED_NEW_TRANSACTION'),
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(purchase_id,supplier_id)
);
-- Only NEW verified atomic workflows post here; legacy rows are not inserted.
CREATE INDEX accounting_purchase_due ON accounting_purchase_postings(supplier_id,due_date,purchase_id);

CREATE TABLE supplier_payments (
 id text PRIMARY KEY,
 supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 method "PaymentMethod" NOT NULL,
 reference text CHECK(reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 100),
 paid_at timestamptz NOT NULL,
 posting_date date NOT NULL,
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 expense_id text NOT NULL UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,supplier_id)
);
CREATE UNIQUE INDEX supplier_payments_mpesa_reference_unique ON supplier_payments(lower(btrim(reference))) WHERE method='MPESA' AND reference IS NOT NULL;
CREATE INDEX supplier_payments_period ON supplier_payments(supplier_id,posting_date,id);

CREATE TABLE supplier_payment_allocations (
 id text PRIMARY KEY,
 payment_id text NOT NULL,
 purchase_id text NOT NULL,
 supplier_id text NOT NULL,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(payment_id,supplier_id) REFERENCES supplier_payments(id,supplier_id) ON DELETE RESTRICT,
 FOREIGN KEY(purchase_id,supplier_id) REFERENCES accounting_purchase_postings(purchase_id,supplier_id) ON DELETE RESTRICT,
 UNIQUE(payment_id,purchase_id)
);
CREATE INDEX supplier_payment_allocations_invoice ON supplier_payment_allocations(purchase_id,id);

CREATE TABLE supplier_credit_notes (
 id text PRIMARY KEY,
 supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
 purchase_id text,
 reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 100),
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 credit_date date NOT NULL,
 posting_date date NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>=3),
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 requester_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 approved_by_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 approval_mode text NOT NULL CHECK(approval_mode IN ('MANAGER_DIRECT','APPROVED_REQUEST')),
 approval_request_id text UNIQUE REFERENCES accounting_approval_requests(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(purchase_id,supplier_id) REFERENCES accounting_purchase_postings(purchase_id,supplier_id) ON DELETE RESTRICT,
 CHECK((approval_mode='MANAGER_DIRECT' AND approval_request_id IS NULL AND requester_id=approved_by_id)
   OR(approval_mode='APPROVED_REQUEST' AND approval_request_id IS NOT NULL AND requester_id<>approved_by_id)),
 UNIQUE(id,supplier_id)
);
CREATE UNIQUE INDEX supplier_credit_reference_unique ON supplier_credit_notes(supplier_id,lower(btrim(reference)));

CREATE TABLE supplier_credit_allocations (
 id text PRIMARY KEY,
 credit_note_id text NOT NULL,
 purchase_id text NOT NULL,
 supplier_id text NOT NULL,
 amount numeric(12,2) NOT NULL CHECK(amount>0),
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(credit_note_id,supplier_id) REFERENCES supplier_credit_notes(id,supplier_id) ON DELETE RESTRICT,
 FOREIGN KEY(purchase_id,supplier_id) REFERENCES accounting_purchase_postings(purchase_id,supplier_id) ON DELETE RESTRICT,
 UNIQUE(credit_note_id,purchase_id)
);
CREATE INDEX supplier_credit_allocations_invoice ON supplier_credit_allocations(purchase_id,id);

CREATE TABLE accounting_adjustments (
 id text PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('SUPPLIER_PAYMENT_REVERSAL','EXPENSE_REVERSAL','PURCHASE_CORRECTION','SUPPLIER_CREDIT_REVERSAL')),
 supplier_payment_id text REFERENCES supplier_payments(id) ON DELETE RESTRICT,
 expense_id text REFERENCES expenses(id) ON DELETE RESTRICT,
 purchase_id text REFERENCES purchases(id) ON DELETE RESTRICT,
 credit_note_id text REFERENCES supplier_credit_notes(id) ON DELETE RESTRICT,
 payable_delta numeric(12,2) NOT NULL DEFAULT 0,
 operating_expense_delta numeric(12,2) NOT NULL DEFAULT 0,
 cash_delta numeric(12,2) NOT NULL DEFAULT 0,
 reason text NOT NULL CHECK(length(btrim(reason))>=3),
 posting_date date NOT NULL,
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 approved_by_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 approval_request_id text UNIQUE REFERENCES accounting_approval_requests(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(supplier_payment_id,expense_id,purchase_id,credit_note_id)=1),
 CHECK((kind='SUPPLIER_PAYMENT_REVERSAL' AND supplier_payment_id IS NOT NULL)
    OR(kind='EXPENSE_REVERSAL' AND expense_id IS NOT NULL)
    OR(kind='PURCHASE_CORRECTION' AND purchase_id IS NOT NULL)
    OR(kind='SUPPLIER_CREDIT_REVERSAL' AND credit_note_id IS NOT NULL)),
 CHECK((approval_request_id IS NULL AND actor_id=approved_by_id)
    OR(approval_request_id IS NOT NULL AND actor_id<>approved_by_id))
);
CREATE UNIQUE INDEX accounting_payment_reversed_once ON accounting_adjustments(supplier_payment_id) WHERE supplier_payment_id IS NOT NULL;
CREATE UNIQUE INDEX accounting_expense_reversed_once ON accounting_adjustments(expense_id) WHERE expense_id IS NOT NULL;
CREATE UNIQUE INDEX accounting_credit_reversed_once ON accounting_adjustments(credit_note_id) WHERE credit_note_id IS NOT NULL;
CREATE INDEX accounting_adjustments_period ON accounting_adjustments(posting_date,shift_id,id);

CREATE TABLE accounting_audit_events (
 id text PRIMARY KEY,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action text NOT NULL,
 target_type text NOT NULL,
 target_id text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>=3),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_audit_target ON accounting_audit_events(target_type,target_id,created_at,id);

CREATE FUNCTION accounting_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Accounting history is append-only';
END;
$$;
CREATE TRIGGER accounting_receipts_immutable BEFORE UPDATE OR DELETE ON accounting_write_receipts FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER accounting_postings_immutable BEFORE UPDATE OR DELETE ON accounting_purchase_postings FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER supplier_payments_immutable BEFORE UPDATE OR DELETE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER supplier_payment_allocations_immutable BEFORE UPDATE OR DELETE ON supplier_payment_allocations FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER supplier_credit_notes_immutable BEFORE UPDATE OR DELETE ON supplier_credit_notes FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER supplier_credit_allocations_immutable BEFORE UPDATE OR DELETE ON supplier_credit_allocations FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER accounting_adjustments_immutable BEFORE UPDATE OR DELETE ON accounting_adjustments FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER accounting_audit_events_immutable BEFORE UPDATE OR DELETE ON accounting_audit_events FOR EACH ROW EXECUTE FUNCTION accounting_append_only();

CREATE FUNCTION accounting_approval_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Approval history cannot be deleted'; END IF;
 IF OLD.status<>'PENDING' OR NEW.status='PENDING'
  OR (to_jsonb(NEW)-ARRAY['status','decided_by_id','decision_reason','decided_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','decided_by_id','decision_reason','decided_at'])
 THEN RAISE EXCEPTION 'Only one immutable-payload approval decision is permitted'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_approval_transition_guard BEFORE UPDATE OR DELETE ON accounting_approval_requests FOR EACH ROW EXECUTE FUNCTION accounting_approval_transition();
COMMIT;
