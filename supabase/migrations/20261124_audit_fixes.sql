-- ============================================================================
-- Audit fixes (October 2026)
-- ----------------------------------------------------------------------------
-- 1. Margin views were readable by anon/authenticated (owner-rights views
--    bypass RLS). Revoked, and switched to security_invoker.
-- 2. pricing_config exposed provider cost to every client. No client reads it
--    directly (the functions use the service role), so it is service-only now.
-- 3. Durable rate limits. The in-memory per-isolate buckets reset on every cold
--    start, and the leads limiter counted rows written after the work. One
--    atomic RPC replaces both.
-- 4. Top-ups are checked against what was actually paid.
-- 5. Partial refunds revoke a share, not the whole order; disputes freeze.
-- 6. wallet_revoke_grant could push reserved above balance.
-- 7. The stale-hold reaper settles what was billed, not the worst case.
-- 8. user_leads: clients may read, delete, and edit status/notes only.
-- 9. Channel constraint matches the product (news, not linkedin).
-- 10. Retention for rate-limit rows and webhook payloads.
-- Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Margin views
-- ---------------------------------------------------------------------------
do $$
declare v text;
begin
  foreach v in array array['v_margin_by_operation','v_margin_by_user','v_platform_totals',
                           'v_treg_reconciliation','v_stale_reservations'] loop
    if to_regclass('public.' || v) is not null then
      execute format('alter view public.%I set (security_invoker = true)', v);
      execute format('revoke all on public.%I from public, anon, authenticated', v);
      execute format('grant select on public.%I to service_role', v);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. pricing_config is service-only
