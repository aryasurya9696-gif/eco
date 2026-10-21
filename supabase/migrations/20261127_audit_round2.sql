-- ============================================================================
-- Migration: 20261127_audit_round2.sql
-- Description: Audit round 2 (docs/audit/AUDIT-2026-10.md, sections D, E, H).
--
--  1. Paid-only reserves (owner decision: welcome credits are for feed sweeps
--     only). wallet_reserve gains p_paid_only; the flag is stored on the hold
--     and wallet_settle then draws only purchased grants for it. Ordinary holds
--     draw welcome credits first, so paid credits stay available for Leads and
--     Mail. N7 comment corrected.
--  2. M7: reserve counts only unexpired grants, the same set settle draws.
--  3. H7: refunds and disputes are one atomic SQL call each. Revokes carry a
--     unique ledger key (refund:<order>:<refund id>), every refund is recorded
--     once per (order, refund id), a refund in another currency is parked in
--     'review', and a webhook delivery is claimed under a row lock so a
--     parallel redelivery cannot be processed twice.
--  4. Reaper: settles stale holds from api_usage.reservation_id sums (Leads now
--     writes reservation_id, H6), closes holds of deleted users, and has its own
--     pg_cron schedule.
--  5. Pricing (owner decisions, treg catalog Oct 2026), applied once: people
--     search 1 credit per billed provider call, extra_50 off, email 1, phone 2,
--     X/Reddit/Web 0.1 per keyword, News free. Credits are numeric(20,6), so
--     fractional prices need no schema change.
--  6. M9: pricing_audit records INSERT/UPDATE/DELETE with changed_by, on
--     pricing_config and topup_packages.
--  7. M8: owners can no longer read cost/revenue columns; financial rows survive
--     account deletion (user_id set null) instead of cascading away.
--  8. N4: v_platform_totals in the right units, with refunds/disputes/revokes.
--  9. N5: indexes on the reaper/webhook hot paths and the mail foreign keys.
-- 10. N6: the hourly sweep cron is built from service_secrets.project_url
--     instead of a REPLACE_WITH_PROJECT_REF literal.
-- 11. N16: take_rate_limit validates its window.
--
-- Replayable: every statement is guarded or idempotent, and the pricing change
-- runs once (public.data_migrations), so a re-run never reverts a later edit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. One-shot data changes are recorded here, so a re-run of this file (or of
--    deploy-all.sql) can never apply them a second time.
-- ---------------------------------------------------------------------------
create table if not exists public.data_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
alter table public.data_migrations enable row level security;
revoke all on public.data_migrations from public, anon, authenticated;
grant select, insert on public.data_migrations to service_role;

-- ---------------------------------------------------------------------------
-- 1. Holds remember whether they may only use purchased credits
-- ---------------------------------------------------------------------------
alter table public.reservations
  add column if not exists paid_only boolean not null default false;

comment on column public.reservations.paid_only is
  'true: this hold may only be settled from purchased grants (source <> ''grant''). Welcome credits are for feed sweeps only.';

-- ---------------------------------------------------------------------------
-- 2. What a workspace can spend right now
--
-- A grant counts only while it is unexpired (M7): settle cannot draw an expired
-- grant, so counting it at reserve time made the work free.
--
-- "Free" credits are grants with source = 'grant' (the welcome grant, and any
-- promotional grant issued the same way). Everything else (topup, bonus,
-- adjustment) came with a purchase or from support and is "paid".
--
-- Ordinary holds draw free credits first, so for every open hold to remain
-- settleable at once, paid credits must cover the paid-only holds plus whatever
-- part of the ordinary holds the free credits cannot:
--
--   available_paid = paid - held_paid - max(held_any - free, 0)
-- ---------------------------------------------------------------------------
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
  v_held_paid numeric := 0;
  v_held_any  numeric := 0;
  v_available numeric;
  v_avail_paid numeric;
begin
  select coalesce(balance, 0), coalesce(reserved, 0)
    into v_balance, v_reserved
    from public.wallet where user_id = p_user_id;

  select coalesce(sum(credits_remaining) filter (where source <> 'grant'), 0),
         coalesce(sum(credits_remaining) filter (where source = 'grant'), 0)
    into v_paid, v_free
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
  v_available  := least(coalesce(v_balance, 0), v_paid + v_free)
                  - greatest(coalesce(v_reserved, 0), v_held_paid + v_held_any);
  v_avail_paid := least(v_available, v_paid - v_held_paid - greatest(v_held_any - v_free, 0));

  return jsonb_build_object(
    'balance',        coalesce(v_balance, 0),
    'reserved',       coalesce(v_reserved, 0),
    'paid_remaining', v_paid,
    'free_remaining', v_free,
    'held_paid_only', v_held_paid,
    'held_any',       v_held_any,
    'available',      greatest(v_available, 0),
    'available_paid', greatest(v_avail_paid, 0)
  );
