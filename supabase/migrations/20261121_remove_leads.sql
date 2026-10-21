-- =============================================================================
-- Remove Leads
-- =============================================================================
-- Takes the Leads feature out of the database: its tables, the views built over
-- them, every function it added, the two columns it hung off `profiles`, the
-- priced operations it registered, and the cron job that drove its worker.
--
-- This is a DROP migration rather than a deletion of the thirteen files that
-- created these objects (20261108 through 20261120). Those files are already
-- applied to the live database, and Supabase records applied migrations by
-- version + name in `supabase_migrations.schema_migrations`. Deleting them from
-- the repository does not drop anything — it just makes a fresh clone unable to
-- build the same schema the live one has. History stays; this migration is the
-- record of what was removed.
--
-- IRREVERSIBLE. Every lead_* row is deleted, and with them every email address,
-- every suppression and every run receipt the feature produced. There is no
-- down-migration and `git revert` will not bring the rows back.
--
-- What was actually on the live database when this ran, for the record: seven
-- tables (lead_icps, lead_runs, lead_rows, lead_attempts, lead_suppressions,
-- lead_filter_cache, lead_waterfall_orders), two functions (estimate_lead_run,
-- lead_active_run_count), one cron job (echo-leads-worker, every minute) and
-- eight priced operations. The nine tables and twenty-odd functions added by
-- 20261116, 20261118 and 20261120 had never been applied to this project, so
-- most of the DROPs below matched nothing. Every statement is IF EXISTS for
-- exactly that reason.
--
-- The rows held were development seed data — one run, six rows, every domain
-- under the reserved .example TLD. A copy is in
-- supabase/backup/2026-10-19-leads-data.json.
--
-- The `leads` Edge Function is removed separately, with
-- `supabase functions delete leads` — that is a deploy-time operation, not a
-- schema one.
--
-- Idempotent throughout: safe to run against a database that never had the
-- feature, or one where part of it is already gone.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Scheduled jobs
-- -----------------------------------------------------------------------------
-- Unscheduled before the tables go, so a worker cannot wake mid-drop and write
-- into a table that is being dropped underneath it. Both names are listed
-- because only echo-leads-worker was ever scheduled on this project;
-- echo-leads-automations came with 20261120, which was never applied. Selecting
-- from cron.job first rather than calling cron.unschedule by name, because that
-- function raises when the job does not exist.
DO $$
DECLARE
  job record;
BEGIN
  -- cron.job only exists when pg_cron is installed (off by default).
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR job IN
      SELECT jobid FROM cron.job WHERE jobname IN ('echo-leads-worker', 'echo-leads-automations')
    LOOP
      PERFORM cron.unschedule(job.jobid);
    END LOOP;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Views
-- -----------------------------------------------------------------------------
-- Before the tables: all three read from lead_* and would otherwise block the
-- drops.
DROP VIEW IF EXISTS public.v_leads_endpoint_economics;
DROP VIEW IF EXISTS public.v_leads_run_economics;
DROP VIEW IF EXISTS public.lead_companies_summary;

-- -----------------------------------------------------------------------------
-- 3. Triggers
-- -----------------------------------------------------------------------------
-- Dropped by explicit name, in a loop rather than as plain statements, because
-- `DROP TRIGGER IF EXISTS x ON some_table` still resolves some_table: the IF
-- EXISTS guards the trigger, not the relation, and Postgres raises 42P01 for a
-- missing table anyway. That is not hypothetical here - lead_automations was
-- created by 20261120, which was never applied to this project, so a plain
-- statement aborts the whole migration on a table that was never there.
--
-- to_regclass is the existence test: it returns NULL for an absent relation
-- instead of raising, which is what lets one statement cover both a database
-- that ran every Leads migration and one that ran only the first two.
--
-- DROP TABLE would take these with it regardless. They are named explicitly so
-- the guard fires are gone before any row is deleted, rather than during it.
DO $$
DECLARE
  pair record;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('lead_icps_set_updated_at',             'public.lead_icps'),
      ('lead_runs_set_updated_at',             'public.lead_runs'),
      ('lead_rows_set_updated_at',             'public.lead_rows'),
      ('lead_waterfall_orders_set_updated_at', 'public.lead_waterfall_orders'),
      ('lead_automations_set_updated_at',      'public.lead_automations'),
      ('lead_runs_automation_guard',           'public.lead_runs')
    ) AS v(trigger_name, table_name)
  LOOP
    IF to_regclass(pair.table_name) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', pair.trigger_name, pair.table_name);
    END IF;
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. Functions
-- -----------------------------------------------------------------------------
-- Dropped by name across every overload rather than one signature at a time.
-- estimate_lead_run in particular was redefined four times with different
-- argument lists, so `DROP FUNCTION name(...)` would need every combination
-- spelled out and would miss any added since. The loop reads pg_proc directly,
-- which is the only form that cannot go stale.
DO $$
DECLARE
  sig record;
