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
--   5. Dropped the unused profiles.email_digest and profiles.slack_webhook
--      columns along with guard_profile_webhook() -- no delivery channel was
--      ever wired to them, so keeping the columns only invited dead settings.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 5. Notification surface removal
-- ---------------------------------------------------------------------------
alter table public.profiles drop column if exists slack_webhook;
alter table public.profiles drop column if exists email_digest;
drop trigger if exists trg_profiles_webhook_guard on public.profiles;
drop function if exists public.guard_profile_webhook();

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
revoke execute on function public.handle_new_user()             from public, anon, authenticated;
revoke execute on function public.set_updated_at()              from public, anon, authenticated;

grant execute on function public.enforce_keyword_limit()       to service_role;
grant execute on function public.guard_profile_server_columns() to service_role;
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

-- ===========================================================================
-- SECTION 7 — Feed retention + SocialFetch integration
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Retention setting. 0 = keep everything.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists feed_retention_days integer not null default 30;

alter table public.profiles drop constraint if exists profiles_feed_retention_range;
alter table public.profiles
  add constraint profiles_feed_retention_range
  check (feed_retention_days between 0 and 365);

grant update (feed_retention_days) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Channels. `news` is served by a free treg endpoint that returns a date on
--    every result.
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_enabled_channels_supported;
alter table public.profiles
  add constraint profiles_enabled_channels_supported
  check (enabled_channels <@ array['twitter', 'reddit', 'google', 'news']);

alter table public.monitored_posts drop constraint if exists monitored_posts_platform_check;
alter table public.monitored_posts
  add constraint monitored_posts_platform_check
  check (platform in ('twitter', 'reddit', 'google', 'news'));

