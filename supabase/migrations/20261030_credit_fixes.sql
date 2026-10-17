-- ============================================================================
-- Fixing the credit meter's three real defects
-- ----------------------------------------------------------------------------
-- 1. UNBOUNDED FREE USAGE (a direct cost to the business)
--    spend_credits only ever decremented the balance by what it actually found
--    in a grant. With no grants left, v_consumed stayed 0, so the shortfall was
--    recorded in the ledger and then discarded: the balance never moved off 0,
--    nothing was charged, no revenue was recognised, and the sweep ran again on
--    the next cron tick. A workspace with no credits got unlimited free search.
--    Proven live: three sweeps, 750 provider calls, $4.32 of treg spend, zero
--    credits charged and a balance that never left 0.00.
--
-- 2. PREDICTABLE BILLING
--    Credits were tallied per provider call. A Reddit keyword whose primary
--    returned nothing falls through to the fallback, which is a second billed
--    call, so the same keyword cost 2 credits one sweep and 4 the next. The
--    customer was billed for the retry rather than for the result.
--
-- 3. NO MONTHLY ALLOWANCE
--    plan_grants was configured but nothing ever handed it out. A new
--    workspace started at zero credits, immediately hit defect 1, and served
--    everything for free.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bounded, real overdraft
-- ---------------------------------------------------------------------------
create or replace function public.spend_credits(
  p_user_id uuid,
  p_credits numeric,
  p_operation text,
  p_service_cost_usd numeric default 0,
  p_calls integer default 0,
  p_provider text default null,
  p_provider_ref text default null,
  p_allow_overdraft boolean default false,
  p_idempotency_key text default null,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_profile     public.profiles%rowtype;
  v_existing    jsonb;
  v_needed      numeric := greatest(coalesce(p_credits, 0), 0);
  v_cost        numeric := greatest(coalesce(p_service_cost_usd, 0), 0);
  v_take        numeric;
  v_expired     numeric;
  v_row         record;
  v_balance     numeric;
  v_ledger_id   bigint;
  v_recognized  numeric := 0;
  v_consumed    numeric := 0;
  v_deficit     numeric := 0;
  -- How far past zero a workspace may be carried by a single operation. One
  -- sweep at the plan's maximum keyword and channel count, so an in-flight
  -- top-up is never cut off mid-run but the debt cannot compound.
  v_overdraft   numeric := 500;
  v_now         timestamptz := now();
begin
  if p_idempotency_key is not null then
    select jsonb_build_object('duplicate', true, 'balance_after', balance_after)
      into v_existing
      from public.credit_ledger
     where idempotency_key = p_idempotency_key;
    if found then
      return v_existing;
    end if;
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'spend_credits: profile % not found', p_user_id;
  end if;

  -- ---- retire lapsed allowances -------------------------------------------
  for v_row in
    select id, credits_remaining
      from public.credit_grants
     where user_id = p_user_id
       and credits_remaining > 0
       and expires_at is not null
       and expires_at <= v_now
     order by granted_at
     for update
  loop
    v_expired := v_row.credits_remaining;
    update public.credit_grants set credits_remaining = 0 where id = v_row.id;

    v_balance := v_profile.credit_balance - v_expired;
    v_profile.credit_balance := v_balance;
    update public.profiles set credit_balance = v_balance where id = p_user_id;

    insert into public.credit_ledger (
      user_id, delta, balance_after, kind, source, grant_id, revenue_usd, note
    ) values (
      p_user_id, -v_expired, v_balance, 'expiry', 'expiration', v_row.id,
      0, 'Unused allowance expired'
    );
  end loop;

  -- ---- consume, oldest live grant first -----------------------------------
  for v_row in
    select id, credits_remaining, unit_price_usd
      from public.credit_grants
     where user_id = p_user_id
       and credits_remaining > 0
       and (expires_at is null or expires_at > v_now)
     order by expires_at nulls last, granted_at
     for update
  loop
    exit when v_needed <= 0;

    v_take := least(v_needed, v_row.credits_remaining);

    update public.credit_grants
       set credits_remaining = credits_remaining - v_take
     where id = v_row.id;

    v_recognized := v_recognized + (v_take * v_row.unit_price_usd);
    v_consumed := v_consumed + v_take;
    v_needed := v_needed - v_take;
  end loop;

  v_deficit := v_needed;

  -- Not affordable. Refusing is the whole point: the previous version charged
  -- nothing and served the request anyway.
  if v_deficit > 0 and not p_allow_overdraft then
    return jsonb_build_object(
      'ok', false,
      'error', 'insufficient_credits',
      'required', p_credits,
      'available', v_consumed,
      'balance_after', v_profile.credit_balance
    );
  end if;

  if v_deficit > 0 then
    -- Overdraft permitted, but the debt has to land on the balance. Capped so a
    -- workspace cannot sink further than one sweep's worth no matter how many
    -- times it is retried.
    v_deficit := least(v_deficit, greatest(v_overdraft + v_profile.credit_balance, 0));
  end if;

  v_balance := v_profile.credit_balance - v_consumed - v_deficit;

  update public.profiles
     set credit_balance = v_balance,
         credit_recognized_usd = credit_recognized_usd + v_recognized,
         updated_at = now()
   where id = p_user_id;

  insert into public.credit_ledger (
    user_id, delta, balance_after, kind, source, ref_type, ref_id,
    revenue_usd, service_cost_usd, idempotency_key, metadata
  ) values (
    p_user_id, -(v_consumed + v_deficit), v_balance, 'usage', p_operation,
    'operation', p_operation,
    v_recognized, v_cost, p_idempotency_key,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'calls', coalesce(p_calls, 0),
      'charged', v_consumed,
      'overdraft', v_deficit
    )
  )
  returning id into v_ledger_id;

  if v_consumed + v_deficit > 0 then
    insert into public.usage_events (
      user_id, operation, provider, provider_ref, calls_made,
      credits_charged, service_cost_usd, revenue_usd, ledger_id, metadata
    ) values (
      p_user_id, p_operation, p_provider, p_provider_ref, coalesce(p_calls, 0),
      v_consumed + v_deficit, v_cost, v_recognized, v_ledger_id,
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('overdraft', v_deficit)
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'ledger_id', v_ledger_id,
    'credits_charged', v_consumed,
    'overdraft', v_deficit,
    'shortfall', v_deficit,
    'revenue_recognized', round(v_recognized, 6),
    'service_cost', round(v_cost, 6),
    'balance_after', v_balance
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Can this workspace afford the sweep it is about to run?
-- ---------------------------------------------------------------------------
-- Checked before any treg call, so an empty workspace costs nothing instead of
-- being discovered only after the money is gone.
create or replace function public.can_afford_sweep(p_user_id uuid, p_keywords int, p_channels text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_balance numeric;
  v_pricing jsonb;
  v_needed   numeric := 0;
  v_op      text;
  v_ch      text;
begin
  select credit_balance into v_balance from public.profiles where id = p_user_id;
  if v_balance is null then
    return jsonb_build_object('ok', false, 'required', 0, 'balance', 0);
  end if;

  select value into v_pricing from public.billing_config where key = 'operation_pricing';

  -- One keyword sweep of each requested channel. Charges are per logical
  -- operation, not per provider call, so the fallback retry does not bill twice.
  foreach v_ch in array coalesce(p_channels, array[]::text[]) loop
    v_op := 'sweep_call_' || v_ch;
    v_needed := v_needed + greatest(p_keywords, 0) * coalesce((v_pricing->v_op->>'credits')::numeric, 0);
  end loop;

  return jsonb_build_object(
    'ok', v_balance >= v_needed,
    'required', v_needed,
    'balance', v_balance
  );
end;
$fn$;

revoke execute on function public.can_afford_sweep(uuid, integer, text[]) from public, anon, authenticated;
grant execute on function public.can_afford_sweep(uuid, integer, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- Hand out the plan allowance
-- ---------------------------------------------------------------------------
-- Idempotent per (user, period) so the hourly cron can call it for everyone on
-- every tick without double granting. Returns true only when it actually
-- granted.
create or replace function public.ensure_monthly_allowance(p_user_id uuid, p_period text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_plan   text;
  v_period text := coalesce(p_period, to_char(now() at time zone 'utc', 'YYYY-MM'));
  v_grant  numeric;
  v_prev   text;
begin
  select subscription_plan, credit_granted_period
    into v_plan, v_prev
    from public.profiles
   where id = p_user_id
     and coalesce(subscription_status, 'active') = 'active';

  if not found then
    return jsonb_build_object('granted', false, 'reason', 'no_active_subscription');
  end if;

  -- Already handed out for this period.
  if v_prev = v_period then
    return jsonb_build_object('granted', false, 'reason', 'already_granted');
  end if;

  v_grant := public.plan_credit_grant(v_plan);
  if v_grant is null or v_grant <= 0 then
    return jsonb_build_object('granted', false, 'reason', 'no_allowance_configured');
  end if;

  -- A free allowance carries no unit price, so it recognises no revenue. The
  -- subscription itself is what was paid for; this is the right to consume it.
  perform public.grant_credits(
    p_user_id, v_grant, 'subscription', 0, null,
    'subscription_grant', v_period,
    'allowance:' || p_user_id || ':' || v_period,
    'Monthly allowance for ' || v_period
  );

  return jsonb_build_object('granted', true, 'credits', v_grant, 'period', v_period);
end;
$fn$;

revoke execute on function public.ensure_monthly_allowance(uuid, text) from public, anon, authenticated;
grant execute on function public.ensure_monthly_allowance(uuid, text) to service_role;
