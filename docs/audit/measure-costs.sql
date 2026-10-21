-- Echo audit 2026-10 — Phase 0 cost measurement. READ-ONLY: every statement is a SELECT.
-- Run against the live project, e.g.:
--   npx supabase db query --linked -f docs/audit/measure-costs.sql
-- or psql with PG* env vars (see scripts/run-sql-test.cjs). For extra safety in psql:
--   psql -X -v ON_ERROR_STOP=1 -c "set default_transaction_read_only = on" -f docs/audit/measure-costs.sql
-- Paste the output into docs/audit/AUDIT-2026-10.md section E.2 and recompute E.4.

-- (a) api_usage by operation x outcome: cost per attempt, hit rate, charged rate
select operation, outcome, calls, avg_provider_cost_usd, sum_provider_cost_usd,
       sum_credits_charged,
       round(calls::numeric / sum(calls) over (partition by operation), 4)          as share_of_operation,
       round(sum(success_calls) over (partition by operation)::numeric
             / sum(calls) over (partition by operation), 4)                          as op_hit_rate,
       round(sum(charged_calls) over (partition by operation)::numeric
             / sum(calls) over (partition by operation), 4)                          as op_charged_rate
from (
  select operation, outcome,
         count(*)                                         as calls,
         avg(provider_cost_usd)                           as avg_provider_cost_usd,
         sum(provider_cost_usd)                           as sum_provider_cost_usd,
         sum(credits_charged)                             as sum_credits_charged,
         count(*) filter (where outcome = 'success')      as success_calls,
         count(*) filter (where credits_charged > 0)      as charged_calls
  from public.api_usage
  group by operation, outcome
) t
order by operation, outcome;

-- (a2) Per-operation roll-up used by the pricing formula (section E.4):
--      cost per attempt = sum cost / attempts; cost per billed hit = sum cost / charged rows.
select operation,
       count(*)                                                  as attempts,
       count(*) filter (where credits_charged > 0)               as billed_hits,
       round(count(*) filter (where credits_charged > 0)::numeric / nullif(count(*), 0), 4) as hit_rate,
       round(sum(provider_cost_usd) / nullif(count(*), 0), 6)    as cost_per_attempt_usd,
       round(sum(provider_cost_usd) / nullif(count(*) filter (where credits_charged > 0), 0), 6) as cost_per_billed_hit_usd,
       sum(provider_cost_usd)                                    as total_cost_usd,
       sum(credits_charged)                                      as total_credits,
       min(created_at) as first_at, max(created_at) as last_at
from public.api_usage
where operation in ('treg.people.search', 'leads.search',
                    'treg.people.email.find', 'treg.people.phone.find',
                    'treg.twitter.search', 'treg.reddit.search',
                    'treg.web.search', 'treg.news.search',
                    'mail.send.hosted', 'mail.send.connected')
group by operation
order by operation;

-- (a3) People search: provider calls per search (search rows share the 'search_<uid>_<uuid>' run via metadata;
--      if metadata does not carry the search id, fall back to calls per user-minute).
select date_trunc('minute', created_at) as minute, user_id,
       count(*) filter (where operation = 'treg.people.search') as provider_calls,
       sum(provider_cost_usd) filter (where operation = 'treg.people.search') as provider_cost_usd,
       sum(credits_charged)  filter (where operation = 'leads.search') as credits_charged
from public.api_usage
where operation in ('treg.people.search', 'leads.search')
group by 1, 2
order by provider_calls desc
limit 50;

-- (b) payment_orders status mix
select status, count(*) as orders,
       sum(gross_usd) as gross_usd, sum(paid_amount_usd) as paid_usd,
       sum(fee_usd) as fee_usd, sum(net_usd) as net_usd,
       sum(refunded_usd) as refunded_usd, sum(credits_granted) as credits_granted,
       count(*) filter (where fee_usd is null) as unknown_fee,
       min(created_at) as first_at, max(created_at) as last_at
from public.payment_orders
group by status
order by orders desc;

-- (c) Retired guard trigger / functions / columns still present live?
select t.tgname, t.tgrelid::regclass as on_table, t.tgenabled, p.proname as fn
from pg_trigger t join pg_proc p on p.oid = t.tgfoid
where t.tgname = 'trg_profiles_server_columns';

select proname, pg_get_function_identity_arguments(oid) as args
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('guard_profile_server_columns', 'apply_subscription_plan', 'plan_keyword_limit');

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
  and column_name in ('subscription_plan', 'subscription_status', 'subscription_renews_at', 'is_admin');

