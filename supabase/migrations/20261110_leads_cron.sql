-- ============================================================================
-- Echo Leads: the worker cron job
-- ----------------------------------------------------------------------------
-- A safety net, not the primary mechanism. The leads function re-invokes itself
-- between chunks, so a run advances as fast as the wall-clock budget allows. This
-- job exists for the case where that chain breaks: an isolate killed between
-- chunks, a re-invocation that did not land, a run that was queued while the
-- function was down.
--
-- Every minute rather than hourly, because the thing it recovers from is a
-- partially-worked run, and the cost of waiting an hour for one to notice is an
-- hour of a run that looks stalled.
--
-- Like the daily sweep, this calls a function with verify_jwt off, so it carries
-- the shared secret rather than a JWT — the gateway cannot authenticate pg_net.
-- ============================================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'echo-leads-worker') then
    raise notice 'echo-leads-worker already scheduled';
  else
    perform cron.schedule(
      'echo-leads-worker',
      '* * * * *',
      $cron$
      select net.http_post(
        url     := 'https://fteoyqhogzuapfdledeg.supabase.co/functions/v1/leads',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-leads-worker-secret',
            (select value from public.service_secrets where name = 'leads_worker_secret')
        ),
        body    := jsonb_build_object('action', 'work'),
        timeout_milliseconds := 55000
      );
      $cron$
    );
    raise notice 'echo-leads-worker scheduled every minute';
  end if;
end;
$$;
