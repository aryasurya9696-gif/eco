-- ============================================================================
-- Credit-based billing and profit accounting
-- ----------------------------------------------------------------------------
-- Echo previously sold flat subscriptions and tracked nothing about what a
-- workspace actually cost to serve. This adds a credit meter on top of the
-- existing plans without removing them: a subscription still grants a monthly
-- allowance, a top-up adds to it, and every metered provider call draws it
-- down.
--
-- THE ACCOUNTING RULE THIS SCHEMA EXISTS TO ENFORCE
-- A top-up is not profit. It is cash collected against work not yet delivered.
-- The moment credits are granted, that cash is deferred revenue and sits on the
-- balance sheet as a liability. It becomes realised revenue only as credits are
-- consumed, and each consumption carries the service cost of the call it paid
-- for. Concretely, for a $50 top-up with a $1.75 card fee:
--
--   cash collected                        50.00
--   gateway fee                           -1.75
--   net cash                              48.25   <- not profit, a liability
--   credits granted (20 per USD)         1000
--   unit price recognised per credit       0.048250
--
-- If nothing is consumed, all 48.25 is deferred. If 400 of the 1000 credits are
-- consumed for 1.14 of provider spend, then 19.30 is recognised as revenue,
-- realised profit is 18.16, and 28.95 remains deferred.
--
-- Consuming the whole grant recognises the full 48.25 against the full service
-- cost. There is no path in this schema that books a top-up as profit without a
-- matching consumption, which is the error that makes most credit systems
-- quietly overstate how much money was made.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Admin check
-- ---------------------------------------------------------------------------
-- Defined first because the RLS policies below call it, and Postgres validates
-- a policy's expressions when the policy is created, not when it first runs.
create or replace function public.is_admin(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = p_uid), false);
$$;

revoke execute on function public.is_admin(uuid) from public, anon;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Admin-tunable pricing
-- ---------------------------------------------------------------------------
-- Single-row-per-key rather than columns so adding an operation does not need a
-- migration. Written only by service_role; readable by authenticated admins.
create table if not exists public.billing_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.billing_config enable row level security;

drop policy if exists billing_config_read_admin on public.billing_config;
create policy "billing_config_read_admin"
  on public.billing_config
  for select
  to authenticated
  using ((select public.is_admin((select auth.uid()))));

revoke insert, update, delete on public.billing_config from anon, authenticated;
grant select on public.billing_config to authenticated;

-- credits_per_usd: how many credits a dollar of top-up buys. 20 means one
-- credit is worth $0.05 of metered search, which keeps the smallest real
-- provider call (news, $0.00) free and a Reddit call at two credits.
insert into public.billing_config (key, value) values
  ('credit_rate', '{"credits_per_usd": 20}'::jsonb),
  ('operation_pricing', '{
    "sweep_call_twitter":  { "credits": 1,    "service_cost_usd": 0.00075, "label": "X (Twitter) search" },
    "sweep_call_reddit":   { "credits": 2,    "service_cost_usd": 0.00288, "label": "Reddit search" },
    "sweep_call_google":   { "credits": 1,    "service_cost_usd": 0.00015, "label": "Web search" },
    "sweep_call_news":     { "credits": 0,    "service_cost_usd": 0,       "label": "Press & news search" },
    "ai_suggest":          { "credits": 5,    "service_cost_usd": 0,       "label": "AI keyword suggestions" },
    "ai_draft":            { "credits": 10,   "service_cost_usd": 0,       "label": "AI outreach draft" }
  }'::jsonb),
  ('plan_grants', '{
    "starter": 1200,
    "pro":     6000,
    "scale":   22000
  }'::jsonb),
  ('topup_packages', '[
    { "id": "topup_25",  "label": "Starter top-up", "usd": 25,  "bonus_credits": 0 },
    { "id": "topup_50",  "label": "Standard top-up", "usd": 50,  "bonus_credits": 100 },
    { "id": "topup_100", "label": "Bulk top-up",     "usd": 100, "bonus_credits": 300 }
  ]'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Cash