end;
$fn$;

revoke execute on function public.wallet_spendable(uuid) from public, anon, authenticated;
grant  execute on function public.wallet_spendable(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. wallet_reserve with p_paid_only
--
-- The 4-argument version is dropped so a PostgREST call with named arguments
-- has exactly one candidate. Callers that do not pass p_paid_only get false,
-- which is the old behaviour (any unexpired credit).
-- ---------------------------------------------------------------------------
drop function if exists public.wallet_reserve(uuid, numeric, text, jsonb);

create or replace function public.wallet_reserve(
  p_user_id         uuid,
  p_credits         numeric,
  p_idempotency_key text,
  p_context         jsonb   default null,
  p_paid_only       boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_wallet      public.wallet%rowtype;
  v_needed      numeric := greatest(coalesce(p_credits, 0), 0);
  v_paid_only   boolean := coalesce(p_paid_only, false);
  v_spend       jsonb;
  v_available   numeric;
  v_existing    public.reservations%rowtype;
  v_reservation uuid;
begin
  if v_needed <= 0 then
    return jsonb_build_object('ok', true, 'reserved', 0, 'reservation_id', null,
                              'paid_only', v_paid_only);
  end if;

  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'wallet_reserve: idempotency_key is required';
  end if;

  -- A retried request reuses the same hold rather than stacking a second one.
  select * into v_existing from public.reservations where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'reservation_id', v_existing.id,
      'reserved', v_existing.credits_held,
      'paid_only', v_existing.paid_only
    );
  end if;

  insert into public.wallet (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

  -- Serialises every reserve, settle, release, grant and revoke for this wallet.
  select * into v_wallet from public.wallet where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet_reserve: wallet % not found', p_user_id;
  end if;

  -- A concurrent caller with the same key may have committed while we waited.
  select * into v_existing from public.reservations where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'reservation_id', v_existing.id,
      'reserved', v_existing.credits_held, 'paid_only', v_existing.paid_only);
  end if;

  v_spend := public.wallet_spendable(p_user_id);
  v_available := case when v_paid_only then (v_spend->>'available_paid')::numeric
                      else (v_spend->>'available')::numeric end;

  if v_available < v_needed then
    return jsonb_build_object(
      'ok', false,
      -- Distinct reason for a paid-only refusal, so callers can say "purchased
      -- credits" instead of a plain "not enough credits".
      'error', case when v_paid_only then 'insufficient_paid_credits' else 'insufficient_credits' end,
      'reason', case when v_paid_only then 'paid_credits_required' else 'insufficient_balance' end,
      'required', v_needed,
      'available', greatest(v_available, 0),
      'shortfall', v_needed - greatest(v_available, 0),
      'paid_only', v_paid_only,
      -- Lets the caller say "your free credits only cover feed sweeps".
      'free_available', case when v_paid_only
                             then greatest((v_spend->>'available')::numeric - v_available, 0)
                             else 0 end,
      'balance_after', v_wallet.balance
    );
  end if;

  insert into public.reservations (
    user_id, idempotency_key, credits_held, status, context, paid_only
  ) values (
    p_user_id, p_idempotency_key, v_needed, 'held', coalesce(p_context, '{}'::jsonb), v_paid_only
  ) returning id into v_reservation;

  update public.wallet
     set reserved   = reserved + v_needed,
         updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'reservation_id', v_reservation,
    'reserved', v_needed,
    'paid_only', v_paid_only,
    'available_after', v_available - v_needed,
    'balance_after', v_wallet.balance
  );
end;
$fn$;

