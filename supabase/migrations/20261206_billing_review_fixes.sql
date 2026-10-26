-- ============================================================================
-- Migration: 20261206_billing_review_fixes.sql
-- Description: Refunds and disputes that land while credits are on hold.
--
--   1. credit_grants.revoke_pending: credits a refund or dispute is owed but
--      could not take yet, because they were held by an in-flight job.
--      Previously that part was simply never taken back: a refund during a
--      bulk reveal left the customer with the money and the credits.
--   2. wallet_spendable: owed credits are not spendable.
--   3. wallet_revoke_grant:
--        - locks the wallet before the grant, the same order as wallet_settle,
--          so a refund and a settle for one user can no longer deadlock;
--        - a purchased grant is capped by what paid-only spending could still
--          use, not by welcome credits that happen to be free;
--        - whatever it cannot take now is recorded as revoke_pending.
--   4. wallet_collect_pending: takes owed credits once they are free. Called
--      whenever a hold closes (wallet_settle, wallet_release).
--   5. wallet_dispute_order: a dispute decided for the merchant clears what
--      was still owed.
--   6. wallet_topup_from_order: an order whose account was deleted is parked
--      for review instead of failing on every webhook retry.
--
-- Same signatures as before; idempotent.
-- ============================================================================

-- 1. ---------------------------------------------------------------------------
alter table public.credit_grants add column if not exists revoke_pending numeric(20,6) not null default 0;

do $rp_check$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.credit_grants'::regclass and conname = 'credit_grants_revoke_pending_check') then
    alter table public.credit_grants add constraint credit_grants_revoke_pending_check check (revoke_pending >= 0);
  end if;
end
$rp_check$;

comment on column public.credit_grants.revoke_pending is
  'Credits a refund or dispute is owed from this grant but could not take while they were on hold. Not spendable; taken by wallet_collect_pending when a hold closes.';

-- 2. ---------------------------------------------------------------------------
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
  v_owed      numeric := 0;
  v_held_paid numeric := 0;
  v_held_any  numeric := 0;
  v_available numeric;
  v_avail_paid numeric;
begin
  select coalesce(balance, 0), coalesce(reserved, 0)
    into v_balance, v_reserved
    from public.wallet where user_id = p_user_id;

  -- Owed credits (revoke_pending) are counted as gone.
  select coalesce(sum(greatest(credits_remaining - revoke_pending, 0)) filter (where source <> 'grant'), 0),
         coalesce(sum(greatest(credits_remaining - revoke_pending, 0)) filter (where source = 'grant'), 0),
         coalesce(sum(least(revoke_pending, credits_remaining)), 0)
    into v_paid, v_free, v_owed
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
  v_available  := least(coalesce(v_balance, 0) - v_owed, v_paid + v_free)
                  - greatest(coalesce(v_reserved, 0), v_held_paid + v_held_any);
  v_avail_paid := least(v_available, v_paid - v_held_paid - greatest(v_held_any - v_free, 0));

  return jsonb_build_object(
    'balance',        coalesce(v_balance, 0),
    'reserved',       coalesce(v_reserved, 0),
    'paid_remaining', v_paid,
    'free_remaining', v_free,
    'owed',           v_owed,
    'held_paid_only', v_held_paid,
    'held_any',       v_held_any,
    'available',      greatest(v_available, 0),
    'available_paid', greatest(v_avail_paid, 0)
  );
end;
$fn$;

revoke execute on function public.wallet_spendable(uuid) from public, anon, authenticated;
grant  execute on function public.wallet_spendable(uuid) to service_role;

-- 3. ---------------------------------------------------------------------------
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
  v_user     uuid;
  v_grant    public.credit_grants%rowtype;
  v_wallet   public.wallet%rowtype;
  v_spend    jsonb;
  v_cap      numeric;
  v_due      numeric;
  v_take     numeric;
  v_pending  numeric;
  v_new_bal  numeric;
  v_prior    public.credit_ledger%rowtype;
