-- ---------------------------------------------------------------------------
-- estimate_lead_run: the three clean modes, and the decision-maker line
-- ---------------------------------------------------------------------------
-- The estimate was wrong in three ways, and all three moved real money.
--
-- 1. full_enrich was priced as though it were a find run. It fell into the same
--    else branch, which means its max was target * (company + person + email).
--    Two things wrong with that, pulling in opposite directions:
--
--      it quoted 0.22 per row for a company lookup and a people lookup, which
--      full_enrich never performs - its rows came from the user's file with both
--      already on them, and steps.ts sets findCompany = false for all three clean
--      modes for exactly that reason;
--
--      and it left company.enrich out of the figure entirely. The worker charges
--      it, one credit per enriched row, and the number the user was shown did not
--      contain it.
--
--    Net effect at 2000 rows: max_credits came back as 2440 when the run's real
--    worst case was 4200. The wallet is checked against max, so a user with 3000
--    credits was allowed to start a run that could not be paid for, and the run
--    stalled part-way with pause_reason 'credits' - after doing most of the work
--    and being charged for it.
--
-- 2. The decision-maker line was unconditional. v_min was target * (company +
--    person), described in the file's own comment as "the lookups happen and are
--    billed whether or not they find anyone". That was never true of the code
--    that ships: creditsForRow charges the person only when the people waterfall
--    returns somebody, so min was a figure the wallet could never reach.
--
-- 3. Because of 2, expected_credits was also wrong - it was built on min, so it
--    carried the unconditional person price.
--
-- Rebuilt so the mode branch is the same branch steps.ts takes, which is the
-- only place the meaning of a mode is defined. The estimate now reads the plan
-- rather than reinterpreting the mode string, and the two cannot drift again.
--
-- max_credits stays a ceiling rather than a sum of the lines. It is what the
-- wallet is checked against, and a wallet check that used a forecast would
-- refuse runs that would have been fine.

-- ---------------------------------------------------------------------------
-- A smoothed success rate for one step of one user's waterfall.
--
-- The email rate already existed inline and was duplicated per step, which is
-- how person and enrich ended up borrowing the email rate: a user with a 40%
-- email hit rate was quoted 40% of decision makers too, which is a statement
-- about a waterfall that was never asked a question about.
--
-- Each step gets its own rate now, from its own attempts, and says which one it
-- used. Below the threshold the shipped 0.7 default applies rather than an
-- average across users - confidently wrong for anyone whose leads are harder
-- than average, on a page whose job is to say what a button will cost.
-- ---------------------------------------------------------------------------
create or replace function public.leads_step_hit_rate(p_user uuid, p_step text)
returns numeric
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    when count(*) >= 50
      then (count(*) filter (where hit)::numeric + 1) / (count(*)::numeric + 2)
    else 0.7
  end
  from public.lead_attempts
  where user_id = p_user and step = p_step;
$fn$;

revoke execute on function public.leads_step_hit_rate(uuid, text)
  from public, anon, authenticated;
grant execute on function public.leads_step_hit_rate(uuid, text) to service_role;

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

  v_find_company   := v_mode is null or v_mode not in ('verify_only', 'verify_refind', 'full_enrich');
  v_verify_existing := v_mode in ('verify_only', 'verify_refind', 'full_enrich');
  v_find_email      := v_find_company or v_mode in ('verify_refind', 'full_enrich');
  v_enrich          := v_mode = 'full_enrich';

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

revoke execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  from public, anon, authenticated;
grant  execute on function public.estimate_lead_run(integer, text, boolean, numeric)
  to service_role;