BEGIN
  FOR sig IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (
        p.proname LIKE 'lead\_%'
        OR p.proname LIKE 'leads\_%'
        OR p.proname = 'estimate_lead_run'
      )
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', sig.signature);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 5. Tables
-- -----------------------------------------------------------------------------
-- CASCADE, because the foreign keys between them are what make this one
-- statement each rather than a hand-ordered list: lead_rows references
-- lead_runs and lead_icps, lead_attempts references lead_rows, lead_list_members
-- references both lead_lists and lead_contacts.
--
-- The set is every lead_* table this feature ever created. lead_unlocks was
-- dropped already in 20261018 and is listed only so the statement is complete
-- against a database that predates that migration.
DROP TABLE IF EXISTS public.lead_automation_runs  CASCADE;
DROP TABLE IF EXISTS public.lead_automations     CASCADE;
DROP TABLE IF EXISTS public.lead_attempts        CASCADE;
DROP TABLE IF EXISTS public.lead_companies        CASCADE;
DROP TABLE IF EXISTS public.lead_contacts         CASCADE;
DROP TABLE IF EXISTS public.lead_filter_cache     CASCADE;
DROP TABLE IF EXISTS public.lead_icps             CASCADE;
DROP TABLE IF EXISTS public.lead_list_members     CASCADE;
DROP TABLE IF EXISTS public.lead_lists            CASCADE;
DROP TABLE IF EXISTS public.lead_rows             CASCADE;
DROP TABLE IF EXISTS public.lead_runs             CASCADE;
DROP TABLE IF EXISTS public.lead_saved_searches   CASCADE;
DROP TABLE IF EXISTS public.lead_scoring          CASCADE;
DROP TABLE IF EXISTS public.lead_search_log       CASCADE;
DROP TABLE IF EXISTS public.lead_suppressions    CASCADE;
DROP TABLE IF EXISTS public.lead_unlocks          CASCADE;
DROP TABLE IF EXISTS public.lead_waterfall_orders CASCADE;

-- -----------------------------------------------------------------------------
-- 6. Priced operations this feature registered
-- -----------------------------------------------------------------------------
-- pricing_config is shared with the Feed and the wallet, so the table stays and
-- only the leads.* rows go. Nine were seeded across the migrations: leads.search,
-- leads.icp.generate, leads.company.found, leads.company.enrich,
-- leads.person.found, leads.email.verified, leads.email.catch_all,
-- leads.phone.found and leads.verify.only.
--
-- Deleted rather than left disabled, because a disabled row is still a row the
-- billing function reads and the price screen would keep listing an operation
-- nothing can invoke any more. Matched by prefix rather than listed one by one
-- so an operation added by a later migration is caught too.
--
-- Safe against the two things that read this table. billing selects
-- pricing_config filtered by the operation it is about to charge, and no
-- surviving code path names a leads.* operation. v_margin_by_operation groups
-- api_usage and never joins pricing_config, so it is unaffected either way.
--
-- api_usage rows for past leads calls are left in place: that table is an
-- append-only provider log the reporting views read, not a catalogue.
DELETE FROM public.pricing_config WHERE operation LIKE 'leads.%';

-- -----------------------------------------------------------------------------
-- 7. Columns this feature added to `profiles`
-- -----------------------------------------------------------------------------
-- `leads_terms_accepted_at` held the consent timestamp and `leads_row_cap_usd`
-- the per-row ceiling. Neither is read by any surviving code path: the client
-- type that declared the first is gone, and the wallet is the only credit
-- system left. Dropped rather than left as dead columns on a table every other
-- query selects.
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS leads_terms_accepted_at,
  DROP COLUMN IF EXISTS leads_row_cap_usd;
