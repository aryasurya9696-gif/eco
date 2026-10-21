-- ============================================================================
-- Credit wallet — concurrency suite
-- ----------------------------------------------------------------------------
-- The claims that a single connection cannot demonstrate:
--
--   1. N parallel reserves against balance B: exactly floor(B / c) succeed, the
--      rest are refused as insufficient, and the wallet never holds more than it
--      owns.
--   2. Two parallel deliveries of the same refund revoke once (H7).
--   3. Two parallel claims of the same webhook delivery: exactly one wins (H7).
--   4. Parallel paid-only reserves never spend welcome credits.
--
-- Needs real parallel connections, so it uses dblink, and it has to COMMIT its
-- fixture so those connections can see it. It therefore works on a dedicated
-- synthetic user (never a real account) and deletes everything it created at the
-- end, whether or not the checks passed. Run it only against a LOCAL or CI
-- database:
--
--   node scripts/run-sql-test.cjs credit_wallet_concurrency --yes --local
--
-- dblink connects with 'dbname=<current db>' unless the session setting
-- echo.test_dblink holds a full connection string:
--   PGOPTIONS="-c echo.test_dblink=host=localhost\ port=5432\ user=postgres"
--
-- Output: one JSON object per check (ord, test, ok, detail), like the
-- acceptance suite.
-- ============================================================================

create extension if not exists dblink;

create temp table _results (ord serial, test text, ok boolean, detail jsonb);

create function pg_temp.u() returns uuid language sql as
  $$ select '00000000-0000-4000-8000-00000000c0c1'::uuid $$;
create function pg_temp.o() returns uuid language sql as
  $$ select '00000000-0000-4000-8000-00000000c0d1'::uuid $$;
create function pg_temp.conn() returns text language sql as
  $$ select coalesce(nullif(current_setting('echo.test_dblink', true), ''),
                     'dbname=' || current_database()) $$;

create function pg_temp.cleanup() returns void language plpgsql as $$
begin
  delete from public.payment_refunds where order_id = pg_temp.o();
  delete from public.credit_ledger  where user_id = pg_temp.u() or payment_order_id = pg_temp.o();
  delete from public.api_usage      where user_id = pg_temp.u();
  delete from public.reservations   where user_id = pg_temp.u();
  delete from public.credit_grants  where user_id = pg_temp.u() or payment_order_id = pg_temp.o();
  delete from public.payment_orders where id = pg_temp.o();
  delete from public.webhook_events where webhook_id like 'conc-%';
  delete from public.wallet         where user_id = pg_temp.u();
  delete from auth.users            where id = pg_temp.u();
end;
$$;

-- Fires N copies of a statement on N connections without waiting, then
-- collects every result. Returns the jsonb results in worker order.
create function pg_temp.race(p_sql text[]) returns jsonb[] language plpgsql as $$
declare
  v_out jsonb[] := '{}';
  v_r   jsonb;
  i     int;
begin
  for i in 1..array_length(p_sql, 1) loop
    perform dblink_connect('w' || i, pg_temp.conn());
  end loop;
  -- Sent, not awaited: this is what makes them overlap on the server.
  for i in 1..array_length(p_sql, 1) loop
    perform dblink_send_query('w' || i, p_sql[i]);
  end loop;
  for i in 1..array_length(p_sql, 1) loop
    select res into v_r from dblink_get_result('w' || i) as t(res jsonb);
    -- drain the end-of-results marker
    perform * from dblink_get_result('w' || i) as t(res jsonb);
    v_out := v_out || v_r;
    perform dblink_disconnect('w' || i);
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture (committed): 10 purchased credits, 20 welcome credits
-- ---------------------------------------------------------------------------
select pg_temp.cleanup();
insert into auth.users (id, email, aud, role)
values (pg_temp.u(), 'concurrency-test@echo.invalid', 'authenticated', 'authenticated');
-- handle_new_user granted the welcome credits; make them exactly 20.
delete from public.credit_ledger where user_id = pg_temp.u();
delete from public.credit_grants where user_id = pg_temp.u();
update public.wallet set balance = 0, reserved = 0, lifetime_granted = 0, lifetime_consumed = 0,
                         recognised_revenue_usd = 0, service_cost_usd = 0
 where user_id = pg_temp.u();
select public.wallet_apply_grant(pg_temp.u(), 20, 'grant', 0, null, 'conc:welcome');
select public.wallet_apply_grant(pg_temp.u(), 10, 'topup', 0.05, null, 'conc:paid');

-- ---------------------------------------------------------------------------
-- 1 + 4. Twenty parallel paid-only single-credit reserves against 10 purchased
--        credits (and 20 welcome credits that must not be touched).
-- ---------------------------------------------------------------------------
do $race1$
declare
  v_sql  text[] := '{}';
  v_res  jsonb[];
  v_ok   int := 0;
  v_no   int := 0;
  v_bad  int := 0;
  v_w    public.wallet%rowtype;
  i      int;