-- (d) Stale held reservations (> 1 hour)
select r.id, r.user_id, r.idempotency_key, r.credits_held, r.reason,
       r.created_at, now() - r.created_at as age,
       (select coalesce(sum(u.credits_charged), 0) from public.api_usage u where u.reservation_id = r.id) as usage_credits,
       (select coalesce(sum(u.provider_cost_usd), 0) from public.api_usage u where u.reservation_id = r.id) as usage_cost_usd
from public.reservations r
where r.status = 'held' and r.created_at < now() - interval '1 hour'
order by r.created_at;

-- (e) Acceptance / concurrency test residue
select 'reservations' as tbl, id::text, user_id, idempotency_key as key, created_at
  from public.reservations
 where idempotency_key like 'acc:%' or idempotency_key like 'reap-test%'
    or idempotency_key like 't:%' or idempotency_key like 'k:%' or idempotency_key like 'conc:%'
union all
select 'credit_ledger', id::text, user_id, idempotency_key, created_at
  from public.credit_ledger
 where idempotency_key like 'acc:%' or idempotency_key like 'reap-test%'
    or idempotency_key like 't:%' or idempotency_key like 's:%' or idempotency_key like 'conc:%'
union all
select 'api_usage', id::text, user_id, idempotency_key, created_at
  from public.api_usage
 where idempotency_key like 'acc:%' or idempotency_key like 'reap-test%'
union all
select 'payment_orders', id::text, user_id, coalesce(provider_ref, '') || ' / ' || status, created_at
  from public.payment_orders
 where provider_ref like 'acc%' or review_reason like 'amount_mismatch: paid unknown%'
union all
select 'monitored_posts', id::text, user_id, post_url, created_at
  from public.monitored_posts where post_url like 'https://acceptance.example/%'
union all
select 'wallet(test users)', user_id::text, user_id, 'bal=' || balance || ' res=' || reserved, updated_at
  from public.wallet
 where user_id in ('231f8d14-488f-4413-a1db-bb34a910ec1c', '00000000-0000-4000-8000-0000000acc01')
order by tbl, created_at;

select id, operation, field, old_value, new_value, changed_at
from public.pricing_audit
where (operation = 'treg.twitter.search' and field = 'credits' and (old_value = '7' or new_value = '7'))
   or (operation = 'treg.reddit.search' and field = 'enabled')
order by changed_at;

-- (f) Live pricing and packages
select operation, display_name, provider_endpoint, credits, provider_cost_usd,
       cost_verified, cost_source, enabled, version, effective_from, updated_at
from public.pricing_config order by operation;

select code, display_name, gross_usd, credits, bonus_credits, currency, active,
       sort_order, provider_ref, round(credits / gross_usd, 4) as credits_per_usd
from public.topup_packages order by sort_order;

-- (g) Outstanding credit liability and wallet-vs-grants drift
select source,
       count(*) filter (where credits_remaining > 0)                     as live_grants,
       sum(credits_remaining)                                            as credits_outstanding,
       sum(credits_remaining * unit_price_usd)                           as liability_usd_at_paid_price,
       sum(credits_remaining) filter (where expires_at <= now())         as credits_expired_unspent
from public.credit_grants
group by rollup(source)
order by source nulls last;

select w.user_id, w.balance, w.reserved, coalesce(g.remaining, 0) as grants_remaining,
       w.balance - coalesce(g.remaining, 0) as drift
from public.wallet w
left join (select user_id, sum(credits_remaining) as remaining
             from public.credit_grants group by user_id) g on g.user_id = w.user_id
where w.balance <> coalesce(g.remaining, 0)
order by abs(w.balance - coalesce(g.remaining, 0)) desc;

-- (h) Is the hourly sweep live, and is it sweeping everyone every hour? (issue N1)
select jobname, schedule, active, command from cron.job;   -- needs pg_cron; skip if absent

select count(*) as users_with_active_keywords
from (select distinct user_id from public.keywords where is_active) k;

select date_trunc('hour', started_at) as hr, users_processed, posts_inserted
from public.sweep_runs
order by started_at desc limit 48;

-- (i) Sweep charges per user per day (N1 impact: >1 charged sweep/day for a 24h-cadence user)
select user_id, date_trunc('day', created_at) as day,
       count(distinct reservation_id) as charged_sweeps,
       sum(credits_charged) as credits
from public.api_usage
where operation like 'treg.%.search' and operation <> 'treg.people.search'
  and credits_charged > 0
group by 1, 2
order by charged_sweeps desc
limit 50;