begin
  -- Wallet first, then the grant: the order wallet_settle locks them in.
  select user_id into v_user from public.credit_grants where id = p_grant_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;
  if v_user is not null then
    select * into v_wallet from public.wallet where user_id = v_user for update;
  end if;

  select * into v_grant from public.credit_grants where id = p_grant_id for update;

  if p_idempotency_key is not null then
    select * into v_prior from public.credit_ledger where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'revoked', -v_prior.delta,
                                'balance_after', v_prior.balance_after);
    end if;
  end if;

  if v_grant.credits_remaining <= 0 then
    update public.credit_grants set revoke_pending = 0 where id = p_grant_id and revoke_pending <> 0;
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'already_fully_spent');
  end if;

  if v_grant.user_id is null then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'owner_deleted');
  end if;

  -- What is owed in total: earlier shortfalls plus this request.
  v_due := least(
    v_grant.credits_remaining,
    v_grant.revoke_pending
      + case when p_credits is null then v_grant.credits_remaining else greatest(p_credits, 0) end
  );

  -- Only credits no job is holding. A purchased grant can only be funding
  -- paid-only work, so it is capped by what paid-only spending could use; this
  -- grant's own owed credits were excluded from that figure, so they are added
  -- back here.
  v_spend := public.wallet_spendable(v_grant.user_id);
  v_cap := case when v_grant.source = 'grant' then (v_spend->>'available')::numeric
                else (v_spend->>'available_paid')::numeric end
           + least(v_grant.revoke_pending, v_grant.credits_remaining);

  v_take    := greatest(least(v_grant.credits_remaining, v_cap, v_due), 0);
  v_pending := greatest(least(v_grant.credits_remaining - v_take, v_due - v_take), 0);

  if v_take <= 0 then
    update public.credit_grants set revoke_pending = v_pending where id = p_grant_id;
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'nothing_spendable', 'pending', v_pending);
  end if;

  v_new_bal := v_wallet.balance - v_take;

  update public.credit_grants
     set credits_remaining = credits_remaining - v_take,
         revoke_pending    = v_pending
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
    jsonb_build_object('unit_price_usd', v_grant.unit_price_usd, 'source', v_grant.source,
                       'pending_after', v_pending)
  );

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'revoked', v_take,
    'pending', v_pending,
    'unrevokable', v_grant.credits_remaining - v_take - v_pending,
    'balance_after', v_new_bal
  );
end;
$fn$;

revoke execute on function public.wallet_revoke_grant(uuid, text, numeric, text) from public, anon, authenticated;
grant  execute on function public.wallet_revoke_grant(uuid, text, numeric, text) to service_role;

-- 4. ---------------------------------------------------------------------------
create or replace function public.wallet_collect_pending(p_user_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grant record;
  v_out   jsonb;
  v_total numeric := 0;
begin
  if p_user_id is null then
    return 0;
  end if;
  for v_grant in
    select id from public.credit_grants
     where user_id = p_user_id and revoke_pending > 0
     order by created_at
  loop
    v_out := public.wallet_revoke_grant(v_grant.id, 'refund (collected after hold)', 0, null);
    v_total := v_total + coalesce((v_out->>'revoked')::numeric, 0);
  end loop;
  return v_total;
end;
$fn$;

revoke execute on function public.wallet_collect_pending(uuid) from public, anon, authenticated;
grant  execute on function public.wallet_collect_pending(uuid) to service_role;

-- 5. wallet_settle / wallet_release: unchanged, plus collecting what is owed ----
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
         set credits_remaining = credits_remaining - v_take,
             -- Work that was held before a refund is paid for from the grant;
             -- what it used can no longer be owed.
             revoke_pending    = least(revoke_pending, credits_remaining - v_take)
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

  -- What the hold no longer needs may be owed to a refund.
  perform public.wallet_collect_pending(v_res.user_id);

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
    -- Credits the hold returns may be owed to a refund.
    perform public.wallet_collect_pending(v_res.user_id);
  end if;

  return jsonb_build_object('ok', true, 'released', v_res.credits_held,
                            'balance_after', v_wallet.balance);
end;
$fn$;

revoke execute on function public.wallet_release(uuid, text) from public, anon, authenticated;
grant  execute on function public.wallet_release(uuid, text) to service_role;

-- 6. ---------------------------------------------------------------------------
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
    -- The merchant kept the money: nothing more is owed. Credits already
    -- frozen are not re-granted automatically (only payment.succeeded creates
    -- credits); restore them by hand if appropriate.
    update public.credit_grants set revoke_pending = 0 where payment_order_id = p_order_id;
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

-- 7. ---------------------------------------------------------------------------
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

  -- The account was deleted before the payment landed: there is no wallet to
  -- credit. Parked for a human (refund the customer) instead of failing on
  -- every webhook retry.
  if v_order.user_id is null then
    update public.payment_orders
       set status = 'review', review_reason = 'account_deleted_before_payment',
           paid_amount_usd = p_paid_usd, provider_ref = coalesce(p_provider_ref, provider_ref)
     where id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'account_deleted');
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
