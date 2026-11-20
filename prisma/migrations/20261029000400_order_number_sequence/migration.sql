BEGIN;
SET LOCAL lock_timeout = '10s';
-- Protect the history preflight and allocator initialization from sale writes.
-- No existing sale, receipt reference or financial field is rewritten.
LOCK TABLE public.sales IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  highest numeric;
BEGIN
  IF to_regclass('public.order_number_seq') IS NOT NULL OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('next_order_number','format_order_number')
  ) THEN
    RAISE EXCEPTION 'Unexpected order allocator objects. Review required; no allocator reset.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales GROUP BY "saleNumber" HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicate historical order numbers. Review required; no renumbering.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
    WHERE n.nspname='public' AND t.relname='sales' AND idx.relname='sales_saleNumber_key'
      AND a.attname='saleNumber' AND i.indisunique AND i.indisvalid
      AND i.indnkeyatts=1 AND i.indpred IS NULL AND i.indexprs IS NULL
  ) THEN RAISE EXCEPTION 'Expected order uniqueness index is missing or invalid.'; END IF;
  -- All dates/statuses, including nonstandard date/padding with numeric suffix.
  -- Nonmatching legacy identifiers are preserved and cannot equal new output.
  IF EXISTS (
    SELECT 1 FROM (SELECT regexp_match("saleNumber", '^HAB-([0-9]{8})-([0-9]+)$') AS parts FROM public.sales) p
    WHERE parts IS NOT NULL AND length(ltrim(parts[2],'0'))>19
  ) THEN RAISE EXCEPTION 'Historical suffix exceeds bigint bounds. Review required.'; END IF;
  SELECT coalesce(max(coalesce(nullif(ltrim(parts[2],'0'),''),'0')::numeric),0) INTO highest
  FROM (SELECT regexp_match("saleNumber", '^HAB-([0-9]{8})-([0-9]+)$') AS parts FROM public.sales) p WHERE parts IS NOT NULL;
  IF highest>=9223372036854775807 THEN RAISE EXCEPTION 'Order sequence cannot be initialized safely.'; END IF;
  EXECUTE format('CREATE SEQUENCE public.order_number_seq AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH %s CACHE 1 NO CYCLE', highest+1);
END $$;

-- Testable pure formatter: no allocation, date/session timezone assumptions,
-- daily reset, floating point conversion or four-digit truncation.
CREATE FUNCTION public.format_order_number(suffix bigint, issued_at timestamptz)
RETURNS text LANGUAGE sql STABLE STRICT AS $$
  SELECT 'HAB-' || to_char(issued_at AT TIME ZONE 'Africa/Nairobi','YYYYMMDD') || '-' ||
    lpad(suffix::text, greatest(4,length(suffix::text)), '0')
$$;
CREATE FUNCTION public.next_order_number()
RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  issued_at timestamptz := clock_timestamp();
  suffix bigint;
BEGIN
  suffix := nextval('public.order_number_seq'::regclass);
  RETURN public.format_order_number(suffix, issued_at);
END $$;
ALTER TABLE public.sales ALTER COLUMN "saleNumber" SET DEFAULT public.next_order_number();
COMMIT;
