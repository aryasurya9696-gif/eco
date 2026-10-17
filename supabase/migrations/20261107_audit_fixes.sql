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