revoke execute on function public.wallet_reserve(uuid, numeric, text, jsonb, boolean) from public, anon, authenticated;
grant  execute on function public.wallet_reserve(uuid, numeric, text, jsonb, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 4. wallet_settle: paid-only holds draw only purchased grants; ordinary holds
--    draw free credits first. Same signature as 20261103.
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
         set credits_remaining = credits_remaining - v_take
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

-- wallet_release: same as 20261103, plus a hold whose owner was deleted.
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
  end if;

  return jsonb_build_object('ok', true, 'released', v_res.credits_held,
                            'balance_after', v_wallet.balance);
end;
$fn$;

revoke execute on function public.wallet_release(uuid, text) from public, anon, authenticated;
grant  execute on function public.wallet_release(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. wallet_revoke_grant with an idempotency key (H7)
--
-- The key is checked after the grant row lock, so two parallel calls with the
-- same key serialise and the second one returns duplicate. The unique index on
-- credit_ledger.idempotency_key backs it up. The unit price of the revoked
-- credits is kept in the ledger metadata for v_platform_totals.
-- ---------------------------------------------------------------------------
drop function if exists public.wallet_revoke_grant(uuid, text, numeric);
drop function if exists public.wallet_revoke_grant(uuid, text);

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
  v_grant    public.credit_grants%rowtype;
  v_wallet   public.wallet%rowtype;
  v_take     numeric;
  v_new_bal  numeric;
  v_prior    public.credit_ledger%rowtype;
begin
  select * into v_grant from public.credit_grants where id = p_grant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;

  if p_idempotency_key is not null then
    select * into v_prior from public.credit_ledger where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'revoked', -v_prior.delta,
                                'balance_after', v_prior.balance_after);
    end if;
  end if;

  if v_grant.credits_remaining <= 0 then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'already_fully_spent');
  end if;

  if v_grant.user_id is null then
    return jsonb_build_object('ok', true, 'revoked', 0, 'reason', 'owner_deleted');
  end if;

  select * into v_wallet from public.wallet where user_id = v_grant.user_id for update;

  -- Only the spendable part: credits on hold belong to an in-flight job.
  v_take := least(
    v_grant.credits_remaining,
    greatest(coalesce(v_wallet.balance, 0) - coalesce(v_wallet.reserved, 0), 0),
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
    user_id, delta, balance_after, kind, grant_id, payment_order_id,
    revenue_usd, idempotency_key, note, metadata
  ) values (
    v_grant.user_id, -v_take, v_new_bal, 'reversal', p_grant_id, v_grant.payment_order_id,
    0, p_idempotency_key, coalesce(p_reason, 'refund'),
    jsonb_build_object('unit_price_usd', v_grant.unit_price_usd, 'source', v_grant.source)
  );

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'revoked', v_take,
    'unrevokable', v_grant.credits_remaining - v_take,
    'balance_after', v_new_bal
  );
end;
$fn$;

revoke execute on function public.wallet_revoke_grant(uuid, text, numeric, text) from public, anon, authenticated;
grant  execute on function public.wallet_revoke_grant(uuid, text, numeric, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Refunds, atomically (H7)
--
-- One row per (order, refund key). A refund event adds its amount; a payment-
-- level "refunded" event carries the payment's cumulative refunded total. The
-- order's refunded amount is max(sum of refunds, largest cumulative total),
-- clipped to the gross, so a refund.succeeded and a payment.refunded for the
-- same money count it once in either order.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_refunds (
  order_id    uuid not null references public.payment_orders(id) on delete cascade,
  refund_key  text not null,
  kind        text not null check (kind in ('refund', 'cumulative')),
  amount      numeric(20,6) not null check (amount >= 0),
  currency    text,
  webhook_id  text,
  created_at  timestamptz not null default now(),
  primary key (order_id, refund_key)
);
alter table public.payment_refunds enable row level security;
revoke all on public.payment_refunds from public, anon, authenticated;
grant select, insert on public.payment_refunds to service_role;

create or replace function public.wallet_refund_order(
  p_order_id   uuid,
  p_refund_id  text,
  p_amount     numeric default null,
  p_currency   text    default null,
  p_cumulative boolean default false,
  p_webhook_id text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_order     public.payment_orders%rowtype;
  v_key       text;
  v_amount    numeric;
  v_old       numeric;
  v_new       numeric;
  v_fraction  numeric;
  v_grant     record;
  v_out       jsonb;
  v_revoked   numeric := 0;
  v_status    text;
  v_base      text;
begin
  -- Serialises every refund, dispute and top-up for this order.
  select * into v_order from public.payment_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  v_key := case when coalesce(p_cumulative, false)
                then 'cumulative:' || coalesce(nullif(p_refund_id, ''), round(p_amount, 2)::text, 'full')
                else nullif(p_refund_id, '') end;
  if v_key is null then
    return jsonb_build_object('ok', false, 'error', 'refund_id_required');
  end if;

  -- A refund in another currency cannot be converted into a share of the
  -- order here. Parked for a human; nothing is revoked.
  if p_currency is not null and upper(p_currency) <> upper(v_order.currency) then
    update public.payment_orders
       set status = 'review',
           review_reason = 'refund_currency_mismatch: ' || upper(p_currency) || ' refund '
                           || v_key || ' on ' || upper(v_order.currency) || ' order'
     where id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'currency_mismatch', 'parked', true);
  end if;

  v_old := least(coalesce(v_order.refunded_usd, 0), v_order.gross_usd);
  v_amount := greatest(coalesce(p_amount, v_order.gross_usd - v_old), 0);

  -- When this refund key has been seen, this is a redelivery: nothing to do.
  insert into public.payment_refunds (order_id, refund_key, kind, amount, currency, webhook_id)
  values (p_order_id, v_key,
          case when coalesce(p_cumulative, false) then 'cumulative' else 'refund' end,
          v_amount, upper(coalesce(p_currency, v_order.currency)), p_webhook_id)
  on conflict (order_id, refund_key) do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'refunded_usd', v_old);
  end if;

  select least(v_order.gross_usd,
               greatest(coalesce(sum(amount) filter (where kind = 'refund'), 0),
                        coalesce(max(amount) filter (where kind = 'cumulative'), 0),
                        v_old))
    into v_new
    from public.payment_refunds where order_id = p_order_id;

  v_fraction := case when v_order.gross_usd > 0
                     then greatest(v_new - v_old, 0) / v_order.gross_usd else 1 end;

  v_base := 'refund:' || p_order_id::text || ':' || v_key;

  if v_fraction > 0 then
    for v_grant in
      select id, credits, source from public.credit_grants
       where payment_order_id = p_order_id
       order by case when source = 'topup' then 0 else 1 end, created_at
    loop
      v_out := public.wallet_revoke_grant(
        v_grant.id, 'refund', v_grant.credits * v_fraction,
        case when v_grant.source = 'topup' then v_base else v_base || ':' || v_grant.source end);
      if coalesce((v_out->>'ok')::boolean, false) is false then
        raise exception 'wallet_refund_order: revoke of grant % failed: %', v_grant.id, v_out;
      end if;
      -- A replayed key reports the original revoke; count only new ones.
      if not coalesce((v_out->>'duplicate')::boolean, false) then
        v_revoked := v_revoked + coalesce((v_out->>'revoked')::numeric, 0);
      end if;
    end loop;
  end if;

  v_status := case
                when v_order.status in ('disputed', 'review') then v_order.status
                when v_new + 0.005 >= v_order.gross_usd then 'refunded'
                when v_new > 0 then 'partially_refunded'
                else v_order.status
              end;

  update public.payment_orders
     set refunded_usd = v_new, status = v_status
   where id = p_order_id;

  return jsonb_build_object('ok', true, 'duplicate', false, 'refund_key', v_key,
                            'refunded_usd', v_new, 'fraction', v_fraction,
                            'revoked', v_revoked, 'status', v_status);
