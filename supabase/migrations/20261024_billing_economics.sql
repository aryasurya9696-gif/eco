-- ============================================================================
-- Billing rebuild: treg-backed plan economics and real spend tracking
-- ----------------------------------------------------------------------------
-- Echo buys search on treg at the provider's own rate, billed per successful
-- call. That makes the product's cost of goods a function of how hard a
-- workspace makes the sweep run, so two things were needed:
--
--   1. The plan limits have to be expressible as a cost. Previously they were
--      picked by feel, which is why Starter was capped at two channels while
--      the two most expensive channels cost under a cent a day at that limit.
--
--   2. Actual spend has to be recorded. The sweep already tracked a running
--      total but threw it away at the end of the run, so there was no way to
--      tell what a workspace actually cost to serve.
--
-- Verified per-call rates (treg catalog, endpoint.cost.usd):
--   anyapi.x.search.posts                     $0.00075  observed, 2026-09-11
--   tikhub.x.reddit-app-fetch-dynamic-search  $0.00100  rate card, 2026-07-28
--   scrapecreators.reddit.search.posts        $0.00188  rate card, 2026-07-28
--     ^ only reached when the tikhub call succeeds but returns no rows
--   crawl4ai.web.search.rich                  $0.00015  observed, 2026-10-09
--   tinyfish.web.search.news                  $0.00000  rate card, 2026-09-23
--
-- Worst-case monthly cost per workspace, all four channels where allowed and
-- every Reddit call falling through to the fallback, 30-day month:
--   starter  8 kw x $0.00363 x 1 sweep/day  x 30 = $0.87   against $29
--   pro     20 kw x $0.00378 x 2 sweeps/day x 30 = $4.54   against $79
--   scale   40 kw x $0.00378 x 4 sweeps/day x 30 = $18.14  against $199
--
-- Worst-case gross margins: 97.0%, 94.3%, 90.9%. Limits are deliberately set
-- where the margin stays above 90% even if every single call takes the
-- expensive path.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Plan limits
-- ---------------------------------------------------------------------------
-- Starter gains channels (2 -> 3). Reddit alone is $0.00288 per keyword per
-- sweep, so three channels is still under a dollar a month at its keyword cap.
create or replace function public.plan_keyword_limit(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case coalesce((select subscription_plan from public.profiles where id = p_user_id), 'starter')
    when 'scale'   then 40
    when 'pro'     then 20
    else 8
  end;
$$;

-- The sweep caps must agree with the largest plan_keyword_limit, otherwise a
-- workspace is allowed N keywords but only ever searches the first M of them.
-- Kept in step with the case expression above.
create or replace function public.plan_max_keywords()
returns integer
language sql
immutable
as $$
  select 40;
$$;

revoke execute on function public.plan_max_keywords() from public, anon, authenticated;
grant execute on function public.plan_max_keywords() to service_role;

-- Channels per plan, in one place the client and the sweep can both be checked
-- against. Ordered cheapest to most expensive so a cap of N keeps the N
-- cheapest available to a user who has not chosen yet.
create or replace function public.plan_max_channels(p_plan text)
returns integer
language sql
immutable
as $$
  select case p_plan
    when 'scale' then 4
    when 'pro'   then 4
    else 3
  end;
$$;

revoke execute on function public.plan_max_channels(text) from public, anon, authenticated;
grant execute on function public.plan_max_channels(text) to service_role;

-- Sweeps per day, so the cost ceiling is checkable without arithmetic at the
-- call site.
create or replace function public.plan_sweeps_per_day(p_plan text)
returns integer
language sql
immutable
as $$
  select case p_plan
    when 'scale' then 4
    when 'pro'   then 2
    else 1
  end;
$$;

revoke execute on function public.plan_sweeps_per_day(text) from public, anon, authenticated;
grant execute on function public.plan_sweeps_per_day(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Real spend tracking
-- ---------------------------------------------------------------------------
-- What the workspace actually cost this calendar month. Reset by the sweep when
-- the month rolls over, so it needs the month it refers to.
alter table public.profiles
  add column if not exists search_spend_month text,
  add column if not exists search_usd_spent numeric(12,6) not null default 0;

comment on column public.profiles.search_usd_spent is
  'US dollars spent on treg calls by this workspace in search_spend_month, accumulated by the sweep.';

alter table public.sweep_runs
  add column if not exists usd_spent numeric(12,6) not null default 0;

comment on column public.sweep_runs.usd_spent is
  'US dollars this run spent on treg calls, across every workspace it swept.';

-- spend_runs is the audit trail behind the profile rollup: one row per
-- workspace per sweep, so a single month total can always be explained.
create table if not exists public.spend_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  run_id      uuid references public.sweep_runs(id) on delete set null,
  occurred_at timestamptz not null default now(),
  usd_spent   numeric(12,6) not null check (usd_spent >= 0),
  calls_made  integer not null default 0 check (calls_made >= 0)
);

create index if not exists spend_runs_user_time_idx
  on public.spend_runs (user_id, occurred_at desc);

alter table public.spend_runs enable row level security;

-- Clients may read their own spend so the billing page can show it. No insert
-- policy: only the sweep's service role writes here.
create policy "spend_runs_select_own"
  on public.spend_runs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke insert, update, delete on public.spend_runs from anon, authenticated;
grant select on public.spend_runs to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Rollup helper
-- ---------------------------------------------------------------------------
-- Adds this sweep's cost to the workspace's month-to-date figure, rolling the
-- month over first when needed. Called once per workspace per sweep.
create or replace function public.record_search_spend(
  p_user_id uuid,
  p_run_id uuid,
  p_usd numeric,
  p_calls integer default 0
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set search_spend_month = to_char(now() at time zone 'utc', 'YYYY-MM'),
         search_usd_spent = case
           when search_spend_month = to_char(now() at time zone 'utc', 'YYYY-MM')
             then search_usd_spent + greatest(coalesce(p_usd, 0), 0)
           else greatest(coalesce(p_usd, 0), 0)
         end,
         updated_at = now()
   where id = p_user_id;
$$;

revoke execute on function public.record_search_spend(uuid, uuid, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.record_search_spend(uuid, uuid, numeric, integer)
  to service_role;
