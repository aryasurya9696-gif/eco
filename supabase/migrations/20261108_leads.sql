-- ============================================================================
-- Echo Leads: tables, tenancy and the server-owned profile columns
-- ----------------------------------------------------------------------------
-- Leads is the second service in Echo. Feed finds people talking about buying;
-- Leads finds the companies that would buy, the decision maker at each, and a
-- verified work email for them.
--
-- Nothing here moves money. The credit wallet that already exists
-- (20261102, 20261103) is the only thing that does, and these tables hold no
-- balance — a lead row records what a run *found* and what it *cost in credits*,
-- and the wallet remains the record of truth for money.
--
-- Every table is per user and readable only by its owner. There are no write
-- policies at all: a client cannot insert, update or delete a single lead row.
-- All writes go through the `leads` edge function with the service role, which
-- is also where credit reservation happens — a row that appeared from the
-- browser would be a row whose cost nobody paid for.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- lead_icps — what the AI worked out about who buys from this user
-- ---------------------------------------------------------------------------
-- Versioned rather than edited in place. "Find more" on an old ICP has to be
-- able to refer back to the segment that produced it, and a comparison between
-- two ICPs is only meaningful if the earlier one still exists.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_icps (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,

  -- Prefilled from the profile at the time the ICP was written, kept so the
  -- card can show what it was generated from after the profile has moved on.
  website       text,
  offer         text,

  -- The New search form answers beyond website and offer: price point, regions,
  -- company sizes, the user's own guess at who buys.
  inputs        jsonb not null default '{}'::jsonb,

  -- What the site scrape returned, with the treg call id per page so a
  -- surprising ICP can be traced back to the pages that produced it.
  pages         jsonb not null default '[]'::jsonb,
  brand         jsonb,

  -- The validated ICP document. jsonb, not columns: the shape is the AI's, it
  -- changes when the prompt changes, and nothing queries into it.
  json          jsonb not null default '{}'::jsonb,

  version       integer not null default 1,
  note          text,
  approved_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint lead_icps_user_version_key unique (user_id, id, version),
  constraint lead_icps_version_positive check (version > 0)
);

create index if not exists lead_icps_user_created_idx
  on public.lead_icps (user_id, created_at desc);

comment on table public.lead_icps is
  'Versioned ideal customer profiles. Read by the owner, written only by the leads function.';

-- ---------------------------------------------------------------------------
-- lead_runs — one job: find leads, clean an imported list, or bake off providers
-- ---------------------------------------------------------------------------
-- The run is the unit the user watches, pauses and is billed for. status is a
-- small closed set because the worker branches on it; pause_reason is free text
-- so an unexpected reason can still be recorded without a migration.
--
--   queued    accepted, waiting for a worker
--   running   a worker holds it
--   paused    credits ran out, or the data provider is unavailable
--   done      finished, including "finished with no results"
--   failed    the worker could not proceed; last_error says why
--   cancelled the user stopped it
--
-- est_credits and max_credits are computed before the run starts and shown to
-- the user before they approve it. charged_credits is what the wallet actually
-- settled, which is not the estimate: a provider that misses is free.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,

  icp_id          uuid references public.lead_icps (id) on delete set null,
  name            text,
  kind            text not null default 'find',
  target          integer,

  -- clean modes only: verify_only | verify_refind | full_enrich
  mode            text,

  -- phone toggle, company-data columns, per-row cap
  options         jsonb not null default '{}'::jsonb,

  status          text not null default 'queued',
  pause_reason    text,
  last_error      text,

  est_credits     numeric(20,6),
  max_credits     numeric(20,6),
  charged_credits numeric(20,6) not null default 0,
  treg_cost_usd   numeric(20,6) not null default 0,

  -- found / verified / catch_all / rows — denormalised so the sidebar badge
  -- and the run header do not each aggregate 10,000 rows on every poll.
  counters        jsonb not null default '{}'::jsonb,

  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint lead_runs_kind_check
    check (kind in ('find', 'clean', 'lab')),
  constraint lead_runs_status_check
    check (status in ('queued', 'running', 'paused', 'done', 'failed', 'cancelled')),
  constraint lead_runs_target_positive
    check (target is null or target > 0),
  -- Nothing may be charged for more than the run was approved for. The
  -- estimate is shown to the user before they press the button, so a charged
  -- figure above the agreed maximum is a bug in the worker's accounting and
  -- should stop the row rather than quietly exceed what was consented to.
  constraint lead_runs_charged_within_max
    check (max_credits is null or charged_credits <= max_credits)
);

