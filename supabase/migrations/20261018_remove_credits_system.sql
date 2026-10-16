-- ============================================================================
-- Echo — Retire the credit-based lead-selling system
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