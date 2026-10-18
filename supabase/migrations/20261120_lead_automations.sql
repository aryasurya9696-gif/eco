-- ============================================================================
-- Echo Leads: automations
-- ----------------------------------------------------------------------------
-- Scheduled work over the lead database, each with its own spending caps.
--
--   saved_search_refresh  re-runs a saved people search (free), saves the people
--                         not already held, and can start a priced find-email
--                         run over them.
--   auto_enrich           starts a priced run over contacts matching a saved
--                         People view.
--   auto_tag              tags contacts matching a saved People view (free).
--
-- Money rule: an automation never starts a run without two caps, one per run and
-- one per calendar month (UTC), and never one whose estimated maximum would
-- break either. The function checks that before it creates the run; the trigger
-- below checks it again on the insert itself, under a lock on the automation,
-- so a bug in the function or two workers at once still cannot get past it.
--
-- Tables are select-own for clients. Every write goes through the leads
-- function with the service role, like the rest of the lead database.
-- ============================================================================

create table if not exists public.lead_automations (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  name                   text not null,
  kind                   text not null,
  config                 jsonb not null default '{}'::jsonb,
  status                 text not null default 'active',
  pause_reason           text,
  -- Schedule, in UTC. weekday is 0 = Sunday .. 6 = Saturday, weekly only.
  frequency              text not null default 'daily',
  hour                   smallint not null default 6,
  weekday                smallint,
  -- Caps, in credits. 0 means "may not spend": a paid automation is refused
  -- by the function at save time and by the trigger below at run time.
  max_credits_per_run    numeric(20,6) not null default 0,
  max_credits_per_month  numeric(20,6) not null default 0,
  next_run_at            timestamptz,
  last_run_at            timestamptz,
  last_status            text,
  failure_count          integer not null default 0,
  lease_until            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint lead_automations_kind_check
    check (kind in ('saved_search_refresh', 'auto_enrich', 'auto_tag')),
  constraint lead_automations_status_check check (status in ('active', 'paused')),
  constraint lead_automations_frequency_check check (frequency in ('daily', 'weekly')),
  constraint lead_automations_hour_check check (hour between 0 and 23),
  constraint lead_automations_weekday_check
    check ((frequency = 'weekly' and weekday between 0 and 6) or (frequency = 'daily' and weekday is null)),
  constraint lead_automations_caps_check
    check (max_credits_per_run >= 0 and max_credits_per_month >= 0
           and max_credits_per_run <= max_credits_per_month),
  constraint lead_automations_name_len check (char_length(trim(name)) between 1 and 80),
  constraint lead_automations_user_name_key unique (user_id, name)
);

create index if not exists lead_automations_due_idx
  on public.lead_automations (next_run_at)
  where status = 'active';

create table if not exists public.lead_automation_runs (
  id                     uuid primary key default gen_random_uuid(),
  automation_id          uuid not null references public.lead_automations (id) on delete cascade,
  user_id                uuid not null references auth.users (id) on delete cascade,
  -- running; succeeded; skipped (nothing to do); refused (a cap or the wallet
  -- said no, nothing was charged); failed (an error, nothing was charged
  -- unless run_id is set).
  status                 text not null default 'running',
  started_at             timestamptz not null default now(),
  finished_at            timestamptz,
  people_found           integer not null default 0,
  people_added           integer not null default 0,
  people_skipped         integer not null default 0,
  contacts_matched       integer not null default 0,
  contacts_tagged        integer not null default 0,
  credits_estimated_max  numeric(20,6),
  -- A snapshot at the end of the automation run. The linked lead run keeps
  -- charging as it works, so readers prefer lead_runs.charged_credits.
  credits_charged        numeric(20,6) not null default 0,
  run_id                 uuid references public.lead_runs (id) on delete set null,
  error                  text,
  detail                 jsonb not null default '{}'::jsonb,
  constraint lead_automation_runs_status_check
    check (status in ('running', 'succeeded', 'skipped', 'refused', 'failed'))
);

create index if not exists lead_automation_runs_automation_idx
  on public.lead_automation_runs (automation_id, started_at desc);
create index if not exists lead_automation_runs_user_idx
  on public.lead_automation_runs (user_id, started_at desc);

-- Runs an automation started, for the monthly budget.
create index if not exists lead_runs_automation_idx
  on public.lead_runs ((options ->> 'automation_id'), created_at)
  where options ? 'automation_id';

-- ---------------------------------------------------------------------------
-- RLS: select-own, no client writes
-- ---------------------------------------------------------------------------
alter table public.lead_automations     enable row level security;
alter table public.lead_automation_runs enable row level security;

do $$
declare t text;
begin
  foreach t in array array['lead_automations', 'lead_automation_runs']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_select_own', t
    );
  end loop;
end;
$$;