create index if not exists lead_runs_user_created_idx
  on public.lead_runs (user_id, created_at desc);

-- The sidebar badge and the cron worker both ask "what is in flight", so the
-- status is worth indexing on its own rather than only under user_id.
create index if not exists lead_runs_status_idx
  on public.lead_runs (status)
  where status in ('queued', 'running', 'paused');

comment on table public.lead_runs is
  'One lead job. The unit the user watches and the unit the wallet is charged per.';

-- ---------------------------------------------------------------------------
-- lead_rows — one person, one row
-- ---------------------------------------------------------------------------
-- A row appears the moment its company is found, and fills in as the later
-- stages resolve. That is deliberate: a table that only shows rows once they are
-- complete looks empty for the whole of stage one and gives the user nothing to
-- watch.
--
-- email_status is the verification verdict, which is not the same question as
-- whether an email was found:
--   verified    deliverability confirmed
--   catch_all   valid syntax, but the domain accepts any mailbox. Sendable and
--               risky; never presented without saying so.
--   invalid     confirmed dead. Worth re-running the waterfall from the next
--               provider.
--   unknown     the verifier did not answer
--   not_found   no provider produced an email. Nothing was charged for this.
--
-- state and step are the live progress of the row, so a reconnecting browser
-- renders the current position instead of restarting the animation.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_rows (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  run_id           uuid not null references public.lead_runs (id) on delete cascade,

  company_name     text,
  domain           text,
  logo_url         text,

  person_name      text,
  title            text,
  linkedin_url     text,

  email            text,
  email_status     text not null default 'not_found',
  email_provider   text,

  phone            text,
  phone_provider   text,

  company_data     jsonb not null default '{}'::jsonb,

  -- Columns the user's CSV had that Leads does not model. Carried through to
  -- the export so a clean does not silently delete their data.
  extra            jsonb not null default '{}'::jsonb,

  -- What this row actually cost, in credits. Sums to the run's charged_credits;
  -- the acceptance suite asserts it.
  credits          numeric(20,6) not null default 0,

  state            text not null default 'queued',
  step             text,
  current_provider text,

  -- Set while a worker holds the row, so a second worker or the cron safety net
  -- skips it instead of processing the same row twice.
  locked_at        timestamptz,
  locked_by        text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint lead_rows_email_status_check
    check (email_status in ('verified', 'catch_all', 'invalid', 'unknown', 'not_found')),
  constraint lead_rows_state_check
    check (state in ('queued', 'trying', 'miss', 'found', 'done', 'skipped', 'failed')),
  constraint lead_rows_step_check
    check (step is null or step in ('company', 'person', 'email', 'verify', 'phone', 'enrich')),
  -- An email with no status, or a status with no email, is the shape of a row
  -- written halfway through a stage. Refusing it is what stops "Found" being
  -- shown for a row whose email later turned out to be invalid.
  constraint lead_rows_email_implies_address
    check (email_status = 'not_found' or email is not null),
  constraint lead_rows_credits_non_negative check (credits >= 0)
);

create index if not exists lead_rows_run_idx
  on public.lead_rows (run_id, created_at);

-- The sidebar badge counts runs; the run header counts rows by status; export
-- pages by run. These three cover every read the UI does.
create index if not exists lead_rows_run_status_idx
  on public.lead_rows (run_id, email_status);

