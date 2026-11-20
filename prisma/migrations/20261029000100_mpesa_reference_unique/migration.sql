-- SQL-managed partial expression index: cash is deliberately excluded.
-- Preserve all existing payment rows and raw references. No backfill or deletion.
-- Match src/utils/payment-reference.js exactly (ECMAScript whitespace + ASCII casing).
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.payments IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payments
    WHERE method = 'MPESA' AND translate(btrim(reference, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') ~ '^[A-Z0-9]{10}$'
    GROUP BY translate(btrim(reference, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'M-Pesa duplicate references exist; review required. No records changed.';
  END IF;
END $$;
CREATE UNIQUE INDEX payments_mpesa_reference_unique
  ON public.payments ((translate(btrim(reference, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')))
  WHERE method = 'MPESA' AND translate(btrim(reference, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') ~ '^[A-Z0-9]{10}$';
COMMIT;
