-- =============================================================================
-- Migration: 20261123_leads_search_pricing.sql
-- Description: Leads pricing: pay only for verified contacts.
--
-- A search is not charged by itself, but it requires a credit balance: every
-- lead it returns is checked for a verified work email (1 credit, charged only
-- when the verifier says `valid`) and a direct phone (2 credits, only when
-- found). Treg bills treg.people.search per call ($0-0.30; the leads function
-- caps it at $0.05 per call), which those per-contact charges cover.
--
-- `leads.search.extra_50` is kept at 0 credits so a per-lead search fee can be
-- switched on later as a data change, without a deploy.
--
-- Backward-compatible: rows only, no schema change. Also fixes the 20261122
-- upsert, which never wrote provider_cost_usd on conflict.
-- =============================================================================

INSERT INTO public.pricing_config (
    operation, display_name, provider_endpoint, provider_cost_usd,
    cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
)
VALUES
    ('treg.people.search', 'People search', 'treg.people.search', 0.05000000, true, 'catalog', 0.000000, true, 2, now(), now()),
    ('leads.search.extra_50', 'People search: per-50-leads fee (off)', 'treg.people.search', 0.05000000, true, 'catalog', 0.000000, true, 1, now(), now()),
    ('treg.people.email.find', 'Verified Work Email', 'treg.people.email.find', 0.04000000, true, 'catalog', 1.000000, true, 2, now(), now()),
    ('treg.people.phone.find', 'Direct Mobile Reveal', 'treg.people.phone.find', 0.08000000, true, 'catalog', 2.000000, true, 2, now(), now())
ON CONFLICT (operation) DO UPDATE
SET
    display_name = EXCLUDED.display_name,
    provider_cost_usd = EXCLUDED.provider_cost_usd,
    enabled = EXCLUDED.enabled,
    version = EXCLUDED.version,
    updated_at = now();
