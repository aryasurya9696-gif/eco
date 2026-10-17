-- ============================================================================
-- Credit wallet — the functions
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