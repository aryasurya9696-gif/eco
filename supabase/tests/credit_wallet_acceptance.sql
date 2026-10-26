-- ============================================================================
-- Credit wallet — acceptance tests
-- ----------------------------------------------------------------------------
-- Phase 1's claim is that the balance cannot be spent twice, cannot go
-- negative, and cannot be charged twice for one job. These assert exactly that
-- and nothing else.
--
-- Runs inside ONE transaction that ends in ROLLBACK, against a throwaway test
-- user created in that transaction. Nothing it does survives: not the user, not
-- its holds, not the pricing edits, not the audit rows. If any statement fails,
-- psql's ON_ERROR_STOP ends the session and the transaction rolls back too.
--
-- (It used to run in autocommit against a real account and clean up by hand.
-- An `on commit drop` temp table then vanished mid-run, the suite aborted, test
-- holds were left in production, it could pick up a real customer's order, and
-- its last step deleted the whole pricing_audit table.)
--
-- Two things about the shape are deliberate.
--
-- Each scenario starts from a clean slate rather than continuing from the last
-- one. That is not tidiness. Grants are drawn FIFO by creation time, so a
-- scenario inheriting an older grant draws down that grant instead of the one it
-- meant to, and its revenue assertion quietly measures the wrong thing.
-- Isolation is what makes the assertions mean anything.
--
-- Helpers live in pg_temp, so they exist for this session and vanish with it.
-- They are deliberately not part of the schema: test scaffolding that survives
-- into production is scaffolding somebody will eventually call by accident.
-- ============================================================================

begin;

-- The test user. Creating it fires handle_new_user (profile, wallet, welcome
-- grant), which reset_wallet then clears for each scenario.
insert into auth.users (id, email, aud, role)
values ('00000000-0000-4000-8000-0000000acc01', 'acceptance-test@echo.invalid', 'authenticated', 'authenticated');

-- ---------------------------------------------------------------------------
-- Reset the test user to zero credits and no history
-- ---------------------------------------------------------------------------
create function pg_temp.reset_wallet(p_user uuid)
returns void
language plpgsql
as $$
begin
  delete from public.credit_ledger where user_id = p_user;
  delete from public.reservations  where user_id = p_user;
  delete from public.credit_grants where user_id = p_user;
  delete from public.payment_orders where user_id = p_user;
  update public.wallet
     set balance = 0, reserved = 0, lifetime_granted = 0, lifetime_consumed = 0,
         recognised_revenue_usd = 0, service_cost_usd = 0
   where user_id = p_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reserve then settle in one step, for the many scenarios that just want to
-- spend some credits. Returns the settle result.
-- ---------------------------------------------------------------------------
create function pg_temp.spend(p_user uuid, p_hold numeric, p_charge numeric, p_cost numeric)
returns jsonb
language plpgsql
as $$
declare
  v_res jsonb;
begin
  v_res := public.wallet_reserve(p_user, p_hold, 'k:' || gen_random_uuid()::text);
  if not (v_res->>'ok')::boolean then
    return jsonb_build_object('ok', false, 'stage', 'reserve', 'reserve', v_res);
  end if;
  return public.wallet_settle((v_res->>'reservation_id')::uuid, p_charge, p_cost,
                              's:' || gen_random_uuid()::text);
end;
$$;

create temp table _results (
  ord    serial,
  test   text,
  ok     boolean,
  detail jsonb
);

-- ===========================================================================
-- A grant adds credits and recognises no revenue.
-- Cash received is a liability until it is spent.
-- ===========================================================================
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid,
                                 15, 'topup', 0.05, null, 't:g1');

insert into _results (test, ok, detail)
select 'grant_adds_credits',
       balance = 15,
       jsonb_build_object('balance', balance, 'expected', 15)
  from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid;

insert into _results (test, ok, detail)
select 'grant_recognises_no_revenue',
       coalesce(sum(revenue_usd), 0) = 0,
       jsonb_build_object('revenue', coalesce(sum(revenue_usd), 0))
  from public.credit_ledger
 where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid and kind = 'topup';

-- A retried payment webhook lands here, so a replay must not double the balance.
select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid,
                                 15, 'topup', 0.05, null, 't:g1');

insert into _results (test, ok, detail)
select 'grant_replay_is_idempotent',
       balance = 15,
       jsonb_build_object('balance_after_replay', balance, 'expected', 15)
  from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid;

-- ===========================================================================
-- A reserve holds credits and shrinks what is spendable
-- ===========================================================================
create temp table _res_a (id uuid);
insert into _res_a
select (public.wallet_reserve('00000000-0000-4000-8000-0000000acc01'::uuid, 8, 't:r1')->>'reservation_id')::uuid;

insert into _results (test, ok, detail)
select 'reserve_holds_credits',
       reserved = 8 and balance = 15,
       jsonb_build_object('balance', balance, 'reserved', reserved,
                          'available', balance - reserved)
  from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid;

-- Over-reserving is refused and reports exactly how much is missing.
create temp table _over (out jsonb);
delete from _over;
insert into _over
select public.wallet_reserve('00000000-0000-4000-8000-0000000acc01'::uuid, 10, 't:r-too-big');

insert into _results (test, ok, detail)
select 'over_reserve_refused',
       (out->>'ok')::boolean = false
       and (out->>'error') = 'insufficient_credits'
       and (out->>'shortfall')::numeric = 3,
       out
  from _over;

insert into _results (test, ok, detail)
select 'over_reserve_left_no_hold',
       not exists (select 1 from public.reservations where idempotency_key = 't:r-too-big'),
       jsonb_build_object('note', 'a refused reserve leaves nothing behind');

-- The same key reuses the hold rather than stacking a second one.
delete from _over;
insert into _over select public.wallet_reserve('00000000-0000-4000-8000-0000000acc01'::uuid, 8, 't:r1');

