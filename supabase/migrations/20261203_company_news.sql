-- ============================================================================
-- Migration: 20261203_company_news.sql
-- Description: Recent news on the company profile (treg.companies.news).
--
--   1. companies.news / news_at / news_miss_at: the latest articles, cached
--      with the profile (7 days; an empty answer is remembered for 3 days).
--   2. pricing_config: treg.companies.news, charged only when articles come back.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

alter table public.companies add column if not exists news jsonb;
alter table public.companies add column if not exists news_at timestamptz;
alter table public.companies add column if not exists news_miss_at timestamptz;

comment on column public.companies.news is
  'Up to 10 recent articles [{title, url, published_at, source}] from treg.companies.news.';

do $news_pricing$
begin
  insert into public.data_migrations (name) values ('20261203_news_pricing')
    on conflict (name) do nothing;
  if not found then
    return;
  end if;

  perform set_config('echo.changed_by', 'migration:20261203_company_news', true);
  perform set_config('echo.change_reason', 'company news launch', true);

  -- One provider (akta, $0.01) with no waterfall; it bills misses too, and
  -- about half of domains have no news, so a hit carries both.
  insert into public.pricing_config (
      operation, display_name, provider_endpoint, provider_cost_usd,
      cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
  )
  values
      ('treg.companies.news', 'Company news', 'treg.companies.news', 0.01000000,
       false, 'treg catalog 2026-10', 1.000000, true, 1, now(), now())
  on conflict (operation) do nothing;
end
$news_pricing$;
