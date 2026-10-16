-- ============================================================================
-- Echo — Scheduled sweeps
-- ----------------------------------------------------------------------------
-- Before this, daily-sweep had no caller. Nothing invoked it, so no workspace —
-- new or existing — ever received an automatic sweep, and the "Run sweep"
-- button was the only way to collect anything.
--
-- pg_cron fires hourly and pg_net makes the HTTP call. Each workspace is swept
-- in the UTC hour it configured in Settings, so "every day at 06:00 UTC" in the
-- UI is literally true. Total provider spend is unchanged: each workspace still
-- sweeps once per day, just at its own hour.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- 1. The schedule
-- ---------------------------------------------------------------------------
-- Needs your project ref substituted below. Idempotent: an existing job with
-- this name is left alone.
--
-- The secret is read from public.service_secrets at fire time rather than
-- baked into the command, so it is never duplicated into cron.job text and
-- there is one place to rotate it. That table has RLS on and no policies, so
-- only the service role can read it.
--
-- Generate the secret once:
--
--   insert into public.service_secrets (name, value)
--   values ('sweep_cron_secret', encode(gen_random_bytes(32), 'hex'));
--
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'echo-daily-sweep') then
    perform cron.schedule(
      'echo-daily-sweep',
      '0 * * * *',
      $job$
      select net.http_post(
        url := 'https://REPLACE_WITH_PROJECT_REF.supabase.co/functions/v1/daily-sweep',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-sweep-secret', (select value from public.service_secrets where name = 'sweep_cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 180000
      );
      $job$
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Index for the fan-out
-- ---------------------------------------------------------------------------
-- daily-sweep reads every active keyword grouped by user on each run.
create index if not exists keywords_active_user_idx
  on public.keywords (user_id)
  where is_active;