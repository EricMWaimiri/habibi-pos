CREATE OR REPLACE FUNCTION public.payroll_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE source public.employee_payroll_sources%ROWTYPE; key text; employee text; capacity numeric; claimed numeric; released numeric;
BEGIN
 IF TG_TABLE_NAME='employee_payroll_sources' THEN source:=NEW;
 ELSE SELECT * INTO source FROM public.employee_payroll_sources WHERE id=NEW.source_id; END IF;
 PERFORM public.payroll_lock(source.draft_id);
 key:=source.source_key;PERFORM pg_advisory_xact_lock(180042,hashtext(key));
 SELECT employee_id INTO employee FROM public.employee_payroll_drafts WHERE id=source.draft_id;
 capacity:=public.payroll_source_capacity(key,employee);
 IF TG_TABLE_NAME='payroll_source_releases' THEN
  IF NOT EXISTS(SELECT 1 FROM public.payroll_corrections WHERE id=NEW.correction_id AND root_draft_id=public.payroll_root(source.draft_id)) THEN RAISE EXCEPTION 'Source release correction belongs to another payroll' USING ERRCODE='23514'; END IF;
 END IF;
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
END $function$