end;
$fn$;

revoke execute on function public.wallet_refund_order(uuid, text, numeric, text, boolean, text) from public, anon, authenticated;
grant  execute on function public.wallet_refund_order(uuid, text, numeric, text, boolean, text) to service_role;

-- Disputes: 'opened' freezes every spendable credit the order bought, 'lost'
-- takes whatever became spendable since and marks the order refunded, 'won'
-- restores the order status (credits are NOT re-granted automatically).
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

-- ---------------------------------------------------------------------------
-- 7. Webhook deliveries are claimed under a row lock (H7)
--
-- 'processing' with a live lease means another invocation is working on this
-- delivery right now; the caller must not process it in parallel. A lease older
-- than p_lease is treated as a crashed attempt and can be reclaimed.
-- ---------------------------------------------------------------------------
alter table public.webhook_events add column if not exists claimed_at timestamptz;
alter table public.webhook_events drop constraint if exists webhook_events_status_check;
alter table public.webhook_events add constraint webhook_events_status_check
  check (status in ('received', 'processing', 'processed', 'failed', 'ignored'));

create or replace function public.webhook_claim(
  p_provider   text,
  p_webhook_id text,
  p_event_type text,
  p_payload    jsonb    default '{}'::jsonb,
  p_lease      interval default '5 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public.webhook_events%rowtype;
begin
  if p_webhook_id is null or p_webhook_id = '' then
    return jsonb_build_object('claimed', false, 'error', 'webhook_id_required');
  end if;

  insert into public.webhook_events (provider, webhook_id, event_type, payload, status, attempts, claimed_at)
  values (coalesce(p_provider, 'dodo'), p_webhook_id, coalesce(p_event_type, 'unknown'),
          coalesce(p_payload, '{}'::jsonb), 'processing', 1, now())
  on conflict (webhook_id) do nothing;
  if found then
    return jsonb_build_object('claimed', true, 'first', true, 'attempts', 1);
  end if;

  select * into v_row from public.webhook_events where webhook_id = p_webhook_id for update;

  if v_row.status in ('processed', 'ignored') then
    return jsonb_build_object('claimed', false, 'status', v_row.status);
  end if;

  if v_row.status = 'processing' and v_row.claimed_at > now() - coalesce(p_lease, '5 minutes') then
    return jsonb_build_object('claimed', false, 'status', 'processing', 'in_flight', true);
  end if;

  update public.webhook_events
     set status = 'processing', attempts = attempts + 1, claimed_at = now()
   where webhook_id = p_webhook_id;

  return jsonb_build_object('claimed', true, 'first', false, 'attempts', v_row.attempts + 1,
                            'prior_status', v_row.status);
end;
$fn$;

revoke execute on function public.webhook_claim(text, text, text, jsonb, interval) from public, anon, authenticated;
grant  execute on function public.webhook_claim(text, text, text, jsonb, interval) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Reaper (H6): settle stale holds for what api_usage recorded against them
--
-- The old 'live:%' exclusion is gone: no caller uses that prefix any more, and a
-- hold older than the window is stale whoever opened it.
-- ---------------------------------------------------------------------------
create or replace function public.reap_stale_reservations(p_older_than interval default '1 hour')
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_age      interval := greatest(coalesce(p_older_than, '1 hour'), interval '10 minutes');
  v_res      record;
  v_cost     numeric;
  v_credits  numeric;
  v_settled  int := 0;
  v_released int := 0;
  v_orphaned int := 0;
  v_out      jsonb;
begin
  for v_res in
    select id, user_id, credits_held
      from public.reservations
     where status = 'held'
       and created_at < now() - v_age
     order by created_at
     for update skip locked
  loop
    if v_res.user_id is null then
      update public.reservations
         set status = 'released', finalised_at = now(), reason = 'owner deleted'
       where id = v_res.id;
      v_orphaned := v_orphaned + 1;
      continue;
    end if;

    select coalesce(sum(provider_cost_usd), 0), coalesce(sum(credits_charged), 0)
      into v_cost, v_credits
      from public.api_usage
     where reservation_id = v_res.id;

    if v_credits > 0 or v_cost > 0 then
      v_out := public.wallet_settle(
        v_res.id,
        least(v_credits, v_res.credits_held),
        v_cost,
        'reap:' || v_res.id::text,
        'stale reservation reaped after ' || v_age
      );
      if coalesce((v_out->>'ok')::boolean, false) then
        v_settled := v_settled + 1;
      end if;
    else
      v_out := public.wallet_release(v_res.id, 'stale reservation reaped after ' || v_age);
      if coalesce((v_out->>'ok')::boolean, false) then
        v_released := v_released + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('settled', v_settled, 'released', v_released,
                            'orphaned', v_orphaned,
                            'total', v_settled + v_released + v_orphaned);
end;
$fn$;

revoke execute on function public.reap_stale_reservations(interval) from public, anon, authenticated;
grant  execute on function public.reap_stale_reservations(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 9. take_rate_limit validates its arguments (N16)
--
-- A null window counted nothing and always passed. Windows above 48 hours are
-- refused because purge_retention deletes hits older than two days, so a longer
-- window would silently count less than it claims.
-- ---------------------------------------------------------------------------
create or replace function public.take_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_limit int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count int;
begin
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 172800 then
    raise exception 'take_rate_limit: window must be 1..172800 seconds, got %', p_window_seconds
      using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 0 then
    raise exception 'take_rate_limit: limit must be >= 0, got %', p_limit using errcode = '22023';
  end if;
  if p_user_id is null or p_bucket is null or p_bucket = '' or p_limit = 0 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_bucket, 0));

  select count(*) into v_count
    from public.rate_limit_hits
   where user_id = p_user_id
     and bucket = p_bucket
     and created_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.rate_limit_hits (user_id, bucket) values (p_user_id, p_bucket);
  return true;
