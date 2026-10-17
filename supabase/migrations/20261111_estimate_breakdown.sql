-- estimate_lead_run: the breakdown has to sum to expected_credits
-- ---------------------------------------------------------------------------
-- The breakdown was built unconditionally in the find/lab shape: Companies,
-- Decision makers, and one email line. For the clean modes that is wrong twice
-- over, and both errors were visible in the returned jsonb.
--
-- It listed Companies and Decision makers for a clean run, which never performs
-- either lookup: the company and the person are already in the file the user
-- imported. On a 2000-row verify_only that is 440 credits of work described and
-- not done.
--
-- It then labelled the email line "Verifications" while still computing it as
-- target * hit_rate * v_email, which is the price of *finding* an address. The
-- verify price is a different number, and the label is a promise the figure does
-- not keep.
--
-- The consequence was three different answers to "what will this cost me":
--   200  expected_credits
--   1600 what the user was actually charged
--   1840 what the breakdown on screen added up to
--
-- Rebuilt so the lines are chosen by the same branch that computes the total, and
-- so they sum to it. The invariant is the point: a breakdown that does not add up
-- to the number above it is worse than no breakdown, because it is the one a user
-- can add up.
--
-- max_credits is deliberately still not a sum of these lines. It is the ceiling
-- every row resolves, which is a worst case rather than a forecast, and it is the
-- figure the wallet is checked against.

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
  -- Unchanged from the shipped version. Only the explanation below them moves,
  -- so no price a user was shown and charged against has changed.
  if v_mode in ('verify_only', 'verify_refind') then
    v_expected := v_target * v_verify
                + case when v_mode = 'verify_refind'
                       then v_target * v_rate * v_email
                       else 0 end;
    v_max       := v_target * v_verify + v_target * v_email;
    v_min       := v_target * v_verify;
  else
    v_min     := v_target * v_company + v_target * v_person;
    v_max     := v_min + v_target * v_email;
    v_expected := v_min + v_target * v_rate * v_email;
  end if;

  if v_phone then
    v_expected := v_expected + v_target * v_rate * v_phone_credit;
    v_max       := v_max + v_target * v_phone_credit;
  end if;

  -- --- the lines behind those totals --------------------------------------
  -- Built from the same branch. verify_only is verification and nothing else, so
  -- it gets one line. verify_refind gets verification plus the refind it may do.
  -- Everything else looks up the company and the person before any address, so it
  -- gets both of those lines.
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
      jsonb_build_object('label', 'Companies',     'credits', round(v_target * v_company, 6)),
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