-- ---------------------------------------------------------------------------
-- 3. Vendor keys, service-role readable only. RLS on, zero policies: the
--    browser has no SELECT path at all, which is the same trust boundary as
--    an edge function secret. The edge functions still prefer Deno.env.
--
--    Insert your own value, never commit it:
--      insert into public.service_secrets (name, value) values
--        ('treg_token', 'treg_...')
--      on conflict (name) do update set value = excluded.value;
-- ---------------------------------------------------------------------------
create table if not exists public.service_secrets (
  name       text primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

alter table public.service_secrets enable row level security;
revoke all on table public.service_secrets from anon, authenticated;
revoke all on table public.service_secrets from public;
grant select on table public.service_secrets to service_role;

-- ---------------------------------------------------------------------------
-- 4. Feed indexes. nulls last keeps undated web-search rows at the bottom.
-- ---------------------------------------------------------------------------
create index if not exists monitored_posts_user_posted_at_idx
  on public.monitored_posts (user_id, posted_at desc nulls last, created_at desc);

create index if not exists monitored_posts_user_created_at_idx
  on public.monitored_posts (user_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. prune_feed / clear_feed
--    prune_feed removes a row only when it is BOTH older than the retention
--    window AND not written by the sweep in flight. Folding p_keep_after into
--    the cutoff made the window meaningless and wiped the feed on every sweep.
-- ---------------------------------------------------------------------------
-- NOTE: superseded further down this file, where the authorization check stops
-- testing session_user, which is a property of the connection rather than of
-- the request. "create or replace" means the later definition is what ends up in
-- the database, but do not copy the check below.
create or replace function public.prune_feed(
  p_user_id uuid default null,
  p_keep_after timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_days int;
  v_cutoff timestamptz;
  v_deleted int;
begin
  v_uid := coalesce(p_user_id, auth.uid());
  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'unauthenticated');
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and session_user <> 'postgres'
     and auth.uid() is distinct from v_uid then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;

  select feed_retention_days into v_days from public.profiles where id = v_uid;
  if v_days is null then
    return jsonb_build_object('success', false, 'error', 'profile_not_found');
  end if;

  if v_days = 0 then
    return jsonb_build_object('success', true, 'deleted', 0, 'retention_days', 0);
  end if;

  v_cutoff := now() - make_interval(days => v_days);

  with gone as (
    delete from public.monitored_posts
    where user_id = v_uid
      and coalesce(posted_at, created_at) < v_cutoff
      and (p_keep_after is null or created_at < p_keep_after)
    returning 1
  )
  select count(*) into v_deleted from gone;

  return jsonb_build_object('success', true, 'deleted', v_deleted,
                             'retention_days', v_days, 'cutoff', v_cutoff);
end;
$$;

revoke execute on function public.prune_feed(uuid, timestamptz) from public, anon;
grant  execute on function public.prune_feed(uuid, timestamptz) to authenticated, service_role;

create or replace function public.clear_feed(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_deleted int;
begin
  v_uid := coalesce(p_user_id, auth.uid());
  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'unauthenticated');
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and session_user <> 'postgres'
     and auth.uid() is distinct from v_uid then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;

  with gone as (
    delete from public.monitored_posts where user_id = v_uid returning 1
  )
  select count(*) into v_deleted from gone;

  return jsonb_build_object('success', true, 'deleted', v_deleted);
end;
$$;

revoke execute on function public.clear_feed(uuid) from public, anon;
grant  execute on function public.clear_feed(uuid) to authenticated, service_role;




-- ============================================================================
-- Inlined: 20261102_credit_wallet.sql
-- ============================================================================
-- ============================================================================
-- Credit wallet â€” the tables
-- ----------------------------------------------------------------------------
-- Prepaid credits. A workspace buys a block of credits once and spends them
-- down as it searches; there is no plan, no renewal and no recurring charge.
--
-- The shape of this schema is driven by one fact about the provider. treg may
-- charge us for a call whose answer never arrives â€” a timeout mid-flight, or a
-- 410 that means "charged, result lost". A model that decrements the balance
-- after the fact cannot tell those apart from a free failure, and either
-- refunds money we spent or bills for a job the customer did not get. So the
-- balance moves in two phases instead:
--
--   reserve  before the provider call   balance -> reserved
--   settle   after a known outcome      draw from grants, drop reserved
--   release  after a non-billable fail   reserved -> balance, no charge
--
-- Because the reserve happens before any money is at risk, the ledger can never
-- discover that it is already spent. That is the whole point of putting the
-- gate here rather than after the response.
--
-- Money is numeric(20,6) everywhere. Credits are fractional by nature, floats
-- lose pennies at exactly the scale where the numbers stop being toy values.
--
-- Definition order below is dependency order, not reading order. A foreign key
-- needs its target to exist first: topup_packages before payment_orders,
-- payment_orders before credit_grants, and the three of those before
-- credit_ledger, which references all of them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- wallet
-- One row per user. balance is what they own; reserved is the slice of that
-- currently held for a call in flight. available = balance - reserved.
-- The check constraints are the last line of defence: if a reserve path is ever
-- coded wrong, the database refuses rather than quietly going negative.
-- ---------------------------------------------------------------------------
create table if not exists public.wallet (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  balance                 numeric(20,6) not null default 0 check (balance >= 0),
  reserved                numeric(20,6) not null default 0 check (reserved >= 0),
  lifetime_granted        numeric(20,6) not null default 0 check (lifetime_granted >= 0),
  lifetime_consumed       numeric(20,6) not null default 0 check (lifetime_consumed >= 0),
  -- Revenue is recognised when credits are consumed, not when cash arrives. The
  -- difference between the two is unspent balance, which is a liability.
  recognised_revenue_usd  numeric(20,6) not null default 0,
  service_cost_usd        numeric(20,6) not null default 0,
  updated_at              timestamptz not null default now(),
  -- A reserve can never hold more than is actually owned.
  constraint wallet_reserved_within_balance check (reserved <= balance)
);

comment on table public.wallet is
  'Prepaid credit balance per user. available = balance - reserved.';
comment on column public.wallet.reserved is
  'Credits held for in-flight provider calls. Not spendable until settled or released.';

alter table public.wallet enable row level security;

drop policy if exists wallet_select_own on public.wallet;
create policy wallet_select_own
  on public.wallet for select
  using (auth.uid() = user_id);

-- No insert, update or delete policy. A client cannot write its own balance.

-- ---------------------------------------------------------------------------
-- topup_packages
-- What can be bought. Readable by the client so the pricing on screen is the
-- pricing charged; writable by nobody through the API. Changing a price is a
-- deliberate SQL edit, which is the point â€” there is no admin surface in this
-- product, so an accidental edit cannot come from the app.
--
-- provider_ref stays null until the payment account exists. Checkout fills it
-- in on first use, so going live needs no migration and no redeploy.
-- ---------------------------------------------------------------------------
create table if not exists public.topup_packages (
  code          text primary key,
  display_name  text not null,
  gross_usd     numeric(20,6) not null check (gross_usd > 0),
  credits       numeric(20,6) not null check (credits > 0),
  -- Kept separate from credits so a promotional bonus can be added without a
  -- migration. It becomes its own grant row at zero unit price.
  bonus_credits numeric(20,6) not null default 0 check (bonus_credits >= 0),
  currency      text not null default 'USD',
  active        boolean not null default true,
  sort_order    int not null default 0,
  provider_ref  text,
  created_at    timestamptz not null default now()
);

alter table public.topup_packages enable row level security;

-- A price list is public information: someone has to be able to read it before
-- they have signed up, or the landing page falls back to hardcoded prices
-- without saying so. SELECT only — no client role has a write path on this
-- table. This matches the running database; it previously said
-- auth.role() = 'authenticated' here while the live policy was `true`, so a
-- rebuild from this file produced a table the landing page could not read.
drop policy if exists topup_packages_select_all on public.topup_packages;
create policy topup_packages_select_all
  on public.topup_packages for select
  using (true);

revoke insert, update, delete on public.topup_packages from anon, authenticated;

-- ---------------------------------------------------------------------------
-- payment_orders
-- One row per attempted purchase. provider_ref carries the gateway's own
-- reference and is unique, which is what makes the webhook path replay-proof:
-- a payment.succeeded delivered twice finds the row already settled and stops.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  provider          text not null default 'dodo',
  package_code      text not null references public.topup_packages(code),
  provider_order_id text unique,
  provider_ref      text unique,
  gross_usd         numeric(20,6) not null check (gross_usd > 0),
  -- Left null until a real charge tells us the rate. Guessing it would put a
  -- fabricated number in the profit report.
  fee_usd           numeric(20,6) check (fee_usd is null or fee_usd >= 0),
  net_usd           numeric(20,6),
  currency          text not null default 'USD',
  credits_granted   numeric(20,6) not null default 0 check (credits_granted >= 0),
  status            text not null default 'created' check (status in (
                      'created', 'pending', 'succeeded', 'failed', 'refunded')),
  checkout_url      text,
  created_at        timestamptz not null default now(),
  settled_at        timestamptz
);

create index if not exists idx_payment_orders_user_created
  on public.payment_orders(user_id, created_at desc);

create index if not exists idx_payment_orders_status
  on public.payment_orders(status)
  where status in ('created', 'pending');

alter table public.payment_orders enable row level security;

drop policy if exists payment_orders_select_own on public.payment_orders;
create policy payment_orders_select_own
  on public.payment_orders for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- credit_grants
-- The FIFO pool. A grant is one issuance and it remembers what that issuance
-- actually cost per credit.
--
-- Keeping them discrete rather than storing a single balance is what makes
-- revenue honest. If a $10 top-up carried a 10% bonus, folding the bonus into
-- the same row would recognise $0.05 of revenue per bonus credit that nobody
-- ever paid. Separate rows with their own unit_price_usd â€” the bonus row at 0
-- â€” keeps recognised revenue equal to cash received, to the credit.
-- ---------------------------------------------------------------------------
create table if not exists public.credit_grants (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  source             text not null check (source in ('topup', 'bonus', 'grant', 'adjustment')),
  payment_order_id   uuid references public.payment_orders(id) on delete set null,
  credits            numeric(20,6) not null check (credits > 0),
  credits_remaining  numeric(20,6) not null check (credits_remaining >= 0),
  -- Cash received divided by credits issued. The rate revenue is recognised at.
  unit_price_usd     numeric(20,6) not null default 0 check (unit_price_usd >= 0),
  expires_at         timestamptz,
  created_at         timestamptz not null default now(),
  constraint credit_grants_remaining_within_total check (credits_remaining <= credits)
);

create index if not exists idx_credit_grants_fifo
  on public.credit_grants(user_id, expires_at nulls last, created_at)
  where credits_remaining > 0;

create index if not exists idx_credit_grants_order
  on public.credit_grants(payment_order_id)
  where payment_order_id is not null;

alter table public.credit_grants enable row level security;

drop policy if exists credit_grants_select_own on public.credit_grants;
create policy credit_grants_select_own
  on public.credit_grants for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- reservations
-- Backing store for the two-phase model. Exists so the database, not the
-- calling code, is the thing that refuses a second finalisation. A sweep that
-- settles twice, or settles after releasing, is a double charge; catching that
-- in a constraint means the bug cannot reach the ledger.
-- ---------------------------------------------------------------------------
create table if not exists public.reservations (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  idempotency_key   text not null unique,
  credits_held      numeric(20,6) not null check (credits_held >= 0),
  status            text not null default 'held'
                      check (status in ('held', 'settled', 'released')),
  reason            text,
  context           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  finalised_at      timestamptz
);

create index if not exists idx_reservations_user_status
  on public.reservations(user_id, status, created_at desc);

-- Stale holds are worth finding: a reservation that never finalised is credits
-- locked up with nothing coming to release them.
create index if not exists idx_reservations_held
  on public.reservations(created_at)
  where status = 'held';

alter table public.reservations enable row level security;

drop policy if exists reservations_select_own on public.reservations;
create policy reservations_select_own
  on public.reservations for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- credit_ledger
-- Append-only. Every movement of the balance lands here with the numbers needed
-- to reconstruct it later: what moved, what it was worth, what it cost us, and
-- what it was tied to.
--
-- Append-only is enforced by giving clients no update or delete policy at all,
-- rather than by a trigger that could be bypassed by a role nobody thought of.
-- ---------------------------------------------------------------------------
create table if not exists public.credit_ledger (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  delta             numeric(20,6) not null,
  balance_after     numeric(20,6) not null,
  kind              text not null check (kind in (
                      'topup', 'grant', 'bonus', 'usage', 'refund',
                      'reversal', 'expiry', 'adjustment')),
  reservation_id    uuid references public.reservations(id) on delete set null,
  grant_id          uuid references public.credit_grants(id) on delete set null,
  payment_order_id  uuid references public.payment_orders(id) on delete set null,
  api_usage_id      bigint,
  -- Recognised on consumption only. A topup row carries zero: cash arrived, it
  -- was not earned, and calling it revenue would let a workspace book money it
  -- has not spent yet.
  revenue_usd       numeric(20,6) not null default 0,
  service_cost_usd  numeric(20,6) not null default 0,
  idempotency_key   text unique,
  note              text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists idx_credit_ledger_user_created
  on public.credit_ledger(user_id, created_at desc);

create index if not exists idx_credit_ledger_reservation
  on public.credit_ledger(reservation_id)
  where reservation_id is not null;

alter table public.credit_ledger enable row level security;

drop policy if exists credit_ledger_select_own on public.credit_ledger;
create policy credit_ledger_select_own
  on public.credit_ledger for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- api_usage
-- One row per billable provider call, carrying the provider's own reported
-- cost. treg returns what it actually charged in x-treg-cost-micro, so the cost
-- column here is measured rather than estimated and the profit it implies is
-- real. The pricing_config estimate covers only the window before the response
-- comes back.
--
-- Metadata only. A full response body would carry whatever people posted
-- publicly, which is not ours to keep.
-- ---------------------------------------------------------------------------
create table if not exists public.api_usage (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  idempotency_key     text not null unique,
  operation           text not null,
  provider            text not null default 'treg',
  provider_call_id    text,
  provider_cost_usd   numeric(20,8) not null default 0 check (provider_cost_usd >= 0),
  credits_charged     numeric(20,6) not null default 0 check (credits_charged >= 0),
  revenue_usd         numeric(20,6) not null default 0,
  gross_profit_usd    numeric(20,8) generated always as (revenue_usd - provider_cost_usd) stored,
  -- success          the caller got what it asked for
  -- free             ran, found nothing, treg did not bill
  -- upstream_failed  treg billed but the upstream provider failed; paid, no value
  -- not_billed       failed in a way treg never charges for
  -- uncertain        we may have been charged and cannot tell yet; reconcile later
  outcome             text not null check (outcome in (
                        'success', 'free', 'upstream_failed',
                        'not_billed', 'uncertain')),
  http_status         int,
  duration_ms         int,
  error_code          text,
  reservation_id      uuid references public.reservations(id) on delete set null,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists idx_api_usage_user_created
  on public.api_usage(user_id, created_at desc);

create index if not exists idx_api_usage_operation
  on public.api_usage(operation, created_at desc);

-- Reconciliation against treg's own ledger. A call id present in
-- GET /calls/{id} but absent here means we were charged for something we never
-- recorded, which is exactly what this index makes findable.
create index if not exists idx_api_usage_provider_call
  on public.api_usage(provider_call_id)
  where provider_call_id is not null;

create index if not exists idx_api_usage_uncertain
  on public.api_usage(created_at)
  where outcome = 'uncertain';

alter table public.api_usage enable row level security;

drop policy if exists api_usage_select_own on public.api_usage;
create policy api_usage_select_own
  on public.api_usage for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- pricing_config
-- The single place a price lives. Edge functions read it at call time and never
-- accept a price from the client.
--
-- provider_cost_usd is a pre-call estimate. The authoritative figure is what
-- treg reports afterwards, which lands in api_usage.provider_cost_usd.
-- cost_verified records whether the number has actually been confirmed against
-- the catalog or a live call, so an unverified estimate is never mistaken for a
-- measured cost in a report.
--
-- There is no admin UI for this table, by design. It is edited by SQL.
-- ---------------------------------------------------------------------------
create table if not exists public.pricing_config (
  operation          text primary key,
  display_name       text not null,
  provider_endpoint  text not null,
  provider_cost_usd  numeric(20,8) not null default 0 check (provider_cost_usd >= 0),
  cost_verified      boolean not null default false,
  cost_source        text not null default 'unverified' check (cost_source in (
                       'catalog', 'rate_card', 'observed', 'live_confirmed', 'unverified')),
  credits            numeric(20,6) not null check (credits >= 0),
  enabled            boolean not null default true,
  version            int not null default 1,
  effective_from     timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.pricing_config enable row level security;

drop policy if exists pricing_config_select_all on public.pricing_config;
create policy pricing_config_select_all
  on public.pricing_config for select
  using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- pricing_audit
-- Who changed a price, when, and from what to what. changed_by is a free-text
-- operator label rather than a user reference: this product has no admin role,
-- so there is no identity to point at, and inventing one would reintroduce
-- exactly the surface that was deliberately left out.
--
-- Written by a trigger rather than by application code, so a change made
-- directly in SQL is recorded too.
-- ---------------------------------------------------------------------------
create table if not exists public.pricing_audit (
  id          bigint generated always as identity primary key,
  operation   text not null,
  field       text not null,
  old_value   jsonb,
  new_value   jsonb,
  changed_by  text,
  changed_at  timestamptz not null default now(),
  reason      text
);

create index if not exists idx_pricing_audit_operation
  on public.pricing_audit(operation, changed_at desc);

alter table public.pricing_audit enable row level security;

-- ---------------------------------------------------------------------------
-- webhook_events
-- Dodo retries, and retries can arrive hours apart and out of order. The
-- webhook id is recorded before processing and marked afterwards, which is what
-- lets a redelivery of the same event be recognised as a redelivery.
-- ---------------------------------------------------------------------------
create table if not exists public.webhook_events (
  id            bigint generated always as identity primary key,
  provider      text not null default 'dodo',
  webhook_id    text not null unique,
  event_type    text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'received' check (status in (
                  'received', 'processed', 'failed', 'ignored')),
  attempts      int not null default 0,
  last_error    text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

create index if not exists idx_webhook_events_status
  on public.webhook_events(status, received_at);

alter table public.webhook_events enable row level security;

-- No client policies at all. The browser never reads this.

-- ============================================================================
-- Inlined: 20261103_wallet_rpcs.sql
-- ============================================================================
-- ============================================================================
-- Credit wallet â€” the functions
-- ----------------------------------------------------------------------------
-- Six entry points. Everything that moves money goes through one of them, and
-- none of them is reachable by a client, because a client that can write its
-- own balance is a client that can set it to a million.
--
-- The two-phase shape is the whole design:
--
--   wallet_reserve    take the credits before the provider call, so the answer
--                     to "can this workspace afford this" is known while the
--                     answer is still free to change
--   wallet_settle     charge what was actually billable and drop the rest
--   wallet_release    give the hold back untouched when nothing was billed
--
-- Three properties these are built to hold, each of which was a real defect in
-- the previous credit system:
--
-- 1. No unbounded free usage. The reserve refuses before a single provider call
--    is made. The earlier version tallied a shortfall after the fact and then
--    discarded it, so a workspace with no credits kept being served and the
--    balance never left zero.
--
-- 2. Predictable billing. A sweep reserves for its worst case and settles for
--    what actually billed, so a Reddit keyword whose primary fell through to
--    the fallback costs the same either way. The customer is billed for the
--    result, not for the retry.
--
-- 3. No overdraft, by decision. Out of credits is a refusal, not a loan. The
--    database refuses to hold a balance below zero regardless.
--
-- Every function returns jsonb rather than raising, except where raising is the
-- clearer answer. A caller that wants to know "can they afford it" needs the
-- shortfall to render a message, and an exception cannot carry that back.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- wallet_apply_grant
-- The only path that adds credits. Cash in, a grant row, a ledger row and the
-- wallet totals, all in one transaction.
--
-- The caller passes the unit price it actually received the money at rather
-- than this function deriving one from the package, because a refund, a
-- discount or a partial capture all mean the real rate is not the list rate.
-- Deriving it here would quietly recognise revenue that was never collected.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_apply_grant(
  p_user_id          uuid,
  p_credits          numeric,
  p_source           text,
  p_unit_price_usd   numeric,
  p_payment_order_id uuid default null,
  p_idempotency_key  text default null,
  p_expires_at       timestamptz default null,
  p_metadata         jsonb    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_wallet       public.wallet%rowtype;
  v_credits      numeric := greatest(coalesce(p_credits, 0), 0);
  v_unit         numeric := greatest(coalesce(p_unit_price_usd, 0), 0);
  v_grant_id     uuid;
  v_seen_balance numeric;
  v_balance      numeric;
begin
  if v_credits <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  -- Replaying a grant must not double the balance. This is the path a retried
  -- payment webhook lands on, and a retry there is expected rather than a bug.
  --
  -- The ledger is where the answer lives, because the unique constraint on
  -- idempotency_key is on the ledger. Anything less direct than asking the
  -- ledger will eventually disagree with that constraint and turn a routine
  -- retry into an error.
  if p_idempotency_key is not null then
    select l.grant_id, l.balance_after into v_grant_id, v_seen_balance
      from public.credit_ledger l
     where l.idempotency_key = p_idempotency_key;

    if found then
      return jsonb_build_object(
        'ok', true,
        'duplicate', true,
        'grant_id', v_grant_id,
        'balance_after', v_seen_balance
      );
    end if;
  end if;

  insert into public.wallet (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

  select * into v_wallet from public.wallet where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet_apply_grant: wallet % not found', p_user_id;
  end if;

  insert into public.credit_grants (
    user_id, source, payment_order_id, credits, credits_remaining,
    unit_price_usd, expires_at
  ) values (
    p_user_id, p_source, p_payment_order_id, v_credits, v_credits,
    v_unit, p_expires_at
  ) returning id into v_grant_id;

  v_balance := v_wallet.balance + v_credits;

  update public.wallet
     set balance          = v_balance,
         lifetime_granted = lifetime_granted + v_credits,
         updated_at       = now()
   where user_id = p_user_id;

  -- Revenue stays zero here on purpose. Cash received is not revenue until the
  -- credits that represent it are actually consumed; until then it is a
  -- liability sitting on the balance sheet.
  insert into public.credit_ledger (
    user_id, delta, balance_after, kind, grant_id, payment_order_id,
    revenue_usd, service_cost_usd, idempotency_key, note, metadata
  ) values (
    p_user_id, v_credits, v_balance,
    case when p_source = 'topup' then 'topup'::text else 'grant'::text end,
    v_grant_id, p_payment_order_id,
    0, 0, p_idempotency_key,
    'Credits added (' || p_source || ')',
    coalesce(p_metadata, '{}'::jsonb)
  );

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'grant_id', v_grant_id,
    'credits_granted', v_credits,
    'unit_price_usd', v_unit,
    'balance_after', v_balance
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- wallet_reserve
-- Take the credits for a whole job up front, before any provider call. For a
-- sweep this is every keyword times every channel at once: the job either runs
-- or it does not. A sweep that ran for six of eight keywords would charge for a
-- truncated search and quietly under-report the results.
--
-- Returns ok=false with the shortfall rather than raising, so the caller can
-- tell the user how much is missing.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_reserve(
  p_user_id         uuid,
  p_credits         numeric,
  p_idempotency_key text,
  p_context         jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_wallet      public.wallet%rowtype;
  v_needed      numeric := greatest(coalesce(p_credits, 0), 0);
  v_available   numeric;
  v_reservation uuid;
  v_existing    uuid;
begin
  if v_needed <= 0 then
    return jsonb_build_object('ok', true, 'reserved', 0, 'reservation_id', null);
  end if;

  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'wallet_reserve: idempotency_key is required';
  end if;

  -- A retried request reuses the same hold rather than stacking a second one.
  select id into v_existing
    from public.reservations
   where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'reservation_id', v_existing,
      'reserved', (select credits_held from public.reservations where id = v_existing)
    );
  end if;

  insert into public.wallet (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

  -- The row lock is what makes concurrent sweeps safe. Two workspaces, or the
  -- same workspace sweeping twice at the same moment, both queue here; the
  -- second one reads the balance the first one already moved. Without it both
  -- would read the same pre-reserve figure and both would decide they could
  -- afford it.
  select * into v_wallet from public.wallet where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet_reserve: wallet % not found', p_user_id;
  end if;

  v_available := v_wallet.balance - v_wallet.reserved;

  if v_available < v_needed then
    return jsonb_build_object(
      'ok', false,
      'error', 'insufficient_credits',
      'required', v_needed,
      'available', greatest(v_available, 0),
      'shortfall', v_needed - greatest(v_available, 0),
      'balance_after', v_wallet.balance
    );
  end if;

  insert into public.reservations (
    user_id, idempotency_key, credits_held, status, context
  ) values (
    p_user_id, p_idempotency_key, v_needed, 'held', coalesce(p_context, '{}'::jsonb)
  ) returning id into v_reservation;

  update public.wallet
     set reserved  = reserved + v_needed,
         updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'reservation_id', v_reservation,
    'reserved', v_needed,
    'available_after', v_available - v_needed,
    'balance_after', v_wallet.balance
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- wallet_settle
-- Close a reservation and charge what was actually billable.
--
-- p_credits_charged is what the outcomes actually justified, which can be less
-- than what was reserved: a search that found nothing is free, a call that
-- failed in a way treg never bills for is free. The difference returns to the
-- balance rather than being kept.
--
-- Costs are drawn from the grants FIFO at each grant's own unit price, so a
-- bonus tranche consumed later recognises at zero and does not inflate revenue
-- beyond what was collected.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_settle(
  p_reservation_id  uuid,
  p_credits_charged numeric,
  p_provider_cost   numeric default 0,
  p_idempotency_key text default null,
  p_note            text    default null,
  p_metadata        jsonb   default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_res       public.reservations%rowtype;
  v_wallet    public.wallet%rowtype;
  v_charge    numeric := greatest(coalesce(p_credits_charged, 0), 0);
  v_cost      numeric := greatest(coalesce(p_provider_cost, 0), 0);
  v_needed    numeric := v_charge;
  v_take      numeric;
  v_revenue   numeric := 0;
  v_drawn     numeric := 0;
  v_new_bal   numeric;
  v_ledger_id bigint;
  v_row       record;
begin
  -- FOR UPDATE plus the status check is what makes settling twice impossible.
  -- A double settle is a double charge, and it has to be impossible at the
  -- database rather than merely unlikely in the caller.
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'reservation_not_found');
  end if;

  if v_res.status <> 'held' then
    return jsonb_build_object(
      'ok', false,
      'error', 'reservation_already_finalised',
      'status', v_res.status
    );
  end if;

  -- Never charge more than was held, whatever the caller passes. A sweep that
  -- over-reports its own billing should be clipped, not obeyed.
  if v_charge > v_res.credits_held then
    v_charge := v_res.credits_held;
    v_needed  := v_charge;
  end if;

  select * into v_wallet from public.wallet where user_id = v_res.user_id for update;

  update public.reservations
     set status = 'settled', finalised_at = now(), reason = coalesce(p_note, 'settled')
   where id = p_reservation_id;

  if v_charge > 0 then
    -- Oldest live grant first, soonest expiry ahead of never-expiring ones.
    for v_row in
      select id, credits_remaining, unit_price_usd
        from public.credit_grants
       where user_id = v_res.user_id
         and credits_remaining > 0
         and (expires_at is null or expires_at > now())
       order by expires_at nulls last, created_at
       for update
    loop
      exit when v_needed <= 0;

      v_take := least(v_needed, v_row.credits_remaining);

      update public.credit_grants
         set credits_remaining = credits_remaining - v_take
       where id = v_row.id;

      v_revenue := v_revenue + (v_take * v_row.unit_price_usd);
      v_drawn   := v_drawn + v_take;
      v_needed  := v_needed - v_take;
    end loop;
  end if;

  -- If the grants ran dry the charge is clipped to what could actually be
  -- drawn. It cannot silently fall through to a negative balance.
  v_charge  := v_drawn;
  v_new_bal := v_wallet.balance - v_charge;

  update public.wallet
     set balance                = v_new_bal,
         reserved               = reserved - v_res.credits_held,
         lifetime_consumed      = lifetime_consumed + v_charge,
         recognised_revenue_usd = recognised_revenue_usd + v_revenue,
         service_cost_usd       = service_cost_usd + v_cost,
         updated_at             = now()
   where user_id = v_res.user_id;

  insert into public.credit_ledger (
    user_id, delta, balance_after, kind, reservation_id,
    revenue_usd, service_cost_usd, idempotency_key, note, metadata
  ) values (
    v_res.user_id, -v_charge, v_new_bal, 'usage', p_reservation_id,
    v_revenue, v_cost, p_idempotency_key, p_note,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'reserved', v_res.credits_held,
      'released', v_res.credits_held - v_charge,
      'provider_cost', v_cost
    )
  ) returning id into v_ledger_id;

  return jsonb_build_object(
    'ok', true,
    'credits_charged', v_charge,
    'credits_released', v_res.credits_held - v_charge,
    'revenue_recognized', round(v_revenue, 6),
    'service_cost', round(v_cost, 8),
    'ledger_id', v_ledger_id,
    'balance_after', v_new_bal
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- wallet_release
-- Give a hold back untouched. For every outcome treg does not bill: a
-- pre-call validation failure, a 5xx, a 429, a 503 for capacity, a 402 for our
-- own balance running out, a provider 4xx, a search that returned nothing.
--
-- This is the function that makes the difference between a provider that is
-- briefly unavailable costing the customer a charge and costing nothing. It
-- writes no usage row and no ledger row, because nothing happened.
--
-- Uncertain outcomes do not come here. A timeout where treg may still have
-- charged is settled as uncertain and reconciled later, because refunding it
-- automatically is how a workspace ends up being served for free.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_release(
  p_reservation_id uuid,
  p_reason         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_res    public.reservations%rowtype;
  v_wallet public.wallet%rowtype;
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'reservation_not_found');
  end if;

  if v_res.status <> 'held' then
    return jsonb_build_object(
      'ok', false,
      'error', 'reservation_already_finalised',
      'status', v_res.status
    );
  end if;

  select * into v_wallet from public.wallet where user_id = v_res.user_id for update;

  update public.reservations
     set status = 'released', finalised_at = now(), reason = coalesce(p_reason, 'released')
   where id = p_reservation_id;

  update public.wallet
     set reserved    = reserved - v_res.credits_held,
         updated_at = now()
   where user_id = v_res.user_id;

  return jsonb_build_object(
    'ok', true,
    'released', v_res.credits_held,
    'balance_after', v_wallet.balance
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- wallet_topup_from_order
-- Settle a paid order into credits. Idempotent twice over: on the order's own
-- status, so a second webhook for a settled order does nothing, and on the
-- ledger key, so a replay cannot double the grant even if the status somehow
-- looked unsettled.
--
-- The bonus, if the package has one, becomes a separate grant at zero unit
-- price rather than being folded into the paid one. Folding it in would
-- recognise revenue on credits that were given away.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_topup_from_order(
  p_order_id      uuid,
  p_fee_usd       numeric default null,
  p_net_usd       numeric default null,
  p_provider_ref  text  default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_order    public.payment_orders%rowtype;
  v_pkg      public.topup_packages%rowtype;
  v_unit     numeric;
  v_result   jsonb;
  v_bonus    jsonb;
begin
  select * into v_order from public.payment_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  if v_order.status = 'succeeded' and v_order.credits_granted > 0 then
    return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', p_order_id);
  end if;

  select * into v_pkg from public.topup_packages where code = v_order.package_code;

  -- Net cash is what actually arrived. Gross would recognise revenue the
  -- gateway kept.
  v_unit := case
              when v_order.net_usd is not null then v_order.net_usd / v_order.credits_granted
              when p_net_usd    is not null then p_net_usd / v_order.credits_granted
              else v_pkg.gross_usd / v_pkg.credits
            end;

  v_result := public.wallet_apply_grant(
    p_user_id          => v_order.user_id,
    p_credits          => v_pkg.credits,
    p_source           => 'topup',
    p_unit_price_usd   => v_unit,
    p_payment_order_id => p_order_id,
    p_idempotency_key  => coalesce(p_idempotency_key, 'topup:' || p_order_id::text),
    p_metadata         => jsonb_build_object('package', v_order.package_code)
  );

  if v_pkg.bonus_credits > 0 then
    v_bonus := public.wallet_apply_grant(
      p_user_id          => v_order.user_id,
      p_credits          => v_pkg.bonus_credits,
      p_source           => 'bonus',
      p_unit_price_usd   => 0,
      p_payment_order_id => p_order_id,
      p_idempotency_key  => coalesce(p_idempotency_key, 'topup:' || p_order_id::text) || ':bonus',
      p_metadata         => jsonb_build_object('package', v_order.package_code)
    );
  end if;

  update public.payment_orders
     set status          = 'succeeded',
         credits_granted = v_pkg.credits + v_pkg.bonus_credits,
         fee_usd         = p_fee_usd,
         net_usd         = coalesce(p_net_usd, v_order.net_usd),
         provider_ref    = coalesce(p_provider_ref, v_order.provider_ref),
         settled_at      = now()
   where id = p_order_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'order_id', p_order_id,
    'credits_granted', v_pkg.credits + v_pkg.bonus_credits,
    'unit_price_usd', v_unit,
    'balance_after', v_result->'balance_after'
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- wallet_revoke_grant
-- The refund path. Take back the unspent portion of a grant, leaving whatever
-- was consumed alone: that work was delivered and the money was spent.
--
-- The balance floors at zero rather than going negative. A workspace that
-- already spent the credits and then got a refund has nothing left to give
-- back, and the difference is ours to absorb, not theirs to owe.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_revoke_grant(
  p_grant_id uuid,
  p_reason   text default 'refund'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grant    public.credit_grants%rowtype;
  v_wallet   public.wallet%rowtype;
  v_take     numeric;
  v_new_bal  numeric;
  v_ledger   bigint;
begin
  select * into v_grant from public.credit_grants where id = p_grant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;

  if v_grant.credits_remaining <= 0 then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'already_fully_spent');
  end if;

  select * into v_wallet from public.wallet where user_id = v_grant.user_id for update;

  v_take := least(v_grant.credits_remaining, v_wallet.balance);
  v_new_bal := v_wallet.balance - v_take;

  update public.credit_grants
     set credits_remaining = credits_remaining - v_take
   where id = p_grant_id;

  update public.wallet
     set balance          = v_new_bal,
         lifetime_granted = greatest(lifetime_granted - v_take, 0),
         updated_at       = now()
   where user_id = v_grant.user_id;

  insert into public.credit_ledger (
    user_id, delta, balance_after, kind, grant_id, revenue_usd, note
  ) values (
    v_grant.user_id, -v_take, v_new_bal, 'reversal', p_grant_id, 0,
    coalesce(p_reason, 'refund')
  ) returning id into v_ledger;

  return jsonb_build_object(
    'ok', true,
    'revoked', v_take,
    'unrevokable', v_grant.credits_remaining - v_take,
    'balance_after', v_new_bal
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- quote_sweep
-- What a sweep would cost, without reserving anything. Lets the client show a
-- running figure and lets the cron decide who to skip before it starts making
-- provider calls, rather than discovering the shortfall halfway through.
--
-- Credits come from pricing_config, never from the caller. A client that could
-- name its own price would not need this table at all.
-- ---------------------------------------------------------------------------
create or replace function public.quote_sweep(p_user_id uuid, p_keywords int, p_operations text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_wallet   public.wallet%rowtype;
  v_needed   numeric := 0;
  v_count    int      := greatest(coalesce(p_keywords, 0), 0);
  v_credits  numeric;
  v_available numeric;
  v_op       text;
begin
  select * into v_wallet from public.wallet where user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'wallet_not_found');
  end if;

  v_available := greatest(v_wallet.balance - v_wallet.reserved, 0);

  -- A disabled or unknown operation contributes nothing and is simply absent
  -- from the total, rather than failing the whole quote. The caller separately
  -- refuses to run a disabled operation, so a silent zero here cannot turn into
  -- a free sweep.
  foreach v_op in array coalesce(p_operations, array[]::text[]) loop
    select p.credits into v_credits
      from public.pricing_config p
     where p.operation = v_op and p.enabled = true;

    if found then
      v_needed := v_needed + (v_count * v_credits);
    end if;
  end loop;

  -- Deliberately no revenue figure here. What a job is worth depends on which
  -- grants it draws down at what unit price, which is only known at settlement.
  -- Multiplying credits by the headline rate would report a number that is
  -- usually close and occasionally wrong, which is worse than reporting none.
  return jsonb_build_object(
    'ok', true,
    'keywords', v_count,
    'required', v_needed,
    'available', v_available,
    'affordable', v_available >= v_needed,
    'shortfall', greatest(v_needed - v_available, 0)
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Grants, revokes
-- None of these are reachable by a client. The whole reason the wallet cannot
-- be tampered with is that there is no path from the API to these functions;
-- a revoke here would undo the entire model.
-- ---------------------------------------------------------------------------
revoke execute on function public.wallet_apply_grant(uuid, numeric, text, numeric, uuid, text, timestamptz, jsonb) from public, anon, authenticated;
revoke execute on function public.wallet_reserve(uuid, numeric, text, jsonb) from public, anon, authenticated;
revoke execute on function public.wallet_settle(uuid, numeric, numeric, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.wallet_release(uuid, text) from public, anon, authenticated;
revoke execute on function public.wallet_topup_from_order(uuid, numeric, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.wallet_revoke_grant(uuid, text) from public, anon, authenticated;
revoke execute on function public.quote_sweep(uuid, integer, text[]) from public, anon, authenticated;

grant execute on function public.wallet_apply_grant(uuid, numeric, text, numeric, uuid, text, timestamptz, jsonb) to service_role;
grant execute on function public.wallet_reserve(uuid, numeric, text, jsonb) to service_role;
grant execute on function public.wallet_settle(uuid, numeric, numeric, text, text, jsonb) to service_role;
grant execute on function public.wallet_release(uuid, text) to service_role;
grant execute on function public.wallet_topup_from_order(uuid, numeric, numeric, text, text) to service_role;
grant execute on function public.wallet_revoke_grant(uuid, text) to service_role;
grant execute on function public.quote_sweep(uuid, integer, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- A wallet row for every existing user
-- Created here rather than in a signup trigger so that users who already exist
-- have a balance to read. Rows are inserted on demand by the functions anyway;
-- this just means nobody's first billing page render is an error.
-- ---------------------------------------------------------------------------
insert into public.wallet (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- A pricing change is always audited, including one made directly in SQL
-- ---------------------------------------------------------------------------
create or replace function public.audit_pricing_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_field text;
begin
  foreach v_field in array array['credits', 'enabled', 'provider_cost_usd', 'cost_verified'] loop
    if to_jsonb(new) -> v_field is distinct from to_jsonb(old) -> v_field then
      insert into public.pricing_audit (operation, field, old_value, new_value)
      values (
        coalesce(new.operation, old.operation),
        v_field,
        to_jsonb(old) -> v_field,
        to_jsonb(new) -> v_field
      );
    end if;
  end loop;
  return new;
end;
$fn$;

drop trigger if exists trg_pricing_audit on public.pricing_config;
create trigger trg_pricing_audit
  after update on public.pricing_config
  for each row execute function public.audit_pricing_change();

revoke execute on function public.audit_pricing_change() from public, anon, authenticated;

-- ============================================================================
-- Inlined: 20261104_pricing_seed.sql
-- ============================================================================
-- ============================================================================
-- Credit wallet â€” the seed prices
-- ----------------------------------------------------------------------------
-- What things cost, and what can be bought.
--
-- The provider costs below were read out of treg's own catalog rather than
-- estimated, and two of them were confirmed against a live call, which is where
-- the live_confirmed marker comes from. They are still only the estimate the
-- system quotes before a call: the figure that actually lands in the profit
-- report is whatever treg reports in x-treg-cost-micro afterwards, so a provider
-- price change shows up in the numbers without anyone editing this file.
--
-- This table is edited by SQL. There is no admin screen for it in this product,
-- which is deliberate â€” the price lives in one place, it is versioned, and
-- every change to it is audited whether it came from a migration or from an
-- editor.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- topup_packages
-- 20 credits per dollar. The unit price is derived from these rows when a grant
-- is issued and stored on the grant itself, so changing a package price later
-- never reprices credits that were already sold.
-- ---------------------------------------------------------------------------
insert into public.topup_packages (code, display_name, gross_usd, credits, bonus_credits, currency, active, sort_order)
values
  ('starter_200',  '200 credits',  10.00,  200,  0, 'USD', true, 10),
  ('standard_500', '500 credits',  25.00,  500,  0, 'USD', true, 20),
  ('pack_1000',    '1000 credits', 50.00, 1000,  0, 'USD', true, 30)
on conflict (code) do update
   set display_name  = excluded.display_name,
       gross_usd     = excluded.gross_usd,
       credits       = excluded.credits,
       bonus_credits = excluded.bonus_credits,
       currency      = excluded.currency,
       active        = excluded.active,
       sort_order    = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- pricing_config
-- One row per logical operation, never per provider call.
--
-- Reddit is the case that forces this. Its primary and its fallback are both
-- billed calls, so a per-call price would make the same keyword cost two
-- credits on one sweep and four the next depending on whether the primary
-- happened to work. Charging per operation makes it two either way. The
-- fallback chain lives in the treg client as routing, which is where routing
-- belongs; what the customer pays is one number.
--
-- cost_verified says the figure was confirmed rather than assumed. Everything
-- else about these rows is a business decision and changes with the pricing
-- conversation, not with treg.
-- ---------------------------------------------------------------------------
insert into public.pricing_config (
  operation, display_name, provider_endpoint, provider_cost_usd,
  cost_verified, cost_source, credits, enabled, version, effective_from
)
values
  (
    'treg.twitter.search',
    'Twitter search',
    'anyapi.x.search.posts',
    0.00075,
    true, 'catalog', 1, true, 1, now()
  ),
  (
    'treg.reddit.search',
    'Reddit search',
    'tikhub.x.reddit-app-fetch-dynamic-search',
    0.00100,
    true, 'live_confirmed', 2, true, 1, now()
  ),
  (
    'treg.web.search',
    'Web search',
    'crawl4ai.web.search.rich',
    0.00015,
    true, 'catalog', 1, true, 1, now()
  ),
  (
    -- Charged one credit despite costing us nothing: treg bills this at zero.
    -- It is the only operation here with no provider cost, which makes it the
    -- one line in the margin report that will read 100%. That is correct.
    'treg.news.search',
    'Press & news',
    'tinyfish.web.search.news',
    0.00000,
    true, 'live_confirmed', 1, true, 1, now()
  )
on conflict (operation) do update
   set display_name      = excluded.display_name,
       provider_endpoint = excluded.provider_endpoint,
       -- credits, enabled and version are deliberately left alone on re-seed.
       -- Re-running a migration must never silently reprice live customers or
       -- re-enable an endpoint somebody deliberately switched off. Price
       -- changes go through an explicit update, which the audit trigger records.
       provider_cost_usd  = excluded.provider_cost_usd,
       cost_verified      = excluded.cost_verified,
       cost_source        = excluded.cost_source;

-- ============================================================================
-- Inlined: 20261105_billing_reports.sql
-- ============================================================================
-- ============================================================================
-- Credit wallet — reconciliation and reporting views
-- ----------------------------------------------------------------------------
-- Read by the operator directly from SQL. Deliberately not surfaced in the app:
-- this product has no admin screen, so a view nobody can reach from the browser
-- cannot be tampered with through the browser either.
--
-- The reconciliation views exist to answer one question honestly: does what we
-- think treg charged us match what treg says it charged us? Everything else here
-- is margin reporting, which is only trustworthy if that question comes back
-- clean.
--
-- None of these views adjust anything. They surface drift; correcting it is a
-- deliberate decision, never an automatic one.
--
-- Written with derived tables rather than CTEs. Plain SELECT ... FROM ( ... ) is
-- used throughout because the tool these migrations are applied through rejects
-- a leading WITH clause, and the two are equivalent to the database. Anyone
-- reading this to check a number should not have to care which form was used.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- What we believe we spent, per operation
--
-- provider_cost_usd here is what treg reported in x-treg-cost-micro, summed
-- across every call. gross_profit_usd is a stored generated column on api_usage,
-- so this is revenue minus measured cost with no rounding of its own.
-- ---------------------------------------------------------------------------
create or replace view public.v_margin_by_operation as
select
  operation,
  count(*)                                                          as calls,
  count(*) filter (where outcome = 'success')                       as succeeded,
  count(*) filter (where outcome = 'free')                          as free,
  count(*) filter (where outcome = 'upstream_failed')               as upstream_failed,
  count(*) filter (where outcome = 'uncertain')                     as uncertain,
  sum(provider_cost_usd)                                             as provider_cost_usd,
  sum(revenue_usd)                                                   as revenue_usd,
  sum(gross_profit_usd)                                              as gross_profit_usd,
  -- Null rather than zero when there is no revenue to take a margin of, so an
  -- empty month reads as unknown instead of as a perfect margin.
  round(100 * sum(gross_profit_usd) / nullif(sum(revenue_usd), 0), 1) as gross_margin_pct,
  min(created_at)                                                    as first_call,
  max(created_at)                                                    as last_call
from public.api_usage
group by operation;

comment on view public.v_margin_by_operation is
  'Measured provider cost and recognised revenue per operation. Cost comes from the charge treg reported, not from the seeded estimate.';

-- ---------------------------------------------------------------------------
-- Platform totals
--
-- Gross and net are kept apart on purpose.
--
--   gross_profit   = revenue recognised - provider cost. What the search layer
--                    earned.
--   net_cash       = what actually landed from payments.
--   unearned_cash  = net cash minus recognised revenue. Normally positive:
--                    credits bought and not yet spent. This is the honest home
--                    for unspent balance — counting it as profit is the single
--                    easiest way to overstate this business.
--
-- Gateway fees sit on payment_orders.fee_usd and stay NULL until a real charge
-- reports one. A null is the honest state; a guessed percentage would make every
-- net figure a fiction.
-- ---------------------------------------------------------------------------
create or replace view public.v_platform_totals as
select
  (select coalesce(sum(revenue_usd), 0) from public.api_usage)         as recognised_revenue_usd,
  (select coalesce(sum(provider_cost_usd), 0) from public.api_usage)   as provider_cost_usd,
  (select coalesce(sum(gross_profit_usd), 0) from public.api_usage)    as gross_profit_usd,
  settled.gross_usd                                                    as gross_cash_usd,
  settled.known_fees                                                   as known_gateway_fees_usd,
  settled.orders_with_unknown_fee                                      as orders_with_unknown_fee,
  -- Only as good as the fee data. An order whose fee was never observed counts
  -- in gross but not in fees, so this is an upper bound until every settled
  -- order has reported one.
  settled.gross_usd - settled.known_fees                               as net_cash_usd,
  (select coalesce(sum(balance), 0) from public.wallet)                as unspent_credit_value_usd,
  (select count(*) from public.api_usage where outcome = 'uncertain')  as uncertain_calls,
  (select count(*) from public.reservations
     where status = 'held' and created_at < now() - interval '1 hour') as stale_reservations
from (
  select
    coalesce(sum(gross_usd), 0)                          as gross_usd,
    coalesce(sum(fee_usd), 0)                            as known_fees,
    count(*) filter (where fee_usd is null)               as orders_with_unknown_fee
  from public.payment_orders
  where status = 'succeeded'
) settled;

comment on view public.v_platform_totals is
  'Gross profit from searches, cash actually collected, and the difference — unspent balance, which is a liability rather than revenue.';

-- ---------------------------------------------------------------------------
-- Per workspace
--
-- The figure that answers "is this customer profitable". Provider cost is
-- measured; revenue is recognised, so it lags the cash by exactly the credits
-- still sitting in their wallet.
-- ---------------------------------------------------------------------------
create or replace view public.v_margin_by_user as
select
  w.user_id,
  w.balance                                             as credit_balance,
  w.lifetime_granted,
  w.lifetime_consumed,
  coalesce(agg.revenue_usd, 0)                          as revenue_usd,
  coalesce(agg.provider_cost_usd, 0)                    as provider_cost_usd,
  coalesce(agg.gross_profit_usd, 0)                     as gross_profit_usd,
  coalesce(agg.calls, 0)                                as calls,
  agg.last_call,
  -- A workspace holding credits but never having spent them has generated no
  -- cost and no revenue. Worth seeing explicitly rather than left to default to
  -- a zero row that reads like a break-even customer.
  (coalesce(agg.calls, 0) = 0)                         as never_searched
from public.wallet w
left join (
  select
    user_id,
    sum(revenue_usd)         as revenue_usd,
    sum(provider_cost_usd)   as provider_cost_usd,
    sum(gross_profit_usd)    as gross_profit_usd,
    count(*)                 as calls,
    max(created_at)          as last_call
  from public.api_usage
  group by user_id
) agg on agg.user_id = w.user_id;

comment on view public.v_margin_by_user is
  'Measured cost and recognised revenue per workspace. never_searched separates a paying-but-idle customer from a break-even one.';

-- ---------------------------------------------------------------------------
-- Reconciliation against treg's own ledger
--
-- Run against GET /orgs/{id}/usage/by-tag?key=customer and compare:
--
--   ours:   select * from public.v_treg_reconciliation;
--   theirs: attributed_micro + unattributed_micro == total_micro
--
-- Three ways this drifts, all worth being able to see:
--
--   calls_we_logged   fewer than treg charged. A call whose answer was lost but
--                     which completed and billed — exactly the timeout case the
--                     reservation model exists to hold open rather than refund.
--   calls_uncertain   ours, still unresolved. Held deliberately, not refunded.
--   untagged           charged by treg but carrying no customer tag, meaning a
--                     call left this system without X-Treg-Meta set. A non-zero
--                     figure here is the loudest signal in this view, because it
--                     is the only one suggesting cost escaping attribution.
--
-- The treg-side figures are null until supplied. Filling them with our own
-- numbers would make the comparison agree by construction and prove nothing.
-- ---------------------------------------------------------------------------
create or replace view public.v_treg_reconciliation as
select
  ours.calls_logged,
  ours.calls_uncertain,
  round(ours.cost_usd, 6)                        as our_cost_usd,
  round(ours.cost_usd * 1e6, 0)                  as our_cost_micro,
  cast(null as numeric)                          as treg_total_cost_micro,
  cast(null as numeric)                          as treg_attributed_cost_micro,
  cast(null as numeric)                          as treg_unattributed_cost_micro,
  -- Null until the figures above are known. Dividing by our own number would
  -- make a mismatch of any size look like zero.
  cast(null as numeric)                          as drift_micro,
  round(100 * (ours.cost_usd * 1e6 - cast(null as numeric))
             / nullif(cast(null as numeric), 0), 2) as drift_pct
from (
  select
    count(*)                              as calls_logged,
    count(*) filter (where outcome = 'uncertain') as calls_uncertain,
    coalesce(sum(provider_cost_usd), 0)   as cost_usd
  from public.api_usage
  where provider = 'treg'
) ours;

comment on view public.v_treg_reconciliation is
  'Our measured treg spend, for comparison against GET /orgs/{id}/usage/by-tag. Nulls stay null until the treg figures are supplied.';

-- ---------------------------------------------------------------------------
-- Stale reservations
--
-- A hold that never reached settle or release is credits locked up with nothing
-- coming to free them. Normally empty; a non-empty list is a sweep that died
-- between reserving and settling, and each row is money the workspace cannot use.
-- ---------------------------------------------------------------------------
create or replace view public.v_stale_reservations as
select
  r.id,
  r.user_id,
  r.credits_held,
  r.reason,
  r.context,
  r.created_at,
  now() - r.created_at                                 as age,
  -- What the calls inside this hold were known to cost, when the tally recorded
  -- it. Zero is a real answer here and not a missing one: it means the sweep
  -- recorded no billable calls at all.
  coalesce((r.context->>'provider_cost_usd')::numeric, 0) as recorded_cost_usd
from public.reservations r
where r.status = 'held'
  and r.created_at < now() - interval '1 hour'
order by r.created_at;

comment on view public.v_stale_reservations is
  'Holds that never finalised. Each is credits the workspace cannot spend until the reservation is released or settled.';

grant select on public.v_margin_by_operation to service_role;
grant select on public.v_platform_totals     to service_role;
grant select on public.v_margin_by_user      to service_role;
grant select on public.v_treg_reconciliation to service_role;
grant select on public.v_stale_reservations  to service_role;
-- ============================================================================
-- Inlined: 20261106_welcome_credits.sql
-- ============================================================================
-- ============================================================================
-- Welcome credits
-- ----------------------------------------------------------------------------
-- A new workspace starts with 20 credits.
--
-- This exists because the alternative was worse than useless: with prepaid
-- credits and no trial, a fresh signup had a balance of zero and could not run a
-- single search. Nothing to evaluate, nothing to show anyone, no reason to stay.
--
-- It is a one-time grant, not a trial and not an allowance. There is no recurring
-- version of this and no renewal path; after the 20 credits are spent the
-- workspace tops up or stops searching. Nothing here can be turned back into a
-- subscription by editing a row.
--
-- The grant is issued at unit price 0, which is the whole point of
-- credit_grants being separate rows rather than one balance. Recognising $0.05 of
-- revenue for credits that were given away is exactly the mistake that structure
-- exists to prevent, and there is a test for it.
--
-- Cost to serve: 20 credits is at most 10 Reddit calls, about $0.01 of provider
-- spend. Cheap enough that a signup which never converts costs almost nothing,
-- and large enough that one search actually works.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Signup grants the welcome credits
--
-- Folds into the existing handle_new_user trigger rather than adding a second
-- one on auth.users. Two triggers on the same table for the same purpose is how
-- you end up debugging why some accounts have twenty credits and some have
-- forty.
--
-- The idempotency key is derived from the user id, so a re-fired trigger grants
-- once and the second attempt returns the duplicate rather than doubling the
-- balance.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profiles (id) values (new.id)
    on conflict (id) do nothing;

  insert into public.wallet (user_id) values (new.id)
    on conflict (user_id) do nothing;

  -- Unit price 0: these credits were not paid for, so spending them must not
  -- book revenue. See the header note.
  perform public.wallet_apply_grant(
    p_user_id         => new.id,
    p_credits         => 20,
    p_source          => 'grant',
    p_unit_price_usd  => 0,
    p_payment_order_id => null,
    p_idempotency_key => 'welcome:' || new.id::text,
    p_expires_at      => null,
    p_metadata        => jsonb_build_object('reason', 'welcome credits')
  );

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Existing workspaces that predate this
--
-- Only those with nothing at all. A workspace that has already paid for credits,
-- or already spent the twenty it would have been given, is left exactly as it
-- is — retroactively topping everyone up would mean giving the same thing twice
-- to anyone who happened to subscribe in between.
--
-- Routed through wallet_apply_grant rather than inserting rows by hand, so the
-- wallet totals, the grant and the ledger entry are produced by the one code
-- path that is tested to keep them consistent. Writing the three tables
-- separately is how a balance ends up disagreeing with its own history.
-- ---------------------------------------------------------------------------
insert into public.wallet (user_id)
select id from auth.users
on conflict (user_id) do nothing;

do $backfill$
declare
  v_user uuid;
begin
  for v_user in
    select u.id
      from auth.users u
     where not exists (select 1 from public.credit_grants g where g.user_id = u.id)
       and coalesce((select balance from public.wallet w where w.user_id = u.id), 0) = 0
  loop
    perform public.wallet_apply_grant(
      p_user_id         => v_user,
      p_credits         => 20,
      p_source          => 'grant',
      p_unit_price_usd  => 0,
      p_payment_order_id => null,
      p_idempotency_key => 'welcome:' || v_user::text,
      p_expires_at      => null,
      p_metadata        => jsonb_build_object('reason', 'welcome credits (backfill)')
    );
  end loop;
end;
$backfill$;

-- ---------------------------------------------------------------------------
-- The grant is a plain function call, so make sure the trigger can make it.
-- handle_new_user is SECURITY DEFINER, which is what lets it reach a function
-- that is revoked from anon and authenticated.
-- ---------------------------------------------------------------------------
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant  execute on function public.handle_new_user() to service_role;

==============================================================================
 20261107_audit_fixes.sql
---------------------------------------------------------------------------

-- ============================================================================
-- Audit fixes: credit arithmetic, stale holds, and two authorization checks
-- ----------------------------------------------------------------------------
-- Five defects found reviewing the billing system against a live probe.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A paid order with a fee could not be granted at all
--
-- wallet_topup_from_order derived the credit unit price by dividing by
-- v_order.credits_granted, which is 0 on an order that has not been settled yet.
-- With no fee the function took the package branch and worked. With a fee — which
-- is every real payment, because the payment processor is a merchant of record
-- and its whole business is the fee — it divided by zero, the RPC raised, and the
-- customer paid and received nothing.
--
-- The order's own credit count is the wrong denominator regardless: it is zero
-- until this very function writes it. The package is what was actually bought.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_topup_from_order(
  p_order_id      uuid,
  p_fee_usd       numeric default null,
  p_net_usd       numeric default null,
  p_provider_ref  text  default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_order    public.payment_orders%rowtype;
  v_pkg      public.topup_packages%rowtype;
  v_unit     numeric;
  v_result   jsonb;
  v_bonus    jsonb;
  v_credits  numeric;
begin
  select * into v_order from public.payment_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  if v_order.status = 'succeeded' and v_order.credits_granted > 0 then
    return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', p_order_id);
  end if;

  select * into v_pkg from public.topup_packages where code = v_order.package_code;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'package_not_found');
  end if;

  v_credits := v_pkg.credits + v_pkg.bonus_credits;
  if v_credits <= 0 then
    return jsonb_build_object('ok', false, 'error', 'package_has_no_credits');
  end if;

  -- Net cash is what actually arrived; gross would recognise revenue the
  -- processor kept. Falls back to the list price only when nothing is known,
  -- which is better than failing and stranding a paid order.
  v_unit := case
              when v_order.net_usd is not null and v_credits > 0 then v_order.net_usd / v_credits
              when p_net_usd      is not null and v_credits > 0 then p_net_usd / v_credits
              else v_pkg.gross_usd / v_pkg.credits
            end;
  v_unit := greatest(v_unit, 0);

  v_result := public.wallet_apply_grant(
    p_user_id          => v_order.user_id,
    p_credits          => v_pkg.credits,
    p_source           => 'topup',
    p_unit_price_usd   => v_unit,
    p_payment_order_id => p_order_id,
    p_idempotency_key  => coalesce(p_idempotency_key, 'topup:' || p_order_id::text),
    p_metadata         => jsonb_build_object('package', v_order.package_code)
  );

  if v_pkg.bonus_credits > 0 then
    v_bonus := public.wallet_apply_grant(
      p_user_id          => v_order.user_id,
      p_credits          => v_pkg.bonus_credits,
      p_source           => 'bonus',
      p_unit_price_usd   => 0,
      p_payment_order_id => p_order_id,
      p_idempotency_key  => coalesce(p_idempotency_key, 'topup:' || p_order_id::text) || ':bonus',
      p_metadata         => jsonb_build_object('package', v_order.package_code)
    );
  end if;

  update public.payment_orders
     set status          = 'succeeded',
         credits_granted = v_credits,
         fee_usd         = coalesce(p_fee_usd, fee_usd),
         net_usd         = coalesce(p_net_usd, net_usd),
         provider_ref    = coalesce(p_provider_ref, provider_ref),
         settled_at      = now()
   where id = p_order_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'order_id', p_order_id,
    'credits_granted', v_credits,
    'unit_price_usd', v_unit,
    'fee_usd', p_fee_usd,
    'balance_after', v_result->'balance_after'
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. A hold that never finalised locked credits forever
--
-- wallet_reserve moves credits from balance into reserved. Only settle and
-- release take them back, and both are called from a narrow window of linear
-- code between them. If the process dies inside that window — isolate eviction,
-- a wall-clock kill, an unhandled throw from a provider promise — the hold is
-- never closed and the workspace silently loses spendable balance on every
-- future sweep. v_stale_reservations showed them to a human; nothing acted on it.
--
-- This closes them. Where usage was recorded against the hold it settles for
-- what was actually billed; otherwise it releases in full. Releasing is the safe
-- direction for a customer, and the api_usage rows remain for reconciliation if
-- a provider was in fact charged.
-- ---------------------------------------------------------------------------
create or replace function public.reap_stale_reservations(p_older_than interval default '1 hour')
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_res     record;
  v_cost    numeric := 0;
  v_settled int := 0;
  v_released int := 0;
  v_out     jsonb;
begin
  for v_res in
    select id, user_id, credits_held
      from public.reservations
     where status = 'held'
       and created_at < now() - p_older_than
       and idempotency_key not like 'live:%'
     order by created_at
     for update skip locked
  loop
    -- Whatever treg reported for the calls this hold was covering.
    select coalesce(sum(provider_cost_usd), 0) into v_cost
      from public.api_usage
     where reservation_id = v_res.id;

    if v_cost > 0 then
      v_out := public.wallet_settle(
        v_res.id,
        v_res.credits_held,
        v_cost,
        'reap:' || v_res.id::text,
        'stale reservation reaped after ' || p_older_than
      );
      if coalesce((v_out->>'ok')::boolean, false) then
        v_settled := v_settled + 1;
      end if;
    else
      v_out := public.wallet_release(v_res.id, 'stale reservation reaped after ' || p_older_than);
      if coalesce((v_out->>'ok')::boolean, false) then
        v_released := v_released + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'settled', v_settled,
    'released', v_released,
    'total', v_settled + v_released
  );
end;
$fn$;

revoke execute on function public.reap_stale_reservations(interval) from public, anon, authenticated;
grant  execute on function public.reap_stale_reservations(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The price list was readable live but not by anything that rebuilds
--
-- topup_packages was widened to anonymous readers directly against the running
-- database, and the migration still said auth.role() = 'authenticated'. A fresh
-- rebuild from these migrations produced a table the landing page could not
-- read, and it falls back to hardcoded prices without saying so. Now the
-- migration matches the database.
--
-- A price list is public information: someone has to be able to see it before
-- signing up. SELECT only — there is no write path for any client role.
-- ---------------------------------------------------------------------------
drop policy if exists topup_packages_select_all on public.topup_packages;
create policy topup_packages_select_all
  on public.topup_packages for select
  using (true);

revoke insert, update, delete on public.topup_packages from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. clear_feed and prune_feed authorised against the connection, not the request
--
-- The guard was:
--
--   if auth.role() <> 'service_role' and session_user <> 'postgres'
--      and auth.uid() is distinct from v_uid then reject
--
-- session_user is a property of the connection, not of the request. Any path
-- that authenticates as postgres while carrying a user JWT skips the check
-- entirely. Probed directly: a different signed-in user deleted another user's
-- post and the function reported success, deleted: 1.
--
-- Through the browser today it holds, because PostgREST authenticates as
-- authenticator. That is a property of the deployment topology rather than of
-- the code, which is exactly the kind of check that fails silently when the
-- topology changes. The session_user clause is removed and the check is now
-- purely about who is asking.
-- ---------------------------------------------------------------------------
-- NOTE: superseded further down this file, on the same grounds as prune_feed
-- above. Do not copy the session_user check below.
-- ---------------------------------------------------------------------------
create or replace function public.clear_feed(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid;
  v_deleted int;
begin
  v_uid := coalesce(p_user_id, auth.uid());

  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'unauthenticated');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from v_uid then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;

  with gone as (
    delete from public.monitored_posts where user_id = v_uid returning 1
  )
  select count(*) into v_deleted from gone;

  return jsonb_build_object('success', true, 'deleted', v_deleted);
end;
$fn$;

create or replace function public.prune_feed(p_user_id uuid default null, p_keep_after timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid;
  v_days int;
  v_cutoff timestamptz;
  v_deleted int;
begin
  v_uid := coalesce(p_user_id, auth.uid());

  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'unauthenticated');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from v_uid then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;

  select feed_retention_days into v_days from public.profiles where id = v_uid;
  if v_days is null then
    return jsonb_build_object('success', false, 'error', 'profile_not_found');
  end if;

  if v_days = 0 then
    return jsonb_build_object('success', true, 'deleted', 0, 'retention_days', 0);
  end if;

  v_cutoff := now() - make_interval(days => v_days);

  with gone as (
    delete from public.monitored_posts
     where user_id = v_uid
       and coalesce(posted_at, created_at) < v_cutoff
       and (p_keep_after is null or created_at < p_keep_after)
    returning 1
  )
  select count(*) into v_deleted from gone;

  return jsonb_build_object('success', true, 'deleted', v_deleted,
                             'retention_days', v_days, 'cutoff', v_cutoff);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. One definition of the sweep's shape
--
-- The billing page priced a sweep from every active keyword and every enabled
-- channel. The sweep itself silently truncated to 8 keywords and 3 channels, and
-- the interactive search used a third number. So a workspace at the limit was
-- told its sweep cost more than the sweep would ever reserve, and could be shown
-- as able to afford a sweep that the cron then skipped.
--
-- Exposed as a table rather than left as three private constants, because three
-- copies of a number is three chances for them to disagree and no way to notice
-- when they have.
-- ---------------------------------------------------------------------------
create or replace function public.sweep_shape()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'max_keywords', public.keyword_limit(),
    'max_channels', public.channel_limit()
  );
$$;

revoke execute on function public.sweep_shape() from public, anon;
grant  execute on function public.sweep_shape() to authenticated, service_role;

==============================================================================
 20261108_leads.sql
---------------------------------------------------------------------------

-- ============================================================================
-- Echo Leads: tables, tenancy and the server-owned profile columns
-- ----------------------------------------------------------------------------
-- Leads is the second service in Echo. Feed finds people talking about buying;
-- Leads finds the companies that would buy, the decision maker at each, and a
-- verified work email for them.
--
-- Nothing here moves money. The credit wallet that already exists
-- (20261102, 20261103) is the only thing that does, and these tables hold no
-- balance — a lead row records what a run *found* and what it *cost in credits*,
-- and the wallet remains the record of truth for money.
--
-- Every table is per user and readable only by its owner. There are no write
-- policies at all: a client cannot insert, update or delete a single lead row.
-- All writes go through the `leads` edge function with the service role, which
-- is also where credit reservation happens — a row that appeared from the
-- browser would be a row whose cost nobody paid for.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- lead_icps — what the AI worked out about who buys from this user
-- ---------------------------------------------------------------------------
-- Versioned rather than edited in place. "Find more" on an old ICP has to be
-- able to refer back to the segment that produced it, and a comparison between
-- two ICPs is only meaningful if the earlier one still exists.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_icps (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,

  -- Prefilled from the profile at the time the ICP was written, kept so the
  -- card can show what it was generated from after the profile has moved on.
  website       text,
  offer         text,

  -- The New search form answers beyond website and offer: price point, regions,
  -- company sizes, the user's own guess at who buys.
  inputs        jsonb not null default '{}'::jsonb,

  -- What the site scrape returned, with the treg call id per page so a
  -- surprising ICP can be traced back to the pages that produced it.
  pages         jsonb not null default '[]'::jsonb,
  brand         jsonb,

  -- The validated ICP document. jsonb, not columns: the shape is the AI's, it
  -- changes when the prompt changes, and nothing queries into it.
  json          jsonb not null default '{}'::jsonb,

  version       integer not null default 1,
  note          text,
  approved_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint lead_icps_user_version_key unique (user_id, id, version),
  constraint lead_icps_version_positive check (version > 0)
);

create index if not exists lead_icps_user_created_idx
  on public.lead_icps (user_id, created_at desc);

comment on table public.lead_icps is
  'Versioned ideal customer profiles. Read by the owner, written only by the leads function.';

-- ---------------------------------------------------------------------------
-- lead_runs — one job: find leads, clean an imported list, or bake off providers
-- ---------------------------------------------------------------------------
-- The run is the unit the user watches, pauses and is billed for. status is a
-- small closed set because the worker branches on it; pause_reason is free text
-- so an unexpected reason can still be recorded without a migration.
--
--   queued    accepted, waiting for a worker
--   running   a worker holds it
--   paused    credits ran out, or the data provider is unavailable
--   done      finished, including "finished with no results"
--   failed    the worker could not proceed; last_error says why
--   cancelled the user stopped it
--
-- est_credits and max_credits are computed before the run starts and shown to
-- the user before they approve it. charged_credits is what the wallet actually
-- settled, which is not the estimate: a provider that misses is free.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,

  icp_id          uuid references public.lead_icps (id) on delete set null,
  name            text,
  kind            text not null default 'find',
  target          integer,

  -- clean modes only: verify_only | verify_refind | full_enrich
  mode            text,

  -- phone toggle, company-data columns, per-row cap
  options         jsonb not null default '{}'::jsonb,

  status          text not null default 'queued',
  pause_reason    text,
  last_error      text,

  est_credits     numeric(20,6),
  max_credits     numeric(20,6),
  charged_credits numeric(20,6) not null default 0,
  treg_cost_usd   numeric(20,6) not null default 0,

  -- found / verified / catch_all / rows — denormalised so the sidebar badge
  -- and the run header do not each aggregate 10,000 rows on every poll.
  counters        jsonb not null default '{}'::jsonb,

  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint lead_runs_kind_check
    check (kind in ('find', 'clean', 'lab')),
  constraint lead_runs_status_check
    check (status in ('queued', 'running', 'paused', 'done', 'failed', 'cancelled')),
  constraint lead_runs_target_positive
    check (target is null or target > 0),
  -- Nothing may be charged for more than the run was approved for. The
  -- estimate is shown to the user before they press the button, so a charged
  -- figure above the agreed maximum is a bug in the worker's accounting and
  -- should stop the row rather than quietly exceed what was consented to.
  constraint lead_runs_charged_within_max
    check (max_credits is null or charged_credits <= max_credits)
);

create index if not exists lead_runs_user_created_idx
  on public.lead_runs (user_id, created_at desc);

-- The sidebar badge and the cron worker both ask "what is in flight", so the
-- status is worth indexing on its own rather than only under user_id.
create index if not exists lead_runs_status_idx
  on public.lead_runs (status)
  where status in ('queued', 'running', 'paused');

comment on table public.lead_runs is
  'One lead job. The unit the user watches and the unit the wallet is charged per.';

-- ---------------------------------------------------------------------------
-- lead_rows — one person, one row
-- ---------------------------------------------------------------------------
-- A row appears the moment its company is found, and fills in as the later
-- stages resolve. That is deliberate: a table that only shows rows once they are
-- complete looks empty for the whole of stage one and gives the user nothing to
-- watch.
--
-- email_status is the verification verdict, which is not the same question as
-- whether an email was found:
--   verified    deliverability confirmed
--   catch_all   valid syntax, but the domain accepts any mailbox. Sendable and
--               risky; never presented without saying so.
--   invalid     confirmed dead. Worth re-running the waterfall from the next
--               provider.
--   unknown     the verifier did not answer
--   not_found   no provider produced an email. Nothing was charged for this.
--
-- state and step are the live progress of the row, so a reconnecting browser
-- renders the current position instead of restarting the animation.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_rows (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  run_id           uuid not null references public.lead_runs (id) on delete cascade,

  company_name     text,
  domain           text,
  logo_url         text,

  person_name      text,
  title            text,
  linkedin_url     text,

  email            text,
  email_status     text not null default 'not_found',
  email_provider   text,

  phone            text,
  phone_provider   text,

  company_data     jsonb not null default '{}'::jsonb,

  -- Columns the user's CSV had that Leads does not model. Carried through to
  -- the export so a clean does not silently delete their data.
  extra            jsonb not null default '{}'::jsonb,

  -- What this row actually cost, in credits. Sums to the run's charged_credits;
  -- the acceptance suite asserts it.
  credits          numeric(20,6) not null default 0,

  state            text not null default 'queued',
  step             text,
  current_provider text,

  -- Set while a worker holds the row, so a second worker or the cron safety net
  -- skips it instead of processing the same row twice.
  locked_at        timestamptz,
  locked_by        text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint lead_rows_email_status_check
    check (email_status in ('verified', 'catch_all', 'invalid', 'unknown', 'not_found')),
  constraint lead_rows_state_check
    check (state in ('queued', 'trying', 'miss', 'found', 'done', 'skipped', 'failed')),
  constraint lead_rows_step_check
    check (step is null or step in ('company', 'person', 'email', 'verify', 'phone', 'enrich')),
  -- An email with no status, or a status with no email, is the shape of a row
  -- written halfway through a stage. Refusing it is what stops "Found" being
  -- shown for a row whose email later turned out to be invalid.
  constraint lead_rows_email_implies_address
    check (email_status = 'not_found' or email is not null),
  constraint lead_rows_credits_non_negative check (credits >= 0)
);

create index if not exists lead_rows_run_idx
  on public.lead_rows (run_id, created_at);

-- The sidebar badge counts runs; the run header counts rows by status; export
-- pages by run. These three cover every read the UI does.
create index if not exists lead_rows_run_status_idx
  on public.lead_rows (run_id, email_status);

create index if not exists lead_rows_user_domain_idx
  on public.lead_rows (user_id, domain)
  where domain is not null;

comment on table public.lead_rows is
  'One person per row. Created when the company is found, enriched as later stages resolve.';

-- ---------------------------------------------------------------------------
-- lead_attempts — every provider call made for a row
-- ---------------------------------------------------------------------------
-- This is what makes the provider lab honest: hit rates are computed from real
-- attempts on real rows, not assumed. It is also the audit trail behind the
-- credits a row cost, and why a user can be told exactly which provider was
-- tried and what it charged before the row's email turned up.
--
-- Cost is the real measured charge, never a list price.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_attempts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  run_id          uuid not null references public.lead_runs (id) on delete cascade,
  row_id          uuid not null references public.lead_rows (id) on delete cascade,

  step            text not null,
  endpoint_id     text not null,
  hit             boolean not null default false,
  cost_usd        numeric(20,6) not null default 0,
  ms              integer,

  treg_call_id    text,
  api_usage_id    uuid,

  created_at      timestamptz not null default now(),

  constraint lead_attempts_step_check
    check (step in ('company', 'person', 'email', 'verify', 'phone', 'enrich')),
  constraint lead_attempts_cost_non_negative check (cost_usd >= 0)
);

create index if not exists lead_attempts_row_idx
  on public.lead_attempts (row_id, created_at);

-- The smart order reads attempts per user per provider, to learn which provider
-- is actually cheapest per hit for this user rather than on average.
create index if not exists lead_attempts_user_endpoint_idx
  on public.lead_attempts (user_id, endpoint_id);

comment on table public.lead_attempts is
  'One row per provider call. The evidence behind hit rates, cost and the row receipt.';

-- ---------------------------------------------------------------------------
-- lead_waterfall_orders — provider order per user, per step
-- ---------------------------------------------------------------------------
-- One row per user per step, so "which providers, in what order" has exactly
-- one answer. mode distinguishes the shipped default from something the user
-- chose, because a drag that leaves the order as shipped should not look like a
-- deliberate pin.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_waterfall_orders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  step         text not null,
  endpoint_ids jsonb not null default '[]'::jsonb,
  mode         text not null default 'default',

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint lead_waterfall_orders_user_step_key unique (user_id, step),
  constraint lead_waterfall_orders_step_check
    check (step in ('company', 'person', 'email', 'verify', 'phone', 'enrich')),
  constraint lead_waterfall_orders_mode_check
    check (mode in ('default', 'smart', 'custom'))
);

comment on table public.lead_waterfall_orders is
  'Per-user provider order. mode=smart defers to measured hit rates until enough attempts exist.';

-- ---------------------------------------------------------------------------
-- lead_suppressions — the opt-out list
-- ---------------------------------------------------------------------------
-- Checked before every paid call. A suppressed row is never processed and never
-- returned, so suppression costs nothing: the provider is not called at all.
--
-- A domain suppresses everyone at that domain. Suppressing a domain after
-- finding one person at it stops future lookups; the rows already collected are
-- removed separately, because pretending they are not there would be a lie.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_suppressions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,

  value      text not null,
  kind       text not null,
  reason     text,

  created_at timestamptz not null default now(),

  constraint lead_suppressions_user_value_key unique (user_id, value),
  constraint lead_suppressions_kind_check check (kind in ('email', 'domain'))
);

create index if not exists lead_suppressions_user_idx
  on public.lead_suppressions (user_id);

comment on table public.lead_suppressions is
  'Contacts and domains this user never wants contacted. Checked before every paid call.';

-- ---------------------------------------------------------------------------
-- lead_filter_cache — provider filter values, shared across users
-- ---------------------------------------------------------------------------
-- Industries, positions and geo values have to be mapped into each provider's
-- own vocabulary before a search can be sent, and those vocabularies change
-- rarely. The list is identical for every user of every workspace, so this
-- table has no user_id and no tenant policy at all: it is shared read-write
-- infrastructure for the worker, not user data.
--
-- Because there is no user_id, RLS is enabled with *no policies*. That is the
-- deny-by-default this table wants, and it is the only Echo table with no
-- select-own policy. The tradeoff is that RLS cannot see a service_role
-- bypass, so the worker reaches it with the service key, which skips RLS.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_filter_cache (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  filter_type text not null,
  values      jsonb not null default '[]'::jsonb,
  fetched_at  timestamptz not null default now(),

  constraint lead_filter_cache_provider_type_key unique (provider, filter_type)
);

comment on table public.lead_filter_cache is
  'Shared provider filter vocabularies. No user_id, no policies: service role only.';

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists lead_icps_set_updated_at on public.lead_icps;
create trigger lead_icps_set_updated_at
  before update on public.lead_icps
  for each row execute function public.set_updated_at();

drop trigger if exists lead_runs_set_updated_at on public.lead_runs;
create trigger lead_runs_set_updated_at
  before update on public.lead_runs
  for each row execute function public.set_updated_at();

drop trigger if exists lead_rows_set_updated_at on public.lead_rows;
create trigger lead_rows_set_updated_at
  before update on public.lead_rows
  for each row execute function public.set_updated_at();

drop trigger if exists lead_waterfall_orders_set_updated_at on public.lead_waterfall_orders;
create trigger lead_waterfall_orders_set_updated_at
  before update on public.lead_waterfall_orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- profiles: the two server-owned columns
-- ---------------------------------------------------------------------------
-- leads_terms_accepted_at records that the user ticked the outreach consent
-- box before their first run. It is written by the leads function and must not
-- be writable by the client, because a client that can set it can skip the
-- consent step entirely.
--
-- The mechanism is deliberate: profiles has no table-level UPDATE grant to
-- authenticated, only per-column grants on eleven named columns (see
-- supabase/README.md). Adding a column here and simply *not* granting UPDATE on
-- it is therefore sufficient — the column is server-only by omission, and this
-- is the same way created_at and updated_at are already protected.
--
-- This is why the alternative was rejected. Tightening the RLS policy's
-- with_check cannot work: it restricts which *row* may be written, never which
-- columns, so the compliance checkbox would have been decorative.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists leads_terms_accepted_at timestamptz,
  add column if not exists leads_row_cap_usd numeric(10,6);

comment on column public.profiles.leads_terms_accepted_at is
  'Server-only. Set by the leads function when the user accepts the outreach terms.';
comment on column public.profiles.leads_row_cap_usd is
  'Server-only. Per-row spend cap in USD; the user sets it through the leads function.';

do $$
declare
  v_privileged text;
begin
  -- Belt and braces, and a loud failure rather than a silent one. If a future
  -- migration ever adds a table-level UPDATE grant to authenticated, the two
  -- columns above stop being protected and every row in this table becomes
  -- writable by its own owner. Refuse the migration instead.
  if exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'profiles'
       and has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
  ) then
    raise exception
      'authenticated holds a table-level UPDATE grant on public.profiles, which would make leads_terms_accepted_at and leads_row_cap_usd client-writable. Revoke it to table level first, or grant UPDATE per column.';
  end if;
end;
$$;

-- Belt and braces: a column-level privilege here would defeat the omission
-- above, so remove it if it ever appears.
revoke update (leads_terms_accepted_at, leads_row_cap_usd) on public.profiles from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- One select-own policy per tenant table and no write policies anywhere. RLS on
-- with no write policy is deny: a client that tries to insert, update or delete
-- a lead row gets zero rows affected and no error it can act on.
alter table public.lead_icps             enable row level security;
alter table public.lead_runs             enable row level security;
alter table public.lead_rows             enable row level security;
alter table public.lead_attempts         enable row level security;
alter table public.lead_waterfall_orders enable row level security;
alter table public.lead_suppressions     enable row level security;
alter table public.lead_filter_cache     enable row level security;

-- anon has no business here at all. Someone has to be able to read the price
-- list before signing up; nobody has to be able to read a lead.
revoke all on public.lead_icps             from anon;
revoke all on public.lead_runs             from anon;
revoke all on public.lead_rows             from anon;
revoke all on public.lead_attempts         from anon;
revoke all on public.lead_waterfall_orders from anon;
revoke all on public.lead_suppressions     from anon;
revoke all on public.lead_filter_cache     from anon;

drop policy if exists lead_icps_select_own on public.lead_icps;
create policy lead_icps_select_own on public.lead_icps
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_runs_select_own on public.lead_runs;
create policy lead_runs_select_own on public.lead_runs
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_rows_select_own on public.lead_rows;
create policy lead_rows_select_own on public.lead_rows
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_attempts_select_own on public.lead_attempts;
create policy lead_attempts_select_own on public.lead_attempts
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_waterfall_orders_select_own on public.lead_waterfall_orders;
create policy lead_waterfall_orders_select_own on public.lead_waterfall_orders
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_suppressions_select_own on public.lead_suppressions;
create policy lead_suppressions_select_own on public.lead_suppressions
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- lead_filter_cache gets no policy on purpose. See the table comment.

-- Nothing below is granted to a client: every write is the service role.
revoke insert, update, delete on public.lead_icps             from anon, authenticated;
revoke insert, update, delete on public.lead_runs             from anon, authenticated;
revoke insert, update, delete on public.lead_rows             from anon, authenticated;
revoke insert, update, delete on public.lead_attempts         from anon, authenticated;
revoke insert, update, delete on public.lead_waterfall_orders from anon, authenticated;
revoke insert, update, delete on public.lead_suppressions     from anon, authenticated;
revoke insert, update, delete on public.lead_filter_cache     from anon, authenticated;

-- Realtime, so a run fills in live instead of only on the next poll.
-- Only these two: attempts are read through the run, and putting every write in
-- the database on a socket is more than the feature needs.
--
-- Guarded because ADD TABLE has no IF NOT EXISTS form, and a migration that runs
-- twice has to be a no-op the second time. deploy-all.sql is documented as safe
-- to paste more than once; this would otherwise break that promise on the second
-- paste rather than on the first.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lead_rows'
  ) then
    raise notice 'lead_rows already in supabase_realtime';
  else
    alter publication supabase_realtime add table public.lead_rows;
  end if;

  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lead_runs'
  ) then
    raise notice 'lead_runs already in supabase_realtime';
  else
    alter publication supabase_realtime add table public.lead_runs;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- A cheap read for the sidebar badge
-- ---------------------------------------------------------------------------
-- Counts a workspace's runs that are not finished, so the sidebar can badge
-- work in progress without loading the whole run list.
--
-- Deliberately NOT SECURITY DEFINER, and deliberately takes no argument.
--
-- The first version of this took p_user_id and was SECURITY DEFINER so it could
-- read past RLS. That is a tenancy hole with a straight line through it: the
-- function is granted to authenticated, so any signed-in user could pass
-- someone else's uuid and learn how many runs they had. A parameter that
-- identifies the subject of a read is only safe if the caller cannot choose it.
--
-- So it takes none. auth.uid() is the only source of the user id, RLS still
-- applies, and there is nothing to bypass in the first place — authenticated can
-- already select its own rows through lead_runs_select_own.
-- ---------------------------------------------------------------------------
create or replace function public.lead_active_run_count()
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
    from public.lead_runs
   where (select auth.uid()) = user_id
     and status in ('queued', 'running', 'paused');
$$;

revoke execute on function public.lead_active_run_count() from public, anon;
grant  execute on function public.lead_active_run_count() to authenticated, service_role;

==============================================================================
 20261109_leads_pricing.sql
---------------------------------------------------------------------------

-- ============================================================================
-- Echo Leads: prices and the run estimate
-- ----------------------------------------------------------------------------
-- What a lead costs the customer, and what it might cost us, as data rather than
-- as constants in a function. Both halves are rows:
--
--   credits             what the customer pays, in Echo credits
--   provider_cost_usd   what we think the provider call costs us
--
-- The second column is the honest one. Every leads row ships with
-- cost_verified = false, because none of these endpoints has been called yet and
-- a price taken from a catalog is a claim, not an observation. The billing
-- system's whole claim is that margin is measured rather than assumed, and a
-- price seeded from a catalog with cost_verified = true would be exactly the
-- assumption the rest of the design refuses to make. It flips when the first
-- real call is observed.
--
-- Credits convert from the Cascade price list, which was written against a
-- $0.01 credit. Echo's credit is $0.05, so every figure is divided by five.
-- Customer dollar prices are unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The price list
-- ---------------------------------------------------------------------------
-- Free to the customer is not free to us. leads.icp.generate is zero because the
-- website read and the model call are the price of admission to the feature and
-- charging for the estimate would mean nobody could see what they were buying;
-- its real cost is logged in api_usage so it still shows in the margin views.
--
-- leads.email.catch_all exists because a catch-all address is not a found
-- contact. It works often enough to be worth having and is untrustworthy often
-- enough that charging the full verified price for it would be selling the
-- customer a worse answer at the better price.
-- ---------------------------------------------------------------------------
insert into public.pricing_config
  (operation, display_name, credits, provider_endpoint, provider_cost_usd, cost_source, cost_verified, enabled)
values
  ('leads.icp.generate', 'Ideal customer profile', 0,     'treg.web.extract',  0.03000000, 'catalog', false, true),
  ('leads.company.found','Company found',              0.02,  'tomba.companies.search.reveal', 0.00017800, 'catalog', false, true),
  ('leads.person.found', 'Decision maker found',       0.2,   'icypeas.people.search', 0.00038000, 'catalog', false, true),
  ('leads.email.verified','Verified email',            1,     'quickenrich.people.email.find', 0.00480000, 'catalog', false, true),
  ('leads.email.catch_all','Catch-all email',          0.4,   'quickenrich.people.email.find', 0.00480000, 'catalog', false, true),
  ('leads.verify.only',  'Email verified (existing)',  0.1,   'contactout.people.email.verify', 0.00000000, 'catalog', false, true),
  ('leads.phone.found',  'Phone found and live',       8,     'aiark.people.phone.find', 0.02600000, 'catalog', false, true),
  ('leads.company.enrich','Company data column',        1,     'prospeo.companies.enrich', 0.02450000, 'catalog', false, true)
on conflict (operation) do update
  set display_name        = excluded.display_name,
      credits             = excluded.credits,
      provider_endpoint   = excluded.provider_endpoint,
      provider_cost_usd   = excluded.provider_cost_usd,
      cost_source         = excluded.cost_source,
      cost_verified       = excluded.cost_verified,
      enabled             = excluded.enabled,
      effective_from      = now();

comment on table public.pricing_config is
  'Credit price per operation, and our believed cost for it. leads.* rows start with cost_verified=false because no endpoint has been called yet.';

-- ---------------------------------------------------------------------------
-- estimate_lead_run
-- ---------------------------------------------------------------------------
-- What a run costs before it starts, in three numbers rather than one.
--
-- The three exist because they answer three different questions:
--
--   min       what it costs if nothing is found. Still non-zero: the company
--             lookups and the decision-maker lookups happen and are billed
--             whether or not they find anyone.
--   expected  what it will probably cost, using this user's own email hit rate
--             where they have enough history for one to mean anything.
--   max       what it will cost if every email resolves. This is the figure the
--             wallet is checked against before the run starts, because a sweep
--             that cannot be paid for in full must not start.
--
-- Two things this deliberately does not do.
--
-- It does not add a separate verification line to a find run. The PRD's worked
-- example does not, and the reason is sound: every address found is verified as
-- part of finding it, so a separate line would double-count the same work. The
-- clean modes are different — there verification is the product, and it is
-- priced on its own at leads.verify.only.
--
-- It does not guess a hit rate for a user with no history. 70% is the shipped
-- default and it is used only until the smoothed estimate has enough attempts
-- behind it to beat it; an average across all users would be confidently wrong
-- for anyone whose leads happen to be harder than average, which is the opposite
-- of useful on a page whose job is to tell someone what a button will cost.
-- ---------------------------------------------------------------------------
create or replace function public.estimate_lead_run(
  p_target      integer,
  p_mode        text default null,
  p_phone       boolean default false,
  p_hit_rate    numeric default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_user        uuid := auth.uid();
  v_target      integer := greatest(1, least(coalesce(p_target, 50), 2000));
  v_mode        text := nullif(trim(p_mode), '');
  v_phone       boolean := coalesce(p_phone, false);

  v_company     numeric;
  v_person      numeric;
  v_email       numeric;
  v_catch_all   numeric;
  v_verify      numeric;
  v_phone_credit numeric;

  -- Smoothed hit rate for this user's email waterfall, used only once there is
  -- enough of it to be better than the default.
  v_attempts    integer;
  v_hits        integer;
  v_rate        numeric;
  v_rate_used   numeric;
  v_rate_source text;

  v_min         numeric;
  v_expected    numeric;
  v_max         numeric;
  v_breakdown   jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'unauthenticated');
  end if;

  -- Prices come from the table, never from constants here. A row that is
  -- disabled or missing means the operation is not being sold, and the estimate
  -- has to say so rather than quietly pricing it at zero.
  select
    max(case when operation = 'leads.company.found' then credits end),
    max(case when operation = 'leads.person.found'  then credits end),
    max(case when operation = 'leads.email.verified' then credits end),
    max(case when operation = 'leads.email.catch_all' then credits end),
    max(case when operation = 'leads.verify.only'  then credits end),
    max(case when operation = 'leads.phone.found'  then credits end)
  into v_company, v_person, v_email, v_catch_all, v_verify, v_phone_credit
  from public.pricing_config
  where operation in (
    'leads.company.found', 'leads.person.found', 'leads.email.verified',
    'leads.email.catch_all', 'leads.verify.only', 'leads.phone.found'
  ) and enabled;

  if v_company is null or v_person is null or v_email is null or v_verify is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'leads_not_priced',
      'note', 'one or more leads operations are missing or disabled in pricing_config'
    );
  end if;

  v_company      := coalesce(v_company, 0);
  v_person       := coalesce(v_person, 0);
  v_catch_all    := coalesce(v_catch_all, v_email);
  v_phone_credit := coalesce(v_phone_credit, 0);

  -- Hit rate. An explicit argument wins, so the caller can price a what-if; then
  -- this user's own measured rate once it is backed by enough attempts; then the
  -- shipped default.
  select
    count(*),
    count(*) filter (where hit)
  into v_attempts, v_hits
  from public.lead_attempts
  where user_id = v_user and step = 'email';

  if p_hit_rate is not null then
    v_rate       := greatest(0, least(1, p_hit_rate));
    v_rate_source := 'supplied';
  elsif v_attempts >= 50 then
    -- (hits + 1) / (attempts + 2) is Laplace smoothing: it keeps a perfect run
    -- from reading as a guaranteed 100% and a single miss from reading as 0%.
    v_rate       := (v_hits::numeric + 1) / (v_attempts::numeric + 2);
    v_rate_source := 'your history';
  else
    v_rate       := 0.7;
    v_rate_source := 'default';
  end if;

  v_rate_used := v_rate;

  -- --- clean modes ---------------------------------------------------------
  -- Verification is the product here, so it is priced per address rather than
  -- folded into finding one.
  if v_mode in ('verify_only', 'verify_refind') then
    v_expected := v_target * v_verify
                + case when v_mode = 'verify_refind'
                       then v_target * v_rate * v_email
                       else 0 end;
    v_max       := v_target * v_verify + v_target * v_email;
    v_min       := v_target * v_verify;
  else
    -- --- find and lab ------------------------------------------------------
    -- Companies and people are found before any email is attempted, and both
    -- are billed whether or not they resolve, so the floor is not zero.
    v_min := v_target * v_company + v_target * v_person;
    v_max := v_min + v_target * v_email;
    v_expected := v_min + v_target * v_rate * v_email;
  end if;

  -- Phone is opt-in and only reached when a row already has a usable contact, so
  -- it is added to the expected figure at the same rate as the email that
  -- precedes it. It is not in the minimum: a user who ticks the box and gets no
  -- emails has spent nothing on phone lookups.
  if v_phone then
    v_expected := v_expected + v_target * v_rate * v_phone_credit;
    v_max       := v_max + v_target * v_phone_credit;
  end if;

  v_breakdown := jsonb_build_array(
    jsonb_build_object('label', 'Companies', 'credits', v_target * v_company),
    jsonb_build_object('label', 'Decision makers', 'credits', v_target * v_person),
    jsonb_build_object(
      'label', case when v_mode in ('verify_only','verify_refind')
                    then 'Verifications' else 'Emails found' end,
      'credits', round(v_target * v_rate_used * v_email, 6),
      'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
    )
  );

  if v_phone then
    v_breakdown := v_breakdown
      || jsonb_build_array(
           jsonb_build_object(
             'label', 'Phone numbers',
             'credits', round(v_target * v_rate_used * v_phone_credit, 6)
           )
         );
  end if;

  return jsonb_build_object(
    'ok', true,
    'min_credits',     round(v_min, 6),
    'expected_credits', round(v_expected, 6),
    'max_credits',     round(v_max, 6),
    'target',          v_target,
    'hit_rate',        round(v_rate_used, 4),
    'hit_rate_source', v_rate_source,
    'attempts_behind_hit_rate', v_attempts,
    'breakdown',       v_breakdown
  );
end;
$fn$;

revoke execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  from public, anon, authenticated;
grant  execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  to service_role;

==============================================================================
 20261110_leads_cron.sql
---------------------------------------------------------------------------

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

==============================================================================
 20261111_estimate_breakdown.sql
---------------------------------------------------------------------------

-- estimate_lead_run: the breakdown has to sum to expected_credits
-- ---------------------------------------------------------------------------
-- The breakdown was built unconditionally in the find/lab shape: Companies,
-- Decision makers, and one email line. For the clean modes that is wrong twice
-- over, and both errors were visible in the returned jsonb.
--
-- It listed Companies and Decision makers for a clean run, which never performs
-- either lookup: the company and the person are already in the file the user
-- imported. On a 2000-row verify_only that is 440 credits of work described and
-- not done.
--
-- It then labelled the email line "Verifications" while still computing it as
-- target * hit_rate * v_email, which is the price of *finding* an address. The
-- verify price is a different number, and the label is a promise the figure does
-- not keep.
--
-- The consequence was three different answers to "what will this cost me":
--   200  expected_credits
--   1600 what the user was actually charged
--   1840 what the breakdown on screen added up to
--
-- Rebuilt so the lines are chosen by the same branch that computes the total, and
-- so they sum to it. The invariant is the point: a breakdown that does not add up
-- to the number above it is worse than no breakdown, because it is the one a user
-- can add up.
--
-- max_credits is deliberately still not a sum of these lines. It is the ceiling
-- every row resolves, which is a worst case rather than a forecast, and it is the
-- figure the wallet is checked against.

create or replace function public.estimate_lead_run(
  p_target      integer,
  p_mode        text default null,
  p_phone       boolean default false,
  p_hit_rate    numeric default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_user        uuid := auth.uid();
  v_target      integer := greatest(1, least(coalesce(p_target, 50), 2000));
  v_mode        text := nullif(trim(p_mode), '');
  v_phone       boolean := coalesce(p_phone, false);

  v_company     numeric;
  v_person      numeric;
  v_email       numeric;
  v_catch_all   numeric;
  v_verify      numeric;
  v_phone_credit numeric;

  v_attempts    integer;
  v_hits        integer;
  v_rate        numeric;
  v_rate_used   numeric;
  v_rate_source text;

  v_min         numeric;
  v_expected    numeric;
  v_max         numeric;
  v_breakdown   jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'unauthenticated');
  end if;

  select
    max(case when operation = 'leads.company.found'   then credits end),
    max(case when operation = 'leads.person.found'    then credits end),
    max(case when operation = 'leads.email.verified'  then credits end),
    max(case when operation = 'leads.email.catch_all' then credits end),
    max(case when operation = 'leads.verify.only'     then credits end),
    max(case when operation = 'leads.phone.found'     then credits end)
  into v_company, v_person, v_email, v_catch_all, v_verify, v_phone_credit
  from public.pricing_config
  where operation in (
    'leads.company.found', 'leads.person.found', 'leads.email.verified',
    'leads.email.catch_all', 'leads.verify.only', 'leads.phone.found'
  ) and enabled;

  if v_company is null or v_person is null or v_email is null or v_verify is null then
    return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
  end if;

  select count(*), count(*) filter (where hit)
  into v_attempts, v_hits
  from public.lead_attempts
  where user_id = v_user and step = 'email';

  if coalesce(v_attempts, 0) >= 50 then
    v_rate       := (v_hits::numeric + 1) / (v_attempts::numeric + 2);
    v_rate_source := 'your history';
  else
    v_rate       := 0.7;
    v_rate_source := 'default';
  end if;

  v_rate_used := v_rate;

  -- --- totals -------------------------------------------------------------
  -- Unchanged from the shipped version. Only the explanation below them moves,
  -- so no price a user was shown and charged against has changed.
  if v_mode in ('verify_only', 'verify_refind') then
    v_expected := v_target * v_verify
                + case when v_mode = 'verify_refind'
                       then v_target * v_rate * v_email
                       else 0 end;
    v_max       := v_target * v_verify + v_target * v_email;
    v_min       := v_target * v_verify;
  else
    v_min     := v_target * v_company + v_target * v_person;
    v_max     := v_min + v_target * v_email;
    v_expected := v_min + v_target * v_rate * v_email;
  end if;

  if v_phone then
    v_expected := v_expected + v_target * v_rate * v_phone_credit;
    v_max       := v_max + v_target * v_phone_credit;
  end if;

  -- --- the lines behind those totals --------------------------------------
  -- Built from the same branch. verify_only is verification and nothing else, so
  -- it gets one line. verify_refind gets verification plus the refind it may do.
  -- Everything else looks up the company and the person before any address, so it
  -- gets both of those lines.
  if v_mode = 'verify_only' then
    v_breakdown := jsonb_build_array(
      jsonb_build_object('label', 'Verifications', 'credits', round(v_target * v_verify, 6))
    );
  elsif v_mode = 'verify_refind' then
    v_breakdown := jsonb_build_array(
      jsonb_build_object('label', 'Verifications', 'credits', round(v_target * v_verify, 6)),
      jsonb_build_object(
        'label', 'Replacements found',
        'credits', round(v_target * v_rate_used * v_email, 6),
        'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
      )
    );
  else
    v_breakdown := jsonb_build_array(
      jsonb_build_object('label', 'Companies',     'credits', round(v_target * v_company, 6)),
      jsonb_build_object('label', 'Decision makers', 'credits', round(v_target * v_person, 6)),
      jsonb_build_object(
        'label', 'Emails found',
        'credits', round(v_target * v_rate_used * v_email, 6),
        'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
      )
    );
  end if;

  if v_phone then
    v_breakdown := v_breakdown
      || jsonb_build_array(
           jsonb_build_object(
             'label', 'Phone numbers',
             'credits', round(v_target * v_rate_used * v_phone_credit, 6)
           )
         );
  end if;

  return jsonb_build_object(
    'ok', true,
    'min_credits',     round(v_min, 6),
    'expected_credits', round(v_expected, 6),
    'max_credits',     round(v_max, 6),
    'target',          v_target,
    'hit_rate',        round(v_rate_used, 4),
    'hit_rate_source', v_rate_source,
    'attempts_behind_hit_rate', v_attempts,
    'breakdown',       v_breakdown
  );
end;
$fn$;

revoke execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  from public, anon, authenticated;
grant  execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  to service_role;

==============================================================================
 20261112_verify_only_ceiling.sql
---------------------------------------------------------------------------

-- estimate_lead_run: verify_only's worst case was the verify_refind worst case
-- ---------------------------------------------------------------------------
-- verify_only was priced at target * (verify + email) for its ceiling, on the
-- assumption that a check might turn into a find. The worker never did that:
-- lead_runs.mode was read for nothing, so all three clean modes ran the identical
-- email waterfall and the ceiling was honest by accident.
--
-- The worker now gates on the mode. steps.ts plans findEmail: false for
-- verify_only, and the row loop never reaches the email step. So the ceiling can
-- no longer be reached, and reserving against it was wrong in the direction that
-- blocks people:
--
--   2000 rows in verify_only costs 200 credits.
--   Before this, starting it required 2200 — eleven times the real cost.
--
-- A user with 300 credits was refused with insufficient_credits on an operation
-- they could comfortably afford, and the only way to run it was to raise their
-- own prices or to buy credits for work they were not asking for.
--
-- The totals are otherwise untouched. min and expected were already correct:
-- min is target * verify, and expected is the same, because in this mode nothing
-- is ever found so there is no find price to expect.
--
-- One honest limitation, unchanged here: min assumes every row arrives with an
-- address to check. A row imported with no email is skipped and charged nothing,
-- so a file of half-addressed rows settles below its stated floor. That errs in
-- the user's favour and the gap is visible on the invoice, which is the right
-- direction for a floor to be wrong in. Making min exact would mean passing the
-- address-bearing count into the estimator, which is a different signature and
-- not worth it for a number that is already an upper bound.

create or replace function public.estimate_lead_run(
  p_target      integer,
  p_mode        text default null,
  p_phone       boolean default false,
  p_hit_rate    numeric default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_user        uuid := auth.uid();
  v_target      integer := greatest(1, least(coalesce(p_target, 50), 2000));
  v_mode        text := nullif(trim(p_mode), '');
  v_phone       boolean := coalesce(p_phone, false);

  v_company     numeric;
  v_person      numeric;
  v_email       numeric;
  v_catch_all   numeric;
  v_verify      numeric;
  v_phone_credit numeric;

  v_attempts    integer;
  v_hits        integer;
  v_rate        numeric;
  v_rate_used   numeric;
  v_rate_source text;

  v_min         numeric;
  v_expected    numeric;
  v_max         numeric;
  v_breakdown   jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'unauthenticated');
  end if;

  select
    max(case when operation = 'leads.company.found'   then credits end),
    max(case when operation = 'leads.person.found'    then credits end),
    max(case when operation = 'leads.email.verified'  then credits end),
    max(case when operation = 'leads.email.catch_all' then credits end),
    max(case when operation = 'leads.verify.only'     then credits end),
    max(case when operation = 'leads.phone.found'     then credits end)
  into v_company, v_person, v_email, v_catch_all, v_verify, v_phone_credit
  from public.pricing_config
  where operation in (
    'leads.company.found', 'leads.person.found', 'leads.email.verified',
    'leads.email.catch_all', 'leads.verify.only', 'leads.phone.found'
  ) and enabled;

  if v_company is null or v_person is null or v_email is null or v_verify is null then
    return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
  end if;

  select count(*), count(*) filter (where hit)
  into v_attempts, v_hits
  from public.lead_attempts
  where user_id = v_user and step = 'email';

  if coalesce(v_attempts, 0) >= 50 then
    v_rate       := (v_hits::numeric + 1) / (v_attempts::numeric + 2);
    v_rate_source := 'your history';
  else
    v_rate       := 0.7;
    v_rate_source := 'default';
  end if;

  v_rate_used := v_rate;

  -- --- totals -------------------------------------------------------------
  if v_mode = 'verify_only' then
    -- Verification and nothing else. The ceiling is the floor, because the one
    -- thing that could push a row over it is a find and this mode does not do
    -- finds. See the banner: the previous (verify + email) ceiling made a 200
    -- credit operation require 2200 credits to start.
    v_expected := v_target * v_verify;
    v_max       := v_target * v_verify;
    v_min       := v_target * v_verify;
  elsif v_mode = 'verify_refind' then
    v_expected := v_target * v_verify + v_target * v_rate * v_email;
    v_max       := v_target * v_verify + v_target * v_email;
    v_min       := v_target * v_verify;
  else
    v_min      := v_target * v_company + v_target * v_person;
    v_max      := v_min + v_target * v_email;
    v_expected := v_min + v_target * v_rate * v_email;
  end if;

  if v_phone then
    v_expected := v_expected + v_target * v_rate * v_phone_credit;
    v_max       := v_max + v_target * v_phone_credit;
  end if;

  -- --- the lines behind those totals --------------------------------------
  -- Built from the same branch as the totals, so they sum to expected_credits.
  -- See 20261111_estimate_breakdown.sql for why that invariant matters.
  if v_mode = 'verify_only' then
    v_breakdown := jsonb_build_array(
      jsonb_build_object('label', 'Verifications', 'credits', round(v_target * v_verify, 6))
    );
  elsif v_mode = 'verify_refind' then
    v_breakdown := jsonb_build_array(
      jsonb_build_object('label', 'Verifications', 'credits', round(v_target * v_verify, 6)),
      jsonb_build_object(
        'label', 'Replacements found',
        'credits', round(v_target * v_rate_used * v_email, 6),
        'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
      )
    );
  else
    v_breakdown := jsonb_build_array(
      jsonb_build_object('label', 'Companies',       'credits', round(v_target * v_company, 6)),
      jsonb_build_object('label', 'Decision makers', 'credits', round(v_target * v_person, 6)),
      jsonb_build_object(
        'label', 'Emails found',
        'credits', round(v_target * v_rate_used * v_email, 6),
        'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
      )
    );
  end if;

  if v_phone then
    v_breakdown := v_breakdown
      || jsonb_build_array(
           jsonb_build_object(
             'label', 'Phone numbers',
             'credits', round(v_target * v_rate_used * v_phone_credit, 6)
           )
         );
  end if;

  return jsonb_build_object(
    'ok', true,
    'min_credits',     round(v_min, 6),
    'expected_credits', round(v_expected, 6),
    'max_credits',     round(v_max, 6),
    'target',          v_target,
    'hit_rate',        round(v_rate_used, 4),
    'hit_rate_source', v_rate_source,
    'attempts_behind_hit_rate', v_attempts,
    'breakdown',       v_breakdown
  );
end;
$fn$;

revoke execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  from public, anon, authenticated;
grant  execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  to service_role;

==============================================================================
 20261113_row_provider_cost.sql
---------------------------------------------------------------------------

-- lead_rows.treg_cost_usd: what this one row actually cost the provider
-- ---------------------------------------------------------------------------
-- The run has carried treg_cost_usd since it was created, so the margin for a
-- whole run is known. The margin for a single row is not, and the single row is
-- where the question actually gets asked: "this lead cost me 1.1 credits, what
-- did the provider charge you for it?"
--
-- Without it the user can see what they paid and never what it cost, which makes
-- the price unauditable. A per-result waterfall's entire claim is that the charge
-- is the measured provider cost at a mark-up, and the mark-up being visible per
-- row is what makes the claim checkable rather than asserted.
--
-- Nullable, deliberately. A row that has not been worked has no provider cost,
-- and zero is not the same as nothing: zero would read as "this was free" on a
-- row that is still queued. The UI shows a dash for null, which is what
-- PendingCount already does for a count that has not arrived.
--
-- Written by the worker in the same update that writes credits, so the two can
-- never be out of step for a row. There is no path that charges without costing
-- or costs without charging.

alter table public.lead_rows
  add column if not exists treg_cost_usd numeric(20,6);

comment on column public.lead_rows.treg_cost_usd is
  'What the provider actually charged for this row. Null until the row has been worked.';

-- A partial index rather than none. The table grows by the thousand per run and
-- the only read is "show me the cost for the rows on this page", which is
-- filtered by run. An index on run_id alone would be wrong — the export and the
-- provider lab read costs across every run at once.
create index if not exists lead_rows_run_treg_cost_idx
  on public.lead_rows (run_id)
  where treg_cost_usd is not null;

==============================================================================
 20261114_attempt_api_usage_link.sql
---------------------------------------------------------------------------

-- lead_attempts.api_usage_id: the wrong type, and therefore no foreign key
-- ---------------------------------------------------------------------------
-- The column was created, never written, and never related. logAttempt inserted
-- the attempt first and the api_usage row second, so the id did not exist when the
-- attempt was written, and nothing went back to fill it. Every row had null.
--
-- The foreign key could not be added either, which turns out to be why nobody
-- noticed sooner. The column is uuid and api_usage.id is bigint. The two have
-- never been able to reference each other, so the relationship existed only as a
-- naming convention in a comment.
--
-- Recast to bigint rather than recasting api_usage.id to uuid. api_usage.id is a
-- sequence-backed primary key with a partial index and a foreign key pointing at
-- it; converting it touches every writer and every reader for no benefit.
-- lead_attempts.api_usage_id holds nothing at all — it is null in every row, which
-- is the problem being fixed — so changing its type costs nothing.
--
-- ON DELETE SET NULL. Deleting a cost row must not delete the evidence that a
-- lookup was made, because the hit rates are computed from the attempts and a
-- provider that stopped being written to would slowly disappear from its own
-- ranking.

-- uuid does not cast straight to bigint, so it goes by way of text. The column
-- holds nothing, so nothing is lost on the way.
alter table public.lead_attempts
  alter column api_usage_id type bigint using (api_usage_id::text)::bigint;

alter table public.lead_attempts
  add constraint lead_attempts_api_usage_id_fkey
  foreign key (api_usage_id) references public.api_usage(id) on delete set null;

comment on column public.lead_attempts.api_usage_id is
  'The api_usage row for this call, carrying its http status and error code. Null when the cost write failed.';

-- The only read is "a row's attempts, with their failures", which is always by row
-- and always needs the link resolved. Covering api_usage_id means PostgREST can
-- embed the parent without a second lookup per attempt.
create index if not exists lead_attempts_row_api_usage_idx
  on public.lead_attempts (row_id, api_usage_id);

==============================================================================
 20261115_estimate_matches_plan.sql
---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- estimate_lead_run: the three clean modes, and the decision-maker line
-- ---------------------------------------------------------------------------
-- The estimate was wrong in three ways, and all three moved real money.
--
-- 1. full_enrich was priced as though it were a find run. It fell into the same
--    else branch, which means its max was target * (company + person + email).
--    Two things wrong with that, pulling in opposite directions:
--
--      it quoted 0.22 per row for a company lookup and a people lookup, which
--      full_enrich never performs - its rows came from the user's file with both
--      already on them, and steps.ts sets findCompany = false for all three clean
--      modes for exactly that reason;
--
--      and it left company.enrich out of the figure entirely. The worker charges
--      it, one credit per enriched row, and the number the user was shown did not
--      contain it.
--
--    Net effect at 2000 rows: max_credits came back as 2440 when the run's real
--    worst case was 4200. The wallet is checked against max, so a user with 3000
--    credits was allowed to start a run that could not be paid for, and the run
--    stalled part-way with pause_reason 'credits' - after doing most of the work
--    and being charged for it.
--
-- 2. The decision-maker line was unconditional. v_min was target * (company +
--    person), described in the file's own comment as "the lookups happen and are
--    billed whether or not they find anyone". That was never true of the code
--    that ships: creditsForRow charges the person only when the people waterfall
--    returns somebody, so min was a figure the wallet could never reach.
--
-- 3. Because of 2, expected_credits was also wrong - it was built on min, so it
--    carried the unconditional person price.
--
-- Rebuilt so the mode branch is the same branch steps.ts takes, which is the
-- only place the meaning of a mode is defined. The estimate now reads the plan
-- rather than reinterpreting the mode string, and the two cannot drift again.
--
-- max_credits stays a ceiling rather than a sum of the lines. It is what the
-- wallet is checked against, and a wallet check that used a forecast would
-- refuse runs that would have been fine.

-- ---------------------------------------------------------------------------
-- A smoothed success rate for one step of one user's waterfall.
--
-- The email rate already existed inline and was duplicated per step, which is
-- how person and enrich ended up borrowing the email rate: a user with a 40%
-- email hit rate was quoted 40% of decision makers too, which is a statement
-- about a waterfall that was never asked a question about.
--
-- Each step gets its own rate now, from its own attempts, and says which one it
-- used. Below the threshold the shipped 0.7 default applies rather than an
-- average across users - confidently wrong for anyone whose leads are harder
-- than average, on a page whose job is to say what a button will cost.
-- ---------------------------------------------------------------------------
create or replace function public.leads_step_hit_rate(p_user uuid, p_step text)
returns numeric
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    when count(*) >= 50
      then (count(*) filter (where hit)::numeric + 1) / (count(*)::numeric + 2)
    else 0.7
  end
  from public.lead_attempts
  where user_id = p_user and step = p_step;
$fn$;

revoke execute on function public.leads_step_hit_rate(uuid, text)
  from public, anon, authenticated;
grant execute on function public.leads_step_hit_rate(uuid, text) to service_role;

create or replace function public.estimate_lead_run(
  p_target      integer,
  p_mode        text default null,
  p_phone       boolean default false,
  p_hit_rate    numeric default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_user        uuid := auth.uid();
  v_target      integer := greatest(1, least(coalesce(p_target, 50), 2000));
  v_mode        text := nullif(trim(p_mode), '');
  v_phone       boolean := coalesce(p_phone, false);

  -- find and lab look the company and the person up. The three clean modes do
  -- not: their rows came from the user's file with both already on them. Kept as
  -- booleans rather than re-testing the mode string in six places, because six
  -- places testing a mode string is how the branches drifted apart in the first
  -- place. These four are steps.ts's StepPlan, field for field.
  v_find_company boolean;   -- findCompany
  v_verify_existing boolean; -- verifyExisting
  v_find_email    boolean;   -- findEmail
  v_enrich       boolean;   -- enrich

  v_company     numeric;
  v_person      numeric;
  v_email       numeric;
  v_catch_all   numeric;
  v_verify      numeric;
  v_phone_credit numeric;
  v_enrich_credit numeric;

  v_rate        numeric;
  v_person_rate numeric;
  v_enrich_rate numeric;
  v_phone_rate  numeric;
  v_rate_used   numeric;
  v_person_rate_used numeric;
  v_enrich_rate_used numeric;
  v_phone_rate_used  numeric;
  v_rate_source text;
  v_person_source text;
  v_enrich_source text;
  v_phone_source  text;

  v_attempts    integer;
  v_hits        integer;

  v_min         numeric;
  v_expected    numeric;
  v_max         numeric;
  v_breakdown   jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'unauthenticated');
  end if;

  v_find_company   := v_mode is null or v_mode not in ('verify_only', 'verify_refind', 'full_enrich');
  v_verify_existing := v_mode in ('verify_only', 'verify_refind', 'full_enrich');
  v_find_email      := v_find_company or v_mode in ('verify_refind', 'full_enrich');
  v_enrich          := v_mode = 'full_enrich';

  -- Prices come from the table, never from constants here. A row that is
  -- disabled or missing means the operation is not being sold, and the estimate
  -- has to say so rather than quote a price nothing charges.
  select
    max(case when operation = 'leads.company.found'  then credits end),
    max(case when operation = 'leads.person.found'   then credits end),
    max(case when operation = 'leads.email.verified' then credits end),
    max(case when operation = 'leads.email.catch_all' then credits end),
    max(case when operation = 'leads.verify.only'     then credits end),
    max(case when operation = 'leads.phone.found'     then credits end),
    max(case when operation = 'leads.company.enrich'  then credits end)
  into v_company, v_person, v_email, v_catch_all, v_verify, v_phone_credit, v_enrich_credit
  from public.pricing_config
  where operation in (
    'leads.company.found', 'leads.person.found', 'leads.email.verified',
    'leads.email.catch_all', 'leads.verify.only', 'leads.phone.found',
    'leads.company.enrich'
  ) and enabled;

  if v_company is null or v_person is null or v_email is null or v_verify is null then
    return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
  end if;

  -- Enrichment is priced only for the mode that sells it, so a missing row there
  -- is an error for that mode and not for any other. Refusing all three clean
  -- modes because enrichment is unpriced would break verify_only, which never
  -- enriches anything.
  if v_enrich and v_enrich_credit is null then
    return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
  end if;

  select count(*), count(*) filter (where hit)
  into v_attempts, v_hits
  from public.lead_attempts
  where user_id = v_user and step = 'email';

  -- The caller may pin the email rate; the other steps are always measured here.
  -- A pinned rate is for a quote being reproduced, not a way to move the others.
  if p_hit_rate is not null then
    v_rate       := p_hit_rate;
    v_rate_source := 'pinned';
  elsif coalesce(v_attempts, 0) >= 50 then
    v_rate        := (v_hits::numeric + 1) / (v_attempts::numeric + 2);
    v_rate_source := 'your history';
  else
    v_rate        := 0.7;
    v_rate_source := 'default';
  end if;

  v_rate_used       := v_rate;
  v_person_rate     := public.leads_step_hit_rate(v_user, 'person');
  v_enrich_rate     := public.leads_step_hit_rate(v_user, 'enrich');
  v_phone_rate      := public.leads_step_hit_rate(v_user, 'phone');
  v_person_rate_used := v_person_rate;
  v_enrich_rate_used := v_enrich_rate;
  v_phone_rate_used  := v_phone_rate;
  v_person_source  := case when v_person_rate = 0.7 then 'default' else 'your history' end;
  v_enrich_source := case when v_enrich_rate = 0.7 then 'default' else 'your history' end;
  v_phone_source  := case when v_phone_rate  = 0.7 then 'default' else 'your history' end;

  -- --- totals -------------------------------------------------------------
  -- Every line below is charged only when the work happened, which is what
  -- creditsForRow does. The company is the exception and is charged per row
  -- because the row exists because that company was found.
  v_min := 0;
  v_expected := 0;
  v_max := 0;

  -- company
  if v_find_company then
    v_min      := v_target * v_company;
    v_expected := v_min;
    -- person only. The email line below adds its own worst case, and adding it
    -- here as well is how max_credits came back at 2.22 per row for a row whose
    -- worst case is 1.22 - a 8200 credit over-reservation on a 2000-row search,
    -- which refuses runs the user can afford.
    v_max      := v_min + v_target * v_person;
  end if;

  -- decision maker
  if v_find_company then
    v_expected := v_expected + v_target * v_person_rate * v_person;
  end if;

  -- verification
  if v_verify_existing then
    v_min      := v_min + v_target * v_verify;
    v_expected := v_expected + v_target * v_verify;
    v_max      := v_max + v_target * v_verify;
  end if;

  -- address
  if v_find_email then
    v_expected := v_expected + v_target * v_rate * v_email;
    v_max      := v_max + v_target * v_email;
  end if;

  -- enrichment
  if v_enrich then
    v_expected := v_expected + v_target * v_enrich_rate * v_enrich_credit;
    v_max      := v_max + v_target * v_enrich_credit;
  end if;

  -- phone
  if v_phone then
    if v_phone_credit is null then
      return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
    end if;
    v_expected := v_expected + v_target * v_phone_rate * v_phone_credit;
    v_max      := v_max + v_target * v_phone_credit;
  end if;

  -- --- the lines behind those totals --------------------------------------
  -- The invariant this file exists to protect: the lines add up to
  -- expected_credits. Built from the same conditionals as the totals above
  -- rather than from the mode string, because the previous version tested the
  -- mode one way for the lines and another for the total.
  v_breakdown := '[]'::jsonb;

  if v_find_company then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object('label', 'Companies', 'credits', round(v_target * v_company, 6)),
      jsonb_build_object(
        'label', 'Decision makers',
        'credits', round(v_target * v_person_rate_used * v_person, 6),
        'note', 'at ' || round(v_person_rate_used * 100, 1) || '% from ' || v_person_source
      )
    );
  end if;

  if v_verify_existing then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object('label', 'Verifications', 'credits', round(v_target * v_verify, 6))
    );
  end if;

  if v_find_email then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object(
        'label', case when v_find_company then 'Emails found' else 'Replacements found' end,
        'credits', round(v_target * v_rate_used * v_email, 6),
        'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
      )
    );
  end if;

  if v_enrich then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object(
        'label', 'Company details',
        'credits', round(v_target * v_enrich_rate_used * v_enrich_credit, 6),
        'note', 'at ' || round(v_enrich_rate_used * 100, 1) || '% from ' || v_enrich_source
      )
    );
  end if;

  if v_phone then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object(
        'label', 'Phone numbers',
        'credits', round(v_target * v_phone_rate_used * v_phone_credit, 6),
        'note', 'at ' || round(v_phone_rate_used * 100, 1) || '% from ' || v_phone_source
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'min_credits',     round(v_min, 6),
    'expected_credits', round(v_expected, 6),
    'max_credits',     round(v_max, 6),
    'target',          v_target,
    'hit_rate',        round(v_rate_used, 4),
    'hit_rate_source', v_rate_source,
    'attempts_behind_hit_rate', v_attempts,
    'breakdown',       v_breakdown
  );
end;
$fn$;

revoke execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  from public, anon, authenticated;
grant  execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  to service_role;

==============================================================================
 20261116_leads_worker_lease.sql
---------------------------------------------------------------------------

-- ============================================================================
-- Echo Leads: one worker per run, and row claims that actually skip locked rows
-- ----------------------------------------------------------------------------
-- Two things the worker needed from the database and was doing through
-- PostgREST instead.
--
-- 1. A run lease. The worker re-invokes itself after every chunk and pg_cron
--    calls it every minute, so two workers on the same run is the normal case,
--    not an edge case. Both read the same chunk counter, both reserved under the
--    same idempotency key, and the second hold came back as a replay of the
--    first - so the second worker's rows were settled against a hold that was
--    already closed and were never charged. A lease makes the chunks of one run
--    strictly sequential.
--
-- 2. A row claim with FOR UPDATE SKIP LOCKED. The old claim was an UPDATE ...
--    LIMIT through PostgREST with no ORDER BY, which PostgREST does not support
--    as a limited update, and it claimed 25 rows to work 5 - leaving 20 locked
--    for five minutes and sizing the credit hold for all 25.
--
-- Both are service-role only, like every other function that moves work.
-- ============================================================================

alter table public.lead_runs
  add column if not exists lease_until timestamptz;

comment on column public.lead_runs.lease_until is
  'Held by the worker that is processing a chunk of this run. Null or past means free.';

-- ---------------------------------------------------------------------------
-- lead_claim_run: take the run for p_seconds, or return false
-- ---------------------------------------------------------------------------
create or replace function public.lead_claim_run(p_run_id uuid, p_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.lead_runs
     set lease_until = now() + make_interval(secs => greatest(10, least(p_seconds, 600)))
   where id = p_run_id
     and status in ('queued', 'running')
     and (lease_until is null or lease_until < now())
  returning id into v_id;

  return v_id is not null;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_release_run: give the lease back early
-- ---------------------------------------------------------------------------
create or replace function public.lead_release_run(p_run_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.lead_runs set lease_until = null where id = p_run_id;
$$;

-- ---------------------------------------------------------------------------
-- lead_claim_rows: up to p_limit workable rows, oldest first, skipping held ones
-- ---------------------------------------------------------------------------
-- Ordered by (created_at, id) so a run is worked in the order it was found and
-- two rows created in the same statement still have a stable order. A retried
-- row reuses its provider idempotency keys, so a call that already happened is
-- replayed by Treg at no cost rather than bought again.
create or replace function public.lead_claim_rows(
  p_run_id uuid,
  p_limit integer,
  p_stale_seconds integer default 300
)
returns setof public.lead_rows
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select r.id
      from public.lead_rows r
     where r.run_id = p_run_id
       -- 'trying' too: a row left mid-step by a worker that died is only ever
       -- in that state, and without it the run could never finish. The stale
       -- lock below is what keeps a row another worker is on from being taken.
       and r.state in ('queued', 'miss', 'trying')
       and (r.locked_at is null
            or r.locked_at < now() - make_interval(secs => greatest(30, p_stale_seconds)))
     order by r.created_at, r.id
     limit greatest(1, least(p_limit, 100))
     for update skip locked
  )
  update public.lead_rows r
     set locked_at = now(),
         locked_by = 'worker'
    from picked
   where r.id = picked.id
  returning r.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_run_add_totals: add a chunk's charge and cost to the run, atomically
-- ---------------------------------------------------------------------------
-- An increment in SQL rather than "snapshot + amount" from the worker. The
-- worker's copy of the run was read before it took the lease, so writing
-- snapshot + amount overwrote whatever another worker had settled meanwhile.
create or replace function public.lead_run_add_totals(
  p_run_id uuid,
  p_credits numeric,
  p_cost_usd numeric,
  p_chunks integer default 0
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $
  update public.lead_runs
     set charged_credits = charged_credits + greatest(coalesce(p_credits, 0), 0),
         treg_cost_usd   = treg_cost_usd + greatest(coalesce(p_cost_usd, 0), 0),
         started_at      = coalesce(started_at, now()),
         counters        = jsonb_set(counters, '{chunk}',
                             to_jsonb(coalesce((counters ->> 'chunk')::integer, 0) + greatest(p_chunks, 0)))
   where id = p_run_id;
$;

revoke execute on function public.lead_run_add_totals(uuid, numeric, numeric, integer) from public, anon, authenticated;
grant  execute on function public.lead_run_add_totals(uuid, numeric, numeric, integer) to service_role;

revoke execute on function public.lead_claim_run(uuid, integer)          from public, anon, authenticated;
revoke execute on function public.lead_release_run(uuid)                 from public, anon, authenticated;
revoke execute on function public.lead_claim_rows(uuid, integer, integer) from public, anon, authenticated;
grant  execute on function public.lead_claim_run(uuid, integer)          to service_role;
grant  execute on function public.lead_release_run(uuid)                 to service_role;
grant  execute on function public.lead_claim_rows(uuid, integer, integer) to service_role;

-- Stable paging for get_run: rows seeded in one insert share a created_at, so
-- the id is the tiebreak and the index covers both.
create index if not exists lead_rows_run_created_id_idx
  on public.lead_rows (run_id, created_at, id);

==============================================================================
 20261117_estimate_for_user.sql
---------------------------------------------------------------------------

-- ============================================================================
-- Echo Leads: the estimate needs to know whose estimate it is
-- ----------------------------------------------------------------------------
-- estimate_lead_run read the user from auth.uid(). It is revoked from
-- authenticated and only ever called by the leads function through the service
-- role client, where auth.uid() is null - so it returned 'unauthenticated' on
-- every call, and the start action, which refuses a run without a price, could
-- never start one.
--
-- The user is now a parameter. Safe because only service_role can execute it,
-- and the function passes the id it resolved from the caller's JWT.
--
-- Also two single-purpose modes for bulk actions on leads already held:
--   phone_only   find a phone number, nothing else
--   enrich_only  company details, nothing else
--
-- The four-argument version is dropped so the old, broken signature cannot be
-- called by an older deployment of the function and silently fail.
-- ============================================================================

drop function if exists public.estimate_lead_run(integer, text, boolean, numeric);

create or replace function public.estimate_lead_run(
  p_target      integer,
  p_mode        text default null,
  p_phone       boolean default false,
  p_hit_rate    numeric default null,
  p_user        uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_user        uuid := coalesce(p_user, auth.uid());
  v_target      integer := greatest(1, least(coalesce(p_target, 50), 2000));
  v_mode        text := nullif(trim(p_mode), '');
  v_phone       boolean := coalesce(p_phone, false);

  -- find and lab look the company and the person up. The three clean modes do
  -- not: their rows came from the user's file with both already on them. Kept as
  -- booleans rather than re-testing the mode string in six places, because six
  -- places testing a mode string is how the branches drifted apart in the first
  -- place. These four are steps.ts's StepPlan, field for field.
  v_find_company boolean;   -- findCompany
  v_verify_existing boolean; -- verifyExisting
  v_find_email    boolean;   -- findEmail
  v_enrich       boolean;   -- enrich

  v_company     numeric;
  v_person      numeric;
  v_email       numeric;
  v_catch_all   numeric;
  v_verify      numeric;
  v_phone_credit numeric;
  v_enrich_credit numeric;

  v_rate        numeric;
  v_person_rate numeric;
  v_enrich_rate numeric;
  v_phone_rate  numeric;
  v_rate_used   numeric;
  v_person_rate_used numeric;
  v_enrich_rate_used numeric;
  v_phone_rate_used  numeric;
  v_rate_source text;
  v_person_source text;
  v_enrich_source text;
  v_phone_source  text;

  v_attempts    integer;
  v_hits        integer;

  v_min         numeric;
  v_expected    numeric;
  v_max         numeric;
  v_breakdown   jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'unauthenticated');
  end if;

  v_find_company   := v_mode is null
                      or v_mode not in ('verify_only', 'verify_refind', 'full_enrich', 'phone_only', 'enrich_only');
  v_verify_existing := coalesce(v_mode in ('verify_only', 'verify_refind', 'full_enrich'), false);
  v_find_email      := v_find_company or coalesce(v_mode in ('verify_refind', 'full_enrich'), false);
  v_enrich          := coalesce(v_mode in ('full_enrich', 'enrich_only'), false);
  -- phone_only exists to find numbers for leads already held; the flag is the mode.
  if v_mode = 'phone_only' then
    v_phone := true;
  end if;

  -- Prices come from the table, never from constants here. A row that is
  -- disabled or missing means the operation is not being sold, and the estimate
  -- has to say so rather than quote a price nothing charges.
  select
    max(case when operation = 'leads.company.found'  then credits end),
    max(case when operation = 'leads.person.found'   then credits end),
    max(case when operation = 'leads.email.verified' then credits end),
    max(case when operation = 'leads.email.catch_all' then credits end),
    max(case when operation = 'leads.verify.only'     then credits end),
    max(case when operation = 'leads.phone.found'     then credits end),
    max(case when operation = 'leads.company.enrich'  then credits end)
  into v_company, v_person, v_email, v_catch_all, v_verify, v_phone_credit, v_enrich_credit
  from public.pricing_config
  where operation in (
    'leads.company.found', 'leads.person.found', 'leads.email.verified',
    'leads.email.catch_all', 'leads.verify.only', 'leads.phone.found',
    'leads.company.enrich'
  ) and enabled;

  if v_company is null or v_person is null or v_email is null or v_verify is null then
    return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
  end if;

  -- Enrichment is priced only for the mode that sells it, so a missing row there
  -- is an error for that mode and not for any other. Refusing all three clean
  -- modes because enrichment is unpriced would break verify_only, which never
  -- enriches anything.
  if v_enrich and v_enrich_credit is null then
    return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
  end if;

  select count(*), count(*) filter (where hit)
  into v_attempts, v_hits
  from public.lead_attempts
  where user_id = v_user and step = 'email';

  -- The caller may pin the email rate; the other steps are always measured here.
  -- A pinned rate is for a quote being reproduced, not a way to move the others.
  if p_hit_rate is not null then
    v_rate       := p_hit_rate;
    v_rate_source := 'pinned';
  elsif coalesce(v_attempts, 0) >= 50 then
    v_rate        := (v_hits::numeric + 1) / (v_attempts::numeric + 2);
    v_rate_source := 'your history';
  else
    v_rate        := 0.7;
    v_rate_source := 'default';
  end if;

  v_rate_used       := v_rate;
  v_person_rate     := public.leads_step_hit_rate(v_user, 'person');
  v_enrich_rate     := public.leads_step_hit_rate(v_user, 'enrich');
  v_phone_rate      := public.leads_step_hit_rate(v_user, 'phone');
  v_person_rate_used := v_person_rate;
  v_enrich_rate_used := v_enrich_rate;
  v_phone_rate_used  := v_phone_rate;
  v_person_source  := case when v_person_rate = 0.7 then 'default' else 'your history' end;
  v_enrich_source := case when v_enrich_rate = 0.7 then 'default' else 'your history' end;
  v_phone_source  := case when v_phone_rate  = 0.7 then 'default' else 'your history' end;

  -- --- totals -------------------------------------------------------------
  -- Every line below is charged only when the work happened, which is what
  -- creditsForRow does. The company is the exception and is charged per row
  -- because the row exists because that company was found.
  v_min := 0;
  v_expected := 0;
  v_max := 0;

  -- company
  if v_find_company then
    v_min      := v_target * v_company;
    v_expected := v_min;
    -- person only. The email line below adds its own worst case, and adding it
    -- here as well is how max_credits came back at 2.22 per row for a row whose
    -- worst case is 1.22 - a 8200 credit over-reservation on a 2000-row search,
    -- which refuses runs the user can afford.
    v_max      := v_min + v_target * v_person;
  end if;

  -- decision maker
  if v_find_company then
    v_expected := v_expected + v_target * v_person_rate * v_person;
  end if;

  -- verification
  if v_verify_existing then
    v_min      := v_min + v_target * v_verify;
    v_expected := v_expected + v_target * v_verify;
    v_max      := v_max + v_target * v_verify;
  end if;

  -- address
  if v_find_email then
    v_expected := v_expected + v_target * v_rate * v_email;
    v_max      := v_max + v_target * v_email;
  end if;

  -- enrichment
  if v_enrich then
    v_expected := v_expected + v_target * v_enrich_rate * v_enrich_credit;
    v_max      := v_max + v_target * v_enrich_credit;
  end if;

  -- phone
  if v_phone then
    if v_phone_credit is null then
      return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
    end if;
    v_expected := v_expected + v_target * v_phone_rate * v_phone_credit;
    v_max      := v_max + v_target * v_phone_credit;
  end if;

  -- --- the lines behind those totals --------------------------------------
  -- The invariant this file exists to protect: the lines add up to
  -- expected_credits. Built from the same conditionals as the totals above
  -- rather than from the mode string, because the previous version tested the
  -- mode one way for the lines and another for the total.
  v_breakdown := '[]'::jsonb;

  if v_find_company then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object('label', 'Companies', 'credits', round(v_target * v_company, 6)),
      jsonb_build_object(
        'label', 'Decision makers',
        'credits', round(v_target * v_person_rate_used * v_person, 6),
        'note', 'at ' || round(v_person_rate_used * 100, 1) || '% from ' || v_person_source
      )
    );
  end if;

  if v_verify_existing then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object('label', 'Verifications', 'credits', round(v_target * v_verify, 6))
    );
  end if;

  if v_find_email then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object(
        'label', case when v_find_company then 'Emails found' else 'Replacements found' end,
        'credits', round(v_target * v_rate_used * v_email, 6),
        'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
      )
    );
  end if;

  if v_enrich then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object(
        'label', 'Company details',
        'credits', round(v_target * v_enrich_rate_used * v_enrich_credit, 6),
        'note', 'at ' || round(v_enrich_rate_used * 100, 1) || '% from ' || v_enrich_source
      )
    );
  end if;

  if v_phone then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object(
        'label', 'Phone numbers',
        'credits', round(v_target * v_phone_rate_used * v_phone_credit, 6),
        'note', 'at ' || round(v_phone_rate_used * 100, 1) || '% from ' || v_phone_source
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'min_credits',     round(v_min, 6),
    'expected_credits', round(v_expected, 6),
    'max_credits',     round(v_max, 6),
    'target',          v_target,
    'hit_rate',        round(v_rate_used, 4),
    'hit_rate_source', v_rate_source,
    'attempts_behind_hit_rate', v_attempts,
    'breakdown',       v_breakdown
  );
end;
$fn$;

revoke execute on function public.estimate_lead_run(integer, text, boolean, numeric, uuid)
  from public, anon, authenticated;
grant  execute on function public.estimate_lead_run(integer, text, boolean, numeric, uuid)
  to service_role;

==============================================================================
 20261118_lead_database.sql
---------------------------------------------------------------------------

-- ============================================================================
-- Echo Leads: a lead database, not a pile of run results
-- ----------------------------------------------------------------------------
-- Until now every lead lived on the run that found it. The same person found by
-- two runs was two rows; nothing could be tagged, noted, listed or qualified;
-- and there was nowhere for "enrich these five again" to write its answer.
--
-- This adds the records a sales workflow is built on:
--
--   lead_companies      one per workspace and domain
--   lead_contacts       one per workspace and person, merged from run rows by
--                       email, then LinkedIn URL, then name + domain
--   lead_lists          people or company lists, with lead_list_members
--   lead_saved_searches saved filter sets for the search and the database views
--   lead_search_log     what was searched, for history
--   lead_scoring        the workspace's scoring rules
--
-- Runs are unchanged: a run still owns its rows, its receipt and its charges.
-- When a row finishes, lead_contact_upsert_from_row merges it into the contact
-- and company it belongs to. The merge never overwrites a value with null and
-- never replaces a checked address with an unchecked one.
--
-- Same tenancy as every other lead_* table: user_id on every row, RLS select-own,
-- no client write policies - all writes go through the leads function.
--
-- Email statuses gain two values:
--   unchecked   an address nothing has verified (imports, unverified finds).
--               Previously stored as 'unknown', which also meant "a verifier
--               tried and could not tell" - two different claims in one word.
--   disposable  a throwaway mailbox, which verifiers report separately
-- ============================================================================

-- ---------------------------------------------------------------------------
-- lead_rows: the new statuses, freshness, and a re-check generation
-- ---------------------------------------------------------------------------
alter table public.lead_rows
  drop constraint if exists lead_rows_email_status_check;
alter table public.lead_rows
  add constraint lead_rows_email_status_check
  check (email_status in ('verified', 'catch_all', 'invalid', 'unknown', 'not_found', 'unchecked', 'disposable'));

alter table public.lead_rows
  add column if not exists email_checked_at timestamptz,
  add column if not exists email_verifier   text,
  -- Part of every provider idempotency key, so a deliberate re-check is a new
  -- call rather than a replay of the old answer.
  add column if not exists generation       integer not null default 0;

-- Imported addresses that nothing has ever verified were stored as 'unknown'.
-- A row with no verify attempt at all was not checked; say so.
update public.lead_rows r
   set email_status = 'unchecked'
 where r.email_status = 'unknown'
   and not exists (
     select 1 from public.lead_attempts a where a.row_id = r.id and a.step = 'verify'
   );

-- ---------------------------------------------------------------------------
-- Normalisation used for matching
-- ---------------------------------------------------------------------------
create or replace function public.lead_norm_email(p text)
returns text language sql immutable as $$
  select nullif(lower(trim(p)), '');
$$;

create or replace function public.lead_norm_linkedin(p text)
returns text language sql immutable as $$
  -- https://www.linkedin.com/in/Jane-Doe/?x=1 -> in/jane-doe. Anything that is
  -- not a personal profile URL does not identify a person and is null.
  select nullif(substring(lower(trim(coalesce(p, ''))) from 'linkedin.com/(in/[^/?#]+)'), '');
$$;

create or replace function public.lead_norm_name(p text)
returns text language sql immutable as $$
  select nullif(regexp_replace(lower(trim(coalesce(p, ''))), '\s+', ' ', 'g'), '');
$$;

create or replace function public.lead_norm_domain(p text)
returns text language sql immutable as $$
  -- Idempotent: normalising a normalised value changes nothing, which the check
  -- constraint on lead_companies.domain relies on. All whitespace, any number of
  -- leading "www.", and any port or path are dropped.
  select nullif(
    regexp_replace(
      regexp_replace(lower(regexp_replace(coalesce(p, ''), '\s+', '', 'g')), '^(https?://)?(www\.)*', ''),
      '[/?#:].*$', ''
    ),
    ''
  );
$$;

-- ---------------------------------------------------------------------------
-- lead_companies
-- ---------------------------------------------------------------------------
create table if not exists public.lead_companies (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  domain       text not null,
  name         text,
  logo_url     text,
  -- Provider-reported firmographics, normalised by endpoints.ts. `source` names
  -- the endpoint; `enriched_at` is when it was fetched.
  data         jsonb not null default '{}'::jsonb,
  enriched_at  timestamptz,
  tags         text[] not null default '{}',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint lead_companies_domain_norm check (domain = public.lead_norm_domain(domain)),
  constraint lead_companies_user_domain_key unique (user_id, domain)
);

-- ---------------------------------------------------------------------------
-- lead_contacts
-- ---------------------------------------------------------------------------
create table if not exists public.lead_contacts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  company_id       uuid references public.lead_companies (id) on delete set null,

  person_name      text,
  title            text,
  linkedin_url     text,
  location         text,
  company_name     text,
  domain           text,

  email            text,
  email_status     text not null default 'not_found',
  email_checked_at timestamptz,
  email_verifier   text,
  email_provider   text,

  phone            text,
  phone_provider   text,

  -- Matching keys, kept in step with the fields above by the upsert.
  email_norm       text,
  linkedin_norm    text,
  name_norm        text,

  -- Provider attributes that are not columns: seniority, department, the
  -- LeadsForge id, the company snapshot a search returned. Never user input.
  attributes       jsonb not null default '{}'::jsonb,

  -- The user's own fields.
  tags             text[] not null default '{}',
  notes            text,
  status           text not null default 'new',
  custom           jsonb not null default '{}'::jsonb,

  score            integer,
  score_label      text,
  score_reasons    jsonb not null default '[]'::jsonb,
  scored_at        timestamptz,

  source           text not null default 'run',
  last_run_id      uuid references public.lead_runs (id) on delete set null,
  last_row_id      uuid references public.lead_rows (id) on delete set null,
  last_enriched_at timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint lead_contacts_email_status_check
    check (email_status in ('verified', 'catch_all', 'invalid', 'unknown', 'not_found', 'unchecked', 'disposable')),
  constraint lead_contacts_email_implies_address
    check (email_status = 'not_found' or email is not null),
  constraint lead_contacts_status_check
    check (status in ('new', 'qualified', 'contacted', 'nurture', 'disqualified')),
  constraint lead_contacts_score_range check (score is null or (score between 0 and 100)),
  constraint lead_contacts_source_check check (source in ('run', 'search', 'import')),
  constraint lead_contacts_identity
    check (email_norm is not null or linkedin_norm is not null or (name_norm is not null and domain is not null))
);