insert into _results (test, ok, detail)
select 'reserve_replay_is_idempotent',
       (select reserved from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = 8
       and (out->>'duplicate')::boolean = true,
       out
  from _over;

-- ===========================================================================
-- Settling charges only what was billable and returns the rest.
-- A sweep reserves for its worst case and settles for what actually billed.
-- ===========================================================================
create temp table _settle1 (out jsonb);
insert into _settle1
select public.wallet_settle(id, 5, 0.00125, 't:s1', 'partial') from _res_a;

insert into _results (test, ok, detail)
select 'settle_charges_only_what_billed',
       (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = 10
       and (select reserved from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = 0,
       jsonb_build_object('out', out,
                          'charged', out->'credits_charged',
                          'released', out->'credits_released')
  from _settle1;

insert into _results (test, ok, detail)
select 'settle_recognises_revenue_at_grant_price',
       (out->>'revenue_recognized')::numeric = 0.25,
       jsonb_build_object('revenue', out->'revenue_recognized', 'expected', 0.25,
                          'basis', '5 credits x $0.05')
  from _settle1;

insert into _results (test, ok, detail)
select 'settle_records_provider_cost',
       (out->>'service_cost')::numeric = 0.00125,
       jsonb_build_object('cost', out->'service_cost')
  from _settle1;

-- ===========================================================================
-- Settling twice is impossible.
-- A double settle is a double charge, so it has to be impossible in the
-- database rather than merely unlikely in the caller.
-- ===========================================================================
delete from _over;
insert into _over
select public.wallet_settle(id, 5, 0.00125, 't:s1-again') from _res_a;

insert into _results (test, ok, detail)
select 'double_settle_refused',
       (out->>'ok')::boolean = false
       and (out->>'error') = 'reservation_already_finalised'
       and (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = 10,
       jsonb_build_object('out', out,
                          'balance', (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid))
  from _over;

delete from _over;
insert into _over
select public.wallet_release(id, 'late release') from _res_a;

insert into _results (test, ok, detail)
select 'release_after_settle_refused', (out->>'ok')::boolean = false, out from _over;

-- ===========================================================================
-- A release returns the hold untouched and charges nothing.
-- This is what makes a provider being briefly unavailable cost us nothing
-- rather than costing the customer a charge.
-- ===========================================================================
create temp table _res_b (id uuid);
insert into _res_b
select (public.wallet_reserve('00000000-0000-4000-8000-0000000acc01'::uuid, 6, 't:r2')->>'reservation_id')::uuid;

create temp table _ledger_before (n bigint);
insert into _ledger_before
select count(*) from public.credit_ledger where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid;

delete from _over;
insert into _over
select public.wallet_release(id, 'provider 503') from _res_b;

insert into _results (test, ok, detail)
select 'release_returns_the_hold',
       (select reserved from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = 0
       and (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = 10,
       out
  from _over;

insert into _results (test, ok, detail)
select 'release_writes_no_charge',
       (select count(*) from public.credit_ledger where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = (select n from _ledger_before)
       and (out->>'released')::numeric = 6,
       out
  from _over;

delete from _over;
insert into _over
select public.wallet_settle(id, 6, 0.001, 't:s2') from _res_b;

insert into _results (test, ok, detail)
select 'settle_after_release_refused', (out->>'ok')::boolean = false, out from _over;

-- ===========================================================================
-- FIFO across two grants bought at different prices.
--
-- This is what the grants table exists for: revenue is recognised at the rate
-- each tranche was actually bought for. 5 credits from the $0.05 grant is
-- $0.25, and 3 more from a $0.02 grant is $0.06. Recognising all 8 at the
-- headline rate would report $0.40, which is revenue that was never collected.
-- ===========================================================================
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid, 5, 'topup', 0.05, null, 't:f:a');
select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid, 10, 'topup', 0.02, null, 't:f:b');

create temp table _fifo (out jsonb);
insert into _fifo
select pg_temp.spend('00000000-0000-4000-8000-0000000acc01'::uuid, 8, 8, 0.0025);

insert into _results (test, ok, detail)
select 'fifo_drains_the_older_grant_first',
       (select credits_remaining from public.credit_grants
         where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid and credits = 5) = 0,
       jsonb_build_object('note', 'the $0.05 grant was issued first, so it drains first');

insert into _results (test, ok, detail)
select 'fifo_recognises_per_grant_price',
       (select coalesce(sum(revenue_usd), 0) from public.credit_ledger
         where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid and kind = 'usage') = 0.31,
       jsonb_build_object(
         'recognised', (select coalesce(sum(revenue_usd), 0) from public.credit_ledger
                         where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid and kind = 'usage'),
         'expected', 0.31,
         'wrong_answer_if_headline_rate_used', 0.40);

insert into _results (test, ok, detail)
select 'fifo_charges_the_right_total',
       (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = 7,
       jsonb_build_object('balance', (select balance from public.wallet
                                       where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid),
                          'expected', 7);

-- ===========================================================================
-- A zero-price grant recognises nothing when consumed.
-- Bonus credits were given away, so spending them earns nothing.
-- ===========================================================================
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid, 4, 'bonus', 0, null, 't:bonus');

create temp table _bonus (out jsonb);
insert into _bonus select pg_temp.spend('00000000-0000-4000-8000-0000000acc01'::uuid, 4, 4, 0);

insert into _results (test, ok, detail)
select 'bonus_grant_recognises_nothing',
       (out->>'revenue_recognized')::numeric = 0
       and (out->>'credits_charged')::numeric = 4,
       out
  from _bonus;

-- ===========================================================================
-- Settling more than was held is clipped, not obeyed
-- ===========================================================================
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid, 20, 'topup', 0.05, null, 't:clip');

create temp table _clip (out jsonb);
insert into _clip
select public.wallet_settle(
  (public.wallet_reserve('00000000-0000-4000-8000-0000000acc01'::uuid, 3, 't:r3')->>'reservation_id')::uuid,
  99, 0.01, 't:s3');

insert into _results (test, ok, detail)
select 'settle_clipped_to_hold',
       (out->>'credits_charged')::numeric = 3,
       jsonb_build_object('out', out, 'note', 'caller asked for 99, held was 3')
  from _clip;

-- ===========================================================================
-- Settling more than the grants can cover is clipped too, rather than falling
-- through to a negative balance.
-- ===========================================================================
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid, 5, 'topup', 0.05, null, 't:dry');

-- Inflate the balance without inflating the grants. This is what a bug anywhere
-- upstream of the draw would look like. Since 20261127 the reserve itself only
-- counts what the grants hold (M7), so it refuses 10 ...
update public.wallet set balance = 100 where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid;

insert into _results (test, ok, detail)
select 'reserve_counts_grants_not_an_inflated_balance',
       (out->>'ok')::boolean = false and (out->>'available')::numeric = 5,
       out
  from (select public.wallet_reserve('00000000-0000-4000-8000-0000000acc01'::uuid, 10, 't:r4x') as out) q;

-- ... and a settle against grants that shrank after the reserve is clipped.
create temp table _dry (out jsonb);
create temp table _dry_res (id uuid);
insert into _dry_res
select (public.wallet_reserve('00000000-0000-4000-8000-0000000acc01'::uuid, 5, 't:r4')->>'reservation_id')::uuid;
update public.credit_grants set credits_remaining = 2
 where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid;
insert into _dry
select public.wallet_settle(id, 5, 0.001, 't:s4') from _dry_res;

insert into _results (test, ok, detail)
select 'settle_clipped_to_available_grants',
       (out->>'credits_charged')::numeric = 2
       and (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) >= 0,
       jsonb_build_object('out', out,
                          'balance_after', (select balance from public.wallet
                                             where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid))
  from _dry;

-- ===========================================================================
-- A refund takes back only what is unspent
-- ===========================================================================
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid, 10, 'topup', 0.05, null, 't:refund');
select pg_temp.spend('00000000-0000-4000-8000-0000000acc01'::uuid, 8, 8, 0.001);

create temp table _refund (out jsonb);
insert into _refund
select public.wallet_revoke_grant(id, 'refund')
  from public.credit_grants
 where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid and credits = 10;

insert into _results (test, ok, detail)
select 'refund_takes_back_only_the_unspent',
       (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = 0
       and (out->>'revoked')::numeric = 2,
       out
  from _refund;

-- Already spent, so nothing left to revoke, and still not negative.
delete from _refund;
insert into _refund
select public.wallet_revoke_grant(id, 'second refund')
  from public.credit_grants
 where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid and credits = 10;

insert into _results (test, ok, detail)
select 'second_refund_is_a_noop',
       (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid) = 0
       and (out->>'revoked')::numeric = 0,
       out
  from _refund;

-- ===========================================================================
-- The database refuses to hold a negative balance, even on a direct write.
-- Last line of defence, if a reserve path is ever coded wrong.
-- ===========================================================================
do $neg$
begin
  begin
    update public.wallet set balance = -1 where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid;
    insert into _results (test, ok, detail)
    values ('direct_negative_balance_blocked', false,
            jsonb_build_object('note', 'the UPDATE should have been rejected'));
  exception when check_violation then
    insert into _results (test, ok, detail)
    values ('direct_negative_balance_blocked', true, jsonb_build_object('error', 'check_violation'));
  end;

  begin
    update public.wallet set reserved = balance + 1 where user_id = '00000000-0000-4000-8000-0000000acc01'::uuid;
    insert into _results (test, ok, detail)
    values ('reserved_within_balance_enforced', false,
            jsonb_build_object('note', 'the UPDATE should have been rejected'));
  exception when check_violation then
    insert into _results (test, ok, detail)
    values ('reserved_within_balance_enforced', true, jsonb_build_object('error', 'check_violation'));
  end;
end;
$neg$;

-- ===========================================================================
-- Quotes come from pricing_config, never from the caller
-- ===========================================================================
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

-- Fixed test prices (rolled back with everything else), so these checks do not
-- change every time the live price list does.
update public.pricing_config set credits = 2, enabled = true where operation = 'treg.reddit.search';
update public.pricing_config set credits = 1, enabled = true where operation = 'treg.twitter.search';
update public.pricing_config set credits = 0, enabled = true where operation = 'treg.news.search';

insert into _results (test, ok, detail)
select 'quote_uses_configured_prices',
       (out->>'required')::numeric = 24,
       jsonb_build_object('out', out, 'basis', '8 keywords x (2 reddit + 1 twitter)')
  from (select public.quote_sweep('00000000-0000-4000-8000-0000000acc01'::uuid, 8,
                                  array['treg.reddit.search','treg.twitter.search']) as out) q;

insert into _results (test, ok, detail)
select 'news_is_free_in_quotes',
       (out->>'required')::numeric = 16,
       jsonb_build_object('out', out)
  from (select public.quote_sweep('00000000-0000-4000-8000-0000000acc01'::uuid, 8,
                                  array['treg.reddit.search','treg.news.search']) as out) q;

insert into _results (test, ok, detail)
select 'quote_of_nothing_is_free',
       (out->>'required')::numeric = 0 and (out->>'affordable')::boolean,
       jsonb_build_object('out', out)
  from (select public.quote_sweep('00000000-0000-4000-8000-0000000acc01'::uuid, 0,
                                  array['treg.reddit.search']) as out) q;

-- A disabled operation must leave the quote entirely rather than become free,
-- which is what a zero weight would quietly do.
update public.pricing_config set enabled = false where operation = 'treg.reddit.search';

insert into _results (test, ok, detail)
select 'disabled_operation_drops_out_of_quote',
       (out->>'required')::numeric = 8,
       jsonb_build_object('out', out)
  from (select public.quote_sweep('00000000-0000-4000-8000-0000000acc01'::uuid, 8,
                                  array['treg.reddit.search','treg.twitter.search']) as out) q;

update public.pricing_config set enabled = true where operation = 'treg.reddit.search';

-- ===========================================================================
-- A sweep the user cannot afford is flagged, never run partially
-- ===========================================================================
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid, 5, 'topup', 0.05, null, 't:poor');

insert into _results (test, ok, detail)
select 'unaffordable_sweep_is_flagged_not_partially_run',
       (out->>'affordable')::boolean = false and (out->>'shortfall')::numeric = 19,
       jsonb_build_object('out', out, 'note', 'all or nothing, never partial')
  from (select public.quote_sweep('00000000-0000-4000-8000-0000000acc01'::uuid, 8,
                                  array['treg.reddit.search','treg.twitter.search']) as out) q;

-- ===========================================================================
-- Pricing changes are audited, including one made directly in SQL
-- ===========================================================================
update public.pricing_config set credits = 7 where operation = 'treg.twitter.search';

insert into _results (test, ok, detail)
select 'price_change_is_audited',
       exists (select 1 from public.pricing_audit
                where operation = 'treg.twitter.search' and field = 'credits'),
       jsonb_build_object('note', 'the trigger records changes made outside the app');

update public.pricing_config set credits = 1 where operation = 'treg.twitter.search';

-- ===========================================================================
-- A paid order carries a fee, and the fee must not stop the grant
-- ===========================================================================
-- The payment processor is a merchant of record: the fee is the business, so
-- every real payment has one. The credit unit price used to be derived by
-- dividing by the order's own credits_granted, which is 0 until the grant is
-- written, so a fee-bearing payment raised 22012 division_by_zero and the
-- customer paid and received nothing. The fee-less path took a different branch
-- and worked, which is why the bug survived.
--
-- The package is what was bought, so it is the divisor.
-- ---------------------------------------------------------------------------
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

insert into public.payment_orders (user_id, package_code, gross_usd, status)
values ('00000000-0000-4000-8000-0000000acc01', 'starter_200', 10.00, 'created');

insert into _results (test, ok, detail)
select 'fee_bearing_payment_still_grants_credits',
       (out->>'ok')::boolean
         and (out->>'credits_granted')::numeric = 200
         and (out->>'unit_price_usd')::numeric = 9.70 / 200,
       jsonb_build_object(
         'out', out,
         'note', 'unit price is net of the fee, not the list price')
  from (select public.wallet_topup_from_order(
          p_order_id        => (select id from public.payment_orders
                                 where user_id = '00000000-0000-4000-8000-0000000acc01'
                                   and status = 'created' order by created_at desc limit 1),
          p_fee_usd         => 0.30,
          p_net_usd         => 9.70,
          p_provider_ref    => 'acc_fee_pay',
          p_idempotency_key => 'acc:fee',
          p_paid_usd        => 10.00,
          p_paid_currency   => 'USD') as out) q;

insert into _results (test, ok, detail)
select 'fee_bearing_payment_credits_land_in_wallet',
       (select balance from public.wallet
         where user_id = '00000000-0000-4000-8000-0000000acc01') = 200,
       jsonb_build_object('balance',
         (select balance from public.wallet
           where user_id = '00000000-0000-4000-8000-0000000acc01'));

-- The provider redelivers, with a NEW event key each time. The grant is keyed
-- on the order, so this holds however many times it retries.
insert into _results (test, ok, detail)
select 'topup_replay_grants_nothing_twice',
       (out->>'duplicate')::boolean
         and (select balance from public.wallet
               where user_id = '00000000-0000-4000-8000-0000000acc01') = 200,
       jsonb_build_object('out', out,
         'note', 'a redelivery grants nothing and leaves the balance at 200')
  from (select public.wallet_topup_from_order(
          p_order_id        => (select id from public.payment_orders
                                 where user_id = '00000000-0000-4000-8000-0000000acc01' and provider_ref = 'acc_fee_pay'),
          p_fee_usd         => 0.30,
          p_net_usd         => 9.70,
          p_provider_ref    => 'acc_fee_pay',
          p_idempotency_key => 'acc:fee:redelivery',
          p_paid_usd        => 10.00,
          p_paid_currency   => 'USD') as out) q;

-- ===========================================================================
-- A refunded order never grants again (20261126)
-- ===========================================================================
-- A refund moves the order out of 'succeeded'. The duplicate check used to look
-- at that status only, so a later payment.succeeded with a new webhook id
-- granted the whole package a second time.
update public.payment_orders set status = 'refunded'
 where user_id = '00000000-0000-4000-8000-0000000acc01' and provider_ref = 'acc_fee_pay';

insert into _results (test, ok, detail)
select 'refunded_order_replay_grants_nothing',
       (out->>'duplicate')::boolean
         and (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01') = 200
         and (select count(*) from public.credit_grants
               where user_id = '00000000-0000-4000-8000-0000000acc01' and source = 'topup') = 1,
       jsonb_build_object('out', out)
  from (select public.wallet_topup_from_order(
          p_order_id        => (select id from public.payment_orders
                                 where user_id = '00000000-0000-4000-8000-0000000acc01' and provider_ref = 'acc_fee_pay'),
          p_idempotency_key => 'acc:fee:after-refund',
          p_paid_usd        => 10.00,
          p_paid_currency   => 'USD') as out) q;

-- A refund or dispute that lands before the payment event: never granted.
insert into public.payment_orders (user_id, package_code, gross_usd, status)
values ('00000000-0000-4000-8000-0000000acc01', 'starter_200', 10.00, 'disputed');

insert into _results (test, ok, detail)
select 'disputed_order_is_never_granted',
       (out->>'ok')::boolean = false
         and (out->>'error') = 'order_not_grantable'
         and (select balance from public.wallet where user_id = '00000000-0000-4000-8000-0000000acc01') = 200,
       jsonb_build_object('out', out)
  from (select public.wallet_topup_from_order(
          p_order_id        => (select id from public.payment_orders
                                 where user_id = '00000000-0000-4000-8000-0000000acc01' and status = 'disputed'),
          p_idempotency_key => 'acc:disputed',
          p_paid_usd        => 10.00,
          p_paid_currency   => 'USD') as out) q;

-- ===========================================================================
-- A hold left behind by a dead sweep is closed, not held forever
-- ===========================================================================
-- Reserve happens before the provider calls and settle after them. The window
-- between the two is not made survivable by a guarantee: an isolate eviction or a
-- wall-clock kill inside it leaves the credits reserved permanently, and the
-- workspace loses spendable balance on every subsequent sweep without ever being
-- told. A view listed them; nothing acted on it.
-- ---------------------------------------------------------------------------
select pg_temp.reset_wallet('00000000-0000-4000-8000-0000000acc01'::uuid);

select public.wallet_apply_grant('00000000-0000-4000-8000-0000000acc01'::uuid, 20, 'topup', 0.05, null, 't:reap-grant');

-- Reserved through the real entry point, then backdated to look like a sweep
-- that died two hours ago. Inserting the row directly would leave the wallet's
-- reserved counter untouched and the reaper would drive it negative — which is
-- what the check constraint did when this test was written the other way.
select public.wallet_reserve(
         '00000000-0000-4000-8000-0000000acc01'::uuid, 12, 'reap-test:old');

update public.reservations
   set created_at = now() - interval '2 hours'
 where idempotency_key = 'reap-test:old';

-- A hold from a minute ago: a sweep still in flight, and must not be touched.
select public.wallet_reserve(
         '00000000-0000-4000-8000-0000000acc01'::uuid, 3, 'reap-test:fresh');

-- The reaper's own counts and the state of the rows are read in two separate
-- statements on purpose. A single statement has one snapshot, taken before it
-- runs, so asserting on the rows it is about to change reads their pre-call
-- values — which would have made this test unable to pass in either direction.
-- (No `on commit drop`: in autocommit that dropped the table before it was read.)
create temp table _reap_out as
  select public.reap_stale_reservations('1 hour') as out;

insert into _results (test, ok, detail)
select 'reaper_releases_only_holds_past_its_window',
       -- >= rather than =: the reaper is global, and inside this transaction it
       -- also sees any genuinely stale holds (rolled back with everything else).
       (out->>'released')::int >= 1
         and (select status from public.reservations
               where idempotency_key = 'reap-test:old') = 'released'
         and (select status from public.reservations
               where idempotency_key = 'reap-test:fresh') = 'held',
       jsonb_build_object('out', out,
         'note', 'the hour-old hold is closed, the one-minute-old hold is a sweep still in flight')
  from _reap_out;

-- A reserve does not reduce balance; it moves credits into reserved, and
-- available = balance - reserved. So the wallet is still whole at 20 and only
-- the live hold is still reserved. What matters is that 15 became 3: without
-- the reaper the workspace would have been 12 credits short on every sweep
-- from here on, with nothing in the interface to say so.
insert into _results (test, ok, detail)
select 'reaped_hold_frees_the_dead_sweeps_hold',
       (select balance from public.wallet
         where user_id = '00000000-0000-4000-8000-0000000acc01') = 20
         and (select reserved from public.wallet
               where user_id = '00000000-0000-4000-8000-0000000acc01') = 3,
       jsonb_build_object(
         'balance', (select balance from public.wallet
                      where user_id = '00000000-0000-4000-8000-0000000acc01'),
         'reserved', (select reserved from public.wallet
                       where user_id = '00000000-0000-4000-8000-0000000acc01'),
         'note', 'the dead sweep hold is gone, the live one is untouched');


-- ===========================================================================
-- A client cannot act on another workspace's feed
-- ===========================================================================
-- The guard also tested session_user, which describes the connection rather than
-- the request, so any path authenticating as postgres while carrying a user JWT
-- skipped it entirely. Probed live: a different signed-in user deleted another
-- user's post and the function answered success, deleted: 1.
--
-- Runs here as the function owner with no request claims, which is the same
-- shape: the check must rest on who is asking, not on how the connection
-- happens to have authenticated.
-- ---------------------------------------------------------------------------
insert into public.monitored_posts (user_id, matched_keyword, platform, post_url, body)
values ('00000000-0000-4000-8000-0000000acc01', 'xpost-test', 'reddit',
        'https://acceptance.example/clear-feed-probe', 'probe')
on conflict (user_id, post_url) do nothing;

insert into _results (test, ok, detail)
select 'cross_workspace_clear_feed_is_refused',
       (out->>'success')::boolean = false
         and (out->>'error') = 'unauthorized',
       jsonb_build_object('out', out)
  from (select public.clear_feed('00000000-0000-4000-8000-0000000acc01'::uuid) as out) q;

insert into _results (test, ok, detail)
select 'refused_clear_feed_leaves_the_posts_alone',
       (select count(*) from public.monitored_posts
         where post_url = 'https://acceptance.example/clear-feed-probe') = 1,
       jsonb_build_object('note', 'the other workspace still has its post');


-- ===========================================================================
-- The sweep's shape is one number, defined once
-- ===========================================================================
-- Billing priced a sweep from every stored keyword and every configured channel,
-- while the sweep itself truncated to the caps and the interactive search used a
-- third count. A workspace at the limit was told its sweep cost more than the
-- sweep could ever reserve, and could be shown as able to afford a sweep the
-- cron then skipped every night.
-- ---------------------------------------------------------------------------
insert into _results (test, ok, detail)
select 'sweep_shape_matches_the_caps_the_sweep_applies',
       (public.sweep_shape()->>'max_keywords')::int = public.keyword_limit()
         and (public.sweep_shape()->>'max_channels')::int = public.channel_limit(),
       jsonb_build_object('shape', public.sweep_shape(),
         'note', 'billing quotes off this, so it cannot drift from the sweep');

-- ===========================================================================
-- Round 2 (20261127): paid-only holds, expiry, atomic refunds, reaper, pricing,
-- rate-limit validation, column privileges, account deletion.
-- ===========================================================================
create function pg_temp.acc() returns uuid language sql as
  $$ select '00000000-0000-4000-8000-0000000acc01'::uuid $$;

-- --- Welcome credits cannot pay for a paid-only hold ------------------------
select pg_temp.reset_wallet(pg_temp.acc());
select public.wallet_apply_grant(pg_temp.acc(), 20, 'grant', 0, null, 'r2:welcome');

insert into _results (test, ok, detail)
select 'paid_only_reserve_refuses_welcome_credits',
       (out->>'ok')::boolean = false
         and out->>'error' = 'insufficient_paid_credits'
         and (out->>'free_available')::numeric = 20,
       out
  from (select public.wallet_reserve(pg_temp.acc(), 1, 'r2:paid1', null, true) as out) q;

insert into _results (test, ok, detail)
select 'ordinary_reserve_still_uses_welcome_credits',
       (out->>'ok')::boolean and (out->>'paid_only')::boolean = false,
       out
  from (select public.wallet_reserve(pg_temp.acc(), 2, 'r2:any1') as out) q;

insert into _results (test, ok, detail)
select 'four_arg_named_call_still_resolves',
       (out->>'ok')::boolean,
       out
  from (select public.wallet_reserve(p_user_id => pg_temp.acc(), p_credits => 1,
                                     p_idempotency_key => 'r2:named', p_context => '{}'::jsonb) as out) q;

insert into _results (test, ok, detail)
select 'old_wallet_reserve_signature_dropped',
       to_regprocedure('public.wallet_reserve(uuid, numeric, text, jsonb)') is null
         and to_regprocedure('public.wallet_reserve(uuid, numeric, text, jsonb, boolean)') is not null,
       '{}'::jsonb;

-- --- Paid-only settle draws only purchased grants; ordinary draws free first --
select pg_temp.reset_wallet(pg_temp.acc());
select public.wallet_apply_grant(pg_temp.acc(), 10, 'topup', 0.05, null, 'r2:paid');
select public.wallet_apply_grant(pg_temp.acc(), 20, 'grant', 0, null, 'r2:free');

create temp table _r2 (k text primary key, v jsonb);
insert into _r2 values ('paid_hold', public.wallet_reserve(pg_temp.acc(), 4, 'r2:ph', null, true));
insert into _r2 values ('paid_settle',
  public.wallet_settle(((select v from _r2 where k = 'paid_hold')->>'reservation_id')::uuid, 4, 0, 'r2:ps'));

insert into _results (test, ok, detail)
select 'paid_only_settle_draws_only_paid_grants',
       (select credits_remaining from public.credit_grants
         where user_id = pg_temp.acc() and source = 'topup') = 6
       and (select credits_remaining from public.credit_grants
             where user_id = pg_temp.acc() and source = 'grant') = 20
       and ((select v from _r2 where k = 'paid_settle')->>'revenue_recognized')::numeric = 0.2,
       (select v from _r2 where k = 'paid_settle');

insert into _r2 values ('any_hold', public.wallet_reserve(pg_temp.acc(), 5, 'r2:ah'));
insert into _r2 values ('any_settle',
  public.wallet_settle(((select v from _r2 where k = 'any_hold')->>'reservation_id')::uuid, 5, 0, 'r2:as'));

insert into _results (test, ok, detail)
select 'ordinary_settle_draws_welcome_credits_first',
       (select credits_remaining from public.credit_grants
         where user_id = pg_temp.acc() and source = 'grant') = 15
       and (select credits_remaining from public.credit_grants
             where user_id = pg_temp.acc() and source = 'topup') = 6,
       (select v from _r2 where k = 'any_settle');

-- Ordinary holds beyond the free credits eat into what paid-only can use.
insert into _r2 values ('big_any', public.wallet_reserve(pg_temp.acc(), 17, 'r2:big'));
insert into _results (test, ok, detail)
select 'paid_available_accounts_for_ordinary_overflow',
       (out->>'available_paid')::numeric = 4 and (out->>'available')::numeric = 4,
       out
  from (select public.wallet_spendable(pg_temp.acc()) as out) q;

insert into _results (test, ok, detail)
select 'paid_only_refused_past_paid_available',
       (out->>'ok')::boolean = false and out->>'error' = 'insufficient_paid_credits',
       out
  from (select public.wallet_reserve(pg_temp.acc(), 5, 'r2:ph2', null, true) as out) q;

-- --- M7: an expired grant is not spendable ----------------------------------
select pg_temp.reset_wallet(pg_temp.acc());
select public.wallet_apply_grant(pg_temp.acc(), 10, 'topup', 0.05, null, 'r2:exp',
                                 now() - interval '1 day');
insert into _results (test, ok, detail)
select 'expired_grant_is_not_spendable_at_reserve',
       (out->>'ok')::boolean = false and (out->>'available')::numeric = 0,
       out
  from (select public.wallet_reserve(pg_temp.acc(), 1, 'r2:exp1') as out) q;

-- --- H7: revoke is idempotent on its key -------------------------------------
select pg_temp.reset_wallet(pg_temp.acc());
select public.wallet_apply_grant(pg_temp.acc(), 10, 'topup', 0.05, null, 'r2:rv');
select public.wallet_revoke_grant(id, 'refund', 3, 'refund:test:r1')
  from public.credit_grants where user_id = pg_temp.acc();
insert into _r2 values ('rv2', (select public.wallet_revoke_grant(id, 'refund', 3, 'refund:test:r1')
                                  from public.credit_grants where user_id = pg_temp.acc()));
insert into _results (test, ok, detail)
select 'revoke_with_same_key_twice_revokes_once',
       (select balance from public.wallet where user_id = pg_temp.acc()) = 7
       and (select count(*) from public.credit_ledger
             where user_id = pg_temp.acc() and kind = 'reversal') = 1
       and ((select v from _r2 where k = 'rv2')->>'duplicate')::boolean,
       (select v from _r2 where k = 'rv2');

-- --- H7: order-level refunds --------------------------------------------------
select pg_temp.reset_wallet(pg_temp.acc());
insert into public.payment_orders (id, user_id, package_code, gross_usd, currency, status)
values ('00000000-0000-4000-8000-0000000a2001'::uuid, pg_temp.acc(), 'starter_200', 10, 'USD', 'created');
select public.wallet_topup_from_order('00000000-0000-4000-8000-0000000a2001'::uuid,
                                      0.8, 9.2, 'pay_r2', 'dodo:r2', 10, 'USD');

insert into _r2 values ('ref1', public.wallet_refund_order('00000000-0000-4000-8000-0000000a2001'::uuid,
                                                            'rf_1', 2.5, 'USD'));
insert into _r2 values ('ref1b', public.wallet_refund_order('00000000-0000-4000-8000-0000000a2001'::uuid,
                                                             'rf_1', 2.5, 'USD'));
-- The payment-level event reporting the same cumulative total must not revoke again.
insert into _r2 values ('ref_total', public.wallet_refund_order('00000000-0000-4000-8000-0000000a2001'::uuid,
                                                                null, 2.5, 'USD', true));

insert into _results (test, ok, detail)
select 'refund_redelivery_and_cumulative_event_revoke_once',
       (select balance from public.wallet where user_id = pg_temp.acc()) = 150
       and (select count(*) from public.credit_ledger
             where user_id = pg_temp.acc() and kind = 'reversal') = 1
       and exists (select 1 from public.credit_ledger
                    where idempotency_key = 'refund:00000000-0000-4000-8000-0000000a2001:rf_1')
       and ((select v from _r2 where k = 'ref1b')->>'duplicate')::boolean
       and (select refunded_usd from public.payment_orders
             where id = '00000000-0000-4000-8000-0000000a2001'::uuid) = 2.5
       and (select status from public.payment_orders
             where id = '00000000-0000-4000-8000-0000000a2001'::uuid) = 'partially_refunded',
       jsonb_build_object('first', (select v from _r2 where k = 'ref1'),
                          'total', (select v from _r2 where k = 'ref_total'));

insert into _r2 values ('ref_eur', public.wallet_refund_order('00000000-0000-4000-8000-0000000a2001'::uuid,
                                                               'rf_2', 5, 'EUR'));
insert into _results (test, ok, detail)
select 'cross_currency_refund_is_parked_not_revoked',
       ((select v from _r2 where k = 'ref_eur')->>'error') = 'currency_mismatch'
       and (select status from public.payment_orders
             where id = '00000000-0000-4000-8000-0000000a2001'::uuid) = 'review'
       and (select balance from public.wallet where user_id = pg_temp.acc()) = 150,
       (select v from _r2 where k = 'ref_eur');

-- --- H7: disputes -------------------------------------------------------------
select pg_temp.reset_wallet(pg_temp.acc());
insert into public.payment_orders (id, user_id, package_code, gross_usd, currency, status)
values ('00000000-0000-4000-8000-0000000a2002'::uuid, pg_temp.acc(), 'starter_200', 10, 'USD', 'created');
select public.wallet_topup_from_order('00000000-0000-4000-8000-0000000a2002'::uuid,
                                      0.8, 9.2, 'pay_r2b', 'dodo:r2b', 10, 'USD');
insert into _r2 values ('d_hold', public.wallet_reserve(pg_temp.acc(), 50, 'r2:dh'));
insert into _r2 values ('d_open', public.wallet_dispute_order('00000000-0000-4000-8000-0000000a2002'::uuid, 'opened'));
insert into _r2 values ('d_open2', public.wallet_dispute_order('00000000-0000-4000-8000-0000000a2002'::uuid, 'opened'));
select public.wallet_release(((select v from _r2 where k = 'd_hold')->>'reservation_id')::uuid);
insert into _r2 values ('d_lost', public.wallet_dispute_order('00000000-0000-4000-8000-0000000a2002'::uuid, 'lost'));

insert into _results (test, ok, detail)
-- The 50 held when the dispute opened is owed (revoke_pending) and taken the
-- moment the hold is released (20261206), so 'lost' finds nothing left to take.
select 'dispute_freezes_spendable_then_lost_takes_the_rest',
       ((select v from _r2 where k = 'd_open')->>'revoked')::numeric = 150
       and ((select v from _r2 where k = 'd_open')->>'revoked')::numeric
           + coalesce((select sum(-delta) from public.credit_ledger
                        where user_id = pg_temp.acc() and kind = 'reversal'
                          and note = 'refund (collected after hold)'), 0)
           + ((select v from _r2 where k = 'd_lost')->>'revoked')::numeric = 200
       and ((select v from _r2 where k = 'd_open2')->>'revoked')::numeric = 0
       and (select balance from public.wallet where user_id = pg_temp.acc()) = 0
       and not exists (select 1 from public.credit_grants
                        where user_id = pg_temp.acc() and revoke_pending > 0)
       and (select status from public.payment_orders
             where id = '00000000-0000-4000-8000-0000000a2002'::uuid) = 'refunded',
       jsonb_build_object('open', (select v from _r2 where k = 'd_open'),
                          'lost', (select v from _r2 where k = 'd_lost'));

-- --- H7: webhook delivery claim ------------------------------------------------
insert into _r2 values ('c1', public.webhook_claim('dodo', 'r2-wh-1', 'refund.succeeded', '{}'));
insert into _r2 values ('c2', public.webhook_claim('dodo', 'r2-wh-1', 'refund.succeeded', '{}'));
update public.webhook_events set status = 'failed' where webhook_id = 'r2-wh-1';
insert into _r2 values ('c3', public.webhook_claim('dodo', 'r2-wh-1', 'refund.succeeded', '{}'));
update public.webhook_events set status = 'processed' where webhook_id = 'r2-wh-1';
insert into _r2 values ('c4', public.webhook_claim('dodo', 'r2-wh-1', 'refund.succeeded', '{}'));

insert into _results (test, ok, detail)
select 'webhook_claim_blocks_parallel_and_finished_deliveries',
       ((select v from _r2 where k = 'c1')->>'claimed')::boolean
       and not ((select v from _r2 where k = 'c2')->>'claimed')::boolean
       and ((select v from _r2 where k = 'c2')->>'in_flight')::boolean
       and ((select v from _r2 where k = 'c3')->>'claimed')::boolean
       and not ((select v from _r2 where k = 'c4')->>'claimed')::boolean,
       jsonb_build_object('c1', (select v from _r2 where k = 'c1'), 'c2', (select v from _r2 where k = 'c2'),
                          'c3', (select v from _r2 where k = 'c3'), 'c4', (select v from _r2 where k = 'c4'));

-- --- H6: the reaper settles a stale hold from api_usage.reservation_id ---------
select pg_temp.reset_wallet(pg_temp.acc());
select public.wallet_apply_grant(pg_temp.acc(), 10, 'topup', 0.05, null, 'r2:reap');
insert into _r2 values ('reap_hold', public.wallet_reserve(pg_temp.acc(), 5, 'r2:reaphold', null, true));
update public.reservations set created_at = now() - interval '2 hours'
 where id = ((select v from _r2 where k = 'reap_hold')->>'reservation_id')::uuid;
insert into public.api_usage (user_id, idempotency_key, operation, provider_cost_usd, credits_charged,
                              outcome, reservation_id)
values (pg_temp.acc(), 'r2:usage1', 'treg.people.email.find', 0.01, 2, 'success',
        ((select v from _r2 where k = 'reap_hold')->>'reservation_id')::uuid);
insert into _r2 values ('reaped', public.reap_stale_reservations('1 hour'));

insert into _results (test, ok, detail)
select 'reaper_settles_stale_hold_for_recorded_usage',
       (select status from public.reservations
         where id = ((select v from _r2 where k = 'reap_hold')->>'reservation_id')::uuid) = 'settled'
       and (select balance from public.wallet where user_id = pg_temp.acc()) = 8
       and (select reserved from public.wallet where user_id = pg_temp.acc()) = 0,
       (select v from _r2 where k = 'reaped');

-- --- Pricing (owner decision, 20261127) -----------------------------------------
-- The quote section above edited reddit/twitter/news inside this transaction, so
-- the seeded values are read from the audit trail's migration rows instead.
insert into _results (test, ok, detail)
select 'round2_prices_seeded',
       (select credits from public.pricing_config where operation = 'treg.people.search') = 1
       and (select credits from public.pricing_config where operation = 'treg.people.email.find') = 1
       and (select credits from public.pricing_config where operation = 'treg.people.phone.find') = 2
       and (select enabled from public.pricing_config where operation = 'leads.search.extra_50') = false
       and exists (select 1 from public.data_migrations where name = '20261127_pricing'),
       (select jsonb_object_agg(operation, jsonb_build_object('credits', credits, 'enabled', enabled))
          from public.pricing_config);

insert into _results (test, ok, detail)
select 'pricing_audit_records_who_and_inserts',
       (select count(*) from public.pricing_audit
         where operation = 'treg.twitter.search' and field = 'credits' and changed_by is not null) > 0,
       '{}'::jsonb;

insert into public.pricing_config (operation, display_name, provider_endpoint, credits)
values ('r2.test.op', 'probe', 'none', 1);
delete from public.pricing_config where operation = 'r2.test.op';
insert into _results (test, ok, detail)
select 'pricing_audit_records_insert_and_delete',
       (select count(*) from public.pricing_audit
         where operation = 'r2.test.op' and field in ('*insert*', '*delete*')) = 2,
       '{}'::jsonb;

-- --- N16 ------------------------------------------------------------------------
do $rl$
declare v_ok boolean := false;
begin
  begin
    perform public.take_rate_limit(pg_temp.acc(), 'r2', 5, null);
  exception when invalid_parameter_value then v_ok := true;
  end;
  insert into _results (test, ok, detail) values ('rate_limit_rejects_null_window', v_ok, '{}');
  v_ok := false;
  begin
    perform public.take_rate_limit(pg_temp.acc(), 'r2', 5, 3 * 86400);
  exception when invalid_parameter_value then v_ok := true;
  end;
  insert into _results (test, ok, detail) values ('rate_limit_rejects_window_over_48h', v_ok, '{}');
  insert into _results (test, ok, detail)
  values ('rate_limit_valid_window_still_works',
          public.take_rate_limit(pg_temp.acc(), 'r2', 5, 60), '{}');
end
$rl$;

-- --- M8: owners cannot read cost or revenue columns ------------------------------
do $m8$
declare
  v_cost_denied   boolean := false;
  v_rev_denied    boolean := false;
  v_price_denied  boolean := false;
  v_wallet_denied boolean := false;
  v_plain_ok      boolean := false;
begin
  perform set_config('request.jwt.claim.sub', pg_temp.acc()::text, true);
  set local role authenticated;
  begin perform provider_cost_usd from public.api_usage limit 1;
  exception when insufficient_privilege then v_cost_denied := true; end;
  begin perform revenue_usd from public.credit_ledger limit 1;
  exception when insufficient_privilege then v_rev_denied := true; end;
  begin perform unit_price_usd from public.credit_grants limit 1;
  exception when insufficient_privilege then v_price_denied := true; end;
  begin perform recognised_revenue_usd from public.wallet limit 1;
  exception when insufficient_privilege then v_wallet_denied := true; end;
  begin perform balance, reserved from public.wallet limit 1; v_plain_ok := true;
  exception when insufficient_privilege then v_plain_ok := false; end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  insert into _results (test, ok, detail)
  values ('owner_cannot_read_cost_and_revenue_columns',
          v_cost_denied and v_rev_denied and v_price_denied and v_wallet_denied and v_plain_ok,
          jsonb_build_object('api_usage.provider_cost_usd', v_cost_denied,
                             'credit_ledger.revenue_usd', v_rev_denied,
                             'credit_grants.unit_price_usd', v_price_denied,
                             'wallet.recognised_revenue_usd', v_wallet_denied,
                             'wallet.balance_readable', v_plain_ok));
end
$m8$;

-- --- N5 -------------------------------------------------------------------------
insert into _results (test, ok, detail)
select 'hot_path_indexes_exist',
       to_regclass('public.idx_api_usage_reservation') is not null
       and to_regclass('public.idx_credit_ledger_grant') is not null
       and to_regclass('public.idx_credit_ledger_payment_order') is not null,
       '{}'::jsonb;

-- --- M8: financial history survives account deletion (LAST: deletes the user) ---
delete from auth.users where id = pg_temp.acc();
insert into _results (test, ok, detail)
select 'financial_rows_survive_account_deletion',
       (select count(*) from public.credit_ledger
         where user_id is null and idempotency_key = 'r2:reap') = 1
       and (select count(*) from public.api_usage where idempotency_key = 'r2:usage1' and user_id is null) = 1
       and not exists (select 1 from public.wallet where user_id = pg_temp.acc()),
       '{}'::jsonb;

-- ===========================================================================
-- Verdict, then undo everything
-- ===========================================================================
-- One JSON object per line; scripts/run-sql-test.cjs parses these.
select row_to_json(r)::text as result
  from (select ord, test, ok, detail from _results order by ord) r;

select count(*) filter (where not ok) as failed, count(*) as total from _results;

rollback;