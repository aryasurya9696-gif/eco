-- ============================================================================
-- Migration: 20261201_person_enrichment.sql
-- Description: Person enrichment (treg.people.enrich) for saved leads.
--
--   1. user_leads.person_enriched_at: when the profile was last enriched, so
--      the UI stops offering it and nobody pays twice for the same lead.
--   2. pricing_config: treg.people.enrich, charged only on a hit.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

alter table public.user_leads add column if not exists person_enriched_at timestamptz;

comment on column public.user_leads.person_enriched_at is
  'Last successful treg.people.enrich for this lead. Written only by the leads edge function.';

do $person_pricing$
begin
  insert into public.data_migrations (name) values ('20261201_person_pricing')
    on conflict (name) do nothing;
  if not found then
    return;
  end if;

  perform set_config('echo.changed_by', 'migration:20261201_person_enrichment', true);
  perform set_config('echo.change_reason', 'person enrichment launch', true);

  -- Cost is the routing cap the leads function sends (X-Treg-Route-Max-Cost).
  -- The LinkedIn-URL route answers for $0.0005 a hit; name + domain lookups
  -- run $0.004-$0.03.
  insert into public.pricing_config (
      operation, display_name, provider_endpoint, provider_cost_usd,
      cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
  )
  values
      ('treg.people.enrich', 'Person enrichment', 'treg.people.enrich', 0.03000000,
       false, 'treg catalog 2026-10', 1.000000, true, 1, now(), now())
  on conflict (operation) do nothing;
end
$person_pricing$;
