-- Row locking requires UPDATE privilege; actual ID updates are prohibited.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TRIGGER immutable_stock_movement_id
BEFORE UPDATE OF id ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.phase5_append_only();
COMMIT;
