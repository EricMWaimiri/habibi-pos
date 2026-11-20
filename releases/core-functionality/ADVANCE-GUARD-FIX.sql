CREATE OR REPLACE FUNCTION public.employee_advance_recovery_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE total numeric; prior numeric; owner text; recipient text;
BEGIN
 PERFORM public.payroll_lock(NEW.draft_id);
 PERFORM pg_advisory_xact_lock(180028,hashtext(NEW.advance_id::text));
 SELECT amount,employee_id INTO total,owner FROM public.employee_salary_advances WHERE id=NEW.advance_id;
 SELECT employee_id INTO recipient FROM public.employee_payroll_drafts WHERE id=NEW.draft_id;
 SELECT coalesce(sum(r.amount),0)-(SELECT coalesce(sum(v.amount),0) FROM public.payroll_advance_reversals v JOIN public.employee_advance_recoveries r2 ON r2.id=v.recovery_id WHERE r2.advance_id=NEW.advance_id) INTO prior FROM public.employee_advance_recoveries r WHERE r.advance_id=NEW.advance_id;
 IF owner IS DISTINCT FROM recipient OR total IS NULL OR prior<0 OR prior+NEW.amount>total
 THEN RAISE EXCEPTION 'Advance recovery exceeds available balance' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$