begin
  for i in 1..20 loop
    v_sql := v_sql || format('select public.wallet_reserve(%L::uuid, 1, %L, null, true)',
                             pg_temp.u(), 'conc:paid:' || i);
  end loop;
  v_res := pg_temp.race(v_sql);
  for i in 1..array_length(v_res, 1) loop
    if (v_res[i]->>'ok')::boolean then v_ok := v_ok + 1;
    elsif v_res[i]->>'error' = 'insufficient_paid_credits' then v_no := v_no + 1;
    else v_bad := v_bad + 1;
    end if;
  end loop;
  select * into v_w from public.wallet where user_id = pg_temp.u();
  insert into _results (test, ok, detail) values (
    'parallel_paid_only_reserves_exactly_fill_paid_credits',
    v_ok = 10 and v_no = 10 and v_bad = 0 and v_w.reserved = 10 and v_w.balance = 30,
    jsonb_build_object('succeeded', v_ok, 'refused', v_no, 'other', v_bad,
                       'balance', v_w.balance, 'reserved', v_w.reserved));
end
$race1$;

-- Then twenty ordinary 1-credit reserves: exactly the 20 welcome credits remain.
do $race2$
declare
  v_sql  text[] := '{}';
  v_res  jsonb[];
  v_ok   int := 0;
  v_no   int := 0;
  v_w    public.wallet%rowtype;
  i      int;
begin
  for i in 1..25 loop
    v_sql := v_sql || format('select public.wallet_reserve(%L::uuid, 1, %L)', pg_temp.u(), 'conc:any:' || i);
  end loop;
  v_res := pg_temp.race(v_sql);
  for i in 1..array_length(v_res, 1) loop
    if (v_res[i]->>'ok')::boolean then v_ok := v_ok + 1;
    elsif v_res[i]->>'error' = 'insufficient_credits' then v_no := v_no + 1;
    end if;
  end loop;
  select * into v_w from public.wallet where user_id = pg_temp.u();
  insert into _results (test, ok, detail) values (
    'parallel_reserves_never_exceed_balance',
    v_ok = 20 and v_no = 5 and v_w.reserved = 30 and v_w.reserved <= v_w.balance,
    jsonb_build_object('succeeded', v_ok, 'refused', v_no,
                       'balance', v_w.balance, 'reserved', v_w.reserved));
end
$race2$;

-- Release everything for the next race.
select public.wallet_release(id, 'conc cleanup')
  from public.reservations where user_id = pg_temp.u() and status = 'held';

-- ---------------------------------------------------------------------------
-- 2. Two parallel deliveries of one refund revoke once
-- ---------------------------------------------------------------------------
insert into public.payment_orders (id, user_id, package_code, gross_usd, currency, status)
values (pg_temp.o(), pg_temp.u(), 'starter_200', 10, 'USD', 'created');
select public.wallet_topup_from_order(pg_temp.o(), 0.8, 9.2, 'pay_conc', 'dodo:conc', 10, 'USD');

do $race3$
declare
  v_one text := format('select public.wallet_refund_order(%L::uuid, %L, 5, %L)', pg_temp.o(), 'rf_conc', 'USD');
  v_res jsonb[];
  v_rev int;
  v_ord public.payment_orders%rowtype;
begin
  v_res := pg_temp.race(array[v_one, v_one, v_one, v_one]);
  select count(*) into v_rev from public.credit_ledger where payment_order_id = pg_temp.o() and kind = 'reversal';
  select * into v_ord from public.payment_orders where id = pg_temp.o();
  insert into _results (test, ok, detail) values (
    'parallel_identical_refunds_revoke_once',
    v_rev = 1 and v_ord.refunded_usd = 5
      and (select balance from public.wallet where user_id = pg_temp.u()) = 130,
    jsonb_build_object('reversal_rows', v_rev, 'refunded_usd', v_ord.refunded_usd,
                       'results', to_jsonb(v_res)));
end
$race3$;

-- ---------------------------------------------------------------------------
-- 3. Two parallel claims of one webhook delivery: one winner
-- ---------------------------------------------------------------------------
do $race4$
declare
  v_one text := $q$select public.webhook_claim('dodo', 'conc-wh-1', 'refund.succeeded', '{}'::jsonb)$q$;
  v_res jsonb[];
  v_won int := 0;
  i int;
begin
  v_res := pg_temp.race(array[v_one, v_one, v_one]);
  for i in 1..array_length(v_res, 1) loop
    if (v_res[i]->>'claimed')::boolean then v_won := v_won + 1; end if;
  end loop;
  insert into _results (test, ok, detail) values (
    'parallel_webhook_claims_one_winner', v_won = 1, jsonb_build_object('results', to_jsonb(v_res)));
end
$race4$;

-- ---------------------------------------------------------------------------
-- Verdict, then remove every committed fixture row
-- ---------------------------------------------------------------------------
select row_to_json(r)::text as result
  from (select ord, test, ok, detail from _results order by ord) r;

select pg_temp.cleanup();

insert into _results (test, ok, detail)
select 'fixture_removed',
       not exists (select 1 from auth.users where id = pg_temp.u())
       and not exists (select 1 from public.credit_ledger where user_id = pg_temp.u()),
       '{}'::jsonb;

select row_to_json(r)::text as result
  from (select ord, test, ok, detail from _results where test = 'fixture_removed') r;
