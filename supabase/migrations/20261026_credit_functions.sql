-- ============================================================================
-- Credit billing: the functions that move money and credits
-- ----------------------------------------------------------------------------
-- Every credit balance change in the product goes through grant_credits or
-- spend_credits. Nothing else writes credit_balance. Both take the profile row
-- with FOR UPDATE so two concurrent sweeps cannot both see the same balance and
-- both spend against it, and both accept an idempotency key so a retried webhook
-- or a replayed cron cannot double-allocate.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Grant credits
-- ---------------------------------------------------------------------------
-- Used by a settled payment, by the monthly subscription allowance, and by an
-- admin adjustment.
--
-- p_unit_price_usd is cash received divided by credits granted: the rate at
-- which consuming these credits recognises revenue. Pass 0 for a free grant,
-- which then recognises nothing.
create or replace function public.grant_credits(
  p_user_id uuid,
  p_credits numeric,
  p_source text,
  p_unit_price_usd numeric default 0,
  p_payment_id uuid default null,
  p_kind text default null,
  p_period text default null,
  p_idempotency_key text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_profile   public.profiles%rowtype;
  v_existing  jsonb;
  v_grant_id  uuid;
  v_ledger_id bigint;
  v_balance   numeric;
  v_kind      text;
  v_price     numeric := greatest(coalesce(p_unit_price_usd, 0), 0);
begin
  if p_credits is null or p_credits <= 0 then
    raise exception 'grant_credits: credits must be positive';
  end if;

  v_kind := coalesce(p_kind,
    case p_source
      when 'topup' then 'topup'
      when 'subscription' then 'subscription_grant'
      when 'bonus' then 'bonus'
      else 'adjustment'
    end);

  -- Replay guard. The unique index would reject a duplicate row, but checking
  -- first lets a retry return the original result instead of erroring, which is
  -- what a retried webhook actually needs.
  if p_idempotency_key is not null then
    select jsonb_build_object(
             'duplicate', true,
             'ledger_id', id,
             'grant_id', grant_id,
             'credits_granted', delta,
             'balance_after', balance_after
           )
      into v_existing
      from public.credit_ledger
     where idempotency_key = p_idempotency_key;

    if found then
      return v_existing;
    end if;
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'grant_credits: profile % not found', p_user_id;
  end if;

  v_balance := v_profile.credit_balance + p_credits;

  insert into public.credit_grants (
    user_id, source, payment_id, credits, credits_remaining,
    unit_price_usd, period, expires_at
  ) values (
    p_user_id, p_source, p_payment_id, p_credits, p_credits,
    v_price, p_period,
    -- Purchased credits never expire. The free monthly allowance lapses after a
    -- year so an abandoned account cannot hold a permanent claim on the balance
    -- sheet.
    case when p_source in ('topup', 'bonus') then null
         else now() + interval '365 days' end
  )
  returning id into v_grant_id;

  update public.profiles
     set credit_balance = v_balance,
         credit_granted_period = coalesce(p_period, credit_granted_period),
         updated_at = now()
   where id = p_user_id;

  insert into public.credit_ledger (
    user_id, delta, balance_after, kind, source, grant_id, payment_id,
    revenue_usd, service_cost_usd, note, idempotency_key
  ) values (
    p_user_id, p_credits, v_balance, v_kind, p_source, v_grant_id, p_payment_id,
    -- A grant recognises nothing. The cash it represents is deferred until the
    -- credits are actually spent.
    0, 0, p_note, p_idempotency_key
  )
  returning id into v_ledger_id;

  return jsonb_build_object(
    'duplicate', false,
    'grant_id', v_grant_id,
    'ledger_id', v_ledger_id,
    'credits_granted', p_credits,
    'balance_after', v_balance,
    'unit_price_usd', v_price
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Spend credits, recognising revenue and capturing cost
-- ---------------------------------------------------------------------------
-- Consumes from the oldest live grant first. Expired grants are retired into an
-- expiry ledger row rather than silently deleted, so the balance a user sees
-- always reconciles against the ledger.
--
-- p_allow_overdraft lets the work proceed when the balance is short and records
-- the shortfall as a negative balance instead of dropping it, which is what
-- keeps a workspace running while a top-up settles.
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
  -- Purchased credits carry no expiry and are ordered last, so a lapse in the
  -- monthly allowance takes precedence over money the customer actually paid for.
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

  if v_consumed = 0 and v_needed > 0 and not p_allow_overdraft then
    return jsonb_build_object(
      'ok', false,
      'error', 'insufficient_credits',
      'required', p_credits,
      'balance_after', v_profile.credit_balance
    );
  end if;

  v_balance := v_profile.credit_balance - v_consumed;

  update public.profiles
     set credit_balance = v_balance,
         credit_recognized_usd = credit_recognized_usd + v_recognized,
         updated_at = now()
   where id = p_user_id;

  insert into public.credit_ledger (
    user_id, delta, balance_after, kind, source, ref_type, ref_id,
    revenue_usd, service_cost_usd, idempotency_key, metadata
  ) values (
    p_user_id, -v_consumed, v_balance, 'usage', p_operation, 'operation', p_operation,
    v_recognized, v_cost, p_idempotency_key,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('calls', coalesce(p_calls, 0))
  )
  returning id into v_ledger_id;

  insert into public.usage_events (
    user_id, operation, provider, provider_ref, calls_made,
    credits_charged, service_cost_usd, revenue_usd, ledger_id, metadata
  ) values (
    p_user_id, p_operation, p_provider, p_provider_ref, coalesce(p_calls, 0),
    v_consumed, v_cost, v_recognized, v_ledger_id, p_metadata
  );

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'ledger_id', v_ledger_id,
    'credits_charged', v_consumed,
    'shortfall', v_needed,
    'revenue_recognized', round(v_recognized, 6),
    'service_cost', round(v_cost, 6),
    'balance_after', v_balance
  );
end;
$fn$;