-- ---------------------------------------------------------------------------
-- Every dollar that moves. A top-up is one row; a refund is another, so the
-- revenue figures can never be inflated by editing a past payment.
create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  provider        text not null default 'stripe',
  -- Stripe checkout session / charge id. The unique index on it is what makes
  -- webhook delivery idempotent: a replayed event collides and is ignored.
  provider_ref    text,
  kind            text not null check (kind in ('topup', 'subscription', 'refund', 'adjustment')),
  status          text not null default 'pending'
                  check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  gross_usd       numeric(12,2) not null check (gross_usd >= 0),
  fee_usd         numeric(12,2) not null default 0 check (fee_usd >= 0),
  net_usd         numeric(12,2) not null default 0,
  currency        text not null default 'usd',
  credits_granted numeric(12,2) not null default 0 check (credits_granted >= 0),
  idempotency_key text,
  note            text,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  settled_at      timestamptz
);

create unique index if not exists payments_provider_ref_uniq
  on public.payments (provider_ref)
  where provider_ref is not null;

create unique index if not exists payments_idempotency_uniq
  on public.payments (idempotency_key)
  where idempotency_key is not null;

create index if not exists payments_user_time_idx on public.payments (user_id, created_at desc);
create index if not exists payments_status_idx on public.payments (status, created_at desc);

alter table public.payments enable row level security;

drop policy if exists payments_read_own on public.payments;
create policy "payments_read_own"
  on public.payments for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin((select auth.uid()))));

revoke insert, update, delete on public.payments from anon, authenticated;
grant select on public.payments to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Credit grants (the pool of unconsumed credits)
-- ---------------------------------------------------------------------------
-- Kept as discrete grants rather than one running balance so each credit can
-- carry the price that was paid for it. That price is what turns consumption
-- into recognised revenue, and it is why a 40% bonus top-up does not silently
-- recognise more revenue per credit than a plain one.
create table if not exists public.credit_grants (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  source            text not null check (source in ('topup', 'subscription', 'admin', 'bonus')),
  payment_id        uuid references public.payments(id) on delete set null,
  credits           numeric(12,2) not null check (credits > 0),
  credits_remaining numeric(12,2) not null check (credits_remaining >= 0),
  -- Cash received for this grant divided by the credits it carries. Consumption
  -- recognises revenue at this rate.
  unit_price_usd    numeric(12,8) not null default 0 check (unit_price_usd >= 0),
  period            text,
  granted_at        timestamptz not null default now(),
  expires_at        timestamptz,
  constraint credit_grants_remaining_lte_total check (credits_remaining <= credits)
);

create index if not exists credit_grants_user_fifo_idx
  on public.credit_grants (user_id, expires_at nulls last, granted_at);

alter table public.credit_grants enable row level security;

drop policy if exists credit_grants_read_own on public.credit_grants;
create policy "credit_grants_read_own"
  on public.credit_grants for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin((select auth.uid()))));

revoke insert, update, delete on public.credit_grants from anon, authenticated;
grant select on public.credit_grants to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Credit ledger (append only)
-- ---------------------------------------------------------------------------
create table if not exists public.credit_ledger (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  delta             numeric(12,2) not null,
  balance_after     numeric(12,2) not null,
  kind              text not null
                    check (kind in ('topup', 'subscription_grant', 'bonus', 'usage', 'refund', 'adjustment', 'expiry')),
  source            text not null,
  ref_type          text,
  ref_id            text,
  grant_id          uuid references public.credit_grants(id) on delete set null,
  payment_id        uuid references public.payments(id) on delete set null,
  -- Revenue recognised by this movement. Grants recognise zero (they are cash
  -- in, not revenue earned); consumption recognises the grant's unit price.
  revenue_usd       numeric(12,6) not null default 0,
  service_cost_usd  numeric(12,6) not null default 0,
  note              text,
  idempotency_key   text,
  metadata          jsonb,
  created_at        timestamptz not null default now()
);

