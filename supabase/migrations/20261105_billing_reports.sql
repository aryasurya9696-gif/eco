-- ============================================================================
-- Credit wallet — reconciliation and reporting views
-- ----------------------------------------------------------------------------
-- Read by the operator directly from SQL. Deliberately not surfaced in the app:
-- this product has no admin screen, so a view nobody can reach from the browser
-- cannot be tampered with through the browser either.
--
-- The reconciliation views exist to answer one question honestly: does what we
-- think treg charged us match what treg says it charged us? Everything else here
-- is margin reporting, which is only trustworthy if that question comes back
-- clean.
--
-- None of these views adjust anything. They surface drift; correcting it is a
-- deliberate decision, never an automatic one.
--
-- Written with derived tables rather than CTEs. Plain SELECT ... FROM ( ... ) is
-- used throughout because the tool these migrations are applied through rejects
-- a leading WITH clause, and the two are equivalent to the database. Anyone
-- reading this to check a number should not have to care which form was used.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- What we believe we spent, per operation
--
-- provider_cost_usd here is what treg reported in x-treg-cost-micro, summed
-- across every call. gross_profit_usd is a stored generated column on api_usage,
-- so this is revenue minus measured cost with no rounding of its own.
-- ---------------------------------------------------------------------------
create or replace view public.v_margin_by_operation as
select
  operation,
  count(*)                                                          as calls,
  count(*) filter (where outcome = 'success')                       as succeeded,
  count(*) filter (where outcome = 'free')                          as free,
  count(*) filter (where outcome = 'upstream_failed')               as upstream_failed,
  count(*) filter (where outcome = 'uncertain')                     as uncertain,
  sum(provider_cost_usd)                                             as provider_cost_usd,
  sum(revenue_usd)                                                   as revenue_usd,
  sum(gross_profit_usd)                                              as gross_profit_usd,
  -- Null rather than zero when there is no revenue to take a margin of, so an
  -- empty month reads as unknown instead of as a perfect margin.
  round(100 * sum(gross_profit_usd) / nullif(sum(revenue_usd), 0), 1) as gross_margin_pct,
  min(created_at)                                                    as first_call,
  max(created_at)                                                    as last_call
from public.api_usage
group by operation;

comment on view public.v_margin_by_operation is
  'Measured provider cost and recognised revenue per operation. Cost comes from the charge treg reported, not from the seeded estimate.';

-- ---------------------------------------------------------------------------
-- Platform totals
--
-- Gross and net are kept apart on purpose.
--
--   gross_profit   = revenue recognised - provider cost. What the search layer
--                    earned.
--   net_cash       = what actually landed from payments.
--   unearned_cash  = net cash minus recognised revenue. Normally positive:
--                    credits bought and not yet spent. This is the honest home
--                    for unspent balance — counting it as profit is the single
--                    easiest way to overstate this business.
--
-- Gateway fees sit on payment_orders.fee_usd and stay NULL until a real charge
-- reports one. A null is the honest state; a guessed percentage would make every
-- net figure a fiction.
-- ---------------------------------------------------------------------------
create or replace view public.v_platform_totals as
select
  (select coalesce(sum(revenue_usd), 0) from public.api_usage)         as recognised_revenue_usd,
  (select coalesce(sum(provider_cost_usd), 0) from public.api_usage)   as provider_cost_usd,
  (select coalesce(sum(gross_profit_usd), 0) from public.api_usage)    as gross_profit_usd,
  settled.gross_usd                                                    as gross_cash_usd,
  settled.known_fees                                                   as known_gateway_fees_usd,
  settled.orders_with_unknown_fee                                      as orders_with_unknown_fee,
  -- Only as good as the fee data. An order whose fee was never observed counts
  -- in gross but not in fees, so this is an upper bound until every settled
  -- order has reported one.
  settled.gross_usd - settled.known_fees                               as net_cash_usd,
  (select coalesce(sum(balance), 0) from public.wallet)                as unspent_credit_value_usd,
  (select count(*) from public.api_usage where outcome = 'uncertain')  as uncertain_calls,
  (select count(*) from public.reservations
     where status = 'held' and created_at < now() - interval '1 hour') as stale_reservations
from (
  select
    coalesce(sum(gross_usd), 0)                          as gross_usd,
    coalesce(sum(fee_usd), 0)                            as known_fees,
    count(*) filter (where fee_usd is null)               as orders_with_unknown_fee
  from public.payment_orders
  where status = 'succeeded'
) settled;

comment on view public.v_platform_totals is
  'Gross profit from searches, cash actually collected, and the difference — unspent balance, which is a liability rather than revenue.';

