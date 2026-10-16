-- ============================================================================
-- Echo — Complete database install (single paste)
-- ----------------------------------------------------------------------------
-- Project ref: fteoyqhogzuapfdledeg
-- Applied via MCP: 2026-10-16
--
-- HOW TO USE
--   Supabase Dashboard -> SQL Editor -> New query -> paste this file -> Run.
--
-- Safe to run more than once (IF NOT EXISTS / IF EXISTS / OR REPLACE, and the
-- backfill is a no-op once scores already match).
--
-- WARNING: Section 4 DROPs lead_unlocks and credit_transactions.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — Core schema (profiles, keywords, monitored_posts, sweep_runs)
-- ============================================================================

-- ============================================================================
-- Echo â€” Complete Multi-Platform Production Schema
-- Supports X, LinkedIn, Reddit, Facebook, Google Discussions
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- profiles
-- One row per user. Auto-created on signup via trigger below.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                     uuid primary key references auth.users(id) on delete cascade,
  full_name              text,
  website                text,
  core_offer             text,
  onboarding_completed   boolean not null default false,
  onboarding_step        smallint not null default 0,
  email_digest           boolean not null default true,
  slack_webhook          text,
  lookback_hours         int not null default 24,
  sweep_time_utc         text not null default '06:00',
  sweep_frequency        text not null default '24h',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- auto-create a profile row whenever a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- keywords
-- Up to 10 active rows per user, enforced server-side.
-- ---------------------------------------------------------------------------
create table if not exists public.keywords (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  keyword     text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (user_id, keyword)
);

create index if not exists idx_keywords_user on public.keywords(user_id) where is_active;

alter table public.keywords enable row level security;

create policy "keywords_select_own"
  on public.keywords for select
  using (auth.uid() = user_id);

create policy "keywords_insert_own"
  on public.keywords for insert
  with check (auth.uid() = user_id);

create policy "keywords_update_own"
  on public.keywords for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "keywords_delete_own"
  on public.keywords for delete
  using (auth.uid() = user_id);

-- hard cap of 10 active keywords per user
create or replace function public.enforce_keyword_limit()
returns trigger
language plpgsql
as $$
declare
  active_count int;
begin
  if new.is_active then
    select count(*) into active_count
    from public.keywords
    where user_id = new.user_id
      and is_active = true
      and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

    if active_count >= 10 then
      raise exception 'Keyword limit reached: a user may have at most 10 active keywords';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_keyword_limit on public.keywords;
create trigger trg_keyword_limit
  before insert or update on public.keywords
  for each row execute function public.enforce_keyword_limit();

-- ---------------------------------------------------------------------------
-- monitored_posts
-- Written by Edge Function (service role) or user sweep.
-- ---------------------------------------------------------------------------
create table if not exists public.monitored_posts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  keyword_id        uuid references public.keywords(id) on delete set null,
  matched_keyword   text not null,
  platform          text not null check (platform in ('twitter', 'linkedin', 'reddit', 'facebook', 'google')),
  channel_source    text,
  post_url          text not null,
  author_name       text,
  author_handle     text,
  author_avatar_url text,
  body              text,
  posted_at         timestamptz,
  intent_score      int default 85,
  status            text default 'new' check (status in ('new', 'saved', 'contacted', 'dismissed')),
  engagement        jsonb,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  unique (user_id, post_url)
);

create index if not exists idx_monitored_posts_user_created
  on public.monitored_posts(user_id, created_at desc);

create index if not exists idx_monitored_posts_user_platform
  on public.monitored_posts(user_id, platform);

alter table public.monitored_posts enable row level security;

create policy "monitored_posts_select_own"
  on public.monitored_posts for select
  using (auth.uid() = user_id);

create policy "monitored_posts_insert_own"
  on public.monitored_posts for insert
  with check (auth.uid() = user_id);

create policy "monitored_posts_update_own"
  on public.monitored_posts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "monitored_posts_delete_own"
  on public.monitored_posts for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- sweep_runs
-- Audit log for automated runs.
-- ---------------------------------------------------------------------------
create table if not exists public.sweep_runs (
  id               uuid primary key default gen_random_uuid(),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  users_processed  int not null default 0,
  posts_inserted   int not null default 0,
  errors           jsonb not null default '[]'::jsonb
);

alter table public.sweep_runs enable row level security;


-- ============================================================================
-- SECTION 2 — Channel selectivity
-- ============================================================================

