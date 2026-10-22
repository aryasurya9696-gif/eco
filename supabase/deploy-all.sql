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

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
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

drop policy if exists "keywords_select_own" on public.keywords;
create policy "keywords_select_own"
  on public.keywords for select
  using (auth.uid() = user_id);

drop policy if exists "keywords_insert_own" on public.keywords;
create policy "keywords_insert_own"
  on public.keywords for insert
  with check (auth.uid() = user_id);

drop policy if exists "keywords_update_own" on public.keywords;
create policy "keywords_update_own"
  on public.keywords for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "keywords_delete_own" on public.keywords;
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

drop policy if exists "monitored_posts_select_own" on public.monitored_posts;
create policy "monitored_posts_select_own"
  on public.monitored_posts for select
  using (auth.uid() = user_id);

drop policy if exists "monitored_posts_insert_own" on public.monitored_posts;
create policy "monitored_posts_insert_own"
  on public.monitored_posts for insert
  with check (auth.uid() = user_id);

drop policy if exists "monitored_posts_update_own" on public.monitored_posts;
create policy "monitored_posts_update_own"
  on public.monitored_posts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "monitored_posts_delete_own" on public.monitored_posts;
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
-- SECTION 3 — Security hardening (keyword limit, profile column grants)
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
--   1. Keyword limits are enforced by a Postgres trigger, so the client cannot
--      bypass them (the flat keyword_limit() further down is the live limit).
--   2. Server-owned profile columns are protected by per-column UPDATE grants.
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
-- 2. Keyword limit (interim; replaced by keyword_limit() further down)
-- ---------------------------------------------------------------------------
create or replace function public.plan_keyword_limit(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  -- The old per-plan body read a column that no longer exists, and a
  -- LANGUAGE sql body naming it fails at create time. The flat keyword_limit()
  -- below replaces this, and the function is dropped further down.
  select 8;
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
-- 4. Column-level UPDATE grants on profiles
--    Even with the row policy in place, the client can only write the columns
--    granted here. Column privileges are enforced by Postgres before RLS runs.
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
revoke execute on function public.handle_new_user()             from public, anon, authenticated;
revoke execute on function public.set_updated_at()              from public, anon, authenticated;

grant execute on function public.enforce_keyword_limit()       to service_role;
grant execute on function public.handle_new_user()              to service_role;
grant execute on function public.set_updated_at()               to service_role;

-- plan_keyword_limit is only called from inside enforce_keyword_limit, which
-- runs as the owner, so EXECUTE is unaffected. Clients read the limit from
-- src/lib/billing.ts instead.
revoke execute on function public.plan_keyword_limit(uuid) from public, anon, authenticated;
grant  execute on function public.plan_keyword_limit(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Retired objects (mirrors 20261101_remove_billing.sql)
-- The old profile-column guard trigger read columns that no longer exist; left
-- in place it makes EVERY profile update fail. This file no longer creates it;
-- these drops remove it from databases that still have it.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_profiles_server_columns on public.profiles;
drop function if exists public.guard_profile_server_columns();
drop function if exists public.apply_subscription_plan(uuid, text, text, timestamptz);

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
-- Insert-only (M9): a re-run must never reprice or re-activate a package.
on conflict (code) do nothing;

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
-- Insert-only (M9): price, cost and enabled state change through an explicit,
-- audited UPDATE, never through a re-run of this file.
on conflict (operation) do nothing;

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
drop view if exists public.v_platform_totals;
create view public.v_platform_totals as
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
-- workspace tops up or stops searching. There is no recurring grant to switch
-- on by editing a row.
--
-- The grant is issued at unit price 0, which is the whole point of
-- credit_grants being separate rows rather than one balance. Recognising $0.05 of
-- revenue for credits that were given away is exactly the mistake that structure
-- exists to prevent, and there is a test for it.
--
-- Cost to serve (corrected, audit N7): welcome credits only pay for feed sweeps;
-- Leads and Mail reserve with p_paid_only and cannot touch them (20261127). At
-- 0.1 credit per keyword per channel, 20 credits is about 8 days of an
-- 8-keyword, 3-channel workspace, roughly $0.05 of provider cost per signup.
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

-- ==============================================================================
-- 20261107_audit_fixes.sql
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
-- The flat product caps sweep_shape() reads. Defined in 20261101, which this
-- file otherwise excludes, so they are inlined here: a LANGUAGE sql body is
-- validated at create time and would fail on a fresh project without them.
create or replace function public.keyword_limit()
returns integer
language sql
immutable
as $$ select 8; $$;

create or replace function public.channel_limit()
returns integer
language sql
immutable
as $$ select 3; $$;

revoke execute on function public.keyword_limit() from public, anon, authenticated;
revoke execute on function public.channel_limit() from public, anon, authenticated;
grant execute on function public.keyword_limit() to authenticated, service_role;
grant execute on function public.channel_limit() to authenticated, service_role;

create or replace function public.enforce_keyword_limit()
returns trigger
language plpgsql
as $fn$
declare
  v_active int;
  v_allowed int := public.keyword_limit();
begin
  if new.is_active then
    select count(*) into v_active
      from public.keywords
     where user_id = new.user_id
       and is_active = true
       and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

    if v_active >= v_allowed then
      raise exception 'keyword limit reached (% active, limit %)', v_active + 1, v_allowed
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$fn$;

revoke execute on function public.enforce_keyword_limit() from public, anon, authenticated;
drop function if exists public.plan_keyword_limit(uuid);

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


-- ============================================================================
-- SECTION 8 - Remove Leads
-- ----------------------------------------------------------------------------
-- Inlined: 20261121_remove_leads.sql
--
-- Everything above this point is the Feed, the keyword store and the credit
-- wallet. Leads used to be inlined here too; its tables, views, functions,
-- cron jobs, priced operations and two profile columns are dropped below.
-- On a fresh install each statement is a no-op, which is what keeps this file
-- safe to paste more than once.
-- ============================================================================

-- =============================================================================
-- Remove Leads
-- =============================================================================
-- Takes the Leads feature out of the database: its tables, the views built over
-- them, every function it added, the two columns it hung off `profiles`, and the
-- two cron jobs that drove its worker.
--
-- This is a DROP migration rather than a deletion of the five files that created
-- these objects. Those files are already applied to the live database, and
-- Supabase records applied migrations by version + name in
-- `supabase_migrations.schema_migrations`. Deleting them from the repository does
-- not drop anything — it just makes a fresh clone unable to build the same
-- schema the live one has. History stays; this migration is the record of what
-- was removed.
--
-- IRREVERSIBLE. Every lead_* row is deleted, and with them every email address,
-- every suppression and every run receipt the feature produced. There is no
-- down-migration and `git revert` will not bring the rows back.
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
-- into a table that is being dropped underneath it. Both calls raise if the job
-- does not exist, hence the guard.
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
-- Named explicitly. DROP TABLE would take them with it, but the automation guard
-- fires on lead_runs during the delete itself and is worth removing first.
DO $g$ BEGIN IF to_regclass('public.lead_icps') IS NOT NULL THEN EXECUTE 'DROP TRIGGER IF EXISTS lead_icps_set_updated_at ON public.lead_icps'; END IF; END $g$;
DO $g$ BEGIN IF to_regclass('public.lead_runs') IS NOT NULL THEN EXECUTE 'DROP TRIGGER IF EXISTS lead_runs_set_updated_at ON public.lead_runs'; END IF; END $g$;
DO $g$ BEGIN IF to_regclass('public.lead_rows') IS NOT NULL THEN EXECUTE 'DROP TRIGGER IF EXISTS lead_rows_set_updated_at ON public.lead_rows'; END IF; END $g$;
DO $g$ BEGIN IF to_regclass('public.lead_waterfall_orders') IS NOT NULL THEN EXECUTE 'DROP TRIGGER IF EXISTS lead_waterfall_orders_set_updated_at ON public.lead_waterfall_orders'; END IF; END $g$;
DO $g$ BEGIN IF to_regclass('public.lead_automations') IS NOT NULL THEN EXECUTE 'DROP TRIGGER IF EXISTS lead_automations_set_updated_at ON public.lead_automations'; END IF; END $g$;
DO $g$ BEGIN IF to_regclass('public.lead_runs') IS NOT NULL THEN EXECUTE 'DROP TRIGGER IF EXISTS lead_runs_automation_guard ON public.lead_runs'; END IF; END $g$;

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
-- leads.search.extra_50 belongs to the current Leads feature (20261123) and is
-- excluded, or every re-run would delete it and re-seed it enabled (M9).
DELETE FROM public.pricing_config
 WHERE operation LIKE 'leads.%' AND operation <> 'leads.search.extra_50';

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

-- ==============================================================================
-- 20261122_user_leads.sql
---------------------------------------------------------------------------

-- =============================================================================
-- Migration: 20261122_user_leads.sql
-- Description: B2B Leads Discovery & Contact Intelligence table and pricing
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    first_name TEXT,
    last_name TEXT,
    full_name TEXT NOT NULL,
    title TEXT,
    company_name TEXT,
    company_domain TEXT,
    company_size TEXT,
    company_revenue TEXT,
    company_phone TEXT,
    linkedin_url TEXT,
    work_email TEXT,
    email_status TEXT, -- 'valid', 'accept_all', 'risky', 'invalid'
    email_confidence NUMERIC,
    phone_number TEXT,
    phone_type TEXT, -- 'mobile', 'landline'
    location TEXT,
    status TEXT NOT NULL DEFAULT 'new', -- 'new', 'contacted', 'replied', 'dismissed'
    notes TEXT,
    raw JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_lead_contact UNIQUE (user_id, company_domain, full_name)
);

CREATE INDEX IF NOT EXISTS idx_user_leads_user_id ON public.user_leads(user_id);
CREATE INDEX IF NOT EXISTS idx_user_leads_created_at ON public.user_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_leads_status ON public.user_leads(user_id, status);

ALTER TABLE public.user_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own leads" ON public.user_leads;
CREATE POLICY "Users can manage own leads" ON public.user_leads
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Pricing entries for Leads
INSERT INTO public.pricing_config (
    operation, display_name, provider_endpoint, provider_cost_usd, 
    cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
)
VALUES 
    ('treg.people.search', 'B2B People Search', 'treg.people.search', 0.00049500, true, 'catalog', 0.000000, true, 1, now(), now()),
    ('treg.people.email.find', 'Work Email Reveal', 'treg.people.email.find', 0.00483400, true, 'catalog', 1.000000, true, 1, now(), now()),
    ('treg.people.phone.find', 'Direct Mobile Reveal', 'treg.people.phone.find', 0.02000000, true, 'catalog', 2.000000, true, 1, now(), now())
-- Insert-only (M9).
ON CONFLICT (operation) DO NOTHING;

-- ==============================================================================
-- 20261123_leads_search_pricing.sql
---------------------------------------------------------------------------

-- =============================================================================
-- Migration: 20261123_leads_search_pricing.sql
-- Description: Leads pricing: pay only for verified contacts.
--
-- A search is not charged by itself, but it requires a credit balance: every
-- lead it returns is checked for a verified work email (1 credit, charged only
-- when the verifier says `valid`) and a direct phone (2 credits, only when
-- found). Treg bills treg.people.search per call ($0-0.30; the leads function
-- caps it at $0.05 per call), which those per-contact charges cover.
--
-- `leads.search.extra_50` is kept at 0 credits so a per-lead search fee can be
-- switched on later as a data change, without a deploy.
--
-- Backward-compatible: rows only, no schema change. Also fixes the 20261122
-- upsert, which never wrote provider_cost_usd on conflict.
-- =============================================================================

INSERT INTO public.pricing_config (
    operation, display_name, provider_endpoint, provider_cost_usd,
    cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
)
VALUES
    ('treg.people.search', 'People search', 'treg.people.search', 0.05000000, true, 'catalog', 0.000000, true, 2, now(), now()),
    ('leads.search.extra_50', 'People search: per-50-leads fee (off)', 'treg.people.search', 0.05000000, true, 'catalog', 0.000000, true, 1, now(), now()),
    ('treg.people.email.find', 'Verified Work Email', 'treg.people.email.find', 0.04000000, true, 'catalog', 1.000000, true, 2, now(), now()),
    ('treg.people.phone.find', 'Direct Mobile Reveal', 'treg.people.phone.find', 0.08000000, true, 'catalog', 2.000000, true, 2, now(), now())
-- Insert-only (M9). Current prices and costs are set once by 20261127.
ON CONFLICT (operation) DO NOTHING;

-- ==============================================================================
-- 20261124_audit_fixes.sql
---------------------------------------------------------------------------

-- ============================================================================
-- Audit fixes (October 2026)
-- ----------------------------------------------------------------------------
-- 1. Margin views were readable by anon/authenticated (owner-rights views
--    bypass RLS). Revoked, and switched to security_invoker.
-- 2. pricing_config exposed provider cost to every client. No client reads it
--    directly (the functions use the service role), so it is service-only now.
-- 3. Durable rate limits. The in-memory per-isolate buckets reset on every cold
--    start, and the leads limiter counted rows written after the work. One
--    atomic RPC replaces both.
-- 4. Top-ups are checked against what was actually paid.
-- 5. Partial refunds revoke a share, not the whole order; disputes freeze.
-- 6. wallet_revoke_grant could push reserved above balance.
-- 7. The stale-hold reaper settles what was billed, not the worst case.
-- 8. user_leads: clients may read, delete, and edit status/notes only.
-- 9. Channel constraint matches the product (news, not linkedin).
-- 10. Retention for rate-limit rows and webhook payloads.
-- Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Margin views
-- ---------------------------------------------------------------------------
do $$
declare v text;
begin
  foreach v in array array['v_margin_by_operation','v_margin_by_user','v_platform_totals',
                           'v_treg_reconciliation','v_stale_reservations'] loop
    if to_regclass('public.' || v) is not null then
      execute format('alter view public.%I set (security_invoker = true)', v);
      execute format('revoke all on public.%I from public, anon, authenticated', v);
      execute format('grant select on public.%I to service_role', v);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. pricing_config is service-only
-- ---------------------------------------------------------------------------
drop policy if exists pricing_config_select_all on public.pricing_config;
revoke all on public.pricing_config from anon, authenticated;
revoke all on public.pricing_audit  from anon, authenticated;
revoke all on public.webhook_events from anon, authenticated;
revoke all on public.service_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Durable rate limits
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_hits (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  bucket     text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_rate_limit_hits_lookup
  on public.rate_limit_hits(user_id, bucket, created_at desc);
alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from anon, authenticated;

-- Takes one slot if the user is under p_limit hits in the window. The advisory
-- lock serialises concurrent callers for the same (user, bucket), so a burst of
-- parallel requests cannot all read the same count and all pass.
create or replace function public.take_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_limit int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count int;
begin
  if p_user_id is null or p_bucket is null or p_limit <= 0 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_bucket, 0));

  select count(*) into v_count
    from public.rate_limit_hits
   where user_id = p_user_id
     and bucket = p_bucket
     and created_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.rate_limit_hits (user_id, bucket) values (p_user_id, p_bucket);
  return true;