end;
$fn$;

revoke execute on function public.take_rate_limit(uuid, text, int, int) from public, anon, authenticated;
grant  execute on function public.take_rate_limit(uuid, text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Pricing audit on INSERT, UPDATE and DELETE, with who did it (M9)
-- ---------------------------------------------------------------------------
create or replace function public.audit_pricing_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_old   jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new   jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row   jsonb := coalesce(v_new, v_old);
  v_key   text  := coalesce(v_row->>'operation', 'package:' || (v_row->>'code'));
  v_who   text  := coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                            nullif(current_setting('echo.changed_by', true), ''),
                            session_user::text);
  v_why   text  := nullif(current_setting('echo.change_reason', true), '');
  v_field text;
begin
  if tg_op = 'INSERT' then
    insert into public.pricing_audit (operation, field, old_value, new_value, changed_by, reason)
    values (v_key, '*insert*', null, v_new, v_who, v_why);
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.pricing_audit (operation, field, old_value, new_value, changed_by, reason)
    values (v_key, '*delete*', v_old, null, v_who, v_why);
    return old;
  end if;

  for v_field in select jsonb_object_keys(v_new) loop
    continue when v_field in ('updated_at', 'effective_from');
    if v_new -> v_field is distinct from v_old -> v_field then
      insert into public.pricing_audit (operation, field, old_value, new_value, changed_by, reason)
      values (v_key, v_field, v_old -> v_field, v_new -> v_field, v_who, v_why);
    end if;
  end loop;
  return new;
end;
$fn$;

revoke execute on function public.audit_pricing_change() from public, anon, authenticated;

drop trigger if exists trg_pricing_audit on public.pricing_config;
create trigger trg_pricing_audit
  after insert or update or delete on public.pricing_config
  for each row execute function public.audit_pricing_change();

drop trigger if exists trg_topup_packages_audit on public.topup_packages;
create trigger trg_topup_packages_audit
  after insert or update or delete on public.topup_packages
  for each row execute function public.audit_pricing_change();