create index if not exists lead_contacts_user_updated_idx on public.lead_contacts (user_id, updated_at desc, id);
create index if not exists lead_contacts_user_email_idx   on public.lead_contacts (user_id, email_norm) where email_norm is not null;
create index if not exists lead_contacts_user_li_idx      on public.lead_contacts (user_id, linkedin_norm) where linkedin_norm is not null;
create index if not exists lead_contacts_user_name_idx    on public.lead_contacts (user_id, name_norm, domain) where name_norm is not null;
create index if not exists lead_contacts_user_domain_idx  on public.lead_contacts (user_id, domain);
create index if not exists lead_contacts_user_score_idx   on public.lead_contacts (user_id, score desc nulls last);
create index if not exists lead_contacts_company_idx      on public.lead_contacts (company_id);
create index if not exists lead_contacts_tags_idx         on public.lead_contacts using gin (tags);

-- ---------------------------------------------------------------------------
-- Lists
-- ---------------------------------------------------------------------------
create table if not exists public.lead_lists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  kind        text not null default 'people',
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lead_lists_kind_check check (kind in ('people', 'companies')),
  constraint lead_lists_name_len check (char_length(trim(name)) between 1 and 80),
  constraint lead_lists_user_name_key unique (user_id, kind, name)
);

create table if not exists public.lead_list_members (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  list_id     uuid not null references public.lead_lists (id) on delete cascade,
  contact_id  uuid references public.lead_contacts (id) on delete cascade,
  company_id  uuid references public.lead_companies (id) on delete cascade,
  added_at    timestamptz not null default now(),
  constraint lead_list_members_one_target check ((contact_id is null) <> (company_id is null))
);

