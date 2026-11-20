-- Audited TEST-only timestamp interpretation correction. Existing timestamp-without-timezone values are UTC.
-- No history, ownership, permissions or financial boundary policy changes.
BEGIN;
CREATE OR REPLACE FUNCTION shift_business_period_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.business_day_period_id IS DISTINCT FROM OLD.business_day_period_id THEN RAISE EXCEPTION 'Shift business period is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.business_day_period_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business_day_periods p WHERE p.id=NEW.business_day_period_id AND (NEW."openedAt" AT TIME ZONE 'UTC')>=p.starts_at AND (NEW."openedAt" AT TIME ZONE 'UTC')<p.ends_at)
 THEN RAISE EXCEPTION 'Shift opening must be within its business period' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('habibi-business-day-policy',0));
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM business_day_policies p WHERE (NEW."openedAt" AT TIME ZONE 'UTC')>=(p.effective_date::timestamp+make_interval(mins=>p.start_minute)) AT TIME ZONE 'Africa/Nairobi') AND NEW.business_day_period_id IS NULL
 THEN RAISE EXCEPTION 'New shifts require the effective business period' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NEW.business_day_period_id IS NOT NULL AND EXISTS(SELECT 1 FROM shifts s WHERE s.status::text='OPEN' AND s.business_day_period_id IS DISTINCT FROM NEW.business_day_period_id)
 THEN RAISE EXCEPTION 'Close incompatible open shifts before activation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
COMMIT;
