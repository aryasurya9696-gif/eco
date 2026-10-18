-- estimate_lead_run: verify_only's worst case was the verify_refind worst case
-- ---------------------------------------------------------------------------
-- verify_only was priced at target * (verify + email) for its ceiling, on the
-- assumption that a check might turn into a find. The worker never did that:
-- lead_runs.mode was read for nothing, so all three clean modes ran the identical
-- email waterfall and the ceiling was honest by accident.
--
-- The worker now gates on the mode. steps.ts plans findEmail: false for
-- verify_only, and the row loop never reaches the email step. So the ceiling can
-- no longer be reached, and reserving against it was wrong in the direction that
-- blocks people:
--
--   2000 rows in verify_only costs 200 credits.
--   Before this, starting it required 2200 — eleven times the real cost.
--
-- A user with 300 credits was refused with insufficient_credits on an operation
-- they could comfortably afford, and the only way to run it was to raise their
-- own prices or to buy credits for work they were not asking for.
--
-- The totals are otherwise untouched. min and expected were already correct:
-- min is target * verify, and expected is the same, because in this mode nothing
-- is ever found so there is no find price to expect.
--
-- One honest limitation, unchanged here: min assumes every row arrives with an
-- address to check. A row imported with no email is skipped and charged nothing,
-- so a file of half-addressed rows settles below its stated floor. That errs in
-- the user's favour and the gap is visible on the invoice, which is the right
-- direction for a floor to be wrong in. Making min exact would mean passing the
-- address-bearing count into the estimator, which is a different signature and
-- not worth it for a number that is already an upper bound.

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

  select
    max(case when operation = 'leads.company.found'   then credits end),
    max(case when operation = 'leads.person.found'    then credits end),
    max(case when operation = 'leads.email.verified'  then credits end),
    max(case when operation = 'leads.email.catch_all' then credits end),
    max(case when operation = 'leads.verify.only'     then credits end),
    max(case when operation = 'leads.phone.found'     then credits end)
  into v_company, v_person, v_email, v_catch_all, v_verify, v_phone_credit
  from public.pricing_config
  where operation in (
    'leads.company.found', 'leads.person.found', 'leads.email.verified',
    'leads.email.catch_all', 'leads.verify.only', 'leads.phone.found'
  ) and enabled;

  if v_company is null or v_person is null or v_email is null or v_verify is null then
    return jsonb_build_object('ok', false, 'error', 'leads_not_priced');
  end if;

  select count(*), count(*) filter (where hit)
  into v_attempts, v_hits
  from public.lead_attempts
  where user_id = v_user and step = 'email';

  if coalesce(v_attempts, 0) >= 50 then
    v_rate       := (v_hits::numeric + 1) / (v_attempts::numeric + 2);
    v_rate_source := 'your history';
  else
    v_rate       := 0.7;
    v_rate_source := 'default';
  end if;

  v_rate_used := v_rate;

  -- --- totals -------------------------------------------------------------
  if v_mode = 'verify_only' then
    -- Verification and nothing else. The ceiling is the floor, because the one
    -- thing that could push a row over it is a find and this mode does not do
    -- finds. See the banner: the previous (verify + email) ceiling made a 200
    -- credit operation require 2200 credits to start.
    v_expected := v_target * v_verify;
    v_max       := v_target * v_verify;
    v_min       := v_target * v_verify;
  elsif v_mode = 'verify_refind' then
    v_expected := v_target * v_verify + v_target * v_rate * v_email;
    v_max       := v_target * v_verify + v_target * v_email;
    v_min       := v_target * v_verify;
  else
    v_min      := v_target * v_company + v_target * v_person;
    v_max      := v_min + v_target * v_email;
    v_expected := v_min + v_target * v_rate * v_email;
  end if;

  if v_phone then
    v_expected := v_expected + v_target * v_rate * v_phone_credit;
    v_max       := v_max + v_target * v_phone_credit;
  end if;

  -- --- the lines behind those totals --------------------------------------
  -- Built from the same branch as the totals, so they sum to expected_credits.
  -- See 20261111_estimate_breakdown.sql for why that invariant matters.
  if v_mode = 'verify_only' then
    v_breakdown := jsonb_build_array(
      jsonb_build_object('label', 'Verifications', 'credits', round(v_target * v_verify, 6))
    );
  elsif v_mode = 'verify_refind' then
    v_breakdown := jsonb_build_array(
      jsonb_build_object('label', 'Verifications', 'credits', round(v_target * v_verify, 6)),
      jsonb_build_object(
        'label', 'Replacements found',
        'credits', round(v_target * v_rate_used * v_email, 6),
        'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
      )
    );
  else
    v_breakdown := jsonb_build_array(
      jsonb_build_object('label', 'Companies',       'credits', round(v_target * v_company, 6)),
      jsonb_build_object('label', 'Decision makers', 'credits', round(v_target * v_person, 6)),
      jsonb_build_object(
        'label', 'Emails found',
        'credits', round(v_target * v_rate_used * v_email, 6),
        'note', 'at ' || round(v_rate_used * 100, 1) || '% from ' || v_rate_source
      )
    );
  end if;

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