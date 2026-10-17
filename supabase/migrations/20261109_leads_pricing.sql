-- ============================================================================
-- Echo Leads: prices and the run estimate
-- ----------------------------------------------------------------------------
-- What a lead costs the customer, and what it might cost us, as data rather than
-- as constants in a function. Both halves are rows:
--
--   credits             what the customer pays, in Echo credits
--   provider_cost_usd   what we think the provider call costs us
--
-- The second column is the honest one. Every leads row ships with
-- cost_verified = false, because none of these endpoints has been called yet and
-- a price taken from a catalog is a claim, not an observation. The billing
-- system's whole claim is that margin is measured rather than assumed, and a
-- price seeded from a catalog with cost_verified = true would be exactly the
-- assumption the rest of the design refuses to make. It flips when the first
-- real call is observed.
--
-- Credits convert from the Cascade price list, which was written against a
-- $0.01 credit. Echo's credit is $0.05, so every figure is divided by five.
-- Customer dollar prices are unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The price list
-- ---------------------------------------------------------------------------
-- Free to the customer is not free to us. leads.icp.generate is zero because the
-- website read and the model call are the price of admission to the feature and
-- charging for the estimate would mean nobody could see what they were buying;
-- its real cost is logged in api_usage so it still shows in the margin views.
--
-- leads.email.catch_all exists because a catch-all address is not a found
-- contact. It works often enough to be worth having and is untrustworthy often
-- enough that charging the full verified price for it would be selling the
-- customer a worse answer at the better price.
-- ---------------------------------------------------------------------------
insert into public.pricing_config
  (operation, display_name, credits, provider_endpoint, provider_cost_usd, cost_source, cost_verified, enabled)
values
  ('leads.icp.generate', 'Ideal customer profile', 0,     'treg.web.extract',  0.03000000, 'catalog', false, true),
  ('leads.company.found','Company found',              0.02,  'tomba.companies.search.reveal', 0.00017800, 'catalog', false, true),
  ('leads.person.found', 'Decision maker found',       0.2,   'icypeas.people.search', 0.00038000, 'catalog', false, true),
  ('leads.email.verified','Verified email',            1,     'quickenrich.people.email.find', 0.00480000, 'catalog', false, true),
  ('leads.email.catch_all','Catch-all email',          0.4,   'quickenrich.people.email.find', 0.00480000, 'catalog', false, true),
  ('leads.verify.only',  'Email verified (existing)',  0.1,   'contactout.people.email.verify', 0.00000000, 'catalog', false, true),
  ('leads.phone.found',  'Phone found and live',       8,     'aiark.people.phone.find', 0.02600000, 'catalog', false, true),
  ('leads.company.enrich','Company data column',        1,     'prospeo.companies.enrich', 0.02450000, 'catalog', false, true)
on conflict (operation) do update
  set display_name        = excluded.display_name,
      credits             = excluded.credits,
      provider_endpoint   = excluded.provider_endpoint,
      provider_cost_usd   = excluded.provider_cost_usd,
      cost_source         = excluded.cost_source,
      cost_verified       = excluded.cost_verified,
      enabled             = excluded.enabled,
      effective_from      = now();

comment on table public.pricing_config is
  'Credit price per operation, and our believed cost for it. leads.* rows start with cost_verified=false because no endpoint has been called yet.';

