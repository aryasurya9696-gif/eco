-- ============================================================================
-- Credit wallet — acceptance tests
-- ----------------------------------------------------------------------------
-- Phase 1's claim is that the balance cannot be spent twice, cannot go
-- negative, and cannot be charged twice for one job. These assert exactly that
-- and nothing else.
--
-- Runs against the live database and cleans up after itself, leaving the test
-- user's wallet at zero and no test rows behind. Nothing here touches real
-- customer data.
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
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);

select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid,
                                 15, 'topup', 0.05, null, 't:g1');

insert into _results (test, ok, detail)
select 'grant_adds_credits',
       balance = 15,
       jsonb_build_object('balance', balance, 'expected', 15)
  from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid;

insert into _results (test, ok, detail)
select 'grant_recognises_no_revenue',
       coalesce(sum(revenue_usd), 0) = 0,
       jsonb_build_object('revenue', coalesce(sum(revenue_usd), 0))
  from public.credit_ledger
 where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid and kind = 'topup';

-- A retried payment webhook lands here, so a replay must not double the balance.
select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid,
                                 15, 'topup', 0.05, null, 't:g1');

insert into _results (test, ok, detail)
select 'grant_replay_is_idempotent',
       balance = 15,
       jsonb_build_object('balance_after_replay', balance, 'expected', 15)
  from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid;

