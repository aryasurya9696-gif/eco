-- ============================================================================
-- Migration: 20261130_company_enrichment.sql
-- Description: Company enrichment (treg.companies.enrich) with a shared cache.
--
--   1. companies: one row per domain, shared by every user. Whoever pays for
--      the first lookup fills it; later lookups inside the freshness window are
--      served from here at no charge and with no provider call. A miss is
--      cached too (miss_at), so an unknown domain is not paid for again.
--      Service role only: the leads function is the only reader and writer.
--   2. pricing_config: treg.companies.enrich, charged only on a hit.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. companies
-- ---------------------------------------------------------------------------
-- The columns are treg's routed output contract (name, domain, website,
-- description, industry, employees, founded, location, linkedin_url) plus a
-- logo when the serving provider has one. Anything provider-specific (funding,
-- tech stack) stays in raw until a feature needs it.
create table if not exists public.companies (
  domain             text primary key check (domain = lower(domain) and length(domain) between 3 and 253),
  name               text,
  description        text,
  industry           text,
  -- Headcount or a range, as the provider states it ("51-200", "1200").
  employees          text,
  founded_year       integer,
  location           text,
  linkedin_url       text,
  website            text,
  logo_url           text,
  -- Which treg child provider answered, and its untouched answer.
  served_by          text,
  raw                jsonb,
  enriched_at        timestamptz,
  -- Set when the last lookup found nothing; cleared by a later hit.
  miss_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.companies enable row level security;
revoke all on public.companies from public, anon, authenticated;
grant select, insert, update, delete on public.companies to service_role;

comment on table public.companies is
  'Shared company-enrichment cache keyed by domain (treg.companies.enrich). Written and read only by the leads edge function.';

-- ---------------------------------------------------------------------------
-- 2. Price: 0.5 credit per company found. Seeded once, so a re-run never
--    reverts a later operator edit.
-- ---------------------------------------------------------------------------
do $company_pricing$
begin
  insert into public.data_migrations (name) values ('20261130_company_pricing')
    on conflict (name) do nothing;
  if not found then
    return;
  end if;

  perform set_config('echo.changed_by', 'migration:20261130_company_enrichment', true);
  perform set_config('echo.change_reason', 'company enrichment launch', true);

  -- Cost is the routing cap the leads function sends (X-Treg-Route-Max-Cost);
  -- the cheapest children answer for $0.0005-$0.005.
  insert into public.pricing_config (
      operation, display_name, provider_endpoint, provider_cost_usd,
      cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
  )
  values
      ('treg.companies.enrich', 'Company enrichment', 'treg.companies.enrich', 0.02000000,
       false, 'treg catalog 2026-10', 0.500000, true, 1, now(), now())
  on conflict (operation) do nothing;
end
$company_pricing$;