end;
$fn$;

revoke execute on function public.take_rate_limit(uuid, text, int, int) from public, anon, authenticated;
grant  execute on function public.take_rate_limit(uuid, text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 4 + 5. Order statuses, paid-amount check
-- ---------------------------------------------------------------------------
alter table public.payment_orders drop constraint if exists payment_orders_status_check;
alter table public.payment_orders add constraint payment_orders_status_check
  check (status in ('created', 'pending', 'succeeded', 'failed', 'refunded',
                    'partially_refunded', 'disputed', 'review'));

alter table public.payment_orders add column if not exists paid_amount_usd numeric(20,6);
alter table public.payment_orders add column if not exists refunded_usd numeric(20,6) not null default 0;
alter table public.payment_orders add column if not exists review_reason text;

drop function if exists public.wallet_topup_from_order(uuid, numeric, numeric, text, text);

create or replace function public.wallet_topup_from_order(
  p_order_id        uuid,
  p_fee_usd         numeric default null,
  p_net_usd         numeric default null,
  p_provider_ref    text    default null,
  p_idempotency_key text    default null,
  p_paid_usd        numeric default null,
  p_paid_currency   text    default null
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

  -- What was paid must be what the order was for. A coupon, a cheaper product,
  -- or a different currency is parked for a human instead of granting the full
  -- package. Taxes can only add to the total, so paying more is accepted.
  if p_paid_currency is not null and upper(p_paid_currency) <> upper(v_order.currency) then
    update public.payment_orders
       set status = 'review', review_reason = 'currency_mismatch: ' || p_paid_currency,
           paid_amount_usd = p_paid_usd, provider_ref = coalesce(p_provider_ref, provider_ref)
     where id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'currency_mismatch');
  end if;

  if p_paid_usd is null or p_paid_usd + 0.005 < v_order.gross_usd then
    update public.payment_orders
       set status = 'review',
           review_reason = 'amount_mismatch: paid ' || coalesce(p_paid_usd::text, 'unknown')
                           || ' expected ' || v_order.gross_usd::text,
           paid_amount_usd = p_paid_usd, provider_ref = coalesce(p_provider_ref, provider_ref)
     where id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'amount_mismatch');
  end if;

  v_credits := v_pkg.credits + v_pkg.bonus_credits;
  if v_credits <= 0 then
    return jsonb_build_object('ok', false, 'error', 'package_has_no_credits');
  end if;

  v_unit := case
              when p_net_usd      is not null then p_net_usd / v_credits
              when v_order.net_usd is not null then v_order.net_usd / v_credits
              else v_order.gross_usd / v_credits
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
    perform public.wallet_apply_grant(
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
         paid_amount_usd = p_paid_usd,
         fee_usd         = coalesce(p_fee_usd, fee_usd),
         net_usd         = coalesce(p_net_usd, net_usd),
         provider_ref    = coalesce(p_provider_ref, provider_ref),
         review_reason   = null,
         settled_at      = now()
   where id = p_order_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'order_id', p_order_id,
    'credits_granted', v_credits,
    'unit_price_usd', v_unit,
    'balance_after', v_result->'balance_after'
  );
end;
$fn$;

revoke execute on function public.wallet_topup_from_order(uuid, numeric, numeric, text, text, numeric, text)
  from public, anon, authenticated;
grant  execute on function public.wallet_topup_from_order(uuid, numeric, numeric, text, text, numeric, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5 + 6. Revoke: optional partial amount, never below what is on hold
-- ---------------------------------------------------------------------------
drop function if exists public.wallet_revoke_grant(uuid, text);

create or replace function public.wallet_revoke_grant(
  p_grant_id uuid,
  p_reason   text    default 'refund',
  p_credits  numeric default null
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
begin
  select * into v_grant from public.credit_grants where id = p_grant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;

  if v_grant.credits_remaining <= 0 then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'already_fully_spent');
  end if;

  select * into v_wallet from public.wallet where user_id = v_grant.user_id for update;

  -- Only the spendable part of the balance can be taken: credits on hold belong
  -- to an in-flight job, and taking them would leave reserved > balance.
  v_take := least(
    v_grant.credits_remaining,
    greatest(v_wallet.balance - v_wallet.reserved, 0),
    coalesce(greatest(p_credits, 0), v_grant.credits_remaining)
  );

  if v_take <= 0 then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'nothing_spendable');
  end if;

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
  );

  return jsonb_build_object(
    'ok', true,
    'revoked', v_take,
    'unrevokable', v_grant.credits_remaining - v_take,
    'balance_after', v_new_bal
  );
end;
$fn$;

