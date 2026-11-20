-- REVIEW ONLY. Portable additive successor to installed TEST29. No execution authorized.
-- No historical updates, seeds, grants, SECURITY DEFINER, extensions or role names.
BEGIN;
SET LOCAL search_path=public,pg_catalog;
CREATE TABLE supplier_invoice_receiving (
 purchase_id text PRIMARY KEY REFERENCES purchases(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Presence, not a backfilled default, distinguishes new separate-receiving invoices.
CREATE TABLE supplier_goods_receipts (
 id uuid PRIMARY KEY,
 purchase_id text NOT NULL REFERENCES supplier_invoice_receiving(purchase_id) ON DELETE RESTRICT,
 creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 reverses_id uuid UNIQUE REFERENCES supplier_goods_receipts(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 shift_id text NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
 posting_date date NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_goods_receipts_invoice ON supplier_goods_receipts(purchase_id,created_at,id);
CREATE TABLE supplier_goods_receipt_lines (
 id uuid PRIMARY KEY,
 receipt_id uuid NOT NULL REFERENCES supplier_goods_receipts(id) ON DELETE RESTRICT,
 purchase_item_id text NOT NULL REFERENCES purchase_items(id) ON DELETE RESTRICT,
 quantity numeric(12,6) NOT NULL CHECK(quantity<>0),
 amount numeric(12,2) NOT NULL,
 movement_id text NOT NULL UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
 UNIQUE(receipt_id,purchase_item_id),
 CHECK((quantity>0 AND amount>=0) OR (quantity<0 AND amount<=0))
);
CREATE INDEX supplier_goods_receipt_lines_item ON supplier_goods_receipt_lines(purchase_item_id,receipt_id);

CREATE TABLE business_day_policies (
 id uuid PRIMARY KEY,
 version integer NOT NULL UNIQUE CHECK(version>0),
 start_minute integer NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),
 effective_date date NOT NULL UNIQUE,
 timezone text NOT NULL DEFAULT 'Africa/Nairobi' CHECK(timezone='Africa/Nairobi'),
 previous_id uuid UNIQUE REFERENCES business_day_policies(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Explicit half-open intervals remove ambiguity at a changed start time.
CREATE TABLE business_day_periods (
 id uuid PRIMARY KEY,
 policy_id uuid NOT NULL REFERENCES business_day_policies(id) ON DELETE RESTRICT,
 business_date date NOT NULL UNIQUE,
 starts_at timestamptz NOT NULL UNIQUE,
 ends_at timestamptz NOT NULL UNIQUE,
 CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '48 hours')
);
ALTER TABLE shifts ADD COLUMN business_day_period_id uuid REFERENCES business_day_periods(id) ON DELETE RESTRICT;
-- NULL remains legacy calendar-midnight; no historical shift is changed.
CREATE INDEX shifts_business_day_period ON shifts(business_day_period_id);

CREATE FUNCTION receiving_marker_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('invoice-receiving:'||NEW.purchase_id,0));
 IF NOT EXISTS(SELECT 1 FROM accounting_purchase_postings p WHERE p.purchase_id=NEW.purchase_id)
 OR EXISTS(SELECT 1 FROM purchase_items i JOIN stock_movements m ON m."purchaseItemId"=i.id WHERE i."purchaseId"=NEW.purchase_id)
 THEN RAISE EXCEPTION 'Separate receiving requires a posted invoice without legacy stock receipts' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receiving_marker_checked BEFORE INSERT ON supplier_invoice_receiving FOR EACH ROW EXECUTE FUNCTION receiving_marker_guard();

CREATE FUNCTION goods_receipt_complete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE rid uuid; h supplier_goods_receipts%ROWTYPE; i record; received numeric; valued numeric; original supplier_goods_receipts%ROWTYPE;
BEGIN
 rid:=CASE WHEN TG_TABLE_NAME='supplier_goods_receipts' THEN NEW.id ELSE NEW.receipt_id END;
 SELECT * INTO STRICT h FROM supplier_goods_receipts WHERE id=rid;
 IF h.creation_xid<>pg_current_xact_id() THEN RAISE EXCEPTION 'Receipt lines must be sealed in the header transaction' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('invoice-receiving:'||h.purchase_id,0));
 IF NOT EXISTS(SELECT 1 FROM supplier_goods_receipt_lines WHERE receipt_id=rid) THEN RAISE EXCEPTION 'Receipt requires lines' USING ERRCODE='23514'; END IF;
 IF h.reverses_id IS NOT NULL THEN
  SELECT * INTO STRICT original FROM supplier_goods_receipts WHERE id=h.reverses_id;
  IF original.reverses_id IS NOT NULL OR original.purchase_id<>h.purchase_id
  OR (SELECT count(*) FROM supplier_goods_receipt_lines WHERE receipt_id=rid)<>(SELECT count(*) FROM supplier_goods_receipt_lines WHERE receipt_id=original.id)
  THEN RAISE EXCEPTION 'Invalid receipt reversal' USING ERRCODE='23514'; END IF;
 END IF;
 FOR i IN SELECT l.*,p."purchaseId",p."productId",p.quantity AS ordered,p."unitCost",m."productId" AS movement_product,m."quantityChange",m."quantityAfter",m."previousQty",m."purchaseItemId",m.type::text AS movement_type,m."userId"
 FROM supplier_goods_receipt_lines l JOIN purchase_items p ON p.id=l.purchase_item_id JOIN stock_movements m ON m.id=l.movement_id WHERE l.receipt_id=rid ORDER BY p.id LOOP
  IF i."purchaseId"<>h.purchase_id OR i."productId"<>i.movement_product OR i.quantity<>i."quantityChange"
   OR i."quantityAfter"-i."previousQty"<>i.quantity OR i."purchaseItemId" IS NOT NULL OR i."userId" IS DISTINCT FROM h.actor_id
   OR (i.quantity>0 AND i.movement_type<>'IN') OR (i.quantity<0 AND i.movement_type<>'OUT')
  THEN RAISE EXCEPTION 'Receipt/movement mismatch' USING ERRCODE='23514'; END IF;
  IF h.reverses_id IS NULL AND i.quantity<=0 THEN RAISE EXCEPTION 'Receipt quantity must be positive' USING ERRCODE='23514'; END IF;
  IF h.reverses_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM supplier_goods_receipt_lines o WHERE o.receipt_id=h.reverses_id AND o.purchase_item_id=i.purchase_item_id AND o.quantity=-i.quantity AND o.amount=-i.amount)
  THEN RAISE EXCEPTION 'Reversal must negate original lines exactly' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(l.quantity),0),coalesce(sum(l.amount),0) INTO received,valued FROM supplier_goods_receipt_lines l WHERE l.purchase_item_id=i.purchase_item_id;
  IF received<0 OR received>i.ordered OR valued<>round(received*i."unitCost",2)
  THEN RAISE EXCEPTION 'Receipt exceeds authorized quantity or valuation does not reconcile' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER goods_receipt_complete AFTER INSERT ON supplier_goods_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION goods_receipt_complete_guard();