create unique index if not exists credit_ledger_idempotency_uniq
  on public.credit_ledger (idempotency_key)
  where idempotency_key is not null;

create index if not exists credit_ledger_user_time_idx
  on public.credit_ledger (user_id, created_at desc);

alter table public.credit_ledger enable row level security;

drop policy if exists credit_ledger_read_own on public.credit_ledger;
create policy "credit_ledger_read_own"
  on public.credit_ledger for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin((select auth.uid()))));

revoke insert, update, delete on public.credit_ledger from anon, authenticated;
grant select on public.credit_ledger to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Metered usage
-- ---------------------------------------------------------------------------
-- One row per billable operation. This is where service cost is captured, which
-- is what lets profit be attributed to the operation that caused it rather than
-- estimated at month end.
create table if not exists public.usage_events (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  operation         text not null,
  provider          text,
  provider_ref      text,
  calls_made        integer not null default 0 check (calls_made >= 0),
  credits_charged   numeric(12,2) not null default 0 check (credits_charged >= 0),
  service_cost_usd  numeric(12,6) not null default 0 check (service_cost_usd >= 0),
  revenue_usd       numeric(12,6) not null default 0,
  ledger_id         bigint references public.credit_ledger(id) on delete set null,
  metadata          jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists usage_events_user_time_idx on public.usage_events (user_id, created_at desc);
create index if not exists usage_events_operation_idx on public.usage_events (operation, created_at desc);

alter table public.usage_events enable row level security;

drop policy if exists usage_events_read_own on public.usage_events;
create policy "usage_events_read_own"
  on public.usage_events for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin((select auth.uid()))));

revoke insert, update, delete on public.usage_events from anon, authenticated;
grant select on public.usage_events to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Denormalised balance
-- ---------------------------------------------------------------------------
-- Cached purely so the UI can render without aggregating the grants. Every
-- mutation goes through the functions below, which keep it correct under
-- concurrency; nothing is allowed to write this column directly.
alter table public.profiles
  add column if not exists credit_balance numeric(12,2) not null default 0,
  add column if not exists credit_granted_period text,
  add column if not exists credit_recognized_usd numeric(12,6) not null default 0;

comment on column public.profiles.credit_balance is
  'Credits available. Maintained only by grant_credits/spend_credits; never written by a client.';

comment on column public.profiles.credit_recognized_usd is
  'Revenue recognised to date from credit consumption. Grants do not touch this.';

-- ---------------------------------------------------------------------------
-- 7. Pricing helpers
-- ---------------------------------------------------------------------------
create or replace function public.credit_rate()
returns numeric
language sql
stable
as $$
  select coalesce(
    (select (value->>'credits_per_usd')::numeric from public.billing_config where key = 'credit_rate'),
    20
  );
$$;

revoke execute on function public.credit_rate() from public, anon, authenticated;
grant execute on function public.credit_rate() to service_role;

create or replace function public.plan_credit_grant(p_plan text)
returns numeric
language sql
stable
as $$
  select coalesce(
    (value->>p_plan)::numeric,
    (value->>'starter')::numeric,
    1200
  )
  from public.billing_config where key = 'plan_grants';
$$;

revoke execute on function public.plan_credit_grant(text) from public, anon, authenticated;
grant execute on function public.plan_credit_grant(text) to service_role;

create or replace function public.operation_price(p_operation text)
returns jsonb
language sql
stable
as $$
  select coalesce(
    (select value->p_operation from public.billing_config where key = 'operation_pricing'),
    '{"credits": 0, "service_cost_usd": 0}'::jsonb
  );
$$;

revoke execute on function public.operation_price(text) from public, anon, authenticated;
grant execute on function public.operation_price(text) to service_role;
