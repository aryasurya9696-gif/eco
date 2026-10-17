-- ============================================================================
-- Credit wallet — concurrency test
-- ----------------------------------------------------------------------------
-- This is the one claim Phase 1 cannot demonstrate on a single connection: that
-- two sweeps starting at the same instant cannot both decide they can afford
-- the same credits.
--
-- It needs two real database connections, because the bug it guards against is
-- specifically two transactions reading the same pre-reserve balance. Run from
-- CI, or anywhere the database password is available, via dblink:
--
--   psql "$DATABASE_URL" -f credit_wallet_concurrency.sql
--
-- It has not been run yet. The environment this was written in connects
-- through a non-superuser role with no database password, so dblink refuses to
-- open the second connection it needs. Run it before trusting the functions
-- under contention.
--
-- What is verified in the acceptance suite instead, and is worth stating
-- plainly: every mutating function takes FOR UPDATE on the wallet row, the
-- table refuses a negative balance, and reserved can never exceed balance. Those
-- are the mechanisms. This file is the proof that they hold under contention.
-- ============================================================================

\set ON_ERROR_STOP on

create extension if not exists dblink;

-- ---------------------------------------------------------------------------
-- Fixture: one wallet, ten credits
-- ---------------------------------------------------------------------------
create or replace function pg_temp.reset_wallet(p_user uuid)
returns void language plpgsql as $$
begin
  delete from public.credit_ledger where user_id = p_user;
  delete from public.reservations  where user_id = p_user;
  delete from public.credit_grants where user_id = p_user;
  update public.wallet
     set balance = 0, reserved = 0, lifetime_granted = 0, lifetime_consumed = 0,
         recognised_revenue_usd = 0, service_cost_usd = 0
   where user_id = p_user;
end;
$$;

select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);
select public.wallet_apply_grant('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid,
                                 10, 'topup', 0.05, null, 'conc:fixture');

commit;

-- ---------------------------------------------------------------------------
-- Twenty simultaneous single-credit reserves against a balance of ten.
--
-- dblink_send_query returns before the remote query finishes, so firing all
-- twenty without collecting in between is what makes them genuinely overlap on
-- the server. Collecting results afterwards lets them all settle.
--
-- The expected outcome is not "all twenty succeed". It is that exactly ten do,
-- that the other ten are told how short they are, and that the wallet is never
-- left holding more than it owns.
-- ---------------------------------------------------------------------------
do $race$
declare
  v_user  constant uuid := '231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid;
  v_workers constant int := 20;
  v_succeeded int := 0;
  v_refused   int := 0;
  v_balance   numeric;
  v_reserved  numeric;
  v_min       numeric;
  i int;
  r jsonb;
begin
  for i in 1..v_workers loop
    perform dblink_connect('w' || i, 'dbname=' || current_database());
    -- Sent, not awaited. This is the part that makes it a race.
    perform dblink_send_query('w' || i,
      format('select public.wallet_reserve(%L::uuid, 1, %L)', v_user, 'conc:' || i));
  end loop;

  for i in 1..v_workers loop
    r := dblink_get_result('w' || i) as res;
    if (r->0->>'ok')::boolean then
      v_succeeded := v_succeeded + 1;
    else
      v_refused := v_refused + 1;
      if (r->0->>'error') <> 'insufficient_credits' then
        raise exception 'worker % refused for the wrong reason: %', i, r->0;
      end if;
    end if;
    perform dblink_disconnect('w' || i);
  end loop;

  select balance, reserved into v_balance, v_reserved
    from public.wallet where user_id = v_user;
  select min(balance) into v_min
    from public.wallet where user_id = v_user;

  raise notice 'succeeded=% refused=% balance=% reserved=%',
               v_succeeded, v_refused, v_balance, v_reserved;

  if v_succeeded <> 10 then
    raise exception 'expected exactly 10 reserves to succeed, got %', v_succeeded;
  end if;
  if v_refused <> 10 then
    raise exception 'expected exactly 10 reserves to be refused, got %', v_refused;
  end if;
  if v_balance <> 0 then
    raise exception 'balance should be fully committed as reserved, expected 0, got %', v_balance;
  end if;
  if v_reserved <> 10 then
    raise exception 'expected 10 credits held, got %', v_reserved;
  end if;
  if v_min < 0 then
    raise exception 'balance went negative: %', v_min;
  end if;

  raise notice 'PASS: contention resolved to exactly 10, no double spend, no negative balance';
end;
$race$;

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------
select pg_temp.reset_wallet('231f8d14-488f-4413-a1db-bb34a910ec1c'::uuid);
drop extension if exists dblink;