-- ---------------------------------------------------------------------------
-- 11. Owner pricing decisions (E.4), applied exactly once
-- ---------------------------------------------------------------------------
alter table public.pricing_config drop constraint if exists pricing_config_cost_source_check;
alter table public.pricing_config add constraint pricing_config_cost_source_check
  check (cost_source in ('catalog', 'rate_card', 'observed', 'live_confirmed', 'unverified',
                         'treg catalog 2026-10'));

do $pricing$
begin
  insert into public.data_migrations (name) values ('20261127_pricing')
    on conflict (name) do nothing;
  if not found then
    return;  -- already applied; never re-apply over a later operator edit
  end if;

  perform set_config('echo.changed_by', 'migration:20261127_audit_round2', true);
  perform set_config('echo.change_reason', 'owner pricing decision (audit E.4)', true);

  -- Owner decision after checking treg's catalog (Oct 2026). Costs are the
  -- catalog figures / routing caps, not measurements, so cost_verified = false.
  update public.pricing_config
     set credits = 1,
         display_name = 'People search (per billed provider call)',
         provider_cost_usd = 0.015, cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.people.search';

  update public.pricing_config
     set enabled = false,
         display_name = 'People search: per-50-leads fee (retired)',
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'leads.search.extra_50';

  update public.pricing_config
     set credits = 1, provider_cost_usd = 0.015,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.people.email.find';

  update public.pricing_config
     set credits = 2, provider_cost_usd = 0.03,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.people.phone.find';

  -- Feed sweeps, per keyword per run.
  update public.pricing_config
     set credits = 0.1, provider_cost_usd = 0.00075,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.twitter.search';

  -- tikhub $0.001; the scrapecreators fallback is $0.00188 when it fires.
  update public.pricing_config
     set credits = 0.1, provider_cost_usd = 0.001,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.reddit.search';

  update public.pricing_config
     set credits = 0.1, provider_cost_usd = 0.00015,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.web.search';

  -- News is free, consistently (N9): tinyfish news is billed at zero.
  update public.pricing_config
     set credits = 0, provider_cost_usd = 0,
         cost_source = 'treg catalog 2026-10', cost_verified = false,
         version = version + 1, effective_from = now(), updated_at = now()
   where operation = 'treg.news.search';
end
$pricing$;

comment on table public.pricing_config is
  'Credit price per operation. treg.people.search.credits is charged PER BILLED PROVIDER CALL. Seeds are insert-only; change prices with an explicit UPDATE (audited by trg_pricing_audit).';

-- ---------------------------------------------------------------------------
-- 12. Cost and revenue columns are ours, not the owner's (M8)
--
-- Table-level SELECT is revoked and re-granted column by column, minus the
-- margin columns. The frontend reads none of these tables directly (billing
-- serves them through the service role), so nothing visible changes. Policies
-- are rewritten with (select auth.uid()) and scoped to authenticated.
-- ---------------------------------------------------------------------------
do $grants$
declare
  v_t    text;
  v_ex   text[];
  v_cols text;
begin
  for v_t, v_ex in
    select * from (values
      ('api_usage',      array['provider_cost_usd', 'gross_profit_usd', 'revenue_usd']),
      ('credit_ledger',  array['revenue_usd', 'service_cost_usd']),
      ('credit_grants',  array['unit_price_usd']),
      ('wallet',         array['recognised_revenue_usd', 'service_cost_usd']),
      ('reservations',   array[]::text[]),
      ('payment_orders', array['fee_usd', 'net_usd'])
    ) v(t, ex)
  loop
    continue when to_regclass('public.' || v_t) is null;

    execute format('revoke all on public.%I from anon', v_t);
    execute format('revoke select, insert, update, delete, truncate, references, trigger on public.%I from authenticated', v_t);

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into v_cols
      from information_schema.columns
     where table_schema = 'public' and table_name = v_t
       and column_name <> all (v_ex);

    execute format('grant select (%s) on public.%I to authenticated', v_cols, v_t);
    execute format('drop policy if exists %I on public.%I', v_t || '_select_own', v_t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
                   v_t || '_select_own', v_t);
  end loop;
end
$grants$;

-- Financial rows outlive the account: user_id is set null on deletion instead
-- of cascading the history away. The wallet row itself (keyed by user) still
-- goes; its totals are derivable from the ledger.
do $fk$
declare
  v_t    text;
  v_con  text;
begin
  foreach v_t in array array['payment_orders', 'credit_grants', 'credit_ledger', 'api_usage', 'reservations'] loop
    continue when to_regclass('public.' || v_t) is null;

    select c.conname into v_con
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.conrelid = ('public.' || v_t)::regclass
       and c.contype = 'f'
       and c.confrelid = 'auth.users'::regclass
       and a.attname = 'user_id'
     limit 1;

    execute format('alter table public.%I alter column user_id drop not null', v_t);
    if v_con is not null then
      execute format('alter table public.%I drop constraint %I', v_t, v_con);
    end if;
    execute format('alter table public.%I add constraint %I foreign key (user_id) references auth.users(id) on delete set null',
                   v_t, v_t || '_user_id_fkey');
  end loop;
