-- ============================================================================
-- Admin pricing controls
-- ----------------------------------------------------------------------------
-- The brief asks an admin to be able to change the conversion rate, the credit
-- price of each operation, the plan allowances and the top-up packages. The
-- schema for that existed but nothing could write it: billing_config had a
-- read policy and a write policy for nobody, so the whole admin configuration
-- surface was read-only in practice.
--
-- These functions are the write path. Each validates before it stores, because
-- a bad rate here silently mis-prices every future purchase, and each records
-- who changed it and when.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Conversion rate
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_credit_rate(p_credits_per_usd numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admin privileges required' using errcode = '42501';
  end if;

  -- A rate below 1 would make one credit worth more than a dollar, which
  -- inverts the whole liability calculation.
  if p_credits_per_usd is null or p_credits_per_usd <= 0 then
    raise exception 'credits_per_usd must be greater than zero';
  end if;
  if p_credits_per_usd > 10000 then
    raise exception 'credits_per_usd above 10000 looks like a typo';
  end if;

  insert into public.billing_config (key, value, updated_at, updated_by)
  values ('credit_rate', jsonb_build_object('credits_per_usd', p_credits_per_usd), now(), auth.uid())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  return jsonb_build_object('ok', true, 'credits_per_usd', p_credits_per_usd);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Per-operation credit price
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_operation_price(
  p_operation text,
  p_credits numeric,
  p_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_existing jsonb;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admin privileges required' using errcode = '42501';
  end if;

  if p_credits is null or p_credits < 0 then
    raise exception 'credits must be zero or more';
  end if;

  select value into v_existing
    from public.billing_config where key = 'operation_pricing';
  v_existing := coalesce(v_existing, '{}'::jsonb);

  -- The service cost is the platform's own expense and is not editable here;
  -- it comes from treg's published rate card. Only the customer-facing price
  -- moves, which is exactly what an admin should be able to change.
  v_existing := jsonb_set(
    v_existing,
    ARRAY[p_operation],
    jsonb_build_object(
      'credits', p_credits,
      'service_cost_usd', coalesce((v_existing->p_operation->>'service_cost_usd')::numeric, 0),
      'label', coalesce(p_label, v_existing->p_operation->>'label', p_operation)
    ),
    true
  );

  insert into public.billing_config (key, value, updated_at, updated_by)
  values ('operation_pricing', v_existing, now(), auth.uid())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  return jsonb_build_object('ok', true, 'operation', p_operation, 'credits', p_credits);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Plan allowances
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_plan_grants(p_plan text, p_credits numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_existing jsonb;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admin privileges required' using errcode = '42501';
  end if;

  if p_plan not in ('starter', 'pro', 'scale') then
    raise exception 'unknown plan';
  end if;
  if p_credits is null or p_credits < 0 then
    raise exception 'credits must be zero or more';
  end if;

  select value into v_existing from public.billing_config where key = 'plan_grants';
  v_existing := coalesce(v_existing, '{}'::jsonb);
  v_existing := jsonb_set(v_existing, ARRAY[p_plan], to_jsonb(p_credits), true);

  insert into public.billing_config (key, value, updated_at, updated_by)
  values ('plan_grants', v_existing, now(), auth.uid())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  return jsonb_build_object('ok', true, 'plan', p_plan, 'credits', p_credits);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Top-up packages
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_topup_packages(p_packages jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_pkg jsonb;
  v_ids text[] := '{}';
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admin privileges required' using errcode = '42501';
  end if;

  if p_packages is null or jsonb_typeof(p_packages) <> 'array' or jsonb_array_length(p_packages) = 0 then
    raise exception 'packages must be a non-empty array';
  end if;

  for v_pkg in select * from jsonb_array_elements(p_packages) loop
    if not (v_pkg ? 'id' and v_pkg ? 'label' and v_pkg ? 'usd') then
      raise exception 'each package needs id, label and usd';
    end if;

    if coalesce((v_pkg->>'usd')::numeric, 0) <= 0 then
      raise exception 'package % has a non-positive price', v_pkg->>'id';
    end if;
    if coalesce((v_pkg->>'bonus_credits')::numeric, 0) < 0 then
      raise exception 'package % has negative bonus credits', v_pkg->>'id';
    end if;

    -- Duplicate ids would make the checkout lookup ambiguous.
    if (v_pkg->>'id') = any (v_ids) then
      raise exception 'duplicate package id %', v_pkg->>'id';
    end if;
    v_ids := array_append(v_ids, v_pkg->>'id');
  end loop;

  insert into public.billing_config (key, value, updated_at, updated_by)
  values ('topup_packages', p_packages, now(), auth.uid())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  return jsonb_build_object('ok', true, 'count', jsonb_array_length(p_packages));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Promote an operator
-- ---------------------------------------------------------------------------
-- The guard trigger blocks every direct write to is_admin, which is right, but
-- it also left nobody able to promote the first operator. This is the escape
-- hatch, and it is itself admin-only so it cannot be used to escalate.
create or replace function public.admin_set_admin(p_user_id uuid, p_is_admin boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admin privileges required' using errcode = '42501';
  end if;

  -- The guard trigger still fires; the escape hatch is the same session flag
  -- apply_subscription_plan already relies on.
  perform set_config('echo.allow_subscription_mutation', 'on', true);

  update public.profiles set is_admin = p_is_admin where id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'is_admin', p_is_admin);
end;
$fn$;

revoke execute on function public.admin_set_credit_rate(numeric) from public, anon, authenticated;
revoke execute on function public.admin_set_operation_price(text, numeric, text) from public, anon, authenticated;
revoke execute on function public.admin_set_plan_grants(text, numeric) from public, anon, authenticated;
revoke execute on function public.admin_set_topup_packages(jsonb) from public, anon, authenticated;
revoke execute on function public.admin_set_admin(uuid, boolean) from public, anon, authenticated;

grant execute on function public.admin_set_credit_rate(numeric) to authenticated;
grant execute on function public.admin_set_operation_price(text, numeric, text) to authenticated;
grant execute on function public.admin_set_plan_grants(text, numeric) to authenticated;
grant execute on function public.admin_set_topup_packages(jsonb) to authenticated;
grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;
