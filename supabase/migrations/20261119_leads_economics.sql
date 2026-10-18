-- ============================================================================
-- Echo Leads: what a run earned, what it cost, and what each provider costs
-- ----------------------------------------------------------------------------
-- v_margin_by_operation reads api_usage, and a Leads provider call carries no
-- revenue there: Leads is charged per chunk through wallet_settle, so revenue
-- lands on credit_ledger. Read alone, that view shows every leads.* operation as
-- pure cost. These two views put the halves together.
--
--   v_leads_run_economics       one row per run
--     credits_charged            what the wallet settled
--     revenue_usd                recognised on the ledger at settle, FIFO from
--                                the grants consumed - free credits are $0
--     provider_cost_usd          the X-Treg-Cost-Micro charges recorded in
--                                api_usage for the run, discovery included
--     gross_profit_usd / gross_margin_pct
--     verified_emails, emails_found, phones_found
--     cost_per_verified_usd      provider cost / verified addresses
--     miss_cost_usd              provider cost of attempts that found nothing
--
--   v_leads_endpoint_economics  one row per provider endpoint and step
--     attempts, hits, hit_rate, provider_cost_usd, miss_cost_usd,
--     cost_per_hit_usd - the number smart order ranks on, as measured
--
-- Revenue is attributed by the run_id the worker writes into the settle
-- metadata (billing.ts). Both views are service-role only: provider cost is our
-- number, not the customer's.
-- ============================================================================

create index if not exists idx_api_usage_leads_run
  on public.api_usage ((metadata ->> 'run_id'))
  where metadata ? 'run_id';

create index if not exists idx_credit_ledger_leads_run
  on public.credit_ledger ((metadata ->> 'run_id'))
  where metadata ? 'run_id';

create or replace view public.v_leads_run_economics as
select
  r.id                                   as run_id,
  r.user_id,
  r.kind,
  r.mode,
  r.status,
  r.created_at,
  r.est_credits,
  r.max_credits,
  r.charged_credits                      as credits_charged,
  coalesce(rev.revenue_usd, 0)           as revenue_usd,
  coalesce(cost.provider_cost_usd, 0)    as provider_cost_usd,
  coalesce(rev.revenue_usd, 0) - coalesce(cost.provider_cost_usd, 0) as gross_profit_usd,
  round(100 * (coalesce(rev.revenue_usd, 0) - coalesce(cost.provider_cost_usd, 0))
        / nullif(rev.revenue_usd, 0), 1)  as gross_margin_pct,
  rows_.total_rows,
  rows_.emails_found,
  rows_.verified_emails,
  rows_.phones_found,
  round(coalesce(cost.provider_cost_usd, 0) / nullif(rows_.verified_emails, 0), 6) as cost_per_verified_usd,
  coalesce(att.miss_cost_usd, 0)         as miss_cost_usd,
  coalesce(cost.uncertain_calls, 0)      as uncertain_calls
from public.lead_runs r
left join lateral (
  select sum(l.revenue_usd) as revenue_usd
  from public.credit_ledger l
  where l.kind = 'usage' and l.metadata ->> 'run_id' = r.id::text
) rev on true
left join lateral (
  select sum(u.provider_cost_usd) as provider_cost_usd,
         count(*) filter (where u.outcome = 'uncertain') as uncertain_calls
  from public.api_usage u
  where u.metadata ->> 'run_id' = r.id::text
) cost on true
left join lateral (
  select count(*)                                                    as total_rows,
         count(*) filter (where x.email is not null)                 as emails_found,
         count(*) filter (where x.email_status = 'verified')         as verified_emails,
         count(*) filter (where x.phone is not null)                 as phones_found
  from public.lead_rows x
  where x.run_id = r.id
) rows_ on true
left join lateral (
  select sum(a.cost_usd) filter (where not a.hit) as miss_cost_usd
  from public.lead_attempts a
  where a.run_id = r.id
) att on true;

create or replace view public.v_leads_endpoint_economics as
select
  a.endpoint_id,
  a.step,
  count(*)                                              as attempts,
  count(*) filter (where a.hit)                         as hits,
  round(count(*) filter (where a.hit)::numeric / nullif(count(*), 0), 4) as hit_rate,
  coalesce(sum(a.cost_usd), 0)                          as provider_cost_usd,
  coalesce(sum(a.cost_usd) filter (where not a.hit), 0) as miss_cost_usd,
  round(coalesce(sum(a.cost_usd), 0) / nullif(count(*) filter (where a.hit), 0), 6) as cost_per_hit_usd,
  max(a.created_at)                                     as last_attempt
from public.lead_attempts a
group by a.endpoint_id, a.step;

revoke all on public.v_leads_run_economics      from public, anon, authenticated;
revoke all on public.v_leads_endpoint_economics from public, anon, authenticated;
grant select on public.v_leads_run_economics      to service_role;
grant select on public.v_leads_endpoint_economics to service_role;

comment on view public.v_leads_run_economics is
  'Per Leads run: credits charged, revenue recognised at settle, measured provider cost, margin, cost per verified lead, cost of misses.';
comment on view public.v_leads_endpoint_economics is
  'Per provider endpoint: attempts, hits, measured cost, cost of misses, cost per hit.';
