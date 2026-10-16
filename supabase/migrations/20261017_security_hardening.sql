-- ============================================================================
-- Echo — Security Hardening & Final Schema
-- ----------------------------------------------------------------------------
-- This is the authoritative definition of the hardened schema. It is written so
-- that it can run on a FRESH database (no credit tables) as well as on top of
-- an older installation — it contains zero references to the retired
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
-- 5. apply_subscription_plan — service-role only.
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