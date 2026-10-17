-- ============================================================================
-- Credit wallet — the tables
-- ----------------------------------------------------------------------------
-- Prepaid credits. A workspace buys a block of credits once and spends them
-- down as it searches; there is no plan, no renewal and no recurring charge.
--
-- The shape of this schema is driven by one fact about the provider. treg may
-- charge us for a call whose answer never arrives — a timeout mid-flight, or a
-- 410 that means "charged, result lost". A model that decrements the balance
-- after the fact cannot tell those apart from a free failure, and either
-- refunds money we spent or bills for a job the customer did not get. So the
-- balance moves in two phases instead:
--
--   reserve  before the provider call   balance -> reserved
--   settle   after a known outcome      draw from grants, drop reserved
--   release  after a non-billable fail   reserved -> balance, no charge
--
-- Because the reserve happens before any money is at risk, the ledger can never
-- discover that it is already spent. That is the whole point of putting the
-- gate here rather than after the response.
--
-- Money is numeric(20,6) everywhere. Credits are fractional by nature, floats
-- lose pennies at exactly the scale where the numbers stop being toy values.
--
-- Definition order below is dependency order, not reading order. A foreign key
-- needs its target to exist first: topup_packages before payment_orders,
-- payment_orders before credit_grants, and the three of those before
-- credit_ledger, which references all of them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- wallet
-- One row per user. balance is what they own; reserved is the slice of that
-- currently held for a call in flight. available = balance - reserved.
-- The check constraints are the last line of defence: if a reserve path is ever
-- coded wrong, the database refuses rather than quietly going negative.
-- ---------------------------------------------------------------------------
create table if not exists public.wallet (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  balance                 numeric(20,6) not null default 0 check (balance >= 0),
  reserved                numeric(20,6) not null default 0 check (reserved >= 0),
  lifetime_granted        numeric(20,6) not null default 0 check (lifetime_granted >= 0),
  lifetime_consumed       numeric(20,6) not null default 0 check (lifetime_consumed >= 0),
  -- Revenue is recognised when credits are consumed, not when cash arrives. The
  -- difference between the two is unspent balance, which is a liability.
  recognised_revenue_usd  numeric(20,6) not null default 0,
  service_cost_usd        numeric(20,6) not null default 0,
  updated_at              timestamptz not null default now(),
  -- A reserve can never hold more than is actually owned.
  constraint wallet_reserved_within_balance check (reserved <= balance)
);

comment on table public.wallet is
  'Prepaid credit balance per user. available = balance - reserved.';
comment on column public.wallet.reserved is
  'Credits held for in-flight provider calls. Not spendable until settled or released.';

alter table public.wallet enable row level security;

drop policy if exists wallet_select_own on public.wallet;
create policy wallet_select_own
  on public.wallet for select
  using (auth.uid() = user_id);

-- No insert, update or delete policy. A client cannot write its own balance.

-- ---------------------------------------------------------------------------
-- topup_packages
-- What can be bought. Readable by the client so the pricing on screen is the
-- pricing charged; writable by nobody through the API. Changing a price is a
-- deliberate SQL edit, which is the point — there is no admin surface in this
-- product, so an accidental edit cannot come from the app.
--
-- provider_ref stays null until the payment account exists. Checkout fills it
-- in on first use, so going live needs no migration and no redeploy.
-- ---------------------------------------------------------------------------
create table if not exists public.topup_packages (
  code          text primary key,
  display_name  text not null,
  gross_usd     numeric(20,6) not null check (gross_usd > 0),
  credits       numeric(20,6) not null check (credits > 0),
  -- Kept separate from credits so a promotional bonus can be added without a
  -- migration. It becomes its own grant row at zero unit price.
  bonus_credits numeric(20,6) not null default 0 check (bonus_credits >= 0),
  currency      text not null default 'USD',
  active        boolean not null default true,
  sort_order    int not null default 0,
  provider_ref  text,
  created_at    timestamptz not null default now()
);

alter table public.topup_packages enable row level security;

drop policy if exists topup_packages_select_all on public.topup_packages;
create policy topup_packages_select_all
  on public.topup_packages for select
  using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- payment_orders
-- One row per attempted purchase. provider_ref carries the gateway's own
-- reference and is unique, which is what makes the webhook path replay-proof:
-- a payment.succeeded delivered twice finds the row already settled and stops.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  provider          text not null default 'dodo',
  package_code      text not null references public.topup_packages(code),
  provider_order_id text unique,
  provider_ref      text unique,
  gross_usd         numeric(20,6) not null check (gross_usd > 0),
  -- Left null until a real charge tells us the rate. Guessing it would put a
  -- fabricated number in the profit report.
  fee_usd           numeric(20,6) check (fee_usd is null or fee_usd >= 0),
  net_usd           numeric(20,6),
  currency          text not null default 'USD',
  credits_granted   numeric(20,6) not null default 0 check (credits_granted >= 0),
  status            text not null default 'created' check (status in (
                      'created', 'pending', 'succeeded', 'failed', 'refunded')),
  checkout_url      text,
  created_at        timestamptz not null default now(),
  settled_at        timestamptz
);