create index if not exists lead_rows_user_domain_idx
  on public.lead_rows (user_id, domain)
  where domain is not null;

comment on table public.lead_rows is
  'One person per row. Created when the company is found, enriched as later stages resolve.';

-- ---------------------------------------------------------------------------
-- lead_attempts — every provider call made for a row
-- ---------------------------------------------------------------------------
-- This is what makes the provider lab honest: hit rates are computed from real
-- attempts on real rows, not assumed. It is also the audit trail behind the
-- credits a row cost, and why a user can be told exactly which provider was
-- tried and what it charged before the row's email turned up.
--
-- Cost is the real measured charge, never a list price.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_attempts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  run_id          uuid not null references public.lead_runs (id) on delete cascade,
  row_id          uuid not null references public.lead_rows (id) on delete cascade,

  step            text not null,
  endpoint_id     text not null,
  hit             boolean not null default false,
  cost_usd        numeric(20,6) not null default 0,
  ms              integer,

  treg_call_id    text,
  api_usage_id    uuid,

  created_at      timestamptz not null default now(),

  constraint lead_attempts_step_check
    check (step in ('company', 'person', 'email', 'verify', 'phone', 'enrich')),
  constraint lead_attempts_cost_non_negative check (cost_usd >= 0)
);

create index if not exists lead_attempts_row_idx
  on public.lead_attempts (row_id, created_at);

-- The smart order reads attempts per user per provider, to learn which provider
-- is actually cheapest per hit for this user rather than on average.
create index if not exists lead_attempts_user_endpoint_idx
  on public.lead_attempts (user_id, endpoint_id);

comment on table public.lead_attempts is
  'One row per provider call. The evidence behind hit rates, cost and the row receipt.';

-- ---------------------------------------------------------------------------
-- lead_waterfall_orders — provider order per user, per step
-- ---------------------------------------------------------------------------
-- One row per user per step, so "which providers, in what order" has exactly
-- one answer. mode distinguishes the shipped default from something the user
-- chose, because a drag that leaves the order as shipped should not look like a
-- deliberate pin.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_waterfall_orders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  step         text not null,
  endpoint_ids jsonb not null default '[]'::jsonb,
  mode         text not null default 'default',

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint lead_waterfall_orders_user_step_key unique (user_id, step),
  constraint lead_waterfall_orders_step_check
    check (step in ('company', 'person', 'email', 'verify', 'phone', 'enrich')),
  constraint lead_waterfall_orders_mode_check
    check (mode in ('default', 'smart', 'custom'))
);

comment on table public.lead_waterfall_orders is
  'Per-user provider order. mode=smart defers to measured hit rates until enough attempts exist.';

-- ---------------------------------------------------------------------------
-- lead_suppressions — the opt-out list
-- ---------------------------------------------------------------------------
-- Checked before every paid call. A suppressed row is never processed and never
-- returned, so suppression costs nothing: the provider is not called at all.
--
-- A domain suppresses everyone at that domain. Suppressing a domain after
-- finding one person at it stops future lookups; the rows already collected are
-- removed separately, because pretending they are not there would be a lie.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_suppressions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,

  value      text not null,
  kind       text not null,
  reason     text,

  created_at timestamptz not null default now(),

  constraint lead_suppressions_user_value_key unique (user_id, value),
  constraint lead_suppressions_kind_check check (kind in ('email', 'domain'))
);

create index if not exists lead_suppressions_user_idx
  on public.lead_suppressions (user_id);

comment on table public.lead_suppressions is
  'Contacts and domains this user never wants contacted. Checked before every paid call.';