-- ---------------------------------------------------------------------------
-- estimate_lead_run
-- ---------------------------------------------------------------------------
-- What a run costs before it starts, in three numbers rather than one.
--
-- The three exist because they answer three different questions:
--
--   min       what it costs if nothing is found. Still non-zero: the company
--             lookups and the decision-maker lookups happen and are billed
--             whether or not they find anyone.
--   expected  what it will probably cost, using this user's own email hit rate
--             where they have enough history for one to mean anything.
--   max       what it will cost if every email resolves. This is the figure the
--             wallet is checked against before the run starts, because a sweep
--             that cannot be paid for in full must not start.
--
-- Two things this deliberately does not do.
--
-- It does not add a separate verification line to a find run. The PRD's worked
-- example does not, and the reason is sound: every address found is verified as
-- part of finding it, so a separate line would double-count the same work. The
-- clean modes are different — there verification is the product, and it is
-- priced on its own at leads.verify.only.
--
-- It does not guess a hit rate for a user with no history. 70% is the shipped
-- default and it is used only until the smoothed estimate has enough attempts
-- behind it to beat it; an average across all users would be confidently wrong
-- for anyone whose leads happen to be harder than average, which is the opposite
-- of useful on a page whose job is to tell someone what a button will cost.
-- ---------------------------------------------------------------------------
create or replace function public.estimate_lead_run(
  p_target      integer,
  p_mode        text default null,
  p_phone       boolean default false,
  p_hit_rate    numeric default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_user        uuid := auth.uid();
  v_target      integer := greatest(1, least(coalesce(p_target, 50), 2000));
  v_mode        text := nullif(trim(p_mode), '');
  v_phone       boolean := coalesce(p_phone, false);

  v_company     numeric;
  v_person      numeric;
  v_email       numeric;
  v_catch_all   numeric;
  v_verify      numeric;
  v_phone_credit numeric;

  -- Smoothed hit rate for this user's email waterfall, used only once there is
  -- enough of it to be better than the default.
  v_attempts    integer;
  v_hits        integer;
  v_rate        numeric;
  v_rate_used   numeric;
  v_rate_source text;

  v_min         numeric;
  v_expected    numeric;
  v_max         numeric;
  v_breakdown   jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'unauthenticated');
  end if;

  -- Prices come from the table, never from constants here. A row that is
  -- disabled or missing means the operation is not being sold, and the estimate
  -- has to say so rather than quietly pricing it at zero.
  select
    max(case when operation = 'leads.company.found' then credits end),
    max(case when operation = 'leads.person.found'  then credits end),
    max(case when operation = 'leads.email.verified' then credits end),
    max(case when operation = 'leads.email.catch_all' then credits end),
    max(case when operation = 'leads.verify.only'  then credits end),
    max(case when operation = 'leads.phone.found'  then credits end)
  into v_company, v_person, v_email, v_catch_all, v_verify, v_phone_credit
  from public.pricing_config
  where operation in (
    'leads.company.found', 'leads.person.found', 'leads.email.verified',
    'leads.email.catch_all', 'leads.verify.only', 'leads.phone.found'
  ) and enabled;

  if v_company is null or v_person is null or v_email is null or v_verify is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'leads_not_priced',
      'note', 'one or more leads operations are missing or disabled in pricing_config'
    );
  end if;

  v_company      := coalesce(v_company, 0);
  v_person       := coalesce(v_person, 0);
  v_catch_all    := coalesce(v_catch_all, v_email);
  v_phone_credit := coalesce(v_phone_credit, 0);

  -- Hit rate. An explicit argument wins, so the caller can price a what-if; then
  -- this user's own measured rate once it is backed by enough attempts; then the
  -- shipped default.
  select
    count(*),
    count(*) filter (where hit)
  into v_attempts, v_hits
  from public.lead_attempts
  where user_id = v_user and step = 'email';

  if p_hit_rate is not null then
    v_rate       := greatest(0, least(1, p_hit_rate));
    v_rate_source := 'supplied';
  elsif v_attempts >= 50 then
    -- (hits + 1) / (attempts + 2) is Laplace smoothing: it keeps a perfect run
    -- from reading as a guaranteed 100% and a single miss from reading as 0%.
    v_rate       := (v_hits::numeric + 1) / (v_attempts::numeric + 2);
    v_rate_source := 'your history';
  else
    v_rate       := 0.7;
    v_rate_source := 'default';
  end if;

  v_rate_used := v_rate;

  -- --- clean modes ---------------------------------------------------------
  -- Verification is the product here, so it is priced per address rather than
  -- folded into finding one.
  if v_mode in ('verify_only', 'verify_refind') then
    v_expected := v_target * v_verify
                + case when v_mode = 'verify_refind'
                       then v_target * v_rate * v_email
                       else 0 end;
    v_max       := v_target * v_verify + v_target * v_email;
    v_min       := v_target * v_verify;
  else
    -- --- find and lab ------------------------------------------------------
    -- Companies and people are found before any email is attempted, and both
    -- are billed whether or not they resolve, so the floor is not zero.
    v_min := v_target * v_company + v_target * v_person;
    v_max := v_min + v_target * v_email;
    v_expected := v_min + v_target * v_rate * v_email;
  end if;

  -- Phone is opt-in and only reached when a row already has a usable contact, so
  -- it is added to the expected figure at the same rate as the email that
  -- precedes it. It is not in the minimum: a user who ticks the box and gets no
  -- emails has spent nothing on phone lookups.
  if v_phone then
    v_expected := v_expected + v_target * v_rate * v_phone_credit;
    v_max       := v_max + v_target * v_phone_credit;
  end if;

  v_breakdown := jsonb_build_array(
    jsonb_build_object('label', 'Companies', 'credits', v_target * v_company),
    jsonb_build_object('label', 'Decision makers', 'credits', v_target * v_person),
    jsonb_build_object(
      'label', case when v_mode in ('verify_only','verify_refind')
                    then 'Verifications' else 'Emails found' end,
      'credits', round(v_target * v_rate_used * v_email, 6),
      'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
    )
  );

  if v_phone then
    v_breakdown := v_breakdown
      || jsonb_build_array(
           jsonb_build_object(
             'label', 'Phone numbers',
             'credits', round(v_target * v_rate_used * v_phone_credit, 6)
           )
         );
  end if;

  return jsonb_build_object(
    'ok', true,
    'min_credits',     round(v_min, 6),
    'expected_credits', round(v_expected, 6),
    'max_credits',     round(v_max, 6),
    'target',          v_target,
    'hit_rate',        round(v_rate_used, 4),
    'hit_rate_source', v_rate_source,
    'attempts_behind_hit_rate', v_attempts,
    'breakdown',       v_breakdown
  );
end;
$fn$;

revoke execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  from public, anon, authenticated;
grant  execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  to service_role;