create index if not exists idx_payment_orders_user_created
  on public.payment_orders(user_id, created_at desc);

create index if not exists idx_payment_orders_status
  on public.payment_orders(status)
  where status in ('created', 'pending');

alter table public.payment_orders enable row level security;

drop policy if exists payment_orders_select_own on public.payment_orders;
create policy payment_orders_select_own
  on public.payment_orders for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- credit_grants
-- The FIFO pool. A grant is one issuance and it remembers what that issuance
-- actually cost per credit.
--
-- Keeping them discrete rather than storing a single balance is what makes
-- revenue honest. If a $10 top-up carried a 10% bonus, folding the bonus into
-- the same row would recognise $0.05 of revenue per bonus credit that nobody
-- ever paid. Separate rows with their own unit_price_usd — the bonus row at 0
-- — keeps recognised revenue equal to cash received, to the credit.
-- ---------------------------------------------------------------------------
create table if not exists public.credit_grants (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  source             text not null check (source in ('topup', 'bonus', 'grant', 'adjustment')),
  payment_order_id   uuid references public.payment_orders(id) on delete set null,
  credits            numeric(20,6) not null check (credits > 0),
  credits_remaining  numeric(20,6) not null check (credits_remaining >= 0),
  -- Cash received divided by credits issued. The rate revenue is recognised at.
  unit_price_usd     numeric(20,6) not null default 0 check (unit_price_usd >= 0),
  expires_at         timestamptz,
  created_at         timestamptz not null default now(),
  constraint credit_grants_remaining_within_total check (credits_remaining <= credits)
);

create index if not exists idx_credit_grants_fifo
  on public.credit_grants(user_id, expires_at nulls last, created_at)
  where credits_remaining > 0;

create index if not exists idx_credit_grants_order
  on public.credit_grants(payment_order_id)
  where payment_order_id is not null;

alter table public.credit_grants enable row level security;

drop policy if exists credit_grants_select_own on public.credit_grants;
create policy credit_grants_select_own
  on public.credit_grants for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- reservations
-- Backing store for the two-phase model. Exists so the database, not the
-- calling code, is the thing that refuses a second finalisation. A sweep that
-- settles twice, or settles after releasing, is a double charge; catching that
-- in a constraint means the bug cannot reach the ledger.
-- ---------------------------------------------------------------------------
create table if not exists public.reservations (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  idempotency_key   text not null unique,
  credits_held      numeric(20,6) not null check (credits_held >= 0),
  status            text not null default 'held'
                      check (status in ('held', 'settled', 'released')),
  reason            text,
  context           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  finalised_at      timestamptz
);

create index if not exists idx_reservations_user_status
  on public.reservations(user_id, status, created_at desc);

-- Stale holds are worth finding: a reservation that never finalised is credits
-- locked up with nothing coming to release them.
create index if not exists idx_reservations_held
  on public.reservations(created_at)
  where status = 'held';

alter table public.reservations enable row level security;

drop policy if exists reservations_select_own on public.reservations;
create policy reservations_select_own
  on public.reservations for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- credit_ledger
