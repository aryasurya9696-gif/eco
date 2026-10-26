-- ============================================================================
-- Migration: 20261205_company_signals.sql
-- Description: Funding rounds and open jobs on the company profile, next to
--              news (leads action `company-signal`).
--
--   1. companies.funding / funding_at / funding_miss_at   (Aviato, 30-day cache)
--      companies.jobs / jobs_at / jobs_miss_at            (treg jobs search, 7-day cache)
--   2. Prices, charged only when the lookup finds something:
--        treg.companies.funding  0.5 credit (Aviato bills $0.01 per hit only)
--        treg.companies.jobs     2 credits  (PredictLeads, $0.04 a call, misses too)
--
-- Idempotent: safe to run more than once.
-- ============================================================================

alter table public.companies add column if not exists funding jsonb;
alter table public.companies add column if not exists funding_at timestamptz;
alter table public.companies add column if not exists funding_miss_at timestamptz;
alter table public.companies add column if not exists jobs jsonb;
alter table public.companies add column if not exists jobs_at timestamptz;
alter table public.companies add column if not exists jobs_miss_at timestamptz;

comment on column public.companies.funding is
  'Up to 10 funding rounds [{name, stage, announced_on, amount_usd}] from aviato.companies.funding_rounds.';
comment on column public.companies.jobs is
  'Up to 10 open jobs [{title, url, location, posted_at}] from treg.companies.jobs.search.';

do $signal_pricing$
begin
  insert into public.data_migrations (name) values ('20261205_signal_pricing')
    on conflict (name) do nothing;
  if not found then
    return;
  end if;

  perform set_config('echo.changed_by', 'migration:20261205_company_signals', true);
  perform set_config('echo.change_reason', 'company funding and hiring signals', true);

  insert into public.pricing_config (
      operation, display_name, provider_endpoint, provider_cost_usd,
      cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
  )
  values
      ('treg.companies.funding', 'Company funding rounds', 'aviato.companies.funding_rounds', 0.01000000,
       false, 'treg catalog 2026-10', 0.500000, true, 1, now(), now()),
      -- One provider (PredictLeads by domain, ~65% hit rate) with no waterfall;
      -- it bills misses, so a hit carries both.
      ('treg.companies.jobs', 'Company open jobs', 'treg.companies.jobs.search', 0.04000000,
       false, 'treg catalog 2026-10', 2.000000, true, 1, now(), now())
  on conflict (operation) do nothing;
end
$signal_pricing$;
