-- Correct locking without granting runtime UPDATE on immutable receipt journals.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION employee_finance_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE received numeric; allocated numeric; original employee_finance_allocations%ROWTYPE;
BEGIN
 -- At READ COMMITTED the volatile trigger's queries see commits after lock wait.
 -- SERIALIZABLE detects conflicting predicates; snapshot-only REPEATABLE READ
 -- cannot safely use this append-only conservation guard and is rejected.
 IF current_setting('transaction_isolation') NOT IN ('read committed','serializable') THEN
  RAISE EXCEPTION 'Unsupported allocation transaction isolation' USING ERRCODE='25000';
 END IF;
 PERFORM pg_advisory_xact_lock(180026,hashtext(NEW.receipt_id::text));
 SELECT amount INTO received FROM employee_finance_receipts WHERE id=NEW.receipt_id;
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
COMMIT;