revoke execute on function public.wallet_revoke_grant(uuid, text, numeric) from public, anon, authenticated;
grant  execute on function public.wallet_revoke_grant(uuid, text, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Reaper settles what was billed
-- ---------------------------------------------------------------------------
create or replace function public.reap_stale_reservations(p_older_than interval default '1 hour')
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_res      record;
  v_cost     numeric := 0;
  v_credits  numeric := 0;
  v_settled  int := 0;
  v_released int := 0;
  v_out      jsonb;
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
    select coalesce(sum(provider_cost_usd), 0), coalesce(sum(credits_charged), 0)
      into v_cost, v_credits
      from public.api_usage
     where reservation_id = v_res.id;

    if v_credits > 0 then
      v_out := public.wallet_settle(
        v_res.id,
        least(v_credits, v_res.credits_held),
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

  return jsonb_build_object('settled', v_settled, 'released', v_released,
                            'total', v_settled + v_released);
end;
$fn$;

revoke execute on function public.reap_stale_reservations(interval) from public, anon, authenticated;
grant  execute on function public.reap_stale_reservations(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 8. user_leads: written only by the leads function
-- ---------------------------------------------------------------------------
update public.user_leads set company_domain = '' where company_domain is null;
alter table public.user_leads alter column company_domain set default '';
alter table public.user_leads alter column company_domain set not null;

update public.user_leads set status = 'new'
 where status not in ('new', 'contacted', 'replied', 'dismissed');
alter table public.user_leads drop constraint if exists user_leads_status_check;
alter table public.user_leads add constraint user_leads_status_check
  check (status in ('new', 'contacted', 'replied', 'dismissed'));
alter table public.user_leads drop constraint if exists user_leads_notes_length;
alter table public.user_leads add constraint user_leads_notes_length
  check (notes is null or length(notes) <= 2000);

drop policy if exists "Users can manage own leads" on public.user_leads;
drop policy if exists user_leads_select_own on public.user_leads;
drop policy if exists user_leads_update_own on public.user_leads;
drop policy if exists user_leads_delete_own on public.user_leads;

create policy user_leads_select_own on public.user_leads
  for select to authenticated using ((select auth.uid()) = user_id);
create policy user_leads_update_own on public.user_leads
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy user_leads_delete_own on public.user_leads
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.user_leads from anon, authenticated;
grant select, delete on public.user_leads to authenticated;
grant update (status, notes) on public.user_leads to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Channels the product actually sells
-- ---------------------------------------------------------------------------
update public.profiles
   set enabled_channels = array(
         select c from unnest(enabled_channels) c
          where c in ('twitter', 'reddit', 'google', 'news'))
 where not enabled_channels <@ array['twitter', 'reddit', 'google', 'news']::text[];
update public.profiles
   set enabled_channels = array['twitter', 'reddit', 'google']::text[]
 where coalesce(array_length(enabled_channels, 1), 0) = 0;

alter table public.profiles drop constraint if exists profiles_enabled_channels_supported;
alter table public.profiles add constraint profiles_enabled_channels_supported
  check (enabled_channels <@ array['twitter', 'reddit', 'google', 'news']::text[]);

-- ---------------------------------------------------------------------------
-- 10. Lead search is priced, AI is metered by rate limit
-- ---------------------------------------------------------------------------
-- A people search fans out to several billed provider calls; it now costs one
-- credit per search. Change the number here, not in code.
update public.pricing_config
   set credits = 1, display_name = 'People search', version = version + 1,
       effective_from = now(), updated_at = now()
 where operation = 'treg.people.search' and credits = 0
   -- One-off: skipped on a re-run once 20261127 has recorded its data changes.
   and to_regclass('public.data_migrations') is null;

-- ---------------------------------------------------------------------------
-- 11. Retention
-- ---------------------------------------------------------------------------
create or replace function public.purge_retention()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limit_hits where created_at < now() - interval '2 days';
  update public.webhook_events set payload = '{}'::jsonb
   where received_at < now() - interval '180 days' and payload <> '{}'::jsonb;
$$;

revoke execute on function public.purge_retention() from public, anon, authenticated;
grant  execute on function public.purge_retention() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'echo-retention';
    perform cron.schedule('echo-retention', '17 3 * * *', 'select public.purge_retention();');
  end if;
end $$;

-- ==============================================================================
--  20261125_mail.sql
-- ---------------------------------------------------------------------------

-- ============================================================================
-- Migration: 20261125_mail.sql
-- Description: Echo Mail — domains, mailboxes, threads and messages.
--
-- Every write that matters goes through the `mail` edge function (service
-- role): connecting a mailbox, sending, saving drafts, adding and verifying a
-- domain. The client reads its own rows under RLS and may only change the
-- per-thread view state (folder, star, unread) and delete its own threads.
--
-- Sending:
--   hosted       mailbox on a domain verified with Resend; sent via Resend.
--   app_password Gmail / Zoho / custom SMTP; sent over SMTPS (port 465).
--                The password lives in Supabase Vault. The mailbox row keeps
--                only the vault secret id, and that column is not readable by
--                the client.
--
-- Credits: mail.send.hosted / mail.send.connected in pricing_config, charged
-- per sent message through wallet_reserve / wallet_settle, the same two-phase
-- path the Leads feature uses. A send that fails is released, not charged.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Domains
-- ---------------------------------------------------------------------------
create table if not exists public.mail_domains (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  domain              text not null,
  status              text not null default 'pending'
                        check (status in ('pending', 'verifying', 'verified', 'failed', 'suspended')),
  provider            text not null default 'resend'
                        check (provider in ('resend', 'ses', 'brevo', 'custom')),
  -- Resend's domain id. Needed to trigger verification and to delete it.
  provider_domain_id  text,
  dkim_tokens         jsonb not null default '[]'::jsonb,
  dns_records         jsonb not null default '[]'::jsonb,
  inbound_provider    text not null default 'none'
                        check (inbound_provider in ('cloudflare', 'ses', 'none')),
  verified_at         timestamptz,
  last_checked_at     timestamptz,
  created_at          timestamptz not null default now()
);

-- One Echo account per domain. Resend keys domains account-wide, so a second
-- workspace adding the same domain would collide there anyway; refusing it here
-- also stops one workspace sending as another's verified domain.
create unique index if not exists uq_mail_domains_domain on public.mail_domains (lower(domain));
create index if not exists idx_mail_domains_user_id on public.mail_domains (user_id);

-- ---------------------------------------------------------------------------
-- 2. Mailboxes
-- ---------------------------------------------------------------------------
create table if not exists public.mailboxes (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  kind              text not null check (kind in ('hosted', 'app_password', 'oauth_send')),
  provider          text not null default 'custom'
                      check (provider in ('google', 'microsoft', 'zoho', 'resend', 'ses', 'brevo', 'custom')),
  address           text not null,
  display_name      text not null,
  domain_id         uuid references public.mail_domains(id) on delete set null,
  status            text not null default 'active'
                      check (status in ('active', 'paused', 'needs_reauth', 'disabled')),
  pause_reason      text,

  -- app_password only. Server-side columns: not granted to the client.
  smtp_host         text,
  smtp_port         int not null default 465,
  smtp_user         text,
  vault_secret_id   uuid,

  daily_send_limit  int not null default 40 check (daily_send_limit >= 0),
  sent_today        int not null default 0 check (sent_today >= 0),
  -- sent_today counts sends on this (UTC) date; a stale date means zero.
  sent_today_date   date not null default current_date,

  is_default        boolean not null default false,
  created_at        timestamptz not null default now(),
  constraint uq_mailboxes_user_address unique (user_id, address)
);

create index if not exists idx_mailboxes_user_id on public.mailboxes (user_id);

-- ---------------------------------------------------------------------------
-- 3. Threads
-- ---------------------------------------------------------------------------
create table if not exists public.mail_threads (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  mailbox_id       uuid not null references public.mailboxes(id) on delete cascade,
  lead_id          uuid references public.user_leads(id) on delete set null,
  lead_name        text,
  lead_company     text,
  subject          text not null default '',
  snippet          text not null default '',
  participants     jsonb not null default '[]'::jsonb,
  folder           text not null default 'inbox'
                     check (folder in ('inbox', 'sent', 'drafts', 'archive', 'trash', 'spam')),
  unread_count     int not null default 0 check (unread_count >= 0),
  starred          boolean not null default false,
  has_attachments  boolean not null default false,
  last_message_at  timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index if not exists idx_mail_threads_user_last
  on public.mail_threads (user_id, last_message_at desc);
create index if not exists idx_mail_threads_mailbox on public.mail_threads (mailbox_id);
create index if not exists idx_mail_threads_lead_id on public.mail_threads (lead_id) where lead_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Messages
-- ---------------------------------------------------------------------------
create table if not exists public.mail_messages (
  id                   uuid primary key default gen_random_uuid(),
  thread_id            uuid not null references public.mail_threads(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  mailbox_id           uuid not null references public.mailboxes(id) on delete cascade,
  lead_id              uuid references public.user_leads(id) on delete set null,
  direction            text not null check (direction in ('in', 'out')),
  status               text not null default 'sent'
                         check (status in ('draft', 'queued', 'sending', 'sent', 'delivered',
                                           'bounced', 'complained', 'failed', 'received')),
  is_auto_reply        boolean not null default false,
  from_addr            text not null,
  to_addrs             jsonb not null default '[]'::jsonb,
  cc_addrs             jsonb not null default '[]'::jsonb,
  bcc_addrs            jsonb not null default '[]'::jsonb,
  subject              text not null default '',
  snippet              text not null default '',
  text_body            text not null default '',
  html_body            text not null default '',
  message_id_header    text,
  in_reply_to          text,
  references_hdr       text,
  provider_message_id  text,
  credits_charged      numeric(20,6) not null default 0,
  error_message        text,
  sent_at              timestamptz,
  received_at          timestamptz,
  read_at              timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists idx_mail_messages_thread on public.mail_messages (thread_id, created_at);
create unique index if not exists uq_mail_messages_message_id_header
  on public.mail_messages (message_id_header) where message_id_header is not null;

-- ---------------------------------------------------------------------------
-- 5. Attachments (read-only for now; nothing writes them yet)
-- ---------------------------------------------------------------------------
create table if not exists public.mail_attachments (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid not null references public.mail_messages(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  filename      text not null,
  content_type  text not null,
  size_bytes    bigint not null,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_mail_attachments_message on public.mail_attachments (message_id);

-- ---------------------------------------------------------------------------
-- 6. RLS and grants
-- ---------------------------------------------------------------------------
alter table public.mail_domains     enable row level security;
alter table public.mailboxes        enable row level security;
alter table public.mail_threads     enable row level security;
alter table public.mail_messages    enable row level security;
alter table public.mail_attachments enable row level security;

revoke all on public.mail_domains, public.mailboxes, public.mail_threads,
              public.mail_messages, public.mail_attachments from anon, authenticated;

-- Column-level select on mailboxes: the SMTP login and vault id stay server-side.
grant select (id, user_id, kind, provider, address, display_name, domain_id, status,
              pause_reason, daily_send_limit, sent_today, sent_today_date, is_default, created_at)
  on public.mailboxes to authenticated;

grant select (id, user_id, domain, status, provider, dkim_tokens, dns_records,
              inbound_provider, verified_at, last_checked_at, created_at)
  on public.mail_domains to authenticated;

grant select on public.mail_threads, public.mail_messages, public.mail_attachments to authenticated;

-- The thread list's own view state is the only thing the client may change.
grant update (folder, starred, unread_count) on public.mail_threads to authenticated;
grant delete on public.mail_threads to authenticated;

drop policy if exists mail_domains_select_own on public.mail_domains;
create policy mail_domains_select_own on public.mail_domains
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists mailboxes_select_own on public.mailboxes;
create policy mailboxes_select_own on public.mailboxes
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists mail_threads_select_own on public.mail_threads;
create policy mail_threads_select_own on public.mail_threads
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists mail_threads_update_own on public.mail_threads;
create policy mail_threads_update_own on public.mail_threads
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists mail_threads_delete_own on public.mail_threads;
create policy mail_threads_delete_own on public.mail_threads
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists mail_messages_select_own on public.mail_messages;
create policy mail_messages_select_own on public.mail_messages
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists mail_attachments_select_own on public.mail_attachments;
create policy mail_attachments_select_own on public.mail_attachments
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 7. Daily send limit
-- Atomic take/return of one send slot. The row lock serialises concurrent
-- sends from the same mailbox, so two parallel requests cannot both pass a
-- limit that has room for one.
-- ---------------------------------------------------------------------------
create or replace function public.mail_take_send_slot(p_mailbox_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_mb public.mailboxes%rowtype;
  v_sent int;
begin
  select * into v_mb from public.mailboxes
   where id = p_mailbox_id and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'mailbox_not_found');
  end if;

  v_sent := case when v_mb.sent_today_date = current_date then v_mb.sent_today else 0 end;

  if v_sent >= v_mb.daily_send_limit then
    return jsonb_build_object('ok', false, 'error', 'daily_limit',
                              'sent_today', v_sent, 'daily_send_limit', v_mb.daily_send_limit);
  end if;

  update public.mailboxes
     set sent_today = v_sent + 1, sent_today_date = current_date
   where id = p_mailbox_id;

  return jsonb_build_object('ok', true, 'sent_today', v_sent + 1, 'daily_send_limit', v_mb.daily_send_limit);
end;
$fn$;

create or replace function public.mail_return_send_slot(p_mailbox_id uuid, p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $fn$
  update public.mailboxes
     set sent_today = greatest(sent_today - 1, 0)
   where id = p_mailbox_id and user_id = p_user_id and sent_today_date = current_date;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Vault helpers for app passwords (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.store_mailbox_secret(p_secret text, p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $fn$
begin
  return vault.create_secret(p_secret, p_name, 'Echo Mail app password');
end;
$fn$;

create or replace function public.get_mailbox_secret(p_secret_id uuid)
returns text
language sql
security definer
set search_path = public, vault
as $fn$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$fn$;

create or replace function public.delete_mailbox_secret(p_secret_id uuid)
returns void
language sql
security definer
set search_path = public, vault
as $fn$
  delete from vault.secrets where id = p_secret_id;
$fn$;

-- A disconnected mailbox takes its password with it, whichever path deleted it
-- (the edge function, a user cascade, or SQL by hand).
create or replace function public.mailboxes_drop_secret()
returns trigger
language plpgsql
security definer
set search_path = public, vault
as $fn$
begin
  if old.vault_secret_id is not null then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return old;
end;
$fn$;

drop trigger if exists trg_mailboxes_drop_secret on public.mailboxes;
create trigger trg_mailboxes_drop_secret
  after delete on public.mailboxes
  for each row execute function public.mailboxes_drop_secret();

revoke all on function public.mail_take_send_slot(uuid, uuid)   from public, anon, authenticated;
revoke all on function public.mail_return_send_slot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.store_mailbox_secret(text, text)  from public, anon, authenticated;
revoke all on function public.get_mailbox_secret(uuid)          from public, anon, authenticated;
revoke all on function public.delete_mailbox_secret(uuid)       from public, anon, authenticated;
revoke all on function public.mailboxes_drop_secret()           from public, anon, authenticated;
grant execute on function public.mail_take_send_slot(uuid, uuid)   to service_role;
grant execute on function public.mail_return_send_slot(uuid, uuid) to service_role;
grant execute on function public.store_mailbox_secret(text, text)  to service_role;
grant execute on function public.get_mailbox_secret(uuid)          to service_role;
grant execute on function public.delete_mailbox_secret(uuid)       to service_role;

-- ---------------------------------------------------------------------------
-- 9. Pricing
-- Resend Pro is $20 per 50,000 emails ($0.0004 each). Connected mailboxes send
-- through the user's own provider, so the provider cost is zero.
-- ---------------------------------------------------------------------------
insert into public.pricing_config (
  operation, display_name, provider_endpoint, provider_cost_usd,
  cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
)
values
  ('mail.send.hosted', 'Email send (Echo hosted)', 'resend.emails.send', 0.00040000,
   true, 'rate_card', 0.100000, true, 1, now(), now()),
  ('mail.send.connected', 'Email send (connected mailbox)', 'smtp', 0.00000000,
   true, 'rate_card', 0.050000, true, 1, now(), now())
-- Insert-only (M9): re-running must not re-enable a disabled send price.
on conflict (operation) do nothing;

-- ==============================================================================
--  20261126_billing_integrity.sql
-- ---------------------------------------------------------------------------

-- ============================================================================
-- Migration: 20261126_billing_integrity.sql
-- Description: A paid order grants its credits once, whatever happens after.
--
-- 1. Replay of a refunded or disputed order re-granted the package.
--    The only duplicate check was `status = 'succeeded' and credits_granted > 0`.
--    A refund or dispute moves the order out of 'succeeded', and the webhook
--    passed a per-delivery ledger key (dodo:<webhook id>), so a later
--    payment.succeeded with a new webhook id granted the full package again and
--    flipped the order back to 'succeeded'.
--    Now: any order that has ever been granted (credits_granted > 0, or a topup
--    grant row pointing at it) is a duplicate, and an order that is refunded,
--    partially refunded or disputed is never granted. The grant's ledger key is
--    per ORDER ('topup:<order id>'), so even a bypassed status check collides on
--    credit_ledger.idempotency_key instead of granting twice. The caller's key
--    is kept in the grant metadata for tracing.
--
-- 2. Revenue under-recognised when a package carries a bonus.
--    The unit price was net / (credits + bonus), but only `credits` were granted
--    at that price (the bonus is its own zero-price grant), so recognised revenue
--    came out below the cash received. The paid grant now carries net / credits.
--    Latent today: every package has bonus_credits = 0.
--
-- Same signature as 20261124, so the webhook needs no change. Idempotent.
-- ============================================================================

create or replace function public.wallet_topup_from_order(
  p_order_id        uuid,
  p_fee_usd         numeric default null,
  p_net_usd         numeric default null,
  p_provider_ref    text    default null,
  p_idempotency_key text    default null,
  p_paid_usd        numeric default null,
  p_paid_currency   text    default null
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
  v_credits  numeric;
  v_key      text;
begin
  -- The row lock serialises concurrent deliveries for one order: the second one
  -- waits here and then sees credits_granted set by the first.
  select * into v_order from public.payment_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  -- Granted once means granted. Status is not the test: a refund or dispute
  -- changes the status but not the fact that the credits already went out.
  if v_order.credits_granted > 0
     or exists (select 1 from public.credit_grants
                 where payment_order_id = p_order_id and source = 'topup') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', p_order_id);
  end if;

  -- Money that has been (or is being) returned never buys credits, including a
  -- refund or dispute that arrived before the payment event.
  if v_order.status in ('refunded', 'partially_refunded', 'disputed') then
    return jsonb_build_object('ok', false, 'error', 'order_not_grantable', 'status', v_order.status);
  end if;

  select * into v_pkg from public.topup_packages where code = v_order.package_code;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'package_not_found');
  end if;

  -- What was paid must be what the order was for. A coupon, a cheaper product,
  -- or a different currency is parked for a human instead of granting the full
  -- package. Taxes can only add to the total, so paying more is accepted.
  if p_paid_currency is not null and upper(p_paid_currency) <> upper(v_order.currency) then
    update public.payment_orders
       set status = 'review', review_reason = 'currency_mismatch: ' || p_paid_currency,
           paid_amount_usd = p_paid_usd, provider_ref = coalesce(p_provider_ref, provider_ref)
     where id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'currency_mismatch');
  end if;

  if p_paid_usd is null or p_paid_usd + 0.005 < v_order.gross_usd then
    update public.payment_orders
       set status = 'review',
           review_reason = 'amount_mismatch: paid ' || coalesce(p_paid_usd::text, 'unknown')
                           || ' expected ' || v_order.gross_usd::text,
           paid_amount_usd = p_paid_usd, provider_ref = coalesce(p_provider_ref, provider_ref)
     where id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'amount_mismatch');
  end if;

  v_credits := v_pkg.credits + v_pkg.bonus_credits;
  if v_pkg.credits <= 0 then
    return jsonb_build_object('ok', false, 'error', 'package_has_no_credits');
  end if;

  -- Revenue per PAID credit. The bonus is a separate zero-price grant, so the
  -- paid credits alone carry the whole net amount.
  v_unit := case
              when p_net_usd      is not null then p_net_usd / v_pkg.credits
              when v_order.net_usd is not null then v_order.net_usd / v_pkg.credits
              else v_order.gross_usd / v_pkg.credits
            end;
  v_unit := greatest(v_unit, 0);

  v_key := 'topup:' || p_order_id::text;

  v_result := public.wallet_apply_grant(
    p_user_id          => v_order.user_id,
    p_credits          => v_pkg.credits,
    p_source           => 'topup',
    p_unit_price_usd   => v_unit,
    p_payment_order_id => p_order_id,
    p_idempotency_key  => v_key,
    p_metadata         => jsonb_build_object('package', v_order.package_code,
                                             'event_key', p_idempotency_key)
  );

  if v_pkg.bonus_credits > 0 then
    perform public.wallet_apply_grant(
      p_user_id          => v_order.user_id,
      p_credits          => v_pkg.bonus_credits,
      p_source           => 'bonus',
      p_unit_price_usd   => 0,
      p_payment_order_id => p_order_id,
      p_idempotency_key  => v_key || ':bonus',
      p_metadata         => jsonb_build_object('package', v_order.package_code,
                                               'event_key', p_idempotency_key)
    );
  end if;

  update public.payment_orders
     set status          = 'succeeded',
         credits_granted = v_credits,
         paid_amount_usd = p_paid_usd,
         fee_usd         = coalesce(p_fee_usd, fee_usd),
         net_usd         = coalesce(p_net_usd, net_usd),
         provider_ref    = coalesce(p_provider_ref, provider_ref),
         review_reason   = null,
         settled_at      = now()
   where id = p_order_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'order_id', p_order_id,
    'credits_granted', v_credits,
    'unit_price_usd', v_unit,
    'balance_after', v_result->'balance_after'
  );
end;
$fn$;

revoke execute on function public.wallet_topup_from_order(uuid, numeric, numeric, text, text, numeric, text)
  from public, anon, authenticated;
grant  execute on function public.wallet_topup_from_order(uuid, numeric, numeric, text, text, numeric, text)
  to service_role;

-- ============================================================================
-- 3. A full revoke revoked nothing.
--    wallet_revoke_grant(p_credits => null) is how the webhook takes back every
--    spendable credit when a dispute opens or is lost. The cap was written as
--    coalesce(greatest(p_credits, 0), credits_remaining); greatest() skips NULLs,
--    so it returned 0, coalesce kept the 0, and the function answered
--    `nothing_spendable`. Chargebacks left every credit in the wallet. Refunds
--    were unaffected because they always pass an amount.
--    Same signature as 20261124; only the cap changes.
-- ============================================================================

create or replace function public.wallet_revoke_grant(
  p_grant_id uuid,
  p_reason   text    default 'refund',
  p_credits  numeric default null
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
begin
  select * into v_grant from public.credit_grants where id = p_grant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;

  if v_grant.credits_remaining <= 0 then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'already_fully_spent');
  end if;

  select * into v_wallet from public.wallet where user_id = v_grant.user_id for update;

  -- Only the spendable part of the balance can be taken: credits on hold belong
  -- to an in-flight job, and taking them would leave reserved > balance.
  v_take := least(
    v_grant.credits_remaining,
    greatest(v_wallet.balance - v_wallet.reserved, 0),
    -- NULL means "all of it". This was coalesce(greatest(p_credits, 0), ...),
    -- but greatest() ignores NULLs, so a NULL became 0 before coalesce saw it.
    case when p_credits is null then v_grant.credits_remaining else greatest(p_credits, 0) end
  );

  if v_take <= 0 then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'nothing_spendable');
  end if;

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
  );

  return jsonb_build_object(
    'ok', true,
    'revoked', v_take,
    'unrevokable', v_grant.credits_remaining - v_take,
    'balance_after', v_new_bal
  );
end;
$fn$;

revoke execute on function public.wallet_revoke_grant(uuid, text, numeric) from public, anon, authenticated;
grant  execute on function public.wallet_revoke_grant(uuid, text, numeric) to service_role;

-- ===========================================================================
-- 20261127_audit_round2.sql
-- ------------------------------------------------------------------------

-- ============================================================================
-- Migration: 20261127_audit_round2.sql
-- Description: Audit round 2 (docs/audit/AUDIT-2026-10.md, sections D, E, H).
--
--  1. Paid-only reserves (owner decision: welcome credits are for feed sweeps
--     only). wallet_reserve gains p_paid_only; the flag is stored on the hold
--     and wallet_settle then draws only purchased grants for it. Ordinary holds
--     draw welcome credits first, so paid credits stay available for Leads and
--     Mail. N7 comment corrected.
--  2. M7: reserve counts only unexpired grants, the same set settle draws.
--  3. H7: refunds and disputes are one atomic SQL call each. Revokes carry a
--     unique ledger key (refund:<order>:<refund id>), every refund is recorded
--     once per (order, refund id), a refund in another currency is parked in
--     'review', and a webhook delivery is claimed under a row lock so a
--     parallel redelivery cannot be processed twice.
--  4. Reaper: settles stale holds from api_usage.reservation_id sums (Leads now
--     writes reservation_id, H6), closes holds of deleted users, and has its own
--     pg_cron schedule.
--  5. Pricing (owner decisions, treg catalog Oct 2026), applied once: people
--     search 1 credit per billed provider call, extra_50 off, email 1, phone 2,
--     X/Reddit/Web 0.1 per keyword, News free. Credits are numeric(20,6), so
--     fractional prices need no schema change.
--  6. M9: pricing_audit records INSERT/UPDATE/DELETE with changed_by, on
--     pricing_config and topup_packages.
--  7. M8: owners can no longer read cost/revenue columns; financial rows survive
--     account deletion (user_id set null) instead of cascading away.
--  8. N4: v_platform_totals in the right units, with refunds/disputes/revokes.
--  9. N5: indexes on the reaper/webhook hot paths and the mail foreign keys.
-- 10. N6: the hourly sweep cron is built from service_secrets.project_url
--     instead of a REPLACE_WITH_PROJECT_REF literal.
-- 11. N16: take_rate_limit validates its window.
--
-- Replayable: every statement is guarded or idempotent, and the pricing change
-- runs once (public.data_migrations), so a re-run never reverts a later edit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. One-shot data changes are recorded here, so a re-run of this file (or of
--    deploy-all.sql) can never apply them a second time.
-- ---------------------------------------------------------------------------
create table if not exists public.data_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
alter table public.data_migrations enable row level security;
revoke all on public.data_migrations from public, anon, authenticated;
grant select, insert on public.data_migrations to service_role;

-- ---------------------------------------------------------------------------
-- 1. Holds remember whether they may only use purchased credits
-- ---------------------------------------------------------------------------
alter table public.reservations
  add column if not exists paid_only boolean not null default false;

comment on column public.reservations.paid_only is
  'true: this hold may only be settled from purchased grants (source <> ''grant''). Welcome credits are for feed sweeps only.';

-- ---------------------------------------------------------------------------
-- 2. What a workspace can spend right now
--
-- A grant counts only while it is unexpired (M7): settle cannot draw an expired
-- grant, so counting it at reserve time made the work free.
--
-- "Free" credits are grants with source = 'grant' (the welcome grant, and any
-- promotional grant issued the same way). Everything else (topup, bonus,
-- adjustment) came with a purchase or from support and is "paid".
--
-- Ordinary holds draw free credits first, so for every open hold to remain
-- settleable at once, paid credits must cover the paid-only holds plus whatever
-- part of the ordinary holds the free credits cannot:
--
--   available_paid = paid - held_paid - max(held_any - free, 0)
-- ---------------------------------------------------------------------------
create or replace function public.wallet_spendable(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_balance   numeric := 0;
  v_reserved  numeric := 0;
  v_paid      numeric := 0;
  v_free      numeric := 0;
  v_held_paid numeric := 0;
  v_held_any  numeric := 0;
  v_available numeric;
  v_avail_paid numeric;
begin
  select coalesce(balance, 0), coalesce(reserved, 0)
    into v_balance, v_reserved
    from public.wallet where user_id = p_user_id;

  select coalesce(sum(credits_remaining) filter (where source <> 'grant'), 0),
         coalesce(sum(credits_remaining) filter (where source = 'grant'), 0)
    into v_paid, v_free
    from public.credit_grants
   where user_id = p_user_id
     and credits_remaining > 0
     and (expires_at is null or expires_at > now());

  select coalesce(sum(credits_held) filter (where paid_only), 0),
         coalesce(sum(credits_held) filter (where not paid_only), 0)
    into v_held_paid, v_held_any
    from public.reservations
   where user_id = p_user_id and status = 'held';

  -- wallet.reserved and the open holds agree by construction; the larger one is
  -- used anyway so a drift can only ever make less spendable, never more.
  v_available  := least(coalesce(v_balance, 0), v_paid + v_free)
                  - greatest(coalesce(v_reserved, 0), v_held_paid + v_held_any);
  v_avail_paid := least(v_available, v_paid - v_held_paid - greatest(v_held_any - v_free, 0));

  return jsonb_build_object(
    'balance',        coalesce(v_balance, 0),
    'reserved',       coalesce(v_reserved, 0),
    'paid_remaining', v_paid,
    'free_remaining', v_free,
    'held_paid_only', v_held_paid,
    'held_any',       v_held_any,
    'available',      greatest(v_available, 0),
    'available_paid', greatest(v_avail_paid, 0)
  );
end;
$fn$;

revoke execute on function public.wallet_spendable(uuid) from public, anon, authenticated;
grant  execute on function public.wallet_spendable(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. wallet_reserve with p_paid_only
--
-- The 4-argument version is dropped so a PostgREST call with named arguments
-- has exactly one candidate. Callers that do not pass p_paid_only get false,
-- which is the old behaviour (any unexpired credit).
-- ---------------------------------------------------------------------------
drop function if exists public.wallet_reserve(uuid, numeric, text, jsonb);

create or replace function public.wallet_reserve(
  p_user_id         uuid,
  p_credits         numeric,
  p_idempotency_key text,
  p_context         jsonb   default null,
  p_paid_only       boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_wallet      public.wallet%rowtype;
  v_needed      numeric := greatest(coalesce(p_credits, 0), 0);
  v_paid_only   boolean := coalesce(p_paid_only, false);
  v_spend       jsonb;
  v_available   numeric;
  v_existing    public.reservations%rowtype;
  v_reservation uuid;
begin
  if v_needed <= 0 then
    return jsonb_build_object('ok', true, 'reserved', 0, 'reservation_id', null,
                              'paid_only', v_paid_only);
  end if;

  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'wallet_reserve: idempotency_key is required';
  end if;

  -- A retried request reuses the same hold rather than stacking a second one.
  select * into v_existing from public.reservations where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'reservation_id', v_existing.id,
      'reserved', v_existing.credits_held,
      'paid_only', v_existing.paid_only
    );
  end if;

  insert into public.wallet (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

  -- Serialises every reserve, settle, release, grant and revoke for this wallet.
  select * into v_wallet from public.wallet where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet_reserve: wallet % not found', p_user_id;
  end if;

  -- A concurrent caller with the same key may have committed while we waited.
  select * into v_existing from public.reservations where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'reservation_id', v_existing.id,
      'reserved', v_existing.credits_held, 'paid_only', v_existing.paid_only);
  end if;

  v_spend := public.wallet_spendable(p_user_id);
  v_available := case when v_paid_only then (v_spend->>'available_paid')::numeric
                      else (v_spend->>'available')::numeric end;

  if v_available < v_needed then
    return jsonb_build_object(
      'ok', false,
      -- Distinct reason for a paid-only refusal, so callers can say "purchased
      -- credits" instead of a plain "not enough credits".
      'error', case when v_paid_only then 'insufficient_paid_credits' else 'insufficient_credits' end,
      'reason', case when v_paid_only then 'paid_credits_required' else 'insufficient_balance' end,
      'required', v_needed,
      'available', greatest(v_available, 0),
      'shortfall', v_needed - greatest(v_available, 0),
      'paid_only', v_paid_only,
      -- Lets the caller say "your free credits only cover feed sweeps".
      'free_available', case when v_paid_only
                             then greatest((v_spend->>'available')::numeric - v_available, 0)
                             else 0 end,
      'balance_after', v_wallet.balance
    );
  end if;

  insert into public.reservations (
    user_id, idempotency_key, credits_held, status, context, paid_only
  ) values (
    p_user_id, p_idempotency_key, v_needed, 'held', coalesce(p_context, '{}'::jsonb), v_paid_only
  ) returning id into v_reservation;

  update public.wallet
     set reserved   = reserved + v_needed,
         updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'reservation_id', v_reservation,
    'reserved', v_needed,
    'paid_only', v_paid_only,
    'available_after', v_available - v_needed,
    'balance_after', v_wallet.balance
  );
end;
$fn$;

revoke execute on function public.wallet_reserve(uuid, numeric, text, jsonb, boolean) from public, anon, authenticated;
grant  execute on function public.wallet_reserve(uuid, numeric, text, jsonb, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 4. wallet_settle: paid-only holds draw only purchased grants; ordinary holds
--    draw free credits first. Same signature as 20261103.
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
  v_needed    numeric;
  v_take      numeric;
  v_revenue   numeric := 0;
  v_drawn     numeric := 0;
  v_new_bal   numeric;
  v_ledger_id bigint;
  v_row       record;
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'reservation_not_found');
  end if;

  if v_res.status <> 'held' then
    return jsonb_build_object('ok', false, 'error', 'reservation_already_finalised',
                              'status', v_res.status);
  end if;

  -- The account was deleted while the hold was open: there is no wallet left
  -- to charge. Closed as released so it stops showing as stale.
  if v_res.user_id is null then
    update public.reservations
       set status = 'released', finalised_at = now(), reason = 'owner deleted'
     where id = p_reservation_id;
    return jsonb_build_object('ok', false, 'error', 'owner_deleted');
  end if;

  if v_charge > v_res.credits_held then
    v_charge := v_res.credits_held;
  end if;
  v_needed := v_charge;

  select * into v_wallet from public.wallet where user_id = v_res.user_id for update;

  update public.reservations
     set status = 'settled', finalised_at = now(), reason = coalesce(p_note, 'settled')
   where id = p_reservation_id;

  if v_charge > 0 then
    for v_row in
      select id, credits_remaining, unit_price_usd
        from public.credit_grants
       where user_id = v_res.user_id
         and credits_remaining > 0
         and (expires_at is null or expires_at > now())
         and (not v_res.paid_only or source <> 'grant')
       -- Free credits first for ordinary holds; then soonest expiry, then FIFO.
       order by case when not v_res.paid_only and source = 'grant' then 0 else 1 end,
                expires_at nulls last, created_at
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

  -- Clipped to what could actually be drawn; never a negative balance.
  v_charge  := v_drawn;
  v_new_bal := v_wallet.balance - v_charge;

  update public.wallet
     set balance                = v_new_bal,
         reserved               = greatest(reserved - v_res.credits_held, 0),
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
      'provider_cost', v_cost,
      'paid_only', v_res.paid_only
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

revoke execute on function public.wallet_settle(uuid, numeric, numeric, text, text, jsonb) from public, anon, authenticated;
grant  execute on function public.wallet_settle(uuid, numeric, numeric, text, text, jsonb) to service_role;

-- wallet_release: same as 20261103, plus a hold whose owner was deleted.
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
    return jsonb_build_object('ok', false, 'error', 'reservation_already_finalised',
                              'status', v_res.status);
  end if;

  if v_res.user_id is not null then
    select * into v_wallet from public.wallet where user_id = v_res.user_id for update;
  end if;

  update public.reservations
     set status = 'released', finalised_at = now(), reason = coalesce(p_reason, 'released')
   where id = p_reservation_id;

  if v_res.user_id is not null then
    update public.wallet
       set reserved   = greatest(reserved - v_res.credits_held, 0),
           updated_at = now()
     where user_id = v_res.user_id;
  end if;

  return jsonb_build_object('ok', true, 'released', v_res.credits_held,
                            'balance_after', v_wallet.balance);
end;
$fn$;

revoke execute on function public.wallet_release(uuid, text) from public, anon, authenticated;
grant  execute on function public.wallet_release(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. wallet_revoke_grant with an idempotency key (H7)
--
-- The key is checked after the grant row lock, so two parallel calls with the
-- same key serialise and the second one returns duplicate. The unique index on
-- credit_ledger.idempotency_key backs it up. The unit price of the revoked
-- credits is kept in the ledger metadata for v_platform_totals.
-- ---------------------------------------------------------------------------
drop function if exists public.wallet_revoke_grant(uuid, text, numeric);
drop function if exists public.wallet_revoke_grant(uuid, text);

create or replace function public.wallet_revoke_grant(
  p_grant_id        uuid,
  p_reason          text    default 'refund',
  p_credits         numeric default null,
  p_idempotency_key text    default null
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
  v_prior    public.credit_ledger%rowtype;
begin
  select * into v_grant from public.credit_grants where id = p_grant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;

  if p_idempotency_key is not null then
    select * into v_prior from public.credit_ledger where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'revoked', -v_prior.delta,
                                'balance_after', v_prior.balance_after);
    end if;
  end if;

  if v_grant.credits_remaining <= 0 then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'already_fully_spent');
  end if;

  if v_grant.user_id is null then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'owner_deleted');
  end if;

  select * into v_wallet from public.wallet where user_id = v_grant.user_id for update;

  -- Only the spendable part: credits on hold belong to an in-flight job.
  v_take := least(
    v_grant.credits_remaining,
    greatest(coalesce(v_wallet.balance, 0) - coalesce(v_wallet.reserved, 0), 0),
    case when p_credits is null then v_grant.credits_remaining else greatest(p_credits, 0) end
  );

  if v_take <= 0 then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'nothing_spendable');
  end if;

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
    user_id, delta, balance_after, kind, grant_id, payment_order_id,
    revenue_usd, idempotency_key, note, metadata
  ) values (
    v_grant.user_id, -v_take, v_new_bal, 'reversal', p_grant_id, v_grant.payment_order_id,
    0, p_idempotency_key, coalesce(p_reason, 'refund'),
    jsonb_build_object('unit_price_usd', v_grant.unit_price_usd, 'source', v_grant.source)
  );

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'revoked', v_take,
    'unrevokable', v_grant.credits_remaining - v_take,
    'balance_after', v_new_bal
  );
end;
$fn$;

revoke execute on function public.wallet_revoke_grant(uuid, text, numeric, text) from public, anon, authenticated;
grant  execute on function public.wallet_revoke_grant(uuid, text, numeric, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Refunds, atomically (H7)
--
-- One row per (order, refund key). A refund event adds its amount; a payment-
-- level "refunded" event carries the payment's cumulative refunded total. The
-- order's refunded amount is max(sum of refunds, largest cumulative total),
-- clipped to the gross, so a refund.succeeded and a payment.refunded for the
-- same money count it once in either order.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_refunds (
  order_id    uuid not null references public.payment_orders(id) on delete cascade,
  refund_key  text not null,
  kind        text not null check (kind in ('refund', 'cumulative')),
  amount      numeric(20,6) not null check (amount >= 0),
  currency    text,
  webhook_id  text,
  created_at  timestamptz not null default now(),
  primary key (order_id, refund_key)
);
alter table public.payment_refunds enable row level security;
revoke all on public.payment_refunds from public, anon, authenticated;
grant select, insert on public.payment_refunds to service_role;

create or replace function public.wallet_refund_order(
  p_order_id   uuid,
  p_refund_id  text,
  p_amount     numeric default null,
  p_currency   text    default null,
  p_cumulative boolean default false,
  p_webhook_id text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_order     public.payment_orders%rowtype;
  v_key       text;
  v_amount    numeric;
  v_old       numeric;
  v_new       numeric;
  v_fraction  numeric;
  v_grant     record;
  v_out       jsonb;
  v_revoked   numeric := 0;
  v_status    text;
  v_base      text;
begin
  -- Serialises every refund, dispute and top-up for this order.
  select * into v_order from public.payment_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  v_key := case when coalesce(p_cumulative, false)
                then 'cumulative:' || coalesce(nullif(p_refund_id, ''), round(p_amount, 2)::text, 'full')
                else nullif(p_refund_id, '') end;
  if v_key is null then
    return jsonb_build_object('ok', false, 'error', 'refund_id_required');
  end if;

  -- A refund in another currency cannot be converted into a share of the
  -- order here. Parked for a human; nothing is revoked.
  if p_currency is not null and upper(p_currency) <> upper(v_order.currency) then
    update public.payment_orders
       set status = 'review',
           review_reason = 'refund_currency_mismatch: ' || upper(p_currency) || ' refund '
                           || v_key || ' on ' || upper(v_order.currency) || ' order'
     where id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'currency_mismatch', 'parked', true);
  end if;

  v_old := least(coalesce(v_order.refunded_usd, 0), v_order.gross_usd);
  v_amount := greatest(coalesce(p_amount, v_order.gross_usd - v_old), 0);

  -- When this refund key has been seen, this is a redelivery: nothing to do.
  insert into public.payment_refunds (order_id, refund_key, kind, amount, currency, webhook_id)
  values (p_order_id, v_key,
          case when coalesce(p_cumulative, false) then 'cumulative' else 'refund' end,
          v_amount, upper(coalesce(p_currency, v_order.currency)), p_webhook_id)
  on conflict (order_id, refund_key) do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'refunded_usd', v_old);
  end if;

  select least(v_order.gross_usd,
               greatest(coalesce(sum(amount) filter (where kind = 'refund'), 0),
                        coalesce(max(amount) filter (where kind = 'cumulative'), 0),
                        v_old))
    into v_new
    from public.payment_refunds where order_id = p_order_id;

  v_fraction := case when v_order.gross_usd > 0
                     then greatest(v_new - v_old, 0) / v_order.gross_usd else 1 end;

  v_base := 'refund:' || p_order_id::text || ':' || v_key;

  if v_fraction > 0 then
    for v_grant in
      select id, credits, source from public.credit_grants
       where payment_order_id = p_order_id
       order by case when source = 'topup' then 0 else 1 end, created_at
    loop
      v_out := public.wallet_revoke_grant(
        v_grant.id, 'refund', v_grant.credits * v_fraction,
        case when v_grant.source = 'topup' then v_base else v_base || ':' || v_grant.source end);
      if coalesce((v_out->>'ok')::boolean, false) is false then
        raise exception 'wallet_refund_order: revoke of grant % failed: %', v_grant.id, v_out;
      end if;
      -- A replayed key reports the original revoke; count only new ones.
      if not coalesce((v_out->>'duplicate')::boolean, false) then
        v_revoked := v_revoked + coalesce((v_out->>'revoked')::numeric, 0);
      end if;
    end loop;
  end if;

  v_status := case
                when v_order.status in ('disputed', 'review') then v_order.status
                when v_new + 0.005 >= v_order.gross_usd then 'refunded'
                when v_new > 0 then 'partially_refunded'
                else v_order.status
              end;

  update public.payment_orders
     set refunded_usd = v_new, status = v_status
   where id = p_order_id;

  return jsonb_build_object('ok', true, 'duplicate', false, 'refund_key', v_key,
                            'refunded_usd', v_new, 'fraction', v_fraction,
                            'revoked', v_revoked, 'status', v_status);
end;
$fn$;

revoke execute on function public.wallet_refund_order(uuid, text, numeric, text, boolean, text) from public, anon, authenticated;
grant  execute on function public.wallet_refund_order(uuid, text, numeric, text, boolean, text) to service_role;

-- Disputes: 'opened' freezes every spendable credit the order bought, 'lost'
-- takes whatever became spendable since and marks the order refunded, 'won'
-- restores the order status (credits are NOT re-granted automatically).
create or replace function public.wallet_dispute_order(
  p_order_id uuid,
  p_stage    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_order   public.payment_orders%rowtype;
  v_grant   record;
  v_out     jsonb;
  v_revoked numeric := 0;
begin
  if p_stage not in ('opened', 'lost', 'won') then
    return jsonb_build_object('ok', false, 'error', 'invalid_stage');
  end if;

  select * into v_order from public.payment_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  if p_stage = 'won' then
    if v_order.status = 'disputed' then
      update public.payment_orders set status = 'succeeded' where id = p_order_id;
    end if;
    return jsonb_build_object('ok', true, 'stage', p_stage, 'revoked', 0,
                              'status', case when v_order.status = 'disputed' then 'succeeded' else v_order.status end);
  end if;

  for v_grant in
    select id from public.credit_grants where payment_order_id = p_order_id order by created_at
  loop
    v_out := public.wallet_revoke_grant(
      v_grant.id, 'dispute_' || p_stage, null,
      'dispute:' || p_order_id::text || ':' || p_stage || ':' || v_grant.id::text);
    if coalesce((v_out->>'ok')::boolean, false) is false then
      raise exception 'wallet_dispute_order: revoke of grant % failed: %', v_grant.id, v_out;
    end if;
    -- A replayed key reports the original revoke; count only new ones.
    if not coalesce((v_out->>'duplicate')::boolean, false) then
      v_revoked := v_revoked + coalesce((v_out->>'revoked')::numeric, 0);
    end if;
  end loop;

  if p_stage = 'opened' then
    update public.payment_orders set status = 'disputed' where id = p_order_id;
  else
    update public.payment_orders
       set status = 'refunded', refunded_usd = gross_usd
     where id = p_order_id;
  end if;

  return jsonb_build_object('ok', true, 'stage', p_stage, 'revoked', v_revoked);
end;
$fn$;

revoke execute on function public.wallet_dispute_order(uuid, text) from public, anon, authenticated;
grant  execute on function public.wallet_dispute_order(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Webhook deliveries are claimed under a row lock (H7)
--
-- 'processing' with a live lease means another invocation is working on this
-- delivery right now; the caller must not process it in parallel. A lease older
-- than p_lease is treated as a crashed attempt and can be reclaimed.
-- ---------------------------------------------------------------------------
alter table public.webhook_events add column if not exists claimed_at timestamptz;
alter table public.webhook_events drop constraint if exists webhook_events_status_check;
alter table public.webhook_events add constraint webhook_events_status_check
  check (status in ('received', 'processing', 'processed', 'failed', 'ignored'));

create or replace function public.webhook_claim(
  p_provider   text,
  p_webhook_id text,
  p_event_type text,
  p_payload    jsonb    default '{}'::jsonb,
  p_lease      interval default '5 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public.webhook_events%rowtype;
begin
  if p_webhook_id is null or p_webhook_id = '' then
    return jsonb_build_object('claimed', false, 'error', 'webhook_id_required');
  end if;

  insert into public.webhook_events (provider, webhook_id, event_type, payload, status, attempts, claimed_at)
  values (coalesce(p_provider, 'dodo'), p_webhook_id, coalesce(p_event_type, 'unknown'),
          coalesce(p_payload, '{}'::jsonb), 'processing', 1, now())
  on conflict (webhook_id) do nothing;
  if found then
    return jsonb_build_object('claimed', true, 'first', true, 'attempts', 1);
  end if;

  select * into v_row from public.webhook_events where webhook_id = p_webhook_id for update;

  if v_row.status in ('processed', 'ignored') then
    return jsonb_build_object('claimed', false, 'status', v_row.status);
  end if;

  if v_row.status = 'processing' and v_row.claimed_at > now() - coalesce(p_lease, '5 minutes') then
    return jsonb_build_object('claimed', false, 'status', 'processing', 'in_flight', true);
  end if;

  update public.webhook_events
     set status = 'processing', attempts = attempts + 1, claimed_at = now()
   where webhook_id = p_webhook_id;

  return jsonb_build_object('claimed', true, 'first', false, 'attempts', v_row.attempts + 1,
                            'prior_status', v_row.status);
end;
$fn$;

revoke execute on function public.webhook_claim(text, text, text, jsonb, interval) from public, anon, authenticated;
grant  execute on function public.webhook_claim(text, text, text, jsonb, interval) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Reaper (H6): settle stale holds for what api_usage recorded against them
--
-- The old 'live:%' exclusion is gone: no caller uses that prefix any more, and a
-- hold older than the window is stale whoever opened it.
-- ---------------------------------------------------------------------------
create or replace function public.reap_stale_reservations(p_older_than interval default '1 hour')
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_age      interval := greatest(coalesce(p_older_than, '1 hour'), interval '10 minutes');
  v_res      record;
  v_cost     numeric;
  v_credits  numeric;
  v_settled  int := 0;
  v_released int := 0;
  v_orphaned int := 0;
  v_out      jsonb;
begin
  for v_res in
    select id, user_id, credits_held
      from public.reservations
     where status = 'held'
       and created_at < now() - v_age
     order by created_at
     for update skip locked
  loop
    if v_res.user_id is null then
      update public.reservations
         set status = 'released', finalised_at = now(), reason = 'owner deleted'
       where id = v_res.id;
      v_orphaned := v_orphaned + 1;
      continue;
    end if;

    select coalesce(sum(provider_cost_usd), 0), coalesce(sum(credits_charged), 0)
      into v_cost, v_credits
      from public.api_usage
     where reservation_id = v_res.id;

    if v_credits > 0 or v_cost > 0 then
      v_out := public.wallet_settle(
        v_res.id,
        least(v_credits, v_res.credits_held),
        v_cost,
        'reap:' || v_res.id::text,
        'stale reservation reaped after ' || v_age
      );
      if coalesce((v_out->>'ok')::boolean, false) then
        v_settled := v_settled + 1;
      end if;
    else
      v_out := public.wallet_release(v_res.id, 'stale reservation reaped after ' || v_age);
      if coalesce((v_out->>'ok')::boolean, false) then
        v_released := v_released + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('settled', v_settled, 'released', v_released,
                            'orphaned', v_orphaned,
                            'total', v_settled + v_released + v_orphaned);
end;
$fn$;

revoke execute on function public.reap_stale_reservations(interval) from public, anon, authenticated;
grant  execute on function public.reap_stale_reservations(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 9. take_rate_limit validates its arguments (N16)
--
-- A null window counted nothing and always passed. Windows above 48 hours are
-- refused because purge_retention deletes hits older than two days, so a longer
-- window would silently count less than it claims.
-- ---------------------------------------------------------------------------
create or replace function public.take_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_limit int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count int;
begin
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 172800 then
    raise exception 'take_rate_limit: window must be 1..172800 seconds, got %', p_window_seconds
      using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 0 then
    raise exception 'take_rate_limit: limit must be >= 0, got %', p_limit using errcode = '22023';
  end if;
  if p_user_id is null or p_bucket is null or p_bucket = '' or p_limit = 0 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_bucket, 0));

  select count(*) into v_count
    from public.rate_limit_hits
   where user_id = p_user_id
     and bucket = p_bucket
     and created_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.rate_limit_hits (user_id, bucket) values (p_user_id, p_bucket);
  return true;
end;
$fn$;

revoke execute on function public.take_rate_limit(uuid, text, int, int) from public, anon, authenticated;
grant  execute on function public.take_rate_limit(uuid, text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Pricing audit on INSERT, UPDATE and DELETE, with who did it (M9)
-- ---------------------------------------------------------------------------
create or replace function public.audit_pricing_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_old   jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new   jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row   jsonb := coalesce(v_new, v_old);
  v_key   text  := coalesce(v_row->>'operation', 'package:' || (v_row->>'code'));
  v_who   text  := coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                            nullif(current_setting('echo.changed_by', true), ''),
                            session_user::text);
  v_why   text  := nullif(current_setting('echo.change_reason', true), '');
  v_field text;
begin
  if tg_op = 'INSERT' then
    insert into public.pricing_audit (operation, field, old_value, new_value, changed_by, reason)
    values (v_key, '*insert*', null, v_new, v_who, v_why);
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.pricing_audit (operation, field, old_value, new_value, changed_by, reason)
    values (v_key, '*delete*', v_old, null, v_who, v_why);
    return old;
  end if;

  for v_field in select jsonb_object_keys(v_new) loop
    continue when v_field in ('updated_at', 'effective_from');
    if v_new -> v_field is distinct from v_old -> v_field then
      insert into public.pricing_audit (operation, field, old_value, new_value, changed_by, reason)
      values (v_key, v_field, v_old -> v_field, v_new -> v_field, v_who, v_why);
    end if;
  end loop;
  return new;
end;
$fn$;

revoke execute on function public.audit_pricing_change() from public, anon, authenticated;

drop trigger if exists trg_pricing_audit on public.pricing_config;
create trigger trg_pricing_audit
  after insert or update or delete on public.pricing_config
  for each row execute function public.audit_pricing_change();

drop trigger if exists trg_topup_packages_audit on public.topup_packages;
create trigger trg_topup_packages_audit
  after insert or update or delete on public.topup_packages
  for each row execute function public.audit_pricing_change();

-- ---------------------------------------------------------------------------
-- 11. Owner pricing decisions (E.4), applied exactly once
-- ---------------------------------------------------------------------------
alter table public.pricing_config drop constraint if exists pricing_config_cost_source_check;
alter table public.pricing_config add constraint pricing_config_cost_source_check
  check (cost_source in ('catalog', 'rate_card', 'observed', 'live_confirmed', 'unverified',
                         'treg catalog 2026-10'));

do $pricing$
begin
  insert into public.data_migrations (name) values ('20261127_pricing')
    on conflict (name) do nothing;
  if not found then
    return;  -- already applied; never re-apply over a later operator edit
  end if;

  perform set_config('echo.changed_by', 'migration:20261127_audit_round2', true);
  perform set_config('echo.change_reason', 'owner pricing decision (audit E.4)', true);

  -- Owner decision after checking treg's catalog (Oct 2026). Costs are the
  -- catalog figures / routing caps, not measurements, so cost_verified = false.
  update public.pricing_config
     set credits = 1,
         display_name = 'People search (per billed provider call)',
         provider_cost_usd = 0.015, cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.people.search';

  update public.pricing_config
     set enabled = false,
         display_name = 'People search: per-50-leads fee (retired)',
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'leads.search.extra_50';

  update public.pricing_config
     set credits = 1, provider_cost_usd = 0.015,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.people.email.find';

  update public.pricing_config
     set credits = 2, provider_cost_usd = 0.03,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.people.phone.find';

  -- Feed sweeps, per keyword per run.
  update public.pricing_config
     set credits = 0.1, provider_cost_usd = 0.00075,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.twitter.search';

  -- tikhub $0.001; the scrapecreators fallback is $0.00188 when it fires.
  update public.pricing_config
     set credits = 0.1, provider_cost_usd = 0.001,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.reddit.search';

  update public.pricing_config
     set credits = 0.1, provider_cost_usd = 0.00015,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.web.search';

  -- News is free, consistently (N9): tinyfish news is billed at zero.
  update public.pricing_config
     set credits = 0, provider_cost_usd = 0,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.news.search';
end
$pricing$;

comment on table public.pricing_config is
  'Credit price per operation. treg.people.search.credits is charged PER BILLED PROVIDER CALL. Seeds are insert-only; change prices with an explicit UPDATE (audited by trg_pricing_audit).';

-- ---------------------------------------------------------------------------
-- 12. Cost and revenue columns are ours, not the owner's (M8)
--
-- Table-level SELECT is revoked and re-granted column by column, minus the
-- margin columns. The frontend reads none of these tables directly (billing
-- serves them through the service role), so nothing visible changes. Policies
-- are rewritten with (select auth.uid()) and scoped to authenticated.
-- ---------------------------------------------------------------------------
do $grants$
declare
  v_t    text;
  v_ex   text[];
  v_cols text;
begin
  for v_t, v_ex in
    select * from (values
      ('api_usage',      array['provider_cost_usd', 'gross_profit_usd', 'revenue_usd']),
      ('credit_ledger',  array['revenue_usd', 'service_cost_usd']),
      ('credit_grants',  array['unit_price_usd']),
      ('wallet',         array['recognised_revenue_usd', 'service_cost_usd']),
      ('reservations',   array[]::text[]),
      ('payment_orders', array['fee_usd', 'net_usd'])
    ) v(t, ex)
  loop
    continue when to_regclass('public.' || v_t) is null;

    execute format('revoke all on public.%I from anon', v_t);
    execute format('revoke select, insert, update, delete, truncate, references, trigger on public.%I from authenticated', v_t);

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into v_cols
      from information_schema.columns
     where table_schema = 'public' and table_name = v_t
       and column_name <> all (v_ex);

    execute format('grant select (%s) on public.%I to authenticated', v_cols, v_t);
    execute format('drop policy if exists %I on public.%I', v_t || '_select_own', v_t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
                   v_t || '_select_own', v_t);
  end loop;
end
$grants$;

-- Financial rows outlive the account: user_id is set null on deletion instead
-- of cascading the history away. The wallet row itself (keyed by user) still
-- goes; its totals are derivable from the ledger.
do $fk$
declare
  v_t    text;
  v_con  text;
begin
  foreach v_t in array array['payment_orders', 'credit_grants', 'credit_ledger', 'api_usage', 'reservations'] loop
    continue when to_regclass('public.' || v_t) is null;

    select c.conname into v_con
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.conrelid = ('public.' || v_t)::regclass
       and c.contype = 'f'
       and c.confrelid = 'auth.users'::regclass
       and a.attname = 'user_id'
     limit 1;

    execute format('alter table public.%I alter column user_id drop not null', v_t);
    if v_con is not null then
      execute format('alter table public.%I drop constraint %I', v_t, v_con);
    end if;
    execute format('alter table public.%I add constraint %I foreign key (user_id) references auth.users(id) on delete set null',
                   v_t, v_t || '_user_id_fkey');
  end loop;
end
$fk$;

-- ---------------------------------------------------------------------------
-- 13. Platform totals in the right units (N4)
-- ---------------------------------------------------------------------------
drop view if exists public.v_platform_totals;
create view public.v_platform_totals
with (security_invoker = true) as
select
  ledger.recognised_revenue_usd,
  usage.provider_cost_usd,
  ledger.recognised_revenue_usd - usage.provider_cost_usd             as gross_profit_usd,
  cash.gross_usd                                                       as gross_cash_usd,
  cash.refunded_usd                                                    as refunded_cash_usd,
  cash.disputed_usd                                                    as disputed_cash_usd,
  cash.known_fees                                                      as known_gateway_fees_usd,
  cash.orders_with_unknown_fee,
  -- Upper bound until every paid order has reported its fee.
  cash.gross_usd - cash.refunded_usd - cash.disputed_usd - cash.known_fees as net_cash_usd,
  liab.unspent_credits,
  liab.unspent_paid_credits,
  liab.unspent_credit_liability_usd,
  rev.revoked_credits,
  rev.revoked_value_usd,
  -- Cash returned beyond the unspent value taken back: revenue that had been
  -- recognised and then went back to the customer.
  greatest(cash.refunded_usd + cash.disputed_usd - rev.revoked_value_usd, 0) as refunds_against_recognised_usd,
  (select count(*) from public.api_usage where outcome = 'uncertain')  as uncertain_calls,
  (select count(*) from public.reservations
     where status = 'held' and created_at < now() - interval '1 hour') as stale_reservations
from
  (select coalesce(sum(revenue_usd), 0) as recognised_revenue_usd
     from public.credit_ledger where kind = 'usage') ledger,
  (select coalesce(sum(provider_cost_usd), 0) as provider_cost_usd from public.api_usage) usage,
  (select
     coalesce(sum(gross_usd), 0)                                               as gross_usd,
     coalesce(sum(least(refunded_usd, gross_usd)) filter (where status <> 'disputed'), 0) as refunded_usd,
     coalesce(sum(gross_usd - least(refunded_usd, gross_usd)) filter (where status = 'disputed'), 0) as disputed_usd,
     coalesce(sum(fee_usd), 0)                                                 as known_fees,
     count(*) filter (where fee_usd is null)                                   as orders_with_unknown_fee
   from public.payment_orders
   where credits_granted > 0
      or status in ('succeeded', 'refunded', 'partially_refunded', 'disputed')) cash,
  (select
     coalesce(sum(credits_remaining), 0)                                       as unspent_credits,
     coalesce(sum(credits_remaining) filter (where source <> 'grant'), 0)      as unspent_paid_credits,
     coalesce(sum(credits_remaining * unit_price_usd), 0)                      as unspent_credit_liability_usd
   from public.credit_grants
   where user_id is not null and (expires_at is null or expires_at > now())) liab,
  (select
     coalesce(sum(-l.delta), 0)                                                as revoked_credits,
     coalesce(sum(-l.delta * coalesce((l.metadata->>'unit_price_usd')::numeric, g.unit_price_usd, 0)), 0) as revoked_value_usd
   from public.credit_ledger l
   left join public.credit_grants g on g.id = l.grant_id
   where l.kind = 'reversal') rev;

comment on view public.v_platform_totals is
  'Recognised revenue (ledger), measured cost, cash net of refunds/disputes/fees, unspent credits (units) and their USD liability, and revoked credits. Service role only.';

revoke all on public.v_platform_totals from public, anon, authenticated;
grant select on public.v_platform_totals to service_role;

-- ---------------------------------------------------------------------------
-- 14. Indexes (N5)
-- ---------------------------------------------------------------------------
create index if not exists idx_api_usage_reservation
  on public.api_usage(reservation_id) where reservation_id is not null;
create index if not exists idx_credit_ledger_grant
  on public.credit_ledger(grant_id) where grant_id is not null;
create index if not exists idx_credit_ledger_payment_order
  on public.credit_ledger(payment_order_id) where payment_order_id is not null;
create index if not exists idx_credit_ledger_reversal
  on public.credit_ledger(created_at) where kind = 'reversal';
create index if not exists idx_reservations_user_held
  on public.reservations(user_id) where status = 'held';
-- daily-sweep reads every active keyword grouped by user (was only in 20261023).
create index if not exists keywords_active_user_idx
  on public.keywords (user_id) where is_active;

-- Mail foreign keys. Guarded per column: the mail schema is still moving.
do $mailidx$
declare
  v_spec text[];
begin
  foreach v_spec slice 1 in array array[
    array['mailboxes',        'domain_id',  'idx_mailboxes_domain_id'],
    array['mail_threads',     'user_id',    'idx_mail_threads_user_id'],
    array['mail_messages',    'user_id',    'idx_mail_messages_user_id'],
    array['mail_messages',    'mailbox_id', 'idx_mail_messages_mailbox_id'],
    array['mail_messages',    'lead_id',    'idx_mail_messages_lead_id'],
    array['mail_attachments', 'user_id',    'idx_mail_attachments_user_id']
  ] loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = v_spec[1] and column_name = v_spec[2]) then
      execute format('create index if not exists %I on public.%I (%I)', v_spec[3], v_spec[1], v_spec[2]);
    end if;
  end loop;
end
$mailidx$;

-- ---------------------------------------------------------------------------
-- 15. Scheduled jobs, built from configuration (N6, H6)
--
--   echo-daily-sweep   hourly; posts to <project_url>/functions/v1/daily-sweep.
--                      project_url comes from public.service_secrets
--                      (name = 'project_url', e.g. https://<ref>.supabase.co).
--                      The secret header is still read at fire time.
--   echo-reap-stale    every 15 minutes; reap_stale_reservations().
--
-- Without pg_cron (local, CI) this does nothing. Without a project_url an
-- existing sweep job is left alone, unless it still posts to the
-- REPLACE_WITH_PROJECT_REF placeholder, which can never work and is removed.
-- Re-run after setting project_url:  select public.configure_echo_cron();
-- ---------------------------------------------------------------------------
create or replace function public.configure_echo_cron()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url     text;
  v_cmd     text;
  v_result  jsonb := '{}'::jsonb;
  v_has_net boolean;
begin
  if to_regclass('cron.job') is null
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'cron' and p.proname = 'schedule') then
    return jsonb_build_object('ok', false, 'skipped', 'pg_cron not installed');
  end if;

  -- Reaper: needs nothing but pg_cron.
  execute 'select cron.unschedule(jobid) from cron.job where jobname = $1' using 'echo-reap-stale';
  execute 'select cron.schedule($1, $2, $3)'
    using 'echo-reap-stale', '*/15 * * * *', 'select public.reap_stale_reservations();';
  v_result := v_result || jsonb_build_object('echo-reap-stale', 'scheduled');

  -- A placeholder URL can never succeed; remove it whatever else happens.
  execute 'select cron.unschedule(jobid) from cron.job where jobname = $1 and command like $2'
    using 'echo-daily-sweep', '%REPLACE_WITH_PROJECT_REF%';

  v_has_net := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'net' and p.proname = 'http_post');

  select rtrim(trim(value), '/') into v_url from public.service_secrets where name = 'project_url';

  if v_url is null or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
    v_result := v_result || jsonb_build_object('echo-daily-sweep',
      case when v_url is null then 'left as is: service_secrets.project_url not set'
           else 'left as is: project_url is not https://host' end);
  elsif not v_has_net then
    v_result := v_result || jsonb_build_object('echo-daily-sweep', 'left as is: pg_net not installed');
  else
    v_cmd := format(
      $cmd$select net.http_post(
  url := %L,
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-sweep-secret', (select value from public.service_secrets where name = 'sweep_cron_secret')),
  body := '{}'::jsonb,
  timeout_milliseconds := 180000);$cmd$,
      v_url || '/functions/v1/daily-sweep');
    execute 'select cron.unschedule(jobid) from cron.job where jobname = $1' using 'echo-daily-sweep';
    execute 'select cron.schedule($1, $2, $3)' using 'echo-daily-sweep', '0 * * * *', v_cmd;
    v_result := v_result || jsonb_build_object('echo-daily-sweep', 'scheduled: ' || v_url);
  end if;

  return jsonb_build_object('ok', true) || v_result;
end;
$fn$;

revoke execute on function public.configure_echo_cron() from public, anon, authenticated;
grant  execute on function public.configure_echo_cron() to service_role;

do $cron$
declare
  v_out jsonb;
begin
  begin
    v_out := public.configure_echo_cron();
    raise notice 'configure_echo_cron: %', v_out;
  exception when others then
    -- Scheduling must never abort the schema; report it and carry on.
    raise warning 'configure_echo_cron failed: %', sqlerrm;
  end;
end
$cron$;

-- ---------------------------------------------------------------------------
-- 16. N7: the welcome grant's real exposure
-- ---------------------------------------------------------------------------
comment on function public.handle_new_user() is
  'Signup: profile, wallet and 20 welcome credits (source=grant, $0). Welcome credits only pay for feed sweeps (Leads and Mail reserve with p_paid_only => true): 20 credits is about 8 days of an 8-keyword, 3-channel workspace at 0.1 credit per keyword per channel (2.4 credits/day), roughly $0.05 of provider cost per signup.';

-- ===========================================================================
-- 20261128_sweep_off.sql
-- ------------------------------------------------------------------------

-- =============================================================================
-- 20261128: automatic sweeps can be turned off
-- -----------------------------------------------------------------------------
-- profiles.sweep_frequency gains 'off'. daily-sweep never treats an 'off'
-- workspace as due (sweep-rules.ts isProfileDue); manual sweeps still work.
--
-- The column had no constraint at all, so a client could store any string
-- (it is in the authenticated UPDATE grant). Unknown values are normalised to
-- the column default first, then the allowed set is enforced.
-- Idempotent.
-- =============================================================================

update public.profiles
   set sweep_frequency = '24h'
 where sweep_frequency is null
    or sweep_frequency not in ('24h', '12h', '6h', 'off');

alter table public.profiles drop constraint if exists profiles_sweep_frequency_check;
alter table public.profiles
  add constraint profiles_sweep_frequency_check
  check (sweep_frequency in ('24h', '12h', '6h', 'off'));

comment on column public.profiles.sweep_frequency is
  'Automatic sweep cadence: 24h, 12h, 6h, or off (manual sweeps only).';