end
$fk$;

-- ---------------------------------------------------------------------------
-- 13. Platform totals in the right units (N4)
-- ---------------------------------------------------------------------------
drop view if exists public.v_platform_totals;
create view public.v_platform_totals
with (security_invoker = true) as
select
  ledger.recognised_revenue_usd,
  usage.provider_cost_usd,
  ledger.recognised_revenue_usd - usage.provider_cost_usd             as gross_profit_usd,
  cash.gross_usd                                                       as gross_cash_usd,
  cash.refunded_usd                                                    as refunded_cash_usd,
  cash.disputed_usd                                                    as disputed_cash_usd,
  cash.known_fees                                                      as known_gateway_fees_usd,
  cash.orders_with_unknown_fee,
  -- Upper bound until every paid order has reported its fee.
  cash.gross_usd - cash.refunded_usd - cash.disputed_usd - cash.known_fees as net_cash_usd,
  liab.unspent_credits,
  liab.unspent_paid_credits,
  liab.unspent_credit_liability_usd,
  rev.revoked_credits,
  rev.revoked_value_usd,
  -- Cash returned beyond the unspent value taken back: revenue that had been
  -- recognised and then went back to the customer.
  greatest(cash.refunded_usd + cash.disputed_usd - rev.revoked_value_usd, 0) as refunds_against_recognised_usd,
  (select count(*) from public.api_usage where outcome = 'uncertain')  as uncertain_calls,
  (select count(*) from public.reservations
     where status = 'held' and created_at < now() - interval '1 hour') as stale_reservations
from
  (select coalesce(sum(revenue_usd), 0) as recognised_revenue_usd
     from public.credit_ledger where kind = 'usage') ledger,
  (select coalesce(sum(provider_cost_usd), 0) as provider_cost_usd from public.api_usage) usage,
  (select
     coalesce(sum(gross_usd), 0)                                               as gross_usd,
     coalesce(sum(least(refunded_usd, gross_usd)) filter (where status <> 'disputed'), 0) as refunded_usd,
     coalesce(sum(gross_usd - least(refunded_usd, gross_usd)) filter (where status = 'disputed'), 0) as disputed_usd,
     coalesce(sum(fee_usd), 0)                                                 as known_fees,
     count(*) filter (where fee_usd is null)                                   as orders_with_unknown_fee
   from public.payment_orders
   where credits_granted > 0
      or status in ('succeeded', 'refunded', 'partially_refunded', 'disputed')) cash,
  (select
     coalesce(sum(credits_remaining), 0)                                       as unspent_credits,
     coalesce(sum(credits_remaining) filter (where source <> 'grant'), 0)      as unspent_paid_credits,
     coalesce(sum(credits_remaining * unit_price_usd), 0)                      as unspent_credit_liability_usd
   from public.credit_grants
   where user_id is not null and (expires_at is null or expires_at > now())) liab,
  (select
     coalesce(sum(-l.delta), 0)                                                as revoked_credits,
     coalesce(sum(-l.delta * coalesce((l.metadata->>'unit_price_usd')::numeric, g.unit_price_usd, 0)), 0) as revoked_value_usd
   from public.credit_ledger l
   left join public.credit_grants g on g.id = l.grant_id
   where l.kind = 'reversal') rev;

comment on view public.v_platform_totals is
  'Recognised revenue (ledger), measured cost, cash net of refunds/disputes/fees, unspent credits (units) and their USD liability, and revoked credits. Service role only.';

revoke all on public.v_platform_totals from public, anon, authenticated;
grant select on public.v_platform_totals to service_role;

-- ---------------------------------------------------------------------------
-- 14. Indexes (N5)
-- ---------------------------------------------------------------------------
create index if not exists idx_api_usage_reservation
  on public.api_usage(reservation_id) where reservation_id is not null;
create index if not exists idx_credit_ledger_grant
  on public.credit_ledger(grant_id) where grant_id is not null;
create index if not exists idx_credit_ledger_payment_order
  on public.credit_ledger(payment_order_id) where payment_order_id is not null;
create index if not exists idx_credit_ledger_reversal
  on public.credit_ledger(created_at) where kind = 'reversal';
create index if not exists idx_reservations_user_held
  on public.reservations(user_id) where status = 'held';
-- daily-sweep reads every active keyword grouped by user (was only in 20261023).
create index if not exists keywords_active_user_idx
  on public.keywords (user_id) where is_active;

-- Mail foreign keys. Guarded per column: the mail schema is still moving.
do $mailidx$
declare
  v_spec text[];
