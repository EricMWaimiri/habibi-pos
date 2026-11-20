-- Portable schema DDL. Execution authorization belongs to the external controlled runner.
-- Migration 28: 20261114000100_core_administration
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';


-- One append-only table holds complete effective-dated employee profile revisions.
-- This does not update users, existing payroll drafts, journals or salary snapshots.
CREATE TABLE public.employee_salary_profiles (
 id uuid PRIMARY KEY,
 employee_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 effective_date date NOT NULL,
 employment_start date NOT NULL,
 employment_end date,
 employment_status text NOT NULL CHECK(employment_status IN ('ACTIVE','ON_LEAVE','ENDED')),
 monthly_basic numeric(12,2) NOT NULL CHECK(monthly_basic>=0),
 commission_eligible boolean NOT NULL,
 commission_rate numeric(5,2) NOT NULL CHECK(commission_rate BETWEEN 0 AND 100),
 actor_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(employee_id,revision),
 CHECK(effective_date>=employment_start),
 CHECK(employment_end IS NULL OR employment_end>=employment_start),
 CHECK(employment_status<>'ENDED' OR employment_end IS NOT NULL),
 CHECK(commission_eligible OR commission_rate=0)
);
CREATE INDEX employee_salary_profiles_asof_idx ON public.employee_salary_profiles(employee_id,effective_date DESC,revision DESC);
CREATE FUNCTION public.core_salary_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE prior integer;
BEGIN
 PERFORM id FROM public.users WHERE id=NEW.employee_id FOR NO KEY UPDATE;
 SELECT coalesce(max(revision),0) INTO prior FROM public.employee_salary_profiles WHERE employee_id=NEW.employee_id;
 IF NEW.revision<>prior+1 THEN RAISE EXCEPTION 'Salary profile revision conflict' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER core_salary_revision BEFORE INSERT ON public.employee_salary_profiles FOR EACH ROW EXECUTE FUNCTION public.core_salary_revision_guard();
CREATE TRIGGER core_salary_immutable BEFORE UPDATE OR DELETE ON public.employee_salary_profiles FOR EACH ROW EXECUTE FUNCTION public.phase5_append_only();

-- Custom business roles refine the existing immutable WAITER/CASHIER/MANAGER
-- authority tier; no PostgreSQL role, system Role enum or existing assignment changes.
CREATE TABLE public.custom_roles (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 80),
 base_role public."Role" NOT NULL,
 is_active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX custom_roles_name_key ON public.custom_roles(lower(btrim(name)));
CREATE TABLE public.custom_role_permissions (
 role_id uuid NOT NULL REFERENCES public.custom_roles(id) ON DELETE RESTRICT,
 permission text NOT NULL CHECK(permission IN ('sales.make','sales.view_all','sales.merge','sales.split','sales.discount','sales.change_price','sales.complimentary','sales.void','sales.remove_item','sales.return','receipt.print','receipt.reprint','pay.mpesa','pay.cash','pay.void','pos.summary','pos.see_stock','stock.view','stock.receive','stock.adjust','stock.adjust_approve','stock.count','stock.count_approve','purchases.manage','purchases.void','expenses.manage','expenses.approve','expenses.void','expense_categories.manage','products.manage','users.manage','permissions.manage','commissions.manage','commissions.void','shifts.manage','settings.manage','printers.manage','dashboard.view','reports.sales','reports.inventory','reports.financial','payments.view_collected','purchases.view','purchases.approve','suppliers.view','suppliers.manage','supplier_payments.manage','supplier_payments.void','supplier_credits.manage','supplier_returns.approve','accounting.view','accounting.export','accounting.approve','accounting.correct','accounting.opening','accounting.documents','accounting.settings','receivables.view','receivables.manage','receivables.correct','tips.allocate','employee_reconciliation.view','employee_finance.export','employee_advances.manage','payroll.view','payroll.manage','payroll.review','payroll.approve','payroll.confirm','payroll.pay')),
 enabled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(role_id,permission)
);
CREATE TABLE public.user_custom_roles (
 user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
 role_id uuid REFERENCES public.custom_roles(id) ON DELETE RESTRICT,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 assigned_by_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_custom_roles_role_idx ON public.user_custom_roles(role_id);
-- No existing user receives a custom role automatically; zero backfill.
-- Disabling a grant uses enabled=false; clearing an assignment uses role_id=NULL.
-- Durable administration_events records before/after, actor and reason in same tx.

-- Optional operational classification: NULL preserves legacy/default routing.
ALTER TABLE public.products ADD COLUMN "operationalLocation" text
 CHECK("operationalLocation" IS NULL OR "operationalLocation" IN ('BAR','KITCHEN'));
-- Snapshot only newly created sale lines after source integration. Never infer
-- a historic route from today's product classification.
ALTER TABLE public.sale_items ADD COLUMN "operationalLocation" text
 CHECK("operationalLocation" IS NULL OR "operationalLocation" IN ('BAR','KITCHEN'));
-- Historical and newly captured routing snapshots may never be rewritten.
CREATE FUNCTION public.core_sale_routing_immutable() RETURNS trigger LANGUAGE plpgsql AS $route$
BEGIN
 IF OLD."operationalLocation" IS DISTINCT FROM NEW."operationalLocation" THEN
  RAISE EXCEPTION 'Sale-item routing snapshot is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $route$;
CREATE TRIGGER core_sale_routing_immutable BEFORE UPDATE OF "operationalLocation" ON public.sale_items FOR EACH ROW EXECUTE FUNCTION public.core_sale_routing_immutable();
COMMIT;
