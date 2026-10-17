-- ============================================================================
-- Remove billing
-- ----------------------------------------------------------------------------
-- Echo is free. There is no plan, no purchase, no credit balance and no
-- payment processor. Every workspace gets the same allowance, so the whole
-- apparatus that existed to meter, price and account for that is gone:
--
--   dropped tables   payments, credit_grants, credit_ledger, usage_events,
--                    billing_config, spend_runs
--   dropped views    billing_summary, billing_by_user, billing_by_operation,
--                    billing_by_month, my_billing
--   dropped funcs    the whole credit and admin surface
--   dropped columns  every subscription_*, credit_* and search_* field
--
-- What survives is the part that was never about money: the settings that
-- describe how a workspace is swept, the feed, and the intent filter. The
-- keyword ceiling stays, but it is now a constant rather than a plan
-- entitlement, so nothing a client does can raise it and nothing has to be
-- upgraded to reach it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Views first, they depend on the tables below
-- ---------------------------------------------------------------------------
drop view if exists public.my_billing cascade;
drop view if exists public.billing_summary cascade;
drop view if exists public.billing_by_user cascade;
drop view if exists public.billing_by_operation cascade;
drop view if exists public.billing_by_month cascade;

-- ---------------------------------------------------------------------------
-- 2. Policies first
-- ---------------------------------------------------------------------------
-- Several read policies call is_admin(), so they have to go before the
-- function does. The tables are dropped next anyway; this just satisfies the
-- dependency order.
drop policy if exists billing_config_read_admin on public.billing_config;
drop policy if exists payments_read_own on public.payments;
drop policy if exists credit_grants_read_own on public.credit_grants;
drop policy if exists credit_ledger_read_own on public.credit_ledger;
drop policy if exists usage_events_read_own on public.usage_events;

-- ---------------------------------------------------------------------------
-- 3. Money and credit functions
-- ---------------------------------------------------------------------------
drop function if exists public.admin_billing_snapshot(integer);
drop function if exists public.admin_set_credit_rate(numeric);
drop function if exists public.admin_set_operation_price(text, numeric, text);
drop function if exists public.admin_set_plan_grants(text, numeric);
drop function if exists public.admin_set_topup_packages(jsonb);
drop function if exists public.admin_set_admin(uuid, boolean);
drop function if exists public.grant_credits(uuid, numeric, text, numeric, uuid, text, text, text, text);
drop function if exists public.spend_credits(uuid, numeric, text, numeric, integer, text, text, boolean, text, jsonb);
drop function if exists public.revoke_grant_credits(uuid, text);
drop function if exists public.record_search_spend(uuid, uuid, numeric, integer);
drop function if exists public.can_afford_sweep(uuid, integer, text[]);
drop function if exists public.ensure_monthly_allowance(uuid, text);
drop function if exists public.credit_rate();
drop function if exists public.plan_credit_grant(text);
drop function if exists public.operation_price(text);
drop function if exists public.plan_max_channels(text);
drop function if exists public.plan_sweeps_per_day(text);
drop function if exists public.plan_max_keywords();
drop function if exists public.plan_keyword_limit(uuid);
drop function if exists public.apply_subscription_plan(uuid, text, text, timestamptz);
drop function if exists public.is_admin(uuid);

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------
drop table if exists public.spend_runs cascade;
drop table if exists public.usage_events cascade;
drop table if exists public.credit_ledger cascade;
drop table if exists public.credit_grants cascade;
drop table if exists public.payments cascade;
drop table if exists public.billing_config cascade;

-- ---------------------------------------------------------------------------
-- 5. Columns
-- ---------------------------------------------------------------------------
alter table public.profiles
  drop column if exists subscription_plan,
  drop column if exists subscription_interval,
  drop column if exists subscription_status,
  drop column if exists subscription_renews_at,
  drop column if exists is_admin,
  drop column if exists credit_balance,
  drop column if exists credit_granted_period,
  drop column if exists credit_recognized_usd,
  drop column if exists search_spend_month,
  drop column if exists search_usd_spent;

alter table public.sweep_runs
  drop column if exists usd_spent;

-- ---------------------------------------------------------------------------
-- 6. The guard trigger goes with the columns it guarded
-- ---------------------------------------------------------------------------
drop trigger if exists trg_profiles_server_columns on public.profiles;
drop function if exists public.guard_profile_server_columns();

-- ---------------------------------------------------------------------------
-- 7. One flat allowance
-- ---------------------------------------------------------------------------
-- Replaces the per-plan lookup. The ceiling is now a constant, so it can be
-- read without a profile lookup and cannot vary per workspace.
create or replace function public.keyword_limit()
returns integer
language sql
immutable
as $$ select 8; $$;

/** Channels a workspace may scan. */
create or replace function public.channel_limit()
returns integer
language sql
immutable
as $$ select 3; $$;

revoke execute on function public.keyword_limit() from public, anon, authenticated;
revoke execute on function public.channel_limit() from public, anon, authenticated;
grant execute on function public.keyword_limit() to authenticated, service_role;
grant execute on function public.channel_limit() to authenticated, service_role;

-- Keeps the ceiling enforced at the database rather than only in the UI.
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

-- ---------------------------------------------------------------------------
-- 8. Anyone left holding more than the flat allowance
-- ---------------------------------------------------------------------------
-- Dropping plan_keyword_limit would otherwise strand a workspace above the new
-- constant, which would then fail every edit on the table. Trimming the
-- overflow keeps them inside the rules rather than locking them out.
update public.keywords k
   set is_active = false
 where k.is_active
   and (select count(*)
          from public.keywords k2
         where k2.user_id = k.user_id
           and k2.is_active
           and k2.created_at <= k.created_at) > public.keyword_limit();

-- No explicit revoke pass: every object those grants referred to is dropped
-- above, and revoking against an already-dropped relation is itself an error.