-- Append-only. Every movement of the balance lands here with the numbers needed
-- to reconstruct it later: what moved, what it was worth, what it cost us, and
-- what it was tied to.
--
-- Append-only is enforced by giving clients no update or delete policy at all,
-- rather than by a trigger that could be bypassed by a role nobody thought of.
-- ---------------------------------------------------------------------------
create table if not exists public.credit_ledger (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  delta             numeric(20,6) not null,
  balance_after     numeric(20,6) not null,
  kind              text not null check (kind in (
                      'topup', 'grant', 'bonus', 'usage', 'refund',
                      'reversal', 'expiry', 'adjustment')),
  reservation_id    uuid references public.reservations(id) on delete set null,
  grant_id          uuid references public.credit_grants(id) on delete set null,
  payment_order_id  uuid references public.payment_orders(id) on delete set null,
  api_usage_id      bigint,
  -- Recognised on consumption only. A topup row carries zero: cash arrived, it
  -- was not earned, and calling it revenue would let a workspace book money it
  -- has not spent yet.
  revenue_usd       numeric(20,6) not null default 0,
  service_cost_usd  numeric(20,6) not null default 0,
  idempotency_key   text unique,
  note              text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists idx_credit_ledger_user_created
  on public.credit_ledger(user_id, created_at desc);

create index if not exists idx_credit_ledger_reservation
  on public.credit_ledger(reservation_id)
  where reservation_id is not null;

alter table public.credit_ledger enable row level security;

drop policy if exists credit_ledger_select_own on public.credit_ledger;
create policy credit_ledger_select_own
  on public.credit_ledger for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- api_usage
-- One row per billable provider call, carrying the provider's own reported
-- cost. treg returns what it actually charged in x-treg-cost-micro, so the cost
-- column here is measured rather than estimated and the profit it implies is
-- real. The pricing_config estimate covers only the window before the response
-- comes back.
--
-- Metadata only. A full response body would carry whatever people posted
-- publicly, which is not ours to keep.
-- ---------------------------------------------------------------------------
create table if not exists public.api_usage (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  idempotency_key     text not null unique,
  operation           text not null,
  provider            text not null default 'treg',
  provider_call_id    text,
  provider_cost_usd   numeric(20,8) not null default 0 check (provider_cost_usd >= 0),
  credits_charged     numeric(20,6) not null default 0 check (credits_charged >= 0),
  revenue_usd         numeric(20,6) not null default 0,
  gross_profit_usd    numeric(20,8) generated always as (revenue_usd - provider_cost_usd) stored,
  -- success          the caller got what it asked for
  -- free             ran, found nothing, treg did not bill
  -- upstream_failed  treg billed but the upstream provider failed; paid, no value
  -- not_billed       failed in a way treg never charges for
  -- uncertain        we may have been charged and cannot tell yet; reconcile later
  outcome             text not null check (outcome in (
                        'success', 'free', 'upstream_failed',
                        'not_billed', 'uncertain')),
  http_status         int,
  duration_ms         int,
  error_code          text,
  reservation_id      uuid references public.reservations(id) on delete set null,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists idx_api_usage_user_created
  on public.api_usage(user_id, created_at desc);

create index if not exists idx_api_usage_operation
  on public.api_usage(operation, created_at desc);

-- Reconciliation against treg's own ledger. A call id present in
-- GET /calls/{id} but absent here means we were charged for something we never
-- recorded, which is exactly what this index makes findable.
create index if not exists idx_api_usage_provider_call
  on public.api_usage(provider_call_id)
  where provider_call_id is not null;

create index if not exists idx_api_usage_uncertain
  on public.api_usage(created_at)
  where outcome = 'uncertain';

alter table public.api_usage enable row level security;

drop policy if exists api_usage_select_own on public.api_usage;
create policy api_usage_select_own
  on public.api_usage for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- pricing_config
-- The single place a price lives. Edge functions read it at call time and never
-- accept a price from the client.
--
-- provider_cost_usd is a pre-call estimate. The authoritative figure is what
-- treg reports afterwards, which lands in api_usage.provider_cost_usd.
-- cost_verified records whether the number has actually been confirmed against
-- the catalog or a live call, so an unverified estimate is never mistaken for a
-- measured cost in a report.
--
-- There is no admin UI for this table, by design. It is edited by SQL.
-- ---------------------------------------------------------------------------
create table if not exists public.pricing_config (
  operation          text primary key,
  display_name       text not null,
  provider_endpoint  text not null,
  provider_cost_usd  numeric(20,8) not null default 0 check (provider_cost_usd >= 0),
  cost_verified      boolean not null default false,
  cost_source        text not null default 'unverified' check (cost_source in (
                       'catalog', 'rate_card', 'observed', 'live_confirmed', 'unverified')),
  credits            numeric(20,6) not null check (credits >= 0),
  enabled            boolean not null default true,
  version            int not null default 1,
  effective_from     timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.pricing_config enable row level security;

drop policy if exists pricing_config_select_all on public.pricing_config;
create policy pricing_config_select_all
  on public.pricing_config for select
  using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- pricing_audit
-- Who changed a price, when, and from what to what. changed_by is a free-text
-- operator label rather than a user reference: this product has no admin role,
-- so there is no identity to point at, and inventing one would reintroduce
-- exactly the surface that was deliberately left out.
--
-- Written by a trigger rather than by application code, so a change made
-- directly in SQL is recorded too.
-- ---------------------------------------------------------------------------
create table if not exists public.pricing_audit (
  id          bigint generated always as identity primary key,
  operation   text not null,
  field       text not null,
  old_value   jsonb,
  new_value   jsonb,
  changed_by  text,
  changed_at  timestamptz not null default now(),
  reason      text
);

create index if not exists idx_pricing_audit_operation
  on public.pricing_audit(operation, changed_at desc);

alter table public.pricing_audit enable row level security;

-- ---------------------------------------------------------------------------
-- webhook_events
-- Dodo retries, and retries can arrive hours apart and out of order. The
-- webhook id is recorded before processing and marked afterwards, which is what
-- lets a redelivery of the same event be recognised as a redelivery.
-- ---------------------------------------------------------------------------
create table if not exists public.webhook_events (
  id            bigint generated always as identity primary key,
  provider      text not null default 'dodo',
  webhook_id    text not null unique,
  event_type    text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'received' check (status in (
                  'received', 'processed', 'failed', 'ignored')),
  attempts      int not null default 0,
  last_error    text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

create index if not exists idx_webhook_events_status
  on public.webhook_events(status, received_at);

alter table public.webhook_events enable row level security;

-- No client policies at all. The browser never reads this.