-- Additive configuration and global administration audit; no business-data backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE pos_settings (
 id text PRIMARY KEY DEFAULT 'global', version integer NOT NULL DEFAULT 0,
 data jsonb NOT NULL DEFAULT '{}', "updatedById" text, "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT pos_settings_singleton CHECK(id='global'),
 CONSTRAINT pos_settings_version CHECK(version>=0),
 CONSTRAINT pos_settings_data_object CHECK(jsonb_typeof(data)='object'),
 CONSTRAINT "pos_settings_updatedById_fkey" FOREIGN KEY("updatedById") REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE administration_events (
 id text PRIMARY KEY, "actorId" text NOT NULL, scope text NOT NULL,
 categories text[] NOT NULL, reason text NOT NULL, before jsonb NOT NULL, after jsonb NOT NULL,
 revision integer, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT administration_events_scope CHECK(scope IN ('SETTINGS','PERMISSIONS')),
 CONSTRAINT administration_events_revision CHECK(revision IS NULL OR revision>0),
 CONSTRAINT administration_events_payload CHECK(jsonb_typeof(before)='object' AND jsonb_typeof(after)='object'),
 CONSTRAINT "administration_events_actorId_fkey" FOREIGN KEY("actorId") REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "administration_events_scope_createdAt_idx" ON administration_events(scope,"createdAt");
CREATE FUNCTION prevent_administration_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Administration audit records are append-only'; END;
$$;
CREATE TRIGGER administration_events_append_only BEFORE UPDATE OR DELETE ON administration_events FOR EACH ROW EXECUTE FUNCTION prevent_administration_event_mutation();
COMMIT;