CREATE CONSTRAINT TRIGGER goods_receipt_line_complete AFTER INSERT ON supplier_goods_receipt_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION goods_receipt_complete_guard();

CREATE FUNCTION business_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE prior business_day_policies%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('habibi-business-day-policy',0));
 SELECT * INTO prior FROM business_day_policies ORDER BY version DESC LIMIT 1;
 IF (prior.id IS NULL AND (NEW.version<>1 OR NEW.previous_id IS NOT NULL))
 OR (prior.id IS NOT NULL AND (NEW.previous_id IS DISTINCT FROM prior.id OR NEW.version<>prior.version+1 OR NEW.effective_date<=prior.effective_date))
 OR NEW.effective_date<=(clock_timestamp() AT TIME ZONE 'Africa/Nairobi')::date
 OR EXISTS(SELECT 1 FROM business_day_periods WHERE business_date>=NEW.effective_date-1)
 THEN RAISE EXCEPTION 'Policy must extend the current version prospectively before adjacent periods exist' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_policy_checked BEFORE INSERT ON business_day_policies FOR EACH ROW EXECUTE FUNCTION business_policy_guard();
CREATE FUNCTION business_period_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE policy business_day_policies%ROWTYPE; following business_day_policies%ROWTYPE; expected_end timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('habibi-business-day-policy',0));
 SELECT * INTO STRICT policy FROM business_day_policies WHERE effective_date<=NEW.business_date ORDER BY effective_date DESC LIMIT 1;
 SELECT * INTO following FROM business_day_policies WHERE effective_date=NEW.business_date+1;
 expected_end:=((NEW.business_date+1)::timestamp+make_interval(mins=>coalesce(following.start_minute,policy.start_minute))) AT TIME ZONE 'Africa/Nairobi';
 IF NEW.policy_id<>policy.id OR NEW.starts_at IS DISTINCT FROM ((NEW.business_date::timestamp+make_interval(mins=>policy.start_minute)) AT TIME ZONE 'Africa/Nairobi')
 OR NEW.ends_at IS DISTINCT FROM expected_end
 OR EXISTS(SELECT 1 FROM business_day_periods p WHERE p.starts_at<NEW.ends_at AND NEW.starts_at<p.ends_at)
 THEN RAISE EXCEPTION 'Invalid or overlapping business period' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_period_checked BEFORE INSERT ON business_day_periods FOR EACH ROW EXECUTE FUNCTION business_period_guard();

CREATE FUNCTION shift_business_period_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.business_day_period_id IS DISTINCT FROM OLD.business_day_period_id THEN RAISE EXCEPTION 'Shift business period is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.business_day_period_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business_day_periods p WHERE p.id=NEW.business_day_period_id AND NEW."openedAt">=p.starts_at AND NEW."openedAt"<p.ends_at)
 THEN RAISE EXCEPTION 'Shift opening must be within its business period' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('habibi-business-day-policy',0));
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM business_day_policies p WHERE NEW."openedAt">=(p.effective_date::timestamp+make_interval(mins=>p.start_minute)) AT TIME ZONE 'Africa/Nairobi') AND NEW.business_day_period_id IS NULL
 THEN RAISE EXCEPTION 'New shifts require the effective business period' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NEW.business_day_period_id IS NOT NULL AND EXISTS(SELECT 1 FROM shifts s WHERE s.status::text='OPEN' AND s.business_day_period_id IS DISTINCT FROM NEW.business_day_period_id)
 THEN RAISE EXCEPTION 'Close incompatible open shifts before activation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shift_business_period_checked BEFORE INSERT OR UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION shift_business_period_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['supplier_invoice_receiving','supplier_goods_receipts','supplier_goods_receipt_lines','business_day_policies','business_day_periods'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION accounting_append_only()',t||'_immutable',t);
 END LOOP;
END $$;
-- New objects must not inherit public application access.
REVOKE ALL ON supplier_invoice_receiving,supplier_goods_receipts,supplier_goods_receipt_lines,business_day_policies,business_day_periods FROM PUBLIC;
REVOKE ALL ON FUNCTION receiving_marker_guard(),goods_receipt_complete_guard(),business_policy_guard(),business_period_guard(),shift_business_period_guard() FROM PUBLIC;
COMMIT;