-- ---------------------------------------------------------------------------
drop policy if exists pricing_config_select_all on public.pricing_config;
revoke all on public.pricing_config from anon, authenticated;
revoke all on public.pricing_audit  from anon, authenticated;
revoke all on public.webhook_events from anon, authenticated;
revoke all on public.service_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Durable rate limits
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_hits (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  bucket     text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_rate_limit_hits_lookup
  on public.rate_limit_hits(user_id, bucket, created_at desc);
alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from anon, authenticated;

-- Takes one slot if the user is under p_limit hits in the window. The advisory
-- lock serialises concurrent callers for the same (user, bucket), so a burst of
-- parallel requests cannot all read the same count and all pass.
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
  if p_user_id is null or p_bucket is null or p_limit <= 0 then
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
-- 4 + 5. Order statuses, paid-amount check
-- ---------------------------------------------------------------------------
alter table public.payment_orders drop constraint if exists payment_orders_status_check;
alter table public.payment_orders add constraint payment_orders_status_check
  check (status in ('created', 'pending', 'succeeded', 'failed', 'refunded',
                    'partially_refunded', 'disputed', 'review'));

alter table public.payment_orders add column if not exists paid_amount_usd numeric(20,6);
alter table public.payment_orders add column if not exists refunded_usd numeric(20,6) not null default 0;
alter table public.payment_orders add column if not exists review_reason text;

drop function if exists public.wallet_topup_from_order(uuid, numeric, numeric, text, text);

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
  if v_credits <= 0 then
    return jsonb_build_object('ok', false, 'error', 'package_has_no_credits');
  end if;

  v_unit := case
              when p_net_usd      is not null then p_net_usd / v_credits
              when v_order.net_usd is not null then v_order.net_usd / v_credits
              else v_order.gross_usd / v_credits
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
    perform public.wallet_apply_grant(
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

-- ---------------------------------------------------------------------------
-- 5 + 6. Revoke: optional partial amount, never below what is on hold
-- ---------------------------------------------------------------------------
drop function if exists public.wallet_revoke_grant(uuid, text);

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
    coalesce(greatest(p_credits, 0), v_grant.credits_remaining)
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

-- ---------------------------------------------------------------------------
-- 7. Reaper settles what was billed
-- ---------------------------------------------------------------------------
create or replace function public.reap_stale_reservations(p_older_than interval default '1 hour')
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_res      record;
  v_cost     numeric := 0;
  v_credits  numeric := 0;
  v_settled  int := 0;
  v_released int := 0;
  v_out      jsonb;
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
    select coalesce(sum(provider_cost_usd), 0), coalesce(sum(credits_charged), 0)
      into v_cost, v_credits
      from public.api_usage
     where reservation_id = v_res.id;

    if v_credits > 0 then
      v_out := public.wallet_settle(
        v_res.id,
        least(v_credits, v_res.credits_held),
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

  return jsonb_build_object('settled', v_settled, 'released', v_released,
                            'total', v_settled + v_released);
end;
$fn$;

revoke execute on function public.reap_stale_reservations(interval) from public, anon, authenticated;
grant  execute on function public.reap_stale_reservations(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 8. user_leads: written only by the leads function
-- ---------------------------------------------------------------------------
update public.user_leads set company_domain = '' where company_domain is null;
alter table public.user_leads alter column company_domain set default '';
alter table public.user_leads alter column company_domain set not null;

update public.user_leads set status = 'new'
 where status not in ('new', 'contacted', 'replied', 'dismissed');
alter table public.user_leads drop constraint if exists user_leads_status_check;
alter table public.user_leads add constraint user_leads_status_check
  check (status in ('new', 'contacted', 'replied', 'dismissed'));
alter table public.user_leads drop constraint if exists user_leads_notes_length;
alter table public.user_leads add constraint user_leads_notes_length
  check (notes is null or length(notes) <= 2000);

drop policy if exists "Users can manage own leads" on public.user_leads;
drop policy if exists user_leads_select_own on public.user_leads;
drop policy if exists user_leads_update_own on public.user_leads;
drop policy if exists user_leads_delete_own on public.user_leads;

create policy user_leads_select_own on public.user_leads
  for select to authenticated using ((select auth.uid()) = user_id);
create policy user_leads_update_own on public.user_leads
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy user_leads_delete_own on public.user_leads
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.user_leads from anon, authenticated;
grant select, delete on public.user_leads to authenticated;
grant update (status, notes) on public.user_leads to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Channels the product actually sells
-- ---------------------------------------------------------------------------
update public.profiles
   set enabled_channels = array(
         select c from unnest(enabled_channels) c
          where c in ('twitter', 'reddit', 'google', 'news'))
 where not enabled_channels <@ array['twitter', 'reddit', 'google', 'news']::text[];
update public.profiles
   set enabled_channels = array['twitter', 'reddit', 'google']::text[]
 where coalesce(array_length(enabled_channels, 1), 0) = 0;

alter table public.profiles drop constraint if exists profiles_enabled_channels_supported;
alter table public.profiles add constraint profiles_enabled_channels_supported
  check (enabled_channels <@ array['twitter', 'reddit', 'google', 'news']::text[]);

-- ---------------------------------------------------------------------------
-- 10. Lead search is priced, AI is metered by rate limit
-- ---------------------------------------------------------------------------
-- A people search fans out to several billed provider calls; it now costs one
-- credit per search. Change the number here, not in code.
update public.pricing_config
   set credits = 1, display_name = 'People search', version = version + 1,
       effective_from = now(), updated_at = now()
 where operation = 'treg.people.search' and credits = 0;

-- ---------------------------------------------------------------------------
-- 11. Retention
-- ---------------------------------------------------------------------------
create or replace function public.purge_retention()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limit_hits where created_at < now() - interval '2 days';
  update public.webhook_events set payload = '{}'::jsonb
   where received_at < now() - interval '180 days' and payload <> '{}'::jsonb;
$$;

revoke execute on function public.purge_retention() from public, anon, authenticated;
grant  execute on function public.purge_retention() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'echo-retention';
    perform cron.schedule('echo-retention', '17 3 * * *', 'select public.purge_retention();');
  end if;
end $$;