-- Add enabled_channels array column to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS enabled_channels text[] NOT NULL DEFAULT ARRAY['twitter', 'reddit', 'google'];


-- ============================================================================
-- SECTION 3 — Subscription columns + security hardening
-- ============================================================================

-- ============================================================================
-- Echo â€” Security Hardening & Final Schema
-- ----------------------------------------------------------------------------
-- This is the authoritative definition of the hardened schema. It is written so
-- that it can run on a FRESH database (no credit tables) as well as on top of
-- an older installation â€” it contains zero references to the retired
-- credit/lead-unlock system, so it never depends on 20261016 running first.
--
-- What it fixes:
--   1. Keyword limits were hardcoded to 10 for every plan. Now they derive from
--      the user's subscription plan and are enforced by a Postgres trigger, so
--      the client cannot bypass them.
--   2. profiles.subscription_* and is_admin were client-writable. They are now
--      protected by BOTH a column-level REVOKE and a BEFORE UPDATE trigger, so
--      only apply_subscription_plan() (service-role only) can change them.
--   3. sweep_runs had RLS enabled with zero policies, so client audit writes
--      silently failed. It is service-role only, which is who actually writes.
--   4. Added the missing profiles.min_intent_threshold column.
--   5. slack_webhook accepted any string; now restricted to Slack/Discord hosts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Intent threshold (used by both the sweep and the feed filter)
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists min_intent_threshold integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2. Plan-aware keyword limit
-- ---------------------------------------------------------------------------
create or replace function public.plan_keyword_limit(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case coalesce((select subscription_plan from public.profiles where id = p_user_id), 'starter')
    when 'scale'   then 25
    when 'pro'     then 10
    else 5
  end;
$$;

create or replace function public.enforce_keyword_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_count int;
  allowed_count int;
begin
  if new.is_active then
    allowed_count := public.plan_keyword_limit(new.user_id);

    select count(*) into active_count
    from public.keywords
    where user_id = new.user_id
      and is_active = true
      and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

    -- <, not <=: the row being inserted is about to become the (active_count+1)th.
    if active_count >= allowed_count then
      raise exception 'Keyword limit reached: your plan allows % active keywords', allowed_count
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_keyword_limit on public.keywords;
create trigger trg_keyword_limit
  before insert or update on public.keywords
  for each row execute function public.enforce_keyword_limit();

-- ---------------------------------------------------------------------------
-- 3. Guard server-owned columns on profiles
--    apply_subscription_plan() flips the GUC while it writes; anything else that
--    tries to touch these columns is rejected.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_server_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('echo.allow_subscription_mutation', true), 'off') = 'on' then
    return new;
  end if;

  if new.subscription_plan is distinct from old.subscription_plan then
    raise exception 'subscription_plan is server-managed and cannot be updated directly'
      using errcode = 'insufficient_privilege';
  end if;

  if new.subscription_status is distinct from old.subscription_status then
    raise exception 'subscription_status is server-managed and cannot be updated directly'
      using errcode = 'insufficient_privilege';
  end if;

  if new.subscription_renews_at is distinct from old.subscription_renews_at then
    raise exception 'subscription_renews_at is server-managed and cannot be updated directly'
      using errcode = 'insufficient_privilege';
  end if;

  if new.is_admin is distinct from old.is_admin then
    raise exception 'is_admin is server-managed and cannot be updated directly'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_server_columns on public.profiles;
create trigger trg_profiles_server_columns
  before update on public.profiles
  for each row execute function public.guard_profile_server_columns();

-- ---------------------------------------------------------------------------
-- 4. Column-level UPDATE grants on profiles
--    Even with the row policy in place, the client cannot write the plan
--    columns. Column privileges are enforced by Postgres before RLS runs.
-- ---------------------------------------------------------------------------
revoke update on public.profiles from anon, authenticated;