-- ---------------------------------------------------------------------------
-- lead_filter_cache — provider filter values, shared across users
-- ---------------------------------------------------------------------------
-- Industries, positions and geo values have to be mapped into each provider's
-- own vocabulary before a search can be sent, and those vocabularies change
-- rarely. The list is identical for every user of every workspace, so this
-- table has no user_id and no tenant policy at all: it is shared read-write
-- infrastructure for the worker, not user data.
--
-- Because there is no user_id, RLS is enabled with *no policies*. That is the
-- deny-by-default this table wants, and it is the only Echo table with no
-- select-own policy. The tradeoff is that RLS cannot see a service_role
-- bypass, so the worker reaches it with the service key, which skips RLS.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_filter_cache (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  filter_type text not null,
  values      jsonb not null default '[]'::jsonb,
  fetched_at  timestamptz not null default now(),

  constraint lead_filter_cache_provider_type_key unique (provider, filter_type)
);

comment on table public.lead_filter_cache is
  'Shared provider filter vocabularies. No user_id, no policies: service role only.';

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists lead_icps_set_updated_at on public.lead_icps;
create trigger lead_icps_set_updated_at
  before update on public.lead_icps
  for each row execute function public.set_updated_at();

drop trigger if exists lead_runs_set_updated_at on public.lead_runs;
create trigger lead_runs_set_updated_at
  before update on public.lead_runs
  for each row execute function public.set_updated_at();

drop trigger if exists lead_rows_set_updated_at on public.lead_rows;
create trigger lead_rows_set_updated_at
  before update on public.lead_rows
  for each row execute function public.set_updated_at();

drop trigger if exists lead_waterfall_orders_set_updated_at on public.lead_waterfall_orders;
create trigger lead_waterfall_orders_set_updated_at
  before update on public.lead_waterfall_orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- profiles: the two server-owned columns
-- ---------------------------------------------------------------------------
-- leads_terms_accepted_at records that the user ticked the outreach consent
-- box before their first run. It is written by the leads function and must not
-- be writable by the client, because a client that can set it can skip the
-- consent step entirely.
--
-- The mechanism is deliberate: profiles has no table-level UPDATE grant to
-- authenticated, only per-column grants on eleven named columns (see
-- supabase/README.md). Adding a column here and simply *not* granting UPDATE on
-- it is therefore sufficient — the column is server-only by omission, and this
-- is the same way created_at and updated_at are already protected.
--
-- This is why the alternative was rejected. Tightening the RLS policy's
-- with_check cannot work: it restricts which *row* may be written, never which
-- columns, so the compliance checkbox would have been decorative.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists leads_terms_accepted_at timestamptz,
  add column if not exists leads_row_cap_usd numeric(10,6);

comment on column public.profiles.leads_terms_accepted_at is
  'Server-only. Set by the leads function when the user accepts the outreach terms.';
comment on column public.profiles.leads_row_cap_usd is
  'Server-only. Per-row spend cap in USD; the user sets it through the leads function.';

do $$
declare
  v_privileged text;
begin
  -- Belt and braces, and a loud failure rather than a silent one. If a future
  -- migration ever adds a table-level UPDATE grant to authenticated, the two
  -- columns above stop being protected and every row in this table becomes
  -- writable by its own owner. Refuse the migration instead.
  if exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'profiles'
       and has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
  ) then
    raise exception
      'authenticated holds a table-level UPDATE grant on public.profiles, which would make leads_terms_accepted_at and leads_row_cap_usd client-writable. Revoke it to table level first, or grant UPDATE per column.';
  end if;
end;
$$;

-- Belt and braces: a column-level privilege here would defeat the omission
-- above, so remove it if it ever appears.
revoke update (leads_terms_accepted_at, leads_row_cap_usd) on public.profiles from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- One select-own policy per tenant table and no write policies anywhere. RLS on
-- with no write policy is deny: a client that tries to insert, update or delete
-- a lead row gets zero rows affected and no error it can act on.
alter table public.lead_icps             enable row level security;
alter table public.lead_runs             enable row level security;
alter table public.lead_rows             enable row level security;
alter table public.lead_attempts         enable row level security;
alter table public.lead_waterfall_orders enable row level security;
alter table public.lead_suppressions     enable row level security;
alter table public.lead_filter_cache     enable row level security;

