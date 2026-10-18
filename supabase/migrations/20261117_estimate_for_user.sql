-- ============================================================================
-- Echo Leads: the estimate needs to know whose estimate it is
-- ----------------------------------------------------------------------------
-- estimate_lead_run read the user from auth.uid(). It is revoked from
-- authenticated and only ever called by the leads function through the service
-- role client, where auth.uid() is null - so it returned 'unauthenticated' on
-- every call, and the start action, which refuses a run without a price, could
-- never start one.
--
-- The user is now a parameter. Safe because only service_role can execute it,
-- and the function passes the id it resolved from the caller's JWT.
--
-- Also two single-purpose modes for bulk actions on leads already held:
--   phone_only   find a phone number, nothing else
--   enrich_only  company details, nothing else
--
-- The four-argument version is dropped so the old, broken signature cannot be
-- called by an older deployment of the function and silently fail.
-- ============================================================================

drop function if exists public.estimate_lead_run(integer, text, boolean, numeric);

create or replace function public.estimate_lead_run(
  p_target      integer,
  p_mode        text default null,
  p_phone       boolean default false,
  p_hit_rate    numeric default null,
  p_user        uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_user        uuid := coalesce(p_user, auth.uid());
  v_target      integer := greatest(1, least(coalesce(p_target, 50), 2000));
  v_mode        text := nullif(trim(p_mode), '');
  v_phone       boolean := coalesce(p_phone, false);

  -- find and lab look the company and the person up. The three clean modes do
  -- not: their rows came from the user's file with both already on them. Kept as
  -- booleans rather than re-testing the mode string in six places, because six
  -- places testing a mode string is how the branches drifted apart in the first
  -- place. These four are steps.ts's StepPlan, field for field.
  v_find_company boolean;   -- findCompany
  v_verify_existing boolean; -- verifyExisting
  v_find_email    boolean;   -- findEmail
  v_enrich       boolean;   -- enrich

  v_company     numeric;
  v_person      numeric;
  v_email       numeric;
  v_catch_all   numeric;
  v_verify      numeric;
  v_phone_credit numeric;
  v_enrich_credit numeric;

  v_rate        numeric;
  v_person_rate numeric;
  v_enrich_rate numeric;
  v_phone_rate  numeric;
  v_rate_used   numeric;
  v_person_rate_used numeric;
  v_enrich_rate_used numeric;
  v_phone_rate_used  numeric;
  v_rate_source text;
  v_person_source text;
  v_enrich_source text;
  v_phone_source  text;

  v_attempts    integer;
  v_hits        integer;

  v_min         numeric;
  v_expected    numeric;
  v_max         numeric;
  v_breakdown   jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'unauthenticated');
  end if;

  v_find_company   := v_mode is null
                      or v_mode not in ('verify_only', 'verify_refind', 'full_enrich', 'phone_only', 'enrich_only');
  v_verify_existing := coalesce(v_mode in ('verify_only', 'verify_refind', 'full_enrich'), false);
  v_find_email      := v_find_company or coalesce(v_mode in ('verify_refind', 'full_enrich'), false);
  v_enrich          := coalesce(v_mode in ('full_enrich', 'enrich_only'), false);
  -- phone_only exists to find numbers for leads already held; the flag is the mode.
  if v_mode = 'phone_only' then
    v_phone := true;
  end if;

  -- Prices come from the table, never from constants here. A row that is
  -- disabled or missing means the operation is not being sold, and the estimate
  -- has to say so rather than quote a price nothing charges.
  select
    max(case when operation = 'leads.company.found'  then credits end),
    max(case when operation = 'leads.person.found'   then credits end),
    max(case when operation = 'leads.email.verified' then credits end),
    max(case when operation = 'leads.email.catch_all' then credits end),
    max(case when operation = 'leads.verify.only'     then credits end),
    max(case when operation = 'leads.phone.found'     then credits end),
    max(case when operation = 'leads.company.enrich'  then credits end)
  into v_company, v_person, v_email, v_catch_all, v_verify, v_phone_credit, v_enrich_credit
  from public.pricing_config
  where operation in (
    'leads.company.found', 'leads.person.found', 'leads.email.verified',
    'leads.email.catch_all', 'leads.verify.only', 'leads.phone.found',
    'leads.company.enrich'
  ) and enabled;

  if v_company is null or v_person is null or v_email is null or v_verify is null then
    return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
  end if;

  -- Enrichment is priced only for the mode that sells it, so a missing row there
  -- is an error for that mode and not for any other. Refusing all three clean
  -- modes because enrichment is unpriced would break verify_only, which never
  -- enriches anything.
  if v_enrich and v_enrich_credit is null then
    return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
  end if;

  select count(*), count(*) filter (where hit)
  into v_attempts, v_hits
  from public.lead_attempts
  where user_id = v_user and step = 'email';

  -- The caller may pin the email rate; the other steps are always measured here.
  -- A pinned rate is for a quote being reproduced, not a way to move the others.
  if p_hit_rate is not null then
    v_rate       := p_hit_rate;
    v_rate_source := 'pinned';
  elsif coalesce(v_attempts, 0) >= 50 then
    v_rate        := (v_hits::numeric + 1) / (v_attempts::numeric + 2);
    v_rate_source := 'your history';
  else
    v_rate        := 0.7;
    v_rate_source := 'default';
  end if;

  v_rate_used       := v_rate;
  v_person_rate     := public.leads_step_hit_rate(v_user, 'person');
  v_enrich_rate     := public.leads_step_hit_rate(v_user, 'enrich');
  v_phone_rate      := public.leads_step_hit_rate(v_user, 'phone');
  v_person_rate_used := v_person_rate;
  v_enrich_rate_used := v_enrich_rate;
  v_phone_rate_used  := v_phone_rate;
  v_person_source  := case when v_person_rate = 0.7 then 'default' else 'your history' end;
  v_enrich_source := case when v_enrich_rate = 0.7 then 'default' else 'your history' end;
  v_phone_source  := case when v_phone_rate  = 0.7 then 'default' else 'your history' end;

  -- --- totals -------------------------------------------------------------
  -- Every line below is charged only when the work happened, which is what
  -- creditsForRow does. The company is the exception and is charged per row
  -- because the row exists because that company was found.
  v_min := 0;
  v_expected := 0;
  v_max := 0;

  -- company
  if v_find_company then
    v_min      := v_target * v_company;
    v_expected := v_min;
    -- person only. The email line below adds its own worst case, and adding it
    -- here as well is how max_credits came back at 2.22 per row for a row whose
    -- worst case is 1.22 - a 8200 credit over-reservation on a 2000-row search,
    -- which refuses runs the user can afford.
    v_max      := v_min + v_target * v_person;
  end if;

  -- decision maker
  if v_find_company then
    v_expected := v_expected + v_target * v_person_rate * v_person;
  end if;

  -- verification
  if v_verify_existing then
    v_min      := v_min + v_target * v_verify;
    v_expected := v_expected + v_target * v_verify;
    v_max      := v_max + v_target * v_verify;
  end if;

  -- address
  if v_find_email then
    v_expected := v_expected + v_target * v_rate * v_email;
    v_max      := v_max + v_target * v_email;
  end if;

  -- enrichment
  if v_enrich then
    v_expected := v_expected + v_target * v_enrich_rate * v_enrich_credit;
    v_max      := v_max + v_target * v_enrich_credit;
  end if;

  -- phone
  if v_phone then
    if v_phone_credit is null then
      return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
    end if;
    v_expected := v_expected + v_target * v_phone_rate * v_phone_credit;
    v_max      := v_max + v_target * v_phone_credit;
  end if;

  -- --- the lines behind those totals --------------------------------------
  -- The invariant this file exists to protect: the lines add up to
  -- expected_credits. Built from the same conditionals as the totals above
  -- rather than from the mode string, because the previous version tested the
  -- mode one way for the lines and another for the total.
  v_breakdown := '[]'::jsonb;

  if v_find_company then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object('label', 'Companies', 'credits', round(v_target * v_company, 6)),
      jsonb_build_object(
        'label', 'Decision makers',
        'credits', round(v_target * v_person_rate_used * v_person, 6),
        'note', 'at ' || round(v_person_rate_used * 100, 1) || '% from ' || v_person_source
      )
    );
  end if;

  if v_verify_existing then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object('label', 'Verifications', 'credits', round(v_target * v_verify, 6))
    );
  end if;

  if v_find_email then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object(
        'label', case when v_find_company then 'Emails found' else 'Replacements found' end,
        'credits', round(v_target * v_rate_used * v_email, 6),
        'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
      )
    );
  end if;

  if v_enrich then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object(
        'label', 'Company details',
        'credits', round(v_target * v_enrich_rate_used * v_enrich_credit, 6),
        'note', 'at ' || round(v_enrich_rate_used * 100, 1) || '% from ' || v_enrich_source
      )
    );
  end if;

  if v_phone then
    v_breakdown := v_breakdown || jsonb_build_array(
      jsonb_build_object(
        'label', 'Phone numbers',
        'credits', round(v_target * v_phone_rate_used * v_phone_credit, 6),
        'note', 'at ' || round(v_phone_rate_used * 100, 1) || '% from ' || v_phone_source
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

revoke execute on function public.estimate_lead_run(integer, text, boolean, numeric, uuid)
  from public, anon, authenticated;
grant  execute on function public.estimate_lead_run(integer, text, boolean, numeric, uuid)
  to service_role;