create unique index if not exists lead_list_members_contact_key on public.lead_list_members (list_id, contact_id) where contact_id is not null;
create unique index if not exists lead_list_members_company_key on public.lead_list_members (list_id, company_id) where company_id is not null;
create index if not exists lead_list_members_contact_idx on public.lead_list_members (contact_id);
create index if not exists lead_list_members_company_idx on public.lead_list_members (company_id);

-- ---------------------------------------------------------------------------
-- Saved searches, search history, scoring
-- ---------------------------------------------------------------------------
create table if not exists public.lead_saved_searches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  -- people_search: provider filters. people_view / companies_view: database filters.
  kind        text not null,
  filters     jsonb not null default '{}'::jsonb,
  last_total  integer,
  last_run_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lead_saved_searches_kind_check check (kind in ('people_search', 'people_view', 'companies_view')),
  constraint lead_saved_searches_name_len check (char_length(trim(name)) between 1 and 80),
  constraint lead_saved_searches_user_name_key unique (user_id, kind, name)
);

create table if not exists public.lead_search_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  filters     jsonb not null,
  total       integer,
  created_at  timestamptz not null default now()
);
create index if not exists lead_search_log_user_idx on public.lead_search_log (user_id, created_at desc);

create table if not exists public.lead_scoring (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  rules       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: select-own, no client writes
-- ---------------------------------------------------------------------------
alter table public.lead_companies      enable row level security;
alter table public.lead_contacts       enable row level security;
alter table public.lead_lists          enable row level security;
alter table public.lead_list_members   enable row level security;
alter table public.lead_saved_searches enable row level security;
alter table public.lead_search_log     enable row level security;
alter table public.lead_scoring        enable row level security;

do $$
declare t text;
begin
  foreach t in array array['lead_companies', 'lead_contacts', 'lead_lists', 'lead_list_members',
                           'lead_saved_searches', 'lead_search_log', 'lead_scoring']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_select_own', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_company_upsert: one company per workspace and domain
-- ---------------------------------------------------------------------------
create or replace function public.lead_company_upsert(
  p_user uuid, p_domain text, p_name text, p_logo text, p_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_domain text := public.lead_norm_domain(p_domain);
  v_id uuid;
  v_has_data boolean := p_data is not null and p_data <> '{}'::jsonb;
  v_at timestamptz := nullif(p_data ->> 'enriched_at', '')::timestamptz;
begin
  if v_domain is null then
    return null;
  end if;

  insert into public.lead_companies (user_id, domain, name, logo_url, data, enriched_at)
  values (p_user, v_domain, nullif(trim(p_name), ''), nullif(trim(p_logo), ''),
          case when v_has_data then p_data else '{}'::jsonb end,
          case when v_has_data then coalesce(v_at, now()) end)
  on conflict (user_id, domain) do update
     set name     = coalesce(public.lead_companies.name, excluded.name),
         logo_url = coalesce(public.lead_companies.logo_url, excluded.logo_url),
         -- Newer provider data replaces older; nothing replaces data with nothing.
         data = case
                  when v_has_data and (public.lead_companies.enriched_at is null
                                       or excluded.enriched_at >= public.lead_companies.enriched_at)
                    then public.lead_companies.data || p_data
                  else public.lead_companies.data
                end,
         enriched_at = case
                  when v_has_data and (public.lead_companies.enriched_at is null
                                       or excluded.enriched_at >= public.lead_companies.enriched_at)
                    then excluded.enriched_at
                  else public.lead_companies.enriched_at
                end,
         updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_contact_merge: fold one set of person fields into the workspace's record
-- ---------------------------------------------------------------------------
-- Matching order: an explicit contact id (a run made from saved contacts), then
-- email, then LinkedIn URL, then name + domain. Returns the contact as jsonb with
-- its company's data, so the caller can score it without a second read.
create or replace function public.lead_contact_merge(p_user uuid, p_fields jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := public.lead_norm_email(p_fields ->> 'email');
  v_li      text := public.lead_norm_linkedin(p_fields ->> 'linkedin_url');
  v_name    text := public.lead_norm_name(p_fields ->> 'person_name');
  v_domain  text := public.lead_norm_domain(p_fields ->> 'domain');
  v_status  text := coalesce(nullif(p_fields ->> 'email_status', ''), 'not_found');
  v_checked timestamptz := nullif(p_fields ->> 'email_checked_at', '')::timestamptz;
  -- Only a real uuid is a hint. extra can carry a CSV's own "contact_id" column,
  -- and casting "12345" would fail the merge (and the backfill with it).
  v_hint    uuid := case
                      when p_fields ->> 'contact_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        then (p_fields ->> 'contact_id')::uuid
                    end;
  v_company uuid;
  v_id      uuid;
  c         public.lead_contacts;
  v_take_email boolean;
begin
  if v_email is null and v_li is null and (v_name is null or v_domain is null) then
    return null; -- nothing that identifies a person
  end if;

  v_company := public.lead_company_upsert(p_user, v_domain, p_fields ->> 'company_name', p_fields ->> 'logo_url',
                                          coalesce(p_fields -> 'company_data', '{}'::jsonb));

  if v_hint is not null then
    select * into c from public.lead_contacts where id = v_hint and user_id = p_user;
  end if;
  if c.id is null and v_email is not null then
    select * into c from public.lead_contacts where user_id = p_user and email_norm = v_email
      order by created_at limit 1;
  end if;
  if c.id is null and v_li is not null then
    select * into c from public.lead_contacts where user_id = p_user and linkedin_norm = v_li
      order by created_at limit 1;
  end if;
  if c.id is null and v_name is not null and v_domain is not null then
    select * into c from public.lead_contacts where user_id = p_user and name_norm = v_name and domain = v_domain
      order by created_at limit 1;
  end if;

  if c.id is null then
    insert into public.lead_contacts (
      user_id, company_id, person_name, title, linkedin_url, location, company_name, domain,
      email, email_status, email_checked_at, email_verifier, email_provider, phone, phone_provider,
      email_norm, linkedin_norm, name_norm, attributes, source, last_run_id, last_row_id, last_enriched_at
    ) values (
      p_user, v_company, nullif(p_fields ->> 'person_name', ''), nullif(p_fields ->> 'title', ''), nullif(p_fields ->> 'linkedin_url', ''),
      nullif(p_fields ->> 'location', ''), nullif(p_fields ->> 'company_name', ''), v_domain,
      case when v_email is not null then v_email end,
      case when v_email is not null then v_status else 'not_found' end,
      v_checked, nullif(p_fields ->> 'email_verifier', ''), nullif(p_fields ->> 'email_provider', ''),
      nullif(p_fields ->> 'phone', ''), nullif(p_fields ->> 'phone_provider', ''),
      v_email, v_li, v_name, coalesce(p_fields -> 'attributes', '{}'::jsonb),
      coalesce(nullif(p_fields ->> 'source', ''), 'run'),
      nullif(p_fields ->> 'run_id', '')::uuid, nullif(p_fields ->> 'row_id', '')::uuid,
      case when v_checked is not null or p_fields ? 'company_data' then now() end
    )
    returning id into v_id;
  else
    -- Take the incoming address when:
    --   none is held;
    --   it is the same address with a newer check, i.e. a fresher verdict on it;
    --   it is a different address a verifier accepted, replacing one that failed
    --   or was never confirmed (or a verified one checked longer ago).
    -- Never: an unchecked copy of the same address over a known verdict - a
    -- phone run carries the address unchecked and must not clear "invalid" - and
    -- never a rejected or unchecked address over a different one.
    v_take_email := v_email is not null and (
         c.email_norm is null
      or (v_email = c.email_norm and v_checked is not null
          and (c.email_checked_at is null or v_checked > c.email_checked_at))
      or (v_email <> c.email_norm and v_status in ('verified', 'catch_all')
          and (c.email_status not in ('verified', 'catch_all')
               or (v_status = 'verified' and v_checked is not null
                   and (c.email_checked_at is null or v_checked > c.email_checked_at))))
    );

    update public.lead_contacts set
      company_id     = coalesce(v_company, company_id),
      person_name    = coalesce(person_name, nullif(p_fields ->> 'person_name', '')),
      title          = coalesce(nullif(p_fields ->> 'title', ''), title),
      linkedin_url   = coalesce(linkedin_url, nullif(p_fields ->> 'linkedin_url', '')),
      linkedin_norm  = coalesce(linkedin_norm, v_li),
      location       = coalesce(nullif(p_fields ->> 'location', ''), location),
      company_name   = coalesce(company_name, nullif(p_fields ->> 'company_name', '')),
      domain         = coalesce(domain, v_domain),
      name_norm      = coalesce(name_norm, v_name),
      email          = case when v_take_email then v_email else email end,
      email_norm     = case when v_take_email then v_email else email_norm end,
      email_status   = case when v_take_email then v_status else email_status end,
      email_checked_at = case when v_take_email then v_checked else email_checked_at end,
      email_verifier = case when v_take_email then nullif(p_fields ->> 'email_verifier', '') else email_verifier end,
      email_provider = case when v_take_email then coalesce(nullif(p_fields ->> 'email_provider', ''), email_provider) else email_provider end,
      phone          = coalesce(nullif(p_fields ->> 'phone', ''), phone),
      phone_provider = case when nullif(p_fields ->> 'phone', '') is not null then nullif(p_fields ->> 'phone_provider', '') else phone_provider end,
      attributes     = attributes || coalesce(p_fields -> 'attributes', '{}'::jsonb),
      last_run_id    = coalesce(nullif(p_fields ->> 'run_id', '')::uuid, last_run_id),
      last_row_id    = coalesce(nullif(p_fields ->> 'row_id', '')::uuid, last_row_id),
      last_enriched_at = case when v_checked is not null or p_fields ? 'company_data' then now() else last_enriched_at end,
      updated_at     = now()
    where id = c.id
    returning id into v_id;
  end if;

  return (
    select to_jsonb(ct) || jsonb_build_object('company', coalesce(to_jsonb(co.data), '{}'::jsonb))
    from public.lead_contacts ct
    left join public.lead_companies co on co.id = ct.company_id
    where ct.id = v_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_contact_upsert_from_row: what the worker calls when a row finishes
-- ---------------------------------------------------------------------------
create or replace function public.lead_contact_upsert_from_row(p_row_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.lead_rows;
begin
  select * into r from public.lead_rows where id = p_row_id;
  if r.id is null or r.state <> 'done' then
    return null;
  end if;

  -- A row with a company and no person still records the company.
  if r.person_name is null and r.email is null and r.linkedin_url is null then
    perform public.lead_company_upsert(r.user_id, r.domain, r.company_name, r.logo_url, r.company_data);
    return null;
  end if;

  return public.lead_contact_merge(r.user_id, jsonb_strip_nulls(jsonb_build_object(
    'contact_id',       r.extra ->> 'contact_id',
    'person_name',      r.person_name,
    'title',            r.title,
    'linkedin_url',     r.linkedin_url,
    'company_name',     r.company_name,
    'domain',           r.domain,
    'logo_url',         r.logo_url,
    'email',            r.email,
    'email_status',     r.email_status,
    'email_checked_at', r.email_checked_at,
    'email_verifier',   r.email_verifier,
    'email_provider',   r.email_provider,
    'phone',            r.phone,
    'phone_provider',   r.phone_provider,
    'company_data',     case when r.company_data <> '{}'::jsonb then r.company_data end,
    'attributes',       case when r.extra ? 'leadsforge_id'
                             then jsonb_build_object('leadsforge_id', r.extra ->> 'leadsforge_id') end,
    'source',           case when (select kind from public.lead_runs where id = r.run_id) = 'clean'
                               and not (r.extra ? 'contact_id') then 'import' else 'run' end,
    'run_id',           r.run_id,
    'row_id',           r.id
  )));
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_contacts_merge: fold duplicates into one record the user chose
-- ---------------------------------------------------------------------------
create or replace function public.lead_contacts_merge(p_user uuid, p_keep uuid, p_drop uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k public.lead_contacts;
  d public.lead_contacts;
  n integer := 0;
begin
  select * into k from public.lead_contacts where id = p_keep and user_id = p_user for update;
  if k.id is null then
    raise exception 'keep_not_found';
  end if;

  for d in
    select * from public.lead_contacts
     where user_id = p_user and id = any(p_drop) and id <> p_keep
     for update
  loop
    update public.lead_contacts set
      person_name  = coalesce(person_name, d.person_name),
      title        = coalesce(title, d.title),
      linkedin_url = coalesce(linkedin_url, d.linkedin_url),
      linkedin_norm = coalesce(linkedin_norm, d.linkedin_norm),
      location     = coalesce(location, d.location),
      company_id   = coalesce(company_id, d.company_id),
      company_name = coalesce(company_name, d.company_name),
      domain       = coalesce(domain, d.domain),
      phone        = coalesce(phone, d.phone),
      phone_provider = case when phone is null then d.phone_provider else phone_provider end,
      -- The kept record's address wins unless it has none.
      email        = coalesce(email, d.email),
      email_norm   = coalesce(email_norm, d.email_norm),
      email_status = case when email is null then d.email_status else email_status end,
      email_checked_at = case when email is null then d.email_checked_at else email_checked_at end,
      tags         = (select array(select distinct unnest(tags || d.tags))),
      notes        = nullif(concat_ws(E'\n\n', notes, d.notes), ''),
      custom       = d.custom || custom,
      attributes   = d.attributes || attributes,
      updated_at   = now()
    where id = p_keep;

    -- List memberships move to the kept record; a duplicate membership is dropped.
    insert into public.lead_list_members (user_id, list_id, contact_id, added_at)
      select user_id, list_id, p_keep, added_at
        from public.lead_list_members
       where contact_id = d.id
      on conflict do nothing;

    delete from public.lead_contacts where id = d.id;
    n := n + 1;
  end loop;

  return n;
end;
$$;

revoke execute on function public.lead_company_upsert(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.lead_contact_merge(uuid, jsonb)                      from public, anon, authenticated;
revoke execute on function public.lead_contact_upsert_from_row(uuid)                  from public, anon, authenticated;
revoke execute on function public.lead_contacts_merge(uuid, uuid, uuid[])             from public, anon, authenticated;
grant  execute on function public.lead_company_upsert(uuid, text, text, text, jsonb) to service_role;
grant  execute on function public.lead_contact_merge(uuid, jsonb)                      to service_role;
grant  execute on function public.lead_contact_upsert_from_row(uuid)                  to service_role;
grant  execute on function public.lead_contacts_merge(uuid, uuid, uuid[])             to service_role;

-- ---------------------------------------------------------------------------
-- Backfill: every finished row into the database, oldest first
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select id from public.lead_rows where state = 'done' order by created_at, id loop
    perform public.lead_contact_upsert_from_row(r.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_companies_summary: a company with what the workspace holds at it
-- ---------------------------------------------------------------------------
-- Read by the leads function only. A view runs as its owner and would bypass
-- RLS, so it is revoked from every client role and always filtered by user_id.
create or replace view public.lead_companies_summary as
select
  co.*,
  count(ct.id)::integer                                                    as contacts,
  count(ct.id) filter (where ct.email_status = 'verified')::integer         as verified_emails,
  count(ct.id) filter (where ct.email is null)::integer                    as missing_emails,
  count(ct.id) filter (where ct.score is not null and ct.score >= 70)::integer as strong_fits,
  max(ct.score)                                                            as best_score
from public.lead_companies co
left join public.lead_contacts ct on ct.company_id = co.id
group by co.id;

revoke all on public.lead_companies_summary from public, anon, authenticated;
grant select on public.lead_companies_summary to service_role;

-- updated_at upkeep for the new tables, with the trigger function the other
-- lead_* tables already use.
do $$
declare t text;
begin
  foreach t in array array['lead_companies', 'lead_contacts', 'lead_lists', 'lead_saved_searches']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The free people search is logged to api_usage like every other provider
-- call, under its own operation, so its traffic shows in the margin views. It is
-- sold at 0 credits: the provider does not charge for it either.
-- ---------------------------------------------------------------------------
insert into public.pricing_config
  (operation, display_name, credits, provider_endpoint, provider_cost_usd, cost_source, cost_verified, enabled)
values
  ('leads.search', 'People search', 0, 'leadsforge.people.search', 0, 'catalog', false, true)
on conflict (operation) do nothing;

-- ---------------------------------------------------------------------------
-- One run per paid request
-- ---------------------------------------------------------------------------
-- Bulk actions send a request id so a double click or a retried request gets
-- the run it already started instead of a second one. The function checks for a
-- prior run first, but two requests arriving together both pass that check;
-- this index is what makes the second insert fail, and the function then
-- returns the run that won.
create unique index if not exists lead_runs_user_request_key
  on public.lead_runs (user_id, (options ->> 'request_id'))
  where options ? 'request_id';

==============================================================================
 20261119_leads_economics.sql
---------------------------------------------------------------------------

-- ============================================================================
-- Echo Leads: what a run earned, what it cost, and what each provider costs
-- ----------------------------------------------------------------------------
-- v_margin_by_operation reads api_usage, and a Leads provider call carries no
-- revenue there: Leads is charged per chunk through wallet_settle, so revenue
-- lands on credit_ledger. Read alone, that view shows every leads.* operation as
-- pure cost. These two views put the halves together.
--
--   v_leads_run_economics       one row per run
--     credits_charged            what the wallet settled
--     revenue_usd                recognised on the ledger at settle, FIFO from
--                                the grants consumed - free credits are $0
--     provider_cost_usd          the X-Treg-Cost-Micro charges recorded in
--                                api_usage for the run, discovery included
--     gross_profit_usd / gross_margin_pct
--     verified_emails, emails_found, phones_found
--     cost_per_verified_usd      provider cost / verified addresses
--     miss_cost_usd              provider cost of attempts that found nothing
--
--   v_leads_endpoint_economics  one row per provider endpoint and step
--     attempts, hits, hit_rate, provider_cost_usd, miss_cost_usd,
--     cost_per_hit_usd - the number smart order ranks on, as measured
--
-- Revenue is attributed by the run_id the worker writes into the settle
-- metadata (billing.ts). Both views are service-role only: provider cost is our
-- number, not the customer's.
-- ============================================================================

create index if not exists idx_api_usage_leads_run
  on public.api_usage ((metadata ->> 'run_id'))
  where metadata ? 'run_id';

create index if not exists idx_credit_ledger_leads_run
  on public.credit_ledger ((metadata ->> 'run_id'))
  where metadata ? 'run_id';

create or replace view public.v_leads_run_economics as
select
  r.id                                   as run_id,
  r.user_id,
  r.kind,
  r.mode,
  r.status,
  r.created_at,
  r.est_credits,
  r.max_credits,
  r.charged_credits                      as credits_charged,
  coalesce(rev.revenue_usd, 0)           as revenue_usd,
  coalesce(cost.provider_cost_usd, 0)    as provider_cost_usd,
  coalesce(rev.revenue_usd, 0) - coalesce(cost.provider_cost_usd, 0) as gross_profit_usd,
  round(100 * (coalesce(rev.revenue_usd, 0) - coalesce(cost.provider_cost_usd, 0))
        / nullif(rev.revenue_usd, 0), 1)  as gross_margin_pct,
  rows_.total_rows,
  rows_.emails_found,
  rows_.verified_emails,
  rows_.phones_found,
  round(coalesce(cost.provider_cost_usd, 0) / nullif(rows_.verified_emails, 0), 6) as cost_per_verified_usd,
  coalesce(att.miss_cost_usd, 0)         as miss_cost_usd,
  coalesce(cost.uncertain_calls, 0)      as uncertain_calls
from public.lead_runs r
left join lateral (
  select sum(l.revenue_usd) as revenue_usd
  from public.credit_ledger l
  where l.kind = 'usage' and l.metadata ->> 'run_id' = r.id::text
) rev on true
left join lateral (
  select sum(u.provider_cost_usd) as provider_cost_usd,
         count(*) filter (where u.outcome = 'uncertain') as uncertain_calls
  from public.api_usage u
  where u.metadata ->> 'run_id' = r.id::text
) cost on true
left join lateral (
  select count(*)                                                    as total_rows,
         count(*) filter (where x.email is not null)                 as emails_found,
         count(*) filter (where x.email_status = 'verified')         as verified_emails,
         count(*) filter (where x.phone is not null)                 as phones_found
  from public.lead_rows x
  where x.run_id = r.id
) rows_ on true
left join lateral (
  select sum(a.cost_usd) filter (where not a.hit) as miss_cost_usd
  from public.lead_attempts a
  where a.run_id = r.id
) att on true;

create or replace view public.v_leads_endpoint_economics as
select
  a.endpoint_id,
  a.step,
  count(*)                                              as attempts,
  count(*) filter (where a.hit)                         as hits,
  round(count(*) filter (where a.hit)::numeric / nullif(count(*), 0), 4) as hit_rate,
  coalesce(sum(a.cost_usd), 0)                          as provider_cost_usd,
  coalesce(sum(a.cost_usd) filter (where not a.hit), 0) as miss_cost_usd,
  round(coalesce(sum(a.cost_usd), 0) / nullif(count(*) filter (where a.hit), 0), 6) as cost_per_hit_usd,
  max(a.created_at)                                     as last_attempt
from public.lead_attempts a
group by a.endpoint_id, a.step;

revoke all on public.v_leads_run_economics      from public, anon, authenticated;
revoke all on public.v_leads_endpoint_economics from public, anon, authenticated;
grant select on public.v_leads_run_economics      to service_role;
grant select on public.v_leads_endpoint_economics to service_role;

comment on view public.v_leads_run_economics is
  'Per Leads run: credits charged, revenue recognised at settle, measured provider cost, margin, cost per verified lead, cost of misses.';
comment on view public.v_leads_endpoint_economics is
  'Per provider endpoint: attempts, hits, measured cost, cost of misses, cost per hit.';

==============================================================================
 20261120_lead_automations.sql
---------------------------------------------------------------------------

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
