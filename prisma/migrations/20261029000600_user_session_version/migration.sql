-- Portable schema history. Target enforcement belongs in the deployment runner.
-- Execution requires separate approval; no credentials/account state are reset.
-- Fail on an existing column rather than resetting or concealing its state.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
-- No account/credential updates, historical backfill or version reset.
ALTER TABLE public.users
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT users_session_version_nonnegative
    CHECK ("sessionVersion" >= 0);
COMMIT;
