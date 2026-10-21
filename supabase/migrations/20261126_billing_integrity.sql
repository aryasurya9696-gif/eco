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
