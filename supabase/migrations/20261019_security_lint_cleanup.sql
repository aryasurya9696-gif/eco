-- ============================================================================
-- Echo — Security lint cleanup
-- ----------------------------------------------------------------------------
-- Driven by `get_advisors` after echo_security_hardening +
-- echo_remove_credits_system were applied to fteoyqhogzuapfdledeg.
--
-- Fixes:
--   1. Trigger functions were SECURITY DEFINER *and* executable by anon /
--      authenticated over /rest/v1/rpc/. They only make sense as trigger
--      bodies, so EXECUTE is revoked from client roles. Triggers still fire.
--   2. set_updated_at had no pinned search_path.
--   3. RLS policies called auth.uid() directly, so Postgres re-evaluated it
--      per row. Wrapping it in (select auth.uid()) initialises it once per
--      query (auth_rls_initplan).
--   4. sweep_runs had RLS on with no policy at all; now an explicit
--      deny-by-default policy.
--   5. monitored_posts.keyword_id FK had no index.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Trigger functions are not RPCs
-- ---------------------------------------------------------------------------
revoke execute on function public.enforce_keyword_limit()      from public, anon, authenticated;
revoke execute on function public.guard_profile_server_columns() from public, anon, authenticated;
revoke execute on function public.guard_profile_webhook()      from public, anon, authenticated;
revoke execute on function public.handle_new_user()             from public, anon, authenticated;
revoke execute on function public.set_updated_at()              from public, anon, authenticated;

grant execute on function public.enforce_keyword_limit()       to service_role;
grant execute on function public.guard_profile_server_columns() to service_role;
grant execute on function public.guard_profile_webhook()       to service_role;
grant execute on function public.handle_new_user()              to service_role;
grant execute on function public.set_updated_at()               to service_role;

-- plan_keyword_limit is only called from inside enforce_keyword_limit, which
-- runs as the owner, so EXECUTE is unaffected. Clients read the limit from
-- src/lib/billing.ts instead.
revoke execute on function public.plan_keyword_limit(uuid) from public, anon, authenticated;
grant  execute on function public.plan_keyword_limit(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Pin search_path
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. RLS policies: (select auth.uid()) instead of auth.uid()
-- ---------------------------------------------------------------------------
drop policy if exists "profiles_select_own"  on public.profiles;
drop policy if exists "profiles_insert_own"  on public.profiles;
drop policy if exists "profiles_update_own"  on public.profiles;
create policy "profiles_select_own" on public.profiles for select
  using ((select auth.uid()) = id);
create policy "profiles_insert_own" on public.profiles for insert
  with check ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles for update
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "keywords_select_own" on public.keywords;
drop policy if exists "keywords_insert_own" on public.keywords;
drop policy if exists "keywords_update_own" on public.keywords;
drop policy if exists "keywords_delete_own" on public.keywords;
create policy "keywords_select_own" on public.keywords for select
  using ((select auth.uid()) = user_id);
create policy "keywords_insert_own" on public.keywords for insert
  with check ((select auth.uid()) = user_id);
create policy "keywords_update_own" on public.keywords for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "keywords_delete_own" on public.keywords for delete
  using ((select auth.uid()) = user_id);

drop policy if exists "monitored_posts_select_own" on public.monitored_posts;
drop policy if exists "monitored_posts_insert_own" on public.monitored_posts;
drop policy if exists "monitored_posts_update_own" on public.monitored_posts;
drop policy if exists "monitored_posts_delete_own" on public.monitored_posts;
create policy "monitored_posts_select_own" on public.monitored_posts for select
  using ((select auth.uid()) = user_id);
create policy "monitored_posts_insert_own" on public.monitored_posts for insert
  with check ((select auth.uid()) = user_id);
create policy "monitored_posts_update_own" on public.monitored_posts for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "monitored_posts_delete_own" on public.monitored_posts for delete
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 4. sweep_runs: explicit deny-by-default (service role bypasses RLS)
-- ---------------------------------------------------------------------------
drop policy if exists "sweep_runs_service_only" on public.sweep_runs;
create policy "sweep_runs_service_only" on public.sweep_runs for all
  using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 5. Index the monitored_posts.keyword_id foreign key
-- ---------------------------------------------------------------------------
create index if not exists idx_monitored_posts_keyword_id
  on public.monitored_posts(keyword_id);