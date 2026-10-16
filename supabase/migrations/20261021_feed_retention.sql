-- ============================================================================
-- Echo — Feed retention and pruning
-- ----------------------------------------------------------------------------
-- The feed used to grow forever: every sweep appended, nothing was ever
-- removed, so a workspace ended up with an unbounded pile of stale mentions.
--
-- This adds:
--   1. profiles.feed_retention_days — how long to keep mentions.
--        0  = keep everything
--        7/14/30/90/365 = delete anything older after each sweep
--   2. public.prune_feed() — deletes only rows that predate the sweep that is
--      currently running, so a sweep can never delete its own results.
--
-- p_keep_after is the timestamp captured at the START of a sweep. Anything
-- written at or after it is part of that batch and is always kept.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Retention setting
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists feed_retention_days integer not null default 30;

alter table public.profiles drop constraint if exists profiles_feed_retention_range;
alter table public.profiles
  add constraint profiles_feed_retention_range
  check (feed_retention_days between 0 and 365);

-- Clients may change this; it is a normal preference.
grant update (feed_retention_days) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Prune function
-- ---------------------------------------------------------------------------
-- A row is removed only when BOTH conditions hold:
--   * it is older than the retention window, AND
--   * it was not written by the sweep currently in flight (p_keep_after).
--
-- These must stay separate. Folding p_keep_after into the cutoff made the
-- retention window meaningless and wiped the entire feed on every sweep.
create or replace function public.prune_feed(
  p_user_id uuid default null,
  p_keep_after timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_days int;
  v_cutoff timestamptz;
  v_deleted int;
begin
  v_uid := coalesce(p_user_id, auth.uid());

  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'unauthenticated');
  end if;

  -- The service role may prune for any account, the owner may prune for
  -- themselves, and a direct superuser session (SQL editor / psql) may do
  -- either. Everything else is rejected.
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user <> 'postgres'
     and auth.uid() is distinct from v_uid then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;

  select feed_retention_days into v_days
  from public.profiles
  where id = v_uid;

  if v_days is null then
    return jsonb_build_object('success', false, 'error', 'profile_not_found');
  end if;

  -- 0 = keep forever.
  if v_days = 0 then
    return jsonb_build_object('success', true, 'deleted', 0, 'retention_days', 0);
  end if;

  v_cutoff := now() - make_interval(days => v_days);

  with gone as (
    delete from public.monitored_posts
    where user_id = v_uid
      and coalesce(posted_at, created_at) < v_cutoff
      and (p_keep_after is null or created_at < p_keep_after)
    returning 1
  )
  select count(*) into v_deleted from gone;

  return jsonb_build_object(
    'success', true,
    'deleted', v_deleted,
    'retention_days', v_days,
    'cutoff', v_cutoff
  );
end;
$$;

-- Callers: the authenticated owner, and the service role (edge functions).
revoke execute on function public.prune_feed(uuid, timestamptz) from public, anon;
grant  execute on function public.prune_feed(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Manual clear — explicit "delete everything in my feed".
--    Separate from prune so the UI can offer both and so the destructive path
--    is obvious in the function name.
-- ---------------------------------------------------------------------------
create or replace function public.clear_feed(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_deleted int;
begin
  v_uid := coalesce(p_user_id, auth.uid());

  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'unauthenticated');
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and session_user <> 'postgres'
     and auth.uid() is distinct from v_uid then
    return jsonb_build_object('success', false, 'error', 'unauthorized');
  end if;

  with gone as (
    delete from public.monitored_posts where user_id = v_uid returning 1
  )
  select count(*) into v_deleted from gone;

  return jsonb_build_object('success', true, 'deleted', v_deleted);
end;
$$;

revoke execute on function public.clear_feed(uuid) from public, anon;
grant  execute on function public.clear_feed(uuid) to authenticated, service_role;