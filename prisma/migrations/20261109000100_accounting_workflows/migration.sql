-- Additive workflow storage. Historical migrations and financial rows are unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE suppliers ADD COLUMN details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object');
CREATE UNIQUE INDEX suppliers_name_unique ON suppliers(lower(btrim(name)));
ALTER TABLE expenses ADD COLUMN "paymentStatus" text NOT NULL DEFAULT 'PAID' CHECK("paymentStatus" IN ('PAID','UNPAID')),
 ADD COLUMN "supplierId" text REFERENCES suppliers(id) ON DELETE RESTRICT,
 ADD COLUMN reference text;
CREATE UNIQUE INDEX accounting_paid_expense_mpesa_reference ON expenses(lower(btrim(reference))) WHERE method='MPESA' AND "paymentStatus"='PAID' AND reference IS NOT NULL;
ALTER TABLE accounting_adjustments ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 ADD COLUMN payment_method "PaymentMethod";
CREATE TABLE accounting_documents (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN('PURCHASE','EXPENSE')),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','POSTED','CANCELLED')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 purchase_id text UNIQUE REFERENCES purchases(id) ON DELETE RESTRICT,
 expense_id text UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(purchase_id,expense_id)<=1),
 CHECK((status='POSTED' AND num_nonnulls(purchase_id,expense_id)=1) OR (status<>'POSTED' AND num_nonnulls(purchase_id,expense_id)=0))
);
CREATE INDEX accounting_documents_browse ON accounting_documents(kind,status,created_at,id);
CREATE TABLE accounting_allocation_reversals (
 id text PRIMARY KEY,
 payment_allocation_id text UNIQUE REFERENCES supplier_payment_allocations(id) ON DELETE RESTRICT,
 credit_allocation_id text UNIQUE REFERENCES supplier_credit_allocations(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(btrim(reason))>=3),
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 approved_by_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 posting_date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(payment_allocation_id,credit_allocation_id)=1)
);
-- A reversed allocation can be replaced by another immutable allocation row.
-- Only the pair uniqueness changes; each allocation retains its original ID/FKs.
ALTER TABLE supplier_payment_allocations DROP CONSTRAINT supplier_payment_allocations_payment_id_purchase_id_key;
ALTER TABLE supplier_credit_allocations DROP CONSTRAINT supplier_credit_allocations_credit_note_id_purchase_id_key;
CREATE TABLE accounting_supplier_openings (
 id text PRIMARY KEY, supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount<>0), posting_date date NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>=3),
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 approved_by_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE accounting_credit_items (
 id text PRIMARY KEY, credit_note_id text NOT NULL REFERENCES supplier_credit_notes(id) ON DELETE RESTRICT,
 purchase_item_id text NOT NULL REFERENCES purchase_items(id) ON DELETE RESTRICT,
 original_movement_id text NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
 quantity numeric(12,6) NOT NULL CHECK(quantity>0), amount numeric(12,2) NOT NULL CHECK(amount>0),
 movement_id text NOT NULL UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(credit_note_id,purchase_item_id)
);
CREATE TABLE accounting_expense_settlements (
 id text PRIMARY KEY, expense_id text NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount>0), method "PaymentMethod" NOT NULL,
 reference text, actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 posting_date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounting_expense_settlement_mpesa_reference ON accounting_expense_settlements(lower(btrim(reference))) WHERE method='MPESA' AND reference IS NOT NULL;
CREATE INDEX accounting_expense_settlements_shift ON accounting_expense_settlements(shift_id,posting_date);
ALTER TABLE accounting_approval_requests DROP CONSTRAINT accounting_approval_requests_action_check;
ALTER TABLE accounting_approval_requests ADD CONSTRAINT accounting_approval_requests_action_check CHECK(action IN(
 'SUPPLIER_PAYMENT_REVERSE','SUPPLIER_CREDIT','SUPPLIER_CREDIT_REVERSE','PURCHASE_CORRECT','EXPENSE_REVERSE',
 'PURCHASE_POST','EXPENSE_CORRECT','SUPPLIER_OPENING','ALLOCATION_REVERSE'));
CREATE FUNCTION accounting_document_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'DRAFT' OR NEW.actor_id<>OLD.actor_id OR NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at OR NEW.id<>OLD.id
 THEN RAISE EXCEPTION 'Only draft documents can be revised; posted history is immutable'; END IF;
 IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Draft revision must advance once'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER accounting_document_transition BEFORE UPDATE OR DELETE ON accounting_documents FOR EACH ROW EXECUTE FUNCTION accounting_document_transition();
CREATE TRIGGER accounting_allocation_reversals_immutable BEFORE UPDATE OR DELETE ON accounting_allocation_reversals FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER accounting_supplier_openings_immutable BEFORE UPDATE OR DELETE ON accounting_supplier_openings FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER accounting_credit_items_immutable BEFORE UPDATE OR DELETE ON accounting_credit_items FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
CREATE TRIGGER accounting_expense_settlements_immutable BEFORE UPDATE OR DELETE ON accounting_expense_settlements FOR EACH ROW EXECUTE FUNCTION accounting_append_only();
COMMIT;