drop trigger if exists lead_automations_set_updated_at on public.lead_automations;
create trigger lead_automations_set_updated_at
  before update on public.lead_automations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- lead_automations_claim_due: take up to p_limit due automations for p_seconds
-- ---------------------------------------------------------------------------
-- The cron tick and a "Run now" kick can overlap, so the claim skips locked
-- rows and leased ones: one worker per automation, as lead_claim_run does for
-- runs. The caller clears lease_until when it has moved next_run_at on.
create or replace function public.lead_automations_claim_due(p_limit integer, p_seconds integer)
returns setof public.lead_automations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select a.id
      from public.lead_automations a
     where a.status = 'active'
       and a.next_run_at is not null
       and a.next_run_at <= now()
       and (a.lease_until is null or a.lease_until < now())
     order by a.next_run_at, a.id
     limit greatest(1, least(p_limit, 50))
     for update skip locked
  )
  update public.lead_automations a
     set lease_until = now() + make_interval(secs => greatest(30, least(p_seconds, 900)))
    from picked
   where a.id = picked.id
  returning a.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_automation_month_committed: credits this automation has committed since
-- p_since
-- ---------------------------------------------------------------------------
-- A finished run counts what it charged. A run still working counts the most it
-- can still charge (its approved maximum), so two runs in one month cannot each
-- assume the other will be cheap.
create or replace function public.lead_automation_month_committed(p_automation uuid, p_since timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(
           case when r.status in ('done', 'failed', 'cancelled') then r.charged_credits
                else greatest(coalesce(r.max_credits, 0), r.charged_credits)
           end), 0)
    from public.lead_runs r
   where r.options ->> 'automation_id' = p_automation::text
     and r.created_at >= p_since;
$$;

revoke execute on function public.lead_automations_claim_due(integer, integer)              from public, anon, authenticated;
revoke execute on function public.lead_automation_month_committed(uuid, timestamptz)         from public, anon, authenticated;
grant  execute on function public.lead_automations_claim_due(integer, integer)              to service_role;
grant  execute on function public.lead_automation_month_committed(uuid, timestamptz)         to service_role;

-- ---------------------------------------------------------------------------
-- The last line: a run tagged with an automation must fit its caps
-- ---------------------------------------------------------------------------
-- Runs on the insert of any lead_runs row whose options carry an automation_id.
-- The automation row is locked for the rest of the transaction, so two inserts
-- for one automation are checked one after the other against the same total.
create or replace function public.lead_runs_automation_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a           public.lead_automations;
  v_auto      uuid;
  v_committed numeric;
begin
  if not (new.options ? 'automation_id') then
    return new;
  end if;

  begin
    v_auto := (new.options ->> 'automation_id')::uuid;
  exception when others then
    raise exception 'automation_guard: bad automation_id';
  end;

  select * into a from public.lead_automations
   where id = v_auto and user_id = new.user_id
   for update;
  if a.id is null then
    raise exception 'automation_guard: automation_not_found';
  end if;
  if new.max_credits is null then
    raise exception 'automation_guard: run_has_no_maximum';
  end if;
  if a.max_credits_per_run <= 0 or a.max_credits_per_month <= 0 then
    raise exception 'automation_guard: no_cap';
  end if;
  if new.max_credits > a.max_credits_per_run then
    raise exception 'automation_guard: over_run_cap';
  end if;

  v_committed := public.lead_automation_month_committed(a.id, date_trunc('month', now() at time zone 'utc') at time zone 'utc');
  if v_committed + new.max_credits > a.max_credits_per_month then
    raise exception 'automation_guard: over_month_cap';
  end if;

  return new;
end;
$$;

revoke execute on function public.lead_runs_automation_guard() from public, anon, authenticated;

drop trigger if exists lead_runs_automation_guard on public.lead_runs;
create trigger lead_runs_automation_guard
  before insert on public.lead_runs
  for each row execute function public.lead_runs_automation_guard();

-- ---------------------------------------------------------------------------
-- The tick: every ten minutes, with the worker's shared secret
-- ---------------------------------------------------------------------------
-- Schedules are on the hour, so ten minutes is the most an automation runs
-- late. A tick with nothing due is one indexed select.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'echo-leads-automations') then
    raise notice 'echo-leads-automations already scheduled';
  else
    perform cron.schedule(
      'echo-leads-automations',
      '*/10 * * * *',
      $cron$
      select net.http_post(
        url     := 'https://fteoyqhogzuapfdledeg.supabase.co/functions/v1/leads',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-leads-worker-secret',
            (select value from public.service_secrets where name = 'leads_worker_secret')
        ),
        body    := jsonb_build_object('action', 'automations_tick'),
        timeout_milliseconds := 55000
      );
      $cron$
    );
    raise notice 'echo-leads-automations scheduled every ten minutes';
  end if;
end;
$$;
