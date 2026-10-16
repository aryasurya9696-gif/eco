-- ============================================================================
-- Billing reporting: the numbers an admin can trust
-- ----------------------------------------------------------------------------
-- The central distinction these views enforce is that a top-up is not profit.
--
--   collected revenue   cash that actually arrived
--   gateway fees        what the processor kept
--   net cash            collected minus fees minus refunds
--   deferred revenue    net cash not yet earned, because the credits behind it
--                       are still sitting unspent. This is a liability.
--   recognised revenue  deferred revenue that has been earned by actually
--                       delivering the search the credits paid for
--   service cost        what treg and the AI providers charged for that work
--   realised profit     recognised revenue minus service cost
--
-- Recognised + deferred reconciles back to net cash, so a total cannot quietly
-- drift. Everything below is derived from the ledger and payments tables, which
-- are append-only, so the figures can always be traced back to a row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Platform-wide totals
-- ---------------------------------------------------------------------------
drop view if exists public.billing_summary cascade;
create or replace view public.billing_summary
with (security_invoker = true)
as
with cfg as (
  select coalesce((value->>'credits_per_usd')::numeric, 20) as credits_per_usd
    from public.billing_config where key = 'credit_rate'
),
cash as (
  -- A refunded original stays in collected on purpose: the refund is recorded
  -- as its own row, so the reversal is visible rather than implied by a status
  -- flip. The fee is not returned by the processor, which is why a full refund
  -- correctly nets to minus the fee rather than zero.
  select
    coalesce(sum(gross_usd) filter (where status in ('succeeded', 'refunded') and kind <> 'refund'), 0) as collected_usd,
    coalesce(sum(fee_usd)   filter (where status in ('succeeded', 'refunded') and kind <> 'refund'), 0) as fees_usd,
    coalesce(sum(gross_usd) filter (where kind = 'refund' and status = 'succeeded'), 0) as refunded_usd,
    coalesce(sum(credits_granted) filter (where status = 'succeeded'), 0)          as credits_granted,
    count(*) filter (where status = 'succeeded')                                   as successful_payments,
    count(*) filter (where kind = 'refund')                                        as refunds,
    count(*) filter (where kind = 'topup' and status = 'succeeded')                as topups,
    count(*) filter (where kind = 'subscription' and status = 'succeeded')         as subscriptions
  from public.payments
),
use_ as (
  select
    coalesce(sum(revenue_usd), 0)      as recognised_usd,
    coalesce(sum(service_cost_usd), 0) as service_cost_usd,
    coalesce(sum(credits_charged), 0)  as credits_consumed,
    coalesce(sum(calls_made), 0)       as provider_calls,
    count(*)                           as usage_events
  from public.usage_events
),
bal as (
  -- Outstanding credits must be valued at what was actually paid for them, not
  -- at the current list rate. A $50 top-up that carried a $1.75 fee bought
  -- 1000 credits at $0.04825 each, not $0.05, so valuing the remainder at the
  -- list rate would put the card fee back on the balance sheet as an asset.
  select
    coalesce(sum(credits_remaining), 0)                                   as credits_outstanding,
    coalesce(sum(credits_remaining * unit_price_usd), 0)                 as deferred_usd,
    -- credits_per_usd is credits bought per dollar, so turning credits back
    -- into dollars divides by it.
    coalesce(sum(credits_remaining), 0) / (select credits_per_usd from cfg) as nominal_usd
  from public.credit_grants
)
select
  (select credits_per_usd from cfg)                                    as credits_per_usd,

  -- Cash
  c.collected_usd,
  c.fees_usd,
  c.refunded_usd,
  (c.collected_usd - c.fees_usd - c.refunded_usd)                     as net_cash_usd,
  c.successful_payments,
  c.refunds,
  c.topups,
  c.subscriptions,

  -- Credits
  c.credits_granted,
  u.credits_consumed,
  b.credits_outstanding,

  -- The split of net cash between money earned and money still owed.
  -- deferred_revenue_usd is a liability, not profit: it is cash already taken
  -- for searches that have not been delivered yet.
  b.deferred_usd                                                       as deferred_revenue_usd,
  -- What the same credits would be worth at today's list rate. The gap against
  -- deferred_revenue_usd is the lifetime shortfall between list and actual,
  -- almost entirely gateway fees paid at purchase time.
  b.nominal_usd                                                        as nominal_credit_value_usd,
  u.recognised_usd,

  -- Cost and profit
  u.service_cost_usd,
  (u.recognised_usd - u.service_cost_usd)                              as realised_profit_usd,
  case when u.recognised_usd > 0
       then round(((u.recognised_usd - u.service_cost_usd) / u.recognised_usd) * 100, 1)
       else null end                                                   as realised_margin_pct,

  -- Cash view: what has been banked minus what delivering it has cost. This is
  -- deliberately not called profit, because the deferred portion is unearned.
  ((c.collected_usd - c.fees_usd - c.refunded_usd) - u.service_cost_usd) as cash_after_cost_usd,

  u.provider_calls,
  u.usage_events,

  -- Should be zero: net cash is exactly recognised revenue plus what is still
  -- owed. Anything else means a credit moved without a ledger row.
  round(
    ((c.collected_usd - c.fees_usd - c.refunded_usd) - (u.recognised_usd + b.deferred_usd)), 6
  )                                                                    as reconciliation_delta_usd