grant update (
  full_name,
  website,
  core_offer,
  onboarding_completed,
  onboarding_step,
  email_digest,
  slack_webhook,
  lookback_hours,
  sweep_time_utc,
  sweep_frequency,
  enabled_channels,
  min_intent_threshold
) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 5. apply_subscription_plan â€” service-role only.
--     The client can NEVER change its own plan; a paid Stripe event calls this.
-- ---------------------------------------------------------------------------
create or replace function public.apply_subscription_plan(
  p_user_id uuid,
  p_plan text,
  p_interval text default 'month',
  p_renews_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_plan not in ('starter', 'pro', 'scale') then
    return jsonb_build_object('success', false, 'error', 'invalid_plan');
  end if;
  if p_interval not in ('month', 'year') then
    return jsonb_build_object('success', false, 'error', 'invalid_interval');
  end if;

  perform set_config('echo.allow_subscription_mutation', 'on', true);

  update public.profiles
  set subscription_plan = p_plan,
      subscription_interval = p_interval,
      subscription_status = 'active',
      subscription_renews_at = coalesce(p_renews_at, now() + interval '30 days'),
      updated_at = now()
  where id = p_user_id;

  if not found then
    return jsonb_build_object('success', false, 'error', 'profile_not_found');
  end if;

  return jsonb_build_object('success', true, 'plan', p_plan, 'interval', p_interval);
end;
$$;

-- The default PUBLIC EXECUTE grant would let any client call this.
revoke execute on function public.apply_subscription_plan(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_subscription_plan(uuid, text, text, timestamptz)
  to service_role;

revoke execute on function public.plan_keyword_limit(uuid) from public, anon;
grant  execute on function public.plan_keyword_limit(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. sweep_runs: service-role only
-- ---------------------------------------------------------------------------
drop policy if exists "sweep_runs_insert_own" on public.sweep_runs;
revoke insert on public.sweep_runs from anon, authenticated;
grant  insert on public.sweep_runs to service_role;

-- ---------------------------------------------------------------------------
-- 7. Signup creates a profile row
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Webhook URLs must be real Slack/Discord endpoints
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.slack_webhook is not null
     and new.slack_webhook <> ''
     and new.slack_webhook !~ '^https://[a-zA-Z0-9.-]*\.(hooks\.slack\.com|slack\.com|discord\.com|discordapp\.com)/' then
    raise exception 'slack_webhook must be an https Slack or Discord webhook URL'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_webhook_guard on public.profiles;
create trigger trg_profiles_webhook_guard
  before insert or update on public.profiles
  for each row execute function public.guard_profile_webhook();

-- ---------------------------------------------------------------------------
-- 9. Client read access
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.profiles to authenticated;


-- ============================================================================
-- SECTION 4 — Retires the credit / lead-unlock system
-- ============================================================================

-- ============================================================================
-- Echo â€” Retire the credit-based lead-selling system
-- ----------------------------------------------------------------------------
-- Lead unlocking is no longer paywalled: feed cards show the author and the
-- post directly, with no credits, no unlock flow and no contact enrichment.
--
-- Drops (only if present, so this is safe on a database that never had them):
--   * credit_transactions  (ledger + policies)
--   * lead_unlocks         (paywall unlock records + policies)
--   * profiles.credits_balance
--   * charge_user_credits / grant_user_credits RPCs
--
-- Keeps:
--   * Subscription plans + Stripe billing (profiles.subscription_* stay)
--   * Plan-based keyword limits (plan_keyword_limit)
--   * profiles.is_admin
--
-- Order: run AFTER 20261017_security_hardening.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Signup trigger no longer writes a credit ledger entry
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Credit RPCs
-- ---------------------------------------------------------------------------
drop function if exists public.charge_user_credits(uuid, integer, text, text, text);
drop function if exists public.grant_user_credits(uuid, integer, text, text, text);

-- ---------------------------------------------------------------------------
-- 3. Triggers owned by the retired tables/columns
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_trigger where tgname = 'trg_profiles_server_columns'
  ) then
    execute 'drop trigger trg_profiles_server_columns on public.profiles';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Drop the retired tables
-- ---------------------------------------------------------------------------
drop table if exists public.lead_unlocks;
drop table if exists public.credit_transactions;

-- ---------------------------------------------------------------------------
-- 5. Drop profiles.credits_balance
-- ---------------------------------------------------------------------------
alter table public.profiles drop column if exists credits_balance;

-- ---------------------------------------------------------------------------
-- 6. Re-attach the guard trigger (already redefined without credits in 20261017,
--    but re-creating is idempotent and protects against older installs where
--    20261017 ran with the credits-aware version).
-- ---------------------------------------------------------------------------
drop trigger if exists trg_profiles_server_columns on public.profiles;
create trigger trg_profiles_server_columns
  before update on public.profiles
  for each row execute function public.guard_profile_server_columns();

-- ---------------------------------------------------------------------------
-- 7. apply_subscription_plan must flip the GUC the current guard checks for
-- ---------------------------------------------------------------------------
create or replace function public.apply_subscription_plan(
  p_user_id uuid,
  p_plan text,
  p_interval text default 'month',
  p_renews_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_plan not in ('starter', 'pro', 'scale') then
    return jsonb_build_object('success', false, 'error', 'invalid_plan');
  end if;
  if p_interval not in ('month', 'year') then
    return jsonb_build_object('success', false, 'error', 'invalid_interval');
  end if;

  perform set_config('echo.allow_subscription_mutation', 'on', true);

  update public.profiles
  set subscription_plan = p_plan,
      subscription_interval = p_interval,
      subscription_status = 'active',
      subscription_renews_at = coalesce(p_renews_at, now() + interval '30 days'),
      updated_at = now()
  where id = p_user_id;

  if not found then
    return jsonb_build_object('success', false, 'error', 'profile_not_found');
  end if;

  return jsonb_build_object('success', true, 'plan', p_plan, 'interval', p_interval);
end;
$$;

revoke execute on function public.apply_subscription_plan(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_subscription_plan(uuid, text, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. Done.
--    No explicit DROP POLICY is needed: dropping a table drops its policies
--    with it, and `drop policy ... on <table>` would ERROR once the table is
--    gone (the IF EXISTS only guards the policy name, not the table).
-- ---------------------------------------------------------------------------


-- ============================================================================
-- SECTION 5 — Advisor-driven lint cleanup (RLS, grants, indexes)
-- ============================================================================

-- ============================================================================
-- Echo â€” Security lint cleanup
-- ----------------------------------------------------------------------------
-- Driven by `get_advisors` after echo_security_hardening +
-- echo_remove_credits_system were applied to fteoyqhogzuapfdledeg.
--
-- Fixes:
--   1. Trigger functions were SECURITY DEFINER *and* executable by anon /
--      authenticated over /rest/v1/rpc/. They only make sense as trigger
--      bodies, so EXECUTE is revoked from client roles. Triggers still fire.
--   2. set_updated_at had no pinned search_path.
--   3. RLS policies called auth.uid() directly, so Postgres re-evaluated it
--      per row. Wrapping it in (select auth.uid()) initialises it once per
--      query (auth_rls_initplan).
--   4. sweep_runs had RLS on with no policy at all; now an explicit
--      deny-by-default policy.
--   5. monitored_posts.keyword_id FK had no index.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Trigger functions are not RPCs
-- ---------------------------------------------------------------------------
revoke execute on function public.enforce_keyword_limit()      from public, anon, authenticated;
revoke execute on function public.guard_profile_server_columns() from public, anon, authenticated;
revoke execute on function public.guard_profile_webhook()      from public, anon, authenticated;
revoke execute on function public.handle_new_user()             from public, anon, authenticated;
revoke execute on function public.set_updated_at()              from public, anon, authenticated;

grant execute on function public.enforce_keyword_limit()       to service_role;
grant execute on function public.guard_profile_server_columns() to service_role;
grant execute on function public.guard_profile_webhook()       to service_role;
grant execute on function public.handle_new_user()              to service_role;
grant execute on function public.set_updated_at()               to service_role;

-- plan_keyword_limit is only called from inside enforce_keyword_limit, which
-- runs as the owner, so EXECUTE is unaffected. Clients read the limit from
-- src/lib/billing.ts instead.
revoke execute on function public.plan_keyword_limit(uuid) from public, anon, authenticated;
grant  execute on function public.plan_keyword_limit(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Pin search_path
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. RLS policies: (select auth.uid()) instead of auth.uid()
-- ---------------------------------------------------------------------------
drop policy if exists "profiles_select_own"  on public.profiles;
drop policy if exists "profiles_insert_own"  on public.profiles;
drop policy if exists "profiles_update_own"  on public.profiles;
create policy "profiles_select_own" on public.profiles for select
  using ((select auth.uid()) = id);
create policy "profiles_insert_own" on public.profiles for insert
  with check ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles for update
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "keywords_select_own" on public.keywords;
drop policy if exists "keywords_insert_own" on public.keywords;
drop policy if exists "keywords_update_own" on public.keywords;
drop policy if exists "keywords_delete_own" on public.keywords;
create policy "keywords_select_own" on public.keywords for select
  using ((select auth.uid()) = user_id);
create policy "keywords_insert_own" on public.keywords for insert
  with check ((select auth.uid()) = user_id);
create policy "keywords_update_own" on public.keywords for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "keywords_delete_own" on public.keywords for delete
  using ((select auth.uid()) = user_id);

drop policy if exists "monitored_posts_select_own" on public.monitored_posts;
drop policy if exists "monitored_posts_insert_own" on public.monitored_posts;
drop policy if exists "monitored_posts_update_own" on public.monitored_posts;
drop policy if exists "monitored_posts_delete_own" on public.monitored_posts;
create policy "monitored_posts_select_own" on public.monitored_posts for select
  using ((select auth.uid()) = user_id);
create policy "monitored_posts_insert_own" on public.monitored_posts for insert
  with check ((select auth.uid()) = user_id);
create policy "monitored_posts_update_own" on public.monitored_posts for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "monitored_posts_delete_own" on public.monitored_posts for delete
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 4. sweep_runs: explicit deny-by-default (service role bypasses RLS)
-- ---------------------------------------------------------------------------
drop policy if exists "sweep_runs_service_only" on public.sweep_runs;
create policy "sweep_runs_service_only" on public.sweep_runs for all
  using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 5. Index the monitored_posts.keyword_id foreign key
-- ---------------------------------------------------------------------------
create index if not exists idx_monitored_posts_keyword_id
  on public.monitored_posts(keyword_id);


-- ============================================================================
-- SECTION 6 — Intent score backfill + integrity constraints
-- ============================================================================

-- ============================================================================
-- Echo â€” Intent score backfill + profile integrity constraints
-- ----------------------------------------------------------------------------
-- 1. The 35 existing monitored_posts rows were scored by the old client-side
--    heuristic that had a floor of 84. The edge functions now score on a 0-97
--    scale (base 30). Left alone, raising min_intent_threshold would blank the
--    entire feed because old rows all sat at 84+. This re-scores them with the
--    current algorithm.
--
-- 2. enabled_channels could contain 'linkedin' / 'facebook', which no sweep
--    function implements. Those values produced silently empty sweeps, so the
--    column is now constrained to the platforms that actually work.
--
-- 3. min_intent_threshold had no range check; a value like 500 would make every
--    sweep return nothing.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Backfill intent_score with the current algorithm (v2)
-- ---------------------------------------------------------------------------
do $$
declare
  v_high constant text[] := array[
    'looking for','recommend','recommendation','alternative to','switching from',
    'anyone using','best tool for','best software for','pricing','how much does',
    'budget','quote','need software','any suggestions','help choosing','rfp',
    'demo','trial','contract','enterprise plan','migration'
  ];
  v_med  constant text[] := array[
    'tool','software','automation','platform','integration','workflow','alternative','vs','versus'
  ];
  v_neg  constant text[] := array[
    'hiring','job opening','we are looking for candidates','free template',
    'looking to buy followers','crypto giveaway'
  ];
begin
  with scored as (
    select p.id,
      greatest(0, least(97,
        30
        + 9 * (select count(*) from unnest(v_high) x
                where lower(coalesce(p.body,'')) like '%'||x||'%')
        + 3 * (select count(*) from unnest(v_med)  x
                where lower(coalesce(p.body,'')) like '%'||x||'%')
        - 40 * (select count(*) from unnest(v_neg) x
                where lower(coalesce(p.body,'')) like '%'||x||'%')
      )) as score
    from public.monitored_posts p
  )
  update public.monitored_posts mp
  set intent_score = s.score
  from scored s
  where s.id = mp.id
    and mp.intent_score is distinct from s.score;
end $$;

-- ---------------------------------------------------------------------------
-- 2. enabled_channels: only platforms the sweep implements, never empty
-- ---------------------------------------------------------------------------
-- Repair any pre-existing bad values first, otherwise the constraint fails.
update public.profiles
set enabled_channels = array['twitter','reddit','google']
where enabled_channels is null
   or array_length(enabled_channels, 1) is null
   or array_length(enabled_channels, 1) = 0
   or not (enabled_channels <@ array['twitter','reddit','google']::text[]);

alter table public.profiles drop constraint if exists profiles_enabled_channels_supported;
alter table public.profiles
  add constraint profiles_enabled_channels_supported
  check (enabled_channels <@ array['twitter','reddit','google']::text[]);

alter table public.profiles drop constraint if exists profiles_enabled_channels_not_empty;
alter table public.profiles
  add constraint profiles_enabled_channels_not_empty
  check (coalesce(array_length(enabled_channels, 1), 0) >= 1);

-- ---------------------------------------------------------------------------
-- 3. Intent threshold must be a sane percentage
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_min_intent_threshold_range;
alter table public.profiles
  add constraint profiles_min_intent_threshold_range
  check (min_intent_threshold between 0 and 100);



