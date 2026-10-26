-- ============================================================================
-- Refunds and disputes against held credits — acceptance tests (20261206)
-- ----------------------------------------------------------------------------
--   * a refund that lands while the bought credits are on hold is owed, not
--     forgotten, and is taken as soon as the hold closes;
--   * owed credits cannot be spent in the meantime;
--   * a refund of a purchased grant never takes welcome credits instead;
--   * a dispute won by the merchant clears what was owed;
--   * an order whose account was deleted is parked for review.
--
-- One transaction, rolled back. Nothing survives.
-- ============================================================================

begin;

insert into auth.users (id, email, aud, role)
values ('00000000-0000-4000-8000-0000000acc03', 'acceptance-billing@echo.invalid', 'authenticated', 'authenticated');

create function pg_temp.acc() returns uuid language sql immutable as
  $$ select '00000000-0000-4000-8000-0000000acc03'::uuid $$;

-- Zero credits and no history, then exactly the grants a scenario asks for.
create function pg_temp.reset() returns void language plpgsql as $$
begin
  delete from public.credit_ledger where user_id = pg_temp.acc();
  delete from public.reservations  where user_id = pg_temp.acc();
  delete from public.credit_grants where user_id = pg_temp.acc();
  delete from public.payment_orders where user_id = pg_temp.acc();
  update public.wallet
     set balance = 0, reserved = 0, lifetime_granted = 0, lifetime_consumed = 0,
         recognised_revenue_usd = 0, service_cost_usd = 0
   where user_id = pg_temp.acc();
end;
$$;

-- A paid order for the 200-credit pack, granted.
create function pg_temp.buy(p_order uuid) returns void language plpgsql as $$
begin
  insert into public.payment_orders (id, user_id, package_code, gross_usd, currency, status)
  values (p_order, pg_temp.acc(), 'starter_200', 10, 'USD', 'created');
  perform public.wallet_topup_from_order(p_order, 0.5, 9.5, 'pay_' || p_order::text, 'dodo:' || p_order::text, 10, 'USD');
end;
$$;

create function pg_temp.bal() returns numeric language sql as
  $$ select balance from public.wallet where user_id = pg_temp.acc() $$;
create function pg_temp.owed() returns numeric language sql as
  $$ select coalesce(sum(revoke_pending), 0) from public.credit_grants where user_id = pg_temp.acc() $$;

create temp table _results (ord serial, test text, ok boolean, detail jsonb);
create temp table _v (k text primary key, v jsonb);

-- --- Refund while everything is on hold ------------------------------------
select pg_temp.reset();
select pg_temp.buy('00000000-0000-4000-8000-0000000b0001');
insert into _v values ('hold', public.wallet_reserve(pg_temp.acc(), 200, 'br:hold', null, true));
insert into _v values ('refund', public.wallet_refund_order('00000000-0000-4000-8000-0000000b0001', 'rf_full', 10, 'USD'));

insert into _results (test, ok, detail)
select 'refund_during_hold_is_owed_not_lost',
       ((select v from _v where k = 'refund')->>'revoked')::numeric = 0
       and pg_temp.owed() = 200,
       (select v from _v where k = 'refund');

insert into _v values ('spend', public.wallet_reserve(pg_temp.acc(), 1, 'br:spend', null, true));
insert into _results (test, ok, detail)
select 'owed_credits_cannot_be_reserved', not ((select v from _v where k = 'spend')->>'ok')::boolean,
       (select v from _v where k = 'spend');

-- The job used 30 of its 200; the other 170 come back and are taken at once.
select public.wallet_settle(((select v from _v where k = 'hold')->>'reservation_id')::uuid, 30, 0.01, 'br:settle');
insert into _results (test, ok, detail)
select 'owed_credits_taken_when_the_hold_closes',
       pg_temp.bal() = 0 and pg_temp.owed() = 0
       and (select coalesce(sum(-delta), 0) from public.credit_ledger
             where user_id = pg_temp.acc() and kind = 'reversal') = 170,
       jsonb_build_object('balance', pg_temp.bal(), 'owed', pg_temp.owed());

-- --- A refund of bought credits never takes welcome credits --------------------
select pg_temp.reset();
select public.wallet_apply_grant(pg_temp.acc(), 20, 'grant', 0, null, 'br:welcome');
select pg_temp.buy('00000000-0000-4000-8000-0000000b0002');
insert into _v values ('hold2', public.wallet_reserve(pg_temp.acc(), 200, 'br:hold2', null, true));
insert into _v values ('refund2', public.wallet_refund_order('00000000-0000-4000-8000-0000000b0002', 'rf_2', 10, 'USD'));

insert into _results (test, ok, detail)
select 'refund_does_not_take_welcome_credits',
       ((select v from _v where k = 'refund2')->>'revoked')::numeric = 0
       and (select credits_remaining from public.credit_grants
             where user_id = pg_temp.acc() and source = 'grant') = 20
       and pg_temp.owed() = 200,
       (select v from _v where k = 'refund2');

-- The paid-only job can still draw everything it held.
insert into _v values ('settle2', public.wallet_settle(((select v from _v where k = 'hold2')->>'reservation_id')::uuid, 200, 0, 'br:settle2'));
insert into _results (test, ok, detail)
select 'held_paid_work_is_fully_charged',
       ((select v from _v where k = 'settle2')->>'credits_charged')::numeric = 200
       and pg_temp.bal() = 20 and pg_temp.owed() = 0,
       (select v from _v where k = 'settle2');

-- --- A dispute the merchant wins clears what was owed --------------------------
select pg_temp.reset();
select pg_temp.buy('00000000-0000-4000-8000-0000000b0003');
insert into _v values ('hold3', public.wallet_reserve(pg_temp.acc(), 50, 'br:hold3', null, true));
select public.wallet_dispute_order('00000000-0000-4000-8000-0000000b0003', 'opened');
select public.wallet_dispute_order('00000000-0000-4000-8000-0000000b0003', 'won');
select public.wallet_release(((select v from _v where k = 'hold3')->>'reservation_id')::uuid);

insert into _results (test, ok, detail)
select 'dispute_won_clears_owed_credits',
       pg_temp.owed() = 0 and pg_temp.bal() = 50
       and (select status from public.payment_orders where id = '00000000-0000-4000-8000-0000000b0003') = 'succeeded',
       jsonb_build_object('balance', pg_temp.bal(), 'owed', pg_temp.owed());

-- --- Payment for a deleted account ----------------------------------------------
select pg_temp.reset();
insert into public.payment_orders (id, user_id, package_code, gross_usd, currency, status)
values ('00000000-0000-4000-8000-0000000b0004', pg_temp.acc(), 'starter_200', 10, 'USD', 'created');
update public.payment_orders set user_id = null where id = '00000000-0000-4000-8000-0000000b0004';
insert into _v values ('orphan', public.wallet_topup_from_order('00000000-0000-4000-8000-0000000b0004',
                                                               0.5, 9.5, 'pay_orphan', 'dodo:orphan', 10, 'USD'));
insert into _results (test, ok, detail)
select 'payment_for_deleted_account_is_parked',
       ((select v from _v where k = 'orphan')->>'error') = 'account_deleted'
       and (select status from public.payment_orders where id = '00000000-0000-4000-8000-0000000b0004') = 'review',
       (select v from _v where k = 'orphan');

-- ===========================================================================
select row_to_json(r)::text as result
  from (select ord, test, ok, detail from _results order by ord) r;

select count(*) filter (where not ok) as failed, count(*) as total from _results;

rollback;
