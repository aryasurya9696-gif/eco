-- ============================================================================
-- Echo — Intent score backfill + profile integrity constraints
-- ----------------------------------------------------------------------------
-- 1. The 35 existing monitored_posts rows were scored by the old client-side
--    heuristic that had a floor of 84. The edge functions now score on a 0-97
--    scale (base 30). Left alone, raising min_intent_threshold would blank the
--    entire feed because old rows all sat at 84+. This re-scores them with the
--    current algorithm.
--
-- 2. enabled_channels could contain 'linkedin' / 'facebook', which no sweep
--    function implements. Those values produced silently empty sweeps, so the
--    column is now constrained to the platforms that actually work.
--
-- 3. min_intent_threshold had no range check; a value like 500 would make every
--    sweep return nothing.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Backfill intent_score with the current algorithm (v2)
-- ---------------------------------------------------------------------------
do $$
declare
  v_high constant text[] := array[
    'looking for','recommend','recommendation','alternative to','switching from',
    'anyone using','best tool for','best software for','pricing','how much does',
    'budget','quote','need software','any suggestions','help choosing','rfp',
    'demo','trial','contract','enterprise plan','migration'
  ];
  v_med  constant text[] := array[
    'tool','software','automation','platform','integration','workflow','alternative','vs','versus'
  ];
  v_neg  constant text[] := array[
    'hiring','job opening','we are looking for candidates','free template',
    'looking to buy followers','crypto giveaway'
  ];
begin
  with scored as (
    select p.id,
      greatest(0, least(97,
        30
        + 9 * (select count(*) from unnest(v_high) x
                where lower(coalesce(p.body,'')) like '%'||x||'%')
        + 3 * (select count(*) from unnest(v_med)  x
                where lower(coalesce(p.body,'')) like '%'||x||'%')
        - 40 * (select count(*) from unnest(v_neg) x
                where lower(coalesce(p.body,'')) like '%'||x||'%')
      )) as score
    from public.monitored_posts p
  )
  update public.monitored_posts mp
  set intent_score = s.score
  from scored s
  where s.id = mp.id
    and mp.intent_score is distinct from s.score;
end $$;

-- ---------------------------------------------------------------------------
-- 2. enabled_channels: only platforms the sweep implements, never empty
-- ---------------------------------------------------------------------------
-- Repair any pre-existing bad values first, otherwise the constraint fails.
update public.profiles
set enabled_channels = array['twitter','reddit','google']
where enabled_channels is null
   or array_length(enabled_channels, 1) is null
   or array_length(enabled_channels, 1) = 0
   or not (enabled_channels <@ array['twitter','reddit','google']::text[]);

alter table public.profiles drop constraint if exists profiles_enabled_channels_supported;
alter table public.profiles
  add constraint profiles_enabled_channels_supported
  check (enabled_channels <@ array['twitter','reddit','google']::text[]);

alter table public.profiles drop constraint if exists profiles_enabled_channels_not_empty;
alter table public.profiles
  add constraint profiles_enabled_channels_not_empty
  check (coalesce(array_length(enabled_channels, 1), 0) >= 1);

-- ---------------------------------------------------------------------------
-- 3. Intent threshold must be a sane percentage
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_min_intent_threshold_range;
alter table public.profiles
  add constraint profiles_min_intent_threshold_range
  check (min_intent_threshold between 0 and 100);