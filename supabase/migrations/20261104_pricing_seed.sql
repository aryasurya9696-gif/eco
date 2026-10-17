-- ============================================================================
-- Credit wallet — the seed prices
-- ----------------------------------------------------------------------------
-- What things cost, and what can be bought.
--
-- The provider costs below were read out of treg's own catalog rather than
-- estimated, and two of them were confirmed against a live call, which is where
-- the live_confirmed marker comes from. They are still only the estimate the
-- system quotes before a call: the figure that actually lands in the profit
-- report is whatever treg reports in x-treg-cost-micro afterwards, so a provider
-- price change shows up in the numbers without anyone editing this file.
--
-- This table is edited by SQL. There is no admin screen for it in this product,
-- which is deliberate — the price lives in one place, it is versioned, and
-- every change to it is audited whether it came from a migration or from an
-- editor.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- topup_packages
-- 20 credits per dollar. The unit price is derived from these rows when a grant
-- is issued and stored on the grant itself, so changing a package price later
-- never reprices credits that were already sold.
-- ---------------------------------------------------------------------------
insert into public.topup_packages (code, display_name, gross_usd, credits, bonus_credits, currency, active, sort_order)
values
  ('starter_200',  '200 credits',  10.00,  200,  0, 'USD', true, 10),
  ('standard_500', '500 credits',  25.00,  500,  0, 'USD', true, 20),
  ('pack_1000',    '1000 credits', 50.00, 1000,  0, 'USD', true, 30)
on conflict (code) do update
   set display_name  = excluded.display_name,
       gross_usd     = excluded.gross_usd,
       credits       = excluded.credits,
       bonus_credits = excluded.bonus_credits,
       currency      = excluded.currency,
       active        = excluded.active,
       sort_order    = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- pricing_config
-- One row per logical operation, never per provider call.
--
-- Reddit is the case that forces this. Its primary and its fallback are both
-- billed calls, so a per-call price would make the same keyword cost two
-- credits on one sweep and four the next depending on whether the primary
-- happened to work. Charging per operation makes it two either way. The
-- fallback chain lives in the treg client as routing, which is where routing
-- belongs; what the customer pays is one number.
--
-- cost_verified says the figure was confirmed rather than assumed. Everything
-- else about these rows is a business decision and changes with the pricing
-- conversation, not with treg.
-- ---------------------------------------------------------------------------
insert into public.pricing_config (
  operation, display_name, provider_endpoint, provider_cost_usd,
  cost_verified, cost_source, credits, enabled, version, effective_from
)
values
  (
    'treg.twitter.search',
    'Twitter search',
    'anyapi.x.search.posts',
    0.00075,
    true, 'catalog', 1, true, 1, now()
  ),
  (
    'treg.reddit.search',
    'Reddit search',
    'tikhub.x.reddit-app-fetch-dynamic-search',
    0.00100,
    true, 'live_confirmed', 2, true, 1, now()
  ),
  (
    'treg.web.search',
    'Web search',
    'crawl4ai.web.search.rich',
    0.00015,
    true, 'catalog', 1, true, 1, now()
  ),
  (
    -- Charged one credit despite costing us nothing: treg bills this at zero.
    -- It is the only operation here with no provider cost, which makes it the
    -- one line in the margin report that will read 100%. That is correct.
    'treg.news.search',
    'Press & news',
    'tinyfish.web.search.news',
    0.00000,
    true, 'live_confirmed', 1, true, 1, now()
  )
on conflict (operation) do update
   set display_name      = excluded.display_name,
       provider_endpoint = excluded.provider_endpoint,
       -- credits, enabled and version are deliberately left alone on re-seed.
       -- Re-running a migration must never silently reprice live customers or
       -- re-enable an endpoint somebody deliberately switched off. Price
       -- changes go through an explicit update, which the audit trigger records.
       provider_cost_usd  = excluded.provider_cost_usd,
       cost_verified      = excluded.cost_verified,
       cost_source        = excluded.cost_source;