begin
  foreach v_spec slice 1 in array array[
    array['mailboxes',        'domain_id',  'idx_mailboxes_domain_id'],
    array['mail_threads',     'user_id',    'idx_mail_threads_user_id'],
    array['mail_messages',    'user_id',    'idx_mail_messages_user_id'],
    array['mail_messages',    'mailbox_id', 'idx_mail_messages_mailbox_id'],
    array['mail_messages',    'lead_id',    'idx_mail_messages_lead_id'],
    array['mail_attachments', 'user_id',    'idx_mail_attachments_user_id']
  ] loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = v_spec[1] and column_name = v_spec[2]) then
      execute format('create index if not exists %I on public.%I (%I)', v_spec[3], v_spec[1], v_spec[2]);
    end if;
  end loop;
end
$mailidx$;

-- ---------------------------------------------------------------------------
-- 15. Scheduled jobs, built from configuration (N6, H6)
--
--   echo-daily-sweep   hourly; posts to <project_url>/functions/v1/daily-sweep.
--                      project_url comes from public.service_secrets
--                      (name = 'project_url', e.g. https://<ref>.supabase.co).
--                      The secret header is still read at fire time.
--   echo-reap-stale    every 15 minutes; reap_stale_reservations().
--
-- Without pg_cron (local, CI) this does nothing. Without a project_url an
-- existing sweep job is left alone, unless it still posts to the
-- REPLACE_WITH_PROJECT_REF placeholder, which can never work and is removed.
-- Re-run after setting project_url:  select public.configure_echo_cron();
-- ---------------------------------------------------------------------------
create or replace function public.configure_echo_cron()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url     text;
  v_cmd     text;
  v_result  jsonb := '{}'::jsonb;
  v_has_net boolean;
begin
  if to_regclass('cron.job') is null
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'cron' and p.proname = 'schedule') then
    return jsonb_build_object('ok', false, 'skipped', 'pg_cron not installed');
  end if;

  -- Reaper: needs nothing but pg_cron.
  execute 'select cron.unschedule(jobid) from cron.job where jobname = $1' using 'echo-reap-stale';
  execute 'select cron.schedule($1, $2, $3)'
    using 'echo-reap-stale', '*/15 * * * *', 'select public.reap_stale_reservations();';
  v_result := v_result || jsonb_build_object('echo-reap-stale', 'scheduled');

  -- A placeholder URL can never succeed; remove it whatever else happens.
  execute 'select cron.unschedule(jobid) from cron.job where jobname = $1 and command like $2'
    using 'echo-daily-sweep', '%REPLACE_WITH_PROJECT_REF%';

  v_has_net := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'net' and p.proname = 'http_post');

  select rtrim(trim(value), '/') into v_url from public.service_secrets where name = 'project_url';

  if v_url is null or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
    v_result := v_result || jsonb_build_object('echo-daily-sweep',
      case when v_url is null then 'left as is: service_secrets.project_url not set'
           else 'left as is: project_url is not https://host' end);
  elsif not v_has_net then
    v_result := v_result || jsonb_build_object('echo-daily-sweep', 'left as is: pg_net not installed');
  else
    v_cmd := format(
      $cmd$select net.http_post(
  url := %L,
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-sweep-secret', (select value from public.service_secrets where name = 'sweep_cron_secret')),
  body := '{}'::jsonb,
  timeout_milliseconds := 180000);$cmd$,
      v_url || '/functions/v1/daily-sweep');
    execute 'select cron.unschedule(jobid) from cron.job where jobname = $1' using 'echo-daily-sweep';
    execute 'select cron.schedule($1, $2, $3)' using 'echo-daily-sweep', '0 * * * *', v_cmd;
    v_result := v_result || jsonb_build_object('echo-daily-sweep', 'scheduled: ' || v_url);
  end if;

  return jsonb_build_object('ok', true) || v_result;
end;
$fn$;

revoke execute on function public.configure_echo_cron() from public, anon, authenticated;
grant  execute on function public.configure_echo_cron() to service_role;

do $cron$
declare
  v_out jsonb;
begin
  begin
    v_out := public.configure_echo_cron();
    raise notice 'configure_echo_cron: %', v_out;
  exception when others then
    -- Scheduling must never abort the schema; report it and carry on.
    raise warning 'configure_echo_cron failed: %', sqlerrm;
  end;
end
$cron$;

-- ---------------------------------------------------------------------------
-- 16. N7: the welcome grant's real exposure
-- ---------------------------------------------------------------------------
comment on function public.handle_new_user() is
  'Signup: profile, wallet and 20 welcome credits (source=grant, $0). Welcome credits only pay for feed sweeps (Leads and Mail reserve with p_paid_only => true): 20 credits is about 8 days of an 8-keyword, 3-channel workspace at 0.1 credit per keyword per channel (2.4 credits/day), roughly $0.05 of provider cost per signup.';