-- ===========================================================================
-- A reserve holds credits and shrinks what is spendable
-- ===========================================================================
create temp table _res_a (id uuid);
insert into _res_a
select (public.wallet_reserve('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 8, 't:r1')->>'reservation_id')::uuid;

insert into _results (test, ok, detail)
select 'reserve_holds_credits',
       reserved = 8 and balance = 15,
       jsonb_build_object('balance', balance, 'reserved', reserved,
                          'available', balance - reserved)
  from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid;

-- Over-reserving is refused and reports exactly how much is missing.
create temp table _over (out jsonb);
delete from _over;
insert into _over
select public.wallet_reserve('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 10, 't:r-too-big');

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
insert into _over select public.wallet_reserve('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 8, 't:r1');

insert into _results (test, ok, detail)
select 'reserve_replay_is_idempotent',
       (select reserved from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = 8
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
       (select balance from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = 10
       and (select reserved from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = 0,
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
       and (select balance from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = 10,
       jsonb_build_object('out', out,
                          'balance', (select balance from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid))
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
select (public.wallet_reserve('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 6, 't:r2')->>'reservation_id')::uuid;

create temp table _ledger_before (n bigint);
insert into _ledger_before
select count(*) from public.credit_ledger where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid;

delete from _over;
insert into _over
select public.wallet_release(id, 'provider 503') from _res_b;

insert into _results (test, ok, detail)
select 'release_returns_the_hold',
       (select reserved from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = 0
       and (select balance from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = 10,
       out
  from _over;

insert into _results (test, ok, detail)
select 'release_writes_no_charge',
       (select count(*) from public.credit_ledger where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = (select n from _ledger_before)
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
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);

select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 5, 'topup', 0.05, null, 't:f:a');
select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 10, 'topup', 0.02, null, 't:f:b');

create temp table _fifo (out jsonb);
insert into _fifo
select pg_temp.spend('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 8, 8, 0.0025);

insert into _results (test, ok, detail)
select 'fifo_drains_the_older_grant_first',
       (select credits_remaining from public.credit_grants
         where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid and credits = 5) = 0,
       jsonb_build_object('note', 'the $0.05 grant was issued first, so it drains first');

insert into _results (test, ok, detail)
select 'fifo_recognises_per_grant_price',
       (select coalesce(sum(revenue_usd), 0) from public.credit_ledger
         where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid and kind = 'usage') = 0.31,
       jsonb_build_object(
         'recognised', (select coalesce(sum(revenue_usd), 0) from public.credit_ledger
                         where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid and kind = 'usage'),
         'expected', 0.31,
         'wrong_answer_if_headline_rate_used', 0.40);

insert into _results (test, ok, detail)
select 'fifo_charges_the_right_total',
       (select balance from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = 7,
       jsonb_build_object('balance', (select balance from public.wallet
                                       where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid),
                          'expected', 7);

-- ===========================================================================
-- A zero-price grant recognises nothing when consumed.
-- Bonus credits were given away, so spending them earns nothing.
-- ===========================================================================
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);

select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 4, 'bonus', 0, null, 't:bonus');

create temp table _bonus (out jsonb);
insert into _bonus select pg_temp.spend('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 4, 4, 0);

insert into _results (test, ok, detail)
select 'bonus_grant_recognises_nothing',
       (out->>'revenue_recognized')::numeric = 0
       and (out->>'credits_charged')::numeric = 4,
       out
  from _bonus;

-- ===========================================================================
-- Settling more than was held is clipped, not obeyed
-- ===========================================================================
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);

select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 20, 'topup', 0.05, null, 't:clip');

create temp table _clip (out jsonb);
insert into _clip
select public.wallet_settle(
  (public.wallet_reserve('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 3, 't:r3')->>'reservation_id')::uuid,
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
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);

select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 5, 'topup', 0.05, null, 't:dry');

-- Inflate the balance without inflating the grants. This is what a bug anywhere
-- upstream of the draw would look like.
update public.wallet set balance = 100 where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid;

create temp table _dry (out jsonb);
insert into _dry
select public.wallet_settle(
  (public.wallet_reserve('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 10, 't:r4')->>'reservation_id')::uuid,
  10, 0.001, 't:s4');

insert into _results (test, ok, detail)
select 'settle_clipped_to_available_grants',
       (out->>'credits_charged')::numeric = 5
       and (select balance from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) >= 0,
       jsonb_build_object('out', out,
                          'balance_after', (select balance from public.wallet
                                             where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid))
  from _dry;

-- ===========================================================================
-- A refund takes back only what is unspent
-- ===========================================================================
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);

select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 10, 'topup', 0.05, null, 't:refund');
select pg_temp.spend('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 8, 8, 0.001);

create temp table _refund (out jsonb);
insert into _refund
select public.wallet_revoke_grant(id, 'refund')
  from public.credit_grants
 where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid and credits = 10;

insert into _results (test, ok, detail)
select 'refund_takes_back_only_the_unspent',
       (select balance from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = 0
       and (out->>'revoked')::numeric = 2,
       out
  from _refund;

-- Already spent, so nothing left to revoke, and still not negative.
delete from _refund;
insert into _refund
select public.wallet_revoke_grant(id, 'second refund')
  from public.credit_grants
 where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid and credits = 10;

insert into _results (test, ok, detail)
select 'second_refund_is_a_noop',
       (select balance from public.wallet where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid) = 0
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
    update public.wallet set balance = -1 where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid;
    insert into _results (test, ok, detail)
    values ('direct_negative_balance_blocked', false,
            jsonb_build_object('note', 'the UPDATE should have been rejected'));
  exception when check_violation then
    insert into _results (test, ok, detail)
    values ('direct_negative_balance_blocked', true, jsonb_build_object('error', 'check_violation'));
  end;

  begin
    update public.wallet set reserved = balance + 1 where user_id = '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid;
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
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);

insert into _results (test, ok, detail)
select 'quote_uses_configured_prices',
       (out->>'required')::numeric = 24,
       jsonb_build_object('out', out, 'basis', '8 keywords x (2 reddit + 1 twitter)')
  from (select public.quote_sweep('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 8,
                                  array['treg.reddit.search','treg.twitter.search']) as out) q;

insert into _results (test, ok, detail)
select 'news_is_charged_a_credit_despite_zero_cost',
       (out->>'required')::numeric = 24,
       jsonb_build_object('out', out)
  from (select public.quote_sweep('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 8,
                                  array['treg.reddit.search','treg.news.search']) as out) q;

insert into _results (test, ok, detail)
select 'quote_of_nothing_is_free',
       (out->>'required')::numeric = 0 and (out->>'affordable')::boolean,
       jsonb_build_object('out', out)
  from (select public.quote_sweep('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 0,
                                  array['treg.reddit.search']) as out) q;

-- A disabled operation must leave the quote entirely rather than become free,
-- which is what a zero weight would quietly do.
update public.pricing_config set enabled = false where operation = 'treg.reddit.search';

insert into _results (test, ok, detail)
select 'disabled_operation_drops_out_of_quote',
       (out->>'required')::numeric = 8,
       jsonb_build_object('out', out)
  from (select public.quote_sweep('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 8,
                                  array['treg.reddit.search','treg.twitter.search']) as out) q;

update public.pricing_config set enabled = true where operation = 'treg.reddit.search';

-- ===========================================================================
-- A sweep the user cannot afford is flagged, never run partially
-- ===========================================================================
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);

select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 5, 'topup', 0.05, null, 't:poor');

insert into _results (test, ok, detail)
select 'unaffordable_sweep_is_flagged_not_partially_run',
       (out->>'affordable')::boolean = false and (out->>'shortfall')::numeric = 19,
       jsonb_build_object('out', out, 'note', 'all or nothing, never partial')
  from (select public.quote_sweep('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid, 8,
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
-- Cleanup, before the verdict
-- ===========================================================================
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);
delete from public.pricing_audit;

select * from _results order by ord;