-- ---------------------------------------------------------------------------
-- Per workspace
--
-- The figure that answers "is this customer profitable". Provider cost is
-- measured; revenue is recognised, so it lags the cash by exactly the credits
-- still sitting in their wallet.
-- ---------------------------------------------------------------------------
create or replace view public.v_margin_by_user as
select
  w.user_id,
  w.balance                                             as credit_balance,
  w.lifetime_granted,
  w.lifetime_consumed,
  coalesce(agg.revenue_usd, 0)                          as revenue_usd,
  coalesce(agg.provider_cost_usd, 0)                    as provider_cost_usd,
  coalesce(agg.gross_profit_usd, 0)                     as gross_profit_usd,
  coalesce(agg.calls, 0)                                as calls,
  agg.last_call,
  -- A workspace holding credits but never having spent them has generated no
  -- cost and no revenue. Worth seeing explicitly rather than left to default to
  -- a zero row that reads like a break-even customer.
  (coalesce(agg.calls, 0) = 0)                         as never_searched
from public.wallet w
left join (
  select
    user_id,
    sum(revenue_usd)         as revenue_usd,
    sum(provider_cost_usd)   as provider_cost_usd,
    sum(gross_profit_usd)    as gross_profit_usd,
    count(*)                 as calls,
    max(created_at)          as last_call
  from public.api_usage
  group by user_id
) agg on agg.user_id = w.user_id;

comment on view public.v_margin_by_user is
  'Measured cost and recognised revenue per workspace. never_searched separates a paying-but-idle customer from a break-even one.';

-- ---------------------------------------------------------------------------
-- Reconciliation against treg's own ledger
--
-- Run against GET /orgs/{id}/usage/by-tag?key=customer and compare:
--
--   ours:   select * from public.v_treg_reconciliation;
--   theirs: attributed_micro + unattributed_micro == total_micro
--
-- Three ways this drifts, all worth being able to see:
--
--   calls_we_logged   fewer than treg charged. A call whose answer was lost but
--                     which completed and billed — exactly the timeout case the
--                     reservation model exists to hold open rather than refund.
--   calls_uncertain   ours, still unresolved. Held deliberately, not refunded.
--   untagged           charged by treg but carrying no customer tag, meaning a
--                     call left this system without X-Treg-Meta set. A non-zero
--                     figure here is the loudest signal in this view, because it
--                     is the only one suggesting cost escaping attribution.
--
-- The treg-side figures are null until supplied. Filling them with our own
-- numbers would make the comparison agree by construction and prove nothing.
-- ---------------------------------------------------------------------------
create or replace view public.v_treg_reconciliation as
select
  ours.calls_logged,
  ours.calls_uncertain,
  round(ours.cost_usd, 6)                        as our_cost_usd,
  round(ours.cost_usd * 1e6, 0)                  as our_cost_micro,
  cast(null as numeric)                          as treg_total_cost_micro,
  cast(null as numeric)                          as treg_attributed_cost_micro,
  cast(null as numeric)                          as treg_unattributed_cost_micro,
  -- Null until the figures above are known. Dividing by our own number would
  -- make a mismatch of any size look like zero.
  cast(null as numeric)                          as drift_micro,
  round(100 * (ours.cost_usd * 1e6 - cast(null as numeric))
             / nullif(cast(null as numeric), 0), 2) as drift_pct
from (
  select
    count(*)                              as calls_logged,
    count(*) filter (where outcome = 'uncertain') as calls_uncertain,
    coalesce(sum(provider_cost_usd), 0)   as cost_usd
  from public.api_usage
  where provider = 'treg'
) ours;

comment on view public.v_treg_reconciliation is
  'Our measured treg spend, for comparison against GET /orgs/{id}/usage/by-tag. Nulls stay null until the treg figures are supplied.';

-- ---------------------------------------------------------------------------
-- Stale reservations
--
-- A hold that never reached settle or release is credits locked up with nothing
-- coming to free them. Normally empty; a non-empty list is a sweep that died
-- between reserving and settling, and each row is money the workspace cannot use.
-- ---------------------------------------------------------------------------
create or replace view public.v_stale_reservations as
select
  r.id,
  r.user_id,
  r.credits_held,
  r.reason,
  r.context,
  r.created_at,
  now() - r.created_at                                 as age,
  -- What the calls inside this hold were known to cost, when the tally recorded
  -- it. Zero is a real answer here and not a missing one: it means the sweep
  -- recorded no billable calls at all.
  coalesce((r.context->>'provider_cost_usd')::numeric, 0) as recorded_cost_usd
from public.reservations r
where r.status = 'held'
  and r.created_at < now() - interval '1 hour'
order by r.created_at;

comment on view public.v_stale_reservations is
  'Holds that never finalised. Each is credits the workspace cannot spend until the reservation is released or settled.';

grant select on public.v_margin_by_operation to service_role;
grant select on public.v_platform_totals     to service_role;
grant select on public.v_margin_by_user      to service_role;
grant select on public.v_treg_reconciliation to service_role;
grant select on public.v_stale_reservations  to service_role;