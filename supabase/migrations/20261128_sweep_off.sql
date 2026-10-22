-- =============================================================================
-- 20261128: automatic sweeps can be turned off
-- -----------------------------------------------------------------------------
-- profiles.sweep_frequency gains 'off'. daily-sweep never treats an 'off'
-- workspace as due (sweep-rules.ts isProfileDue); manual sweeps still work.
--
-- The column had no constraint at all, so a client could store any string
-- (it is in the authenticated UPDATE grant). Unknown values are normalised to
-- the column default first, then the allowed set is enforced.
-- Idempotent.
-- =============================================================================

update public.profiles
   set sweep_frequency = '24h'
 where sweep_frequency is null
    or sweep_frequency not in ('24h', '12h', '6h', 'off');

alter table public.profiles drop constraint if exists profiles_sweep_frequency_check;
alter table public.profiles
  add constraint profiles_sweep_frequency_check
  check (sweep_frequency in ('24h', '12h', '6h', 'off'));

comment on column public.profiles.sweep_frequency is
  'Automatic sweep cadence: 24h, 12h, 6h, or off (manual sweeps only).';