-- anon has no business here at all. Someone has to be able to read the price
-- list before signing up; nobody has to be able to read a lead.
revoke all on public.lead_icps             from anon;
revoke all on public.lead_runs             from anon;
revoke all on public.lead_rows             from anon;
revoke all on public.lead_attempts         from anon;
revoke all on public.lead_waterfall_orders from anon;
revoke all on public.lead_suppressions     from anon;
revoke all on public.lead_filter_cache     from anon;

drop policy if exists lead_icps_select_own on public.lead_icps;
create policy lead_icps_select_own on public.lead_icps
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_runs_select_own on public.lead_runs;
create policy lead_runs_select_own on public.lead_runs
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_rows_select_own on public.lead_rows;
create policy lead_rows_select_own on public.lead_rows
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_attempts_select_own on public.lead_attempts;
create policy lead_attempts_select_own on public.lead_attempts
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_waterfall_orders_select_own on public.lead_waterfall_orders;
create policy lead_waterfall_orders_select_own on public.lead_waterfall_orders
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists lead_suppressions_select_own on public.lead_suppressions;
create policy lead_suppressions_select_own on public.lead_suppressions
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- lead_filter_cache gets no policy on purpose. See the table comment.

-- Nothing below is granted to a client: every write is the service role.
revoke insert, update, delete on public.lead_icps             from anon, authenticated;
revoke insert, update, delete on public.lead_runs             from anon, authenticated;
revoke insert, update, delete on public.lead_rows             from anon, authenticated;
revoke insert, update, delete on public.lead_attempts         from anon, authenticated;
revoke insert, update, delete on public.lead_waterfall_orders from anon, authenticated;
revoke insert, update, delete on public.lead_suppressions     from anon, authenticated;
revoke insert, update, delete on public.lead_filter_cache     from anon, authenticated;

-- Realtime, so a run fills in live instead of only on the next poll.
-- Only these two: attempts are read through the run, and putting every write in
-- the database on a socket is more than the feature needs.
--
-- Guarded because ADD TABLE has no IF NOT EXISTS form, and a migration that runs
-- twice has to be a no-op the second time. deploy-all.sql is documented as safe
-- to paste more than once; this would otherwise break that promise on the second
-- paste rather than on the first.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lead_rows'
  ) then
    raise notice 'lead_rows already in supabase_realtime';
  else
    alter publication supabase_realtime add table public.lead_rows;
  end if;

  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lead_runs'
  ) then
    raise notice 'lead_runs already in supabase_realtime';
  else
    alter publication supabase_realtime add table public.lead_runs;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- A cheap read for the sidebar badge
-- ---------------------------------------------------------------------------
-- Counts a workspace's runs that are not finished, so the sidebar can badge
-- work in progress without loading the whole run list.
--
-- Deliberately NOT SECURITY DEFINER, and deliberately takes no argument.
--
-- The first version of this took p_user_id and was SECURITY DEFINER so it could
-- read past RLS. That is a tenancy hole with a straight line through it: the
-- function is granted to authenticated, so any signed-in user could pass
-- someone else's uuid and learn how many runs they had. A parameter that
-- identifies the subject of a read is only safe if the caller cannot choose it.
--
-- So it takes none. auth.uid() is the only source of the user id, RLS still
-- applies, and there is nothing to bypass in the first place — authenticated can
-- already select its own rows through lead_runs_select_own.
-- ---------------------------------------------------------------------------
create or replace function public.lead_active_run_count()
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
    from public.lead_runs
   where (select auth.uid()) = user_id
     and status in ('queued', 'running', 'paused');
$$;

revoke execute on function public.lead_active_run_count() from public, anon;
grant  execute on function public.lead_active_run_count() to authenticated, service_role;