from cash c, use_ u, bal b;

-- ---------------------------------------------------------------------------
-- Per-workspace breakdown
-- ---------------------------------------------------------------------------

drop view if exists public.billing_by_user cascade;
create or replace view public.billing_by_user
with (security_invoker = true)
as
select
  p.id                                                                   as user_id,
  coalesce(p.full_name, '')                                              as name,
  p.subscription_plan,
  p.credit_balance                                                      as credits_balance,
  coalesce(p.credit_recognized_usd, 0)                                   as recognised_usd,
  coalesce(pm.collected_usd, 0)                                          as paid_usd,
  coalesce(pm.fees_usd, 0)                                               as fees_usd,
  coalesce(pm.credits_bought, 0)                                         as credits_bought,
  coalesce(us.service_cost_usd, 0)                                       as service_cost_usd,
  coalesce(us.credits_consumed, 0)                                       as credits_consumed,
  coalesce(us.provider_calls, 0)                                         as provider_calls,
  coalesce(pm.collected_usd, 0) - coalesce(us.service_cost_usd, 0)        as cash_after_cost_usd,
  coalesce(us.recognised_usd, 0) - coalesce(us.service_cost_usd, 0)      as realised_profit_usd,
  (select coalesce(sum(g.credits_remaining), 0)
     from public.credit_grants g where g.user_id = p.id)                as credits_outstanding,
  -- Valued at what this user actually paid, so gateway fees are not counted
  -- back as an asset sitting in their balance.
  (select coalesce(sum(g.credits_remaining * g.unit_price_usd), 0)
     from public.credit_grants g where g.user_id = p.id)                as deferred_revenue_usd
from public.profiles p
left join lateral (
  select sum(gross_usd) as collected_usd,
         sum(fee_usd)   as fees_usd,
         sum(credits_granted) as credits_bought
    from public.payments
   where user_id = p.id and status = 'succeeded'
) pm on true
left join lateral (
  select sum(revenue_usd)      as recognised_usd,
         sum(service_cost_usd) as service_cost_usd,
         sum(credits_charged)  as credits_consumed,
         sum(calls_made)       as provider_calls
    from public.usage_events
   where user_id = p.id
) us on true;

-- ---------------------------------------------------------------------------
-- Revenue and cost by operation
-- ---------------------------------------------------------------------------

drop view if exists public.billing_by_operation cascade;
create or replace view public.billing_by_operation
with (security_invoker = true)
as
select
  ue.operation,
  -- cfg.value is the whole operation_pricing object, so the per-operation entry
  -- has to be pulled out before its label can be read.
  coalesce(
    (cfg.value -> ue.operation) ->> 'label',
    ue.operation
  )                                                                    as label,
  count(*)                                   as events,
  coalesce(sum(ue.calls_made), 0)            as calls,
  coalesce(sum(ue.credits_charged), 0)       as credits,
  coalesce(sum(ue.revenue_usd), 0)           as revenue_usd,
  coalesce(sum(ue.service_cost_usd), 0)      as service_cost_usd,
  coalesce(sum(ue.revenue_usd), 0) - coalesce(sum(ue.service_cost_usd), 0) as profit_usd,
  case when coalesce(sum(ue.revenue_usd), 0) > 0
       then round((1 - (sum(ue.service_cost_usd) / sum(ue.revenue_usd))) * 100, 1)
       else null end                         as margin_pct
from public.usage_events ue
left join public.billing_config cfg on cfg.key = 'operation_pricing'
group by ue.operation, cfg.value;

-- ---------------------------------------------------------------------------
-- Monthly trend
-- ---------------------------------------------------------------------------

drop view if exists public.billing_by_month cascade;
create or replace view public.billing_by_month
with (security_invoker = true)
as
select
  to_char(month, 'YYYY-MM')                                     as month,
  coalesce((select sum(p.gross_usd) from public.payments p
             where p.status = 'succeeded' and date_trunc('month', p.created_at) = m.month), 0) as collected_usd,
  coalesce((select sum(p.fee_usd) from public.payments p
             where p.status = 'succeeded' and date_trunc('month', p.created_at) = m.month), 0) as fees_usd,
  coalesce((select sum(u.service_cost_usd) from public.usage_events u
             where date_trunc('month', u.created_at) = m.month), 0)                           as service_cost_usd,
  coalesce((select sum(u.revenue_usd) from public.usage_events u
             where date_trunc('month', u.created_at) = m.month), 0)                           as recognised_usd,
  coalesce((select sum(u.credits_charged) from public.usage_events u
             where date_trunc('month', u.created_at) = m.month), 0)                           as credits_consumed
from generate_series(
       date_trunc('month', now()) - interval '11 months',
       date_trunc('month', now()),
       interval '1 month'
     ) as m(month);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- billing_summary aggregates every user's money, so only an admin may read it.
grant select on public.billing_summary to service_role;
grant select on public.billing_by_user to service_role;
grant select on public.billing_by_operation to service_role;
grant select on public.billing_by_month to service_role;

-- The per-user row a workspace may see about itself. Exposed as a security
-- invoker view filtered to the caller rather than granting the raw one, so a
-- client cannot simply query billing_by_user for somebody else.

drop view if exists public.my_billing cascade;
create or replace view public.my_billing
with (security_invoker = true)
as
select * from public.billing_by_user where user_id = (select auth.uid());

grant select on public.my_billing to authenticated;
