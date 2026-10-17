-- ============================================================================
-- Welcome credits
-- ----------------------------------------------------------------------------
-- A new workspace starts with 20 credits.
--
-- This exists because the alternative was worse than useless: with prepaid
-- credits and no trial, a fresh signup had a balance of zero and could not run a
-- single search. Nothing to evaluate, nothing to show anyone, no reason to stay.
--
-- It is a one-time grant, not a trial and not an allowance. There is no recurring
-- version of this and no renewal path; after the 20 credits are spent the
-- workspace tops up or stops searching. Nothing here can be turned back into a
-- subscription by editing a row.
--
-- The grant is issued at unit price 0, which is the whole point of
-- credit_grants being separate rows rather than one balance. Recognising $0.05 of
-- revenue for credits that were given away is exactly the mistake that structure
-- exists to prevent, and there is a test for it.
--
-- Cost to serve: 20 credits is at most 10 Reddit calls, about $0.01 of provider
-- spend. Cheap enough that a signup which never converts costs almost nothing,
-- and large enough that one search actually works.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Signup grants the welcome credits
--
-- Folds into the existing handle_new_user trigger rather than adding a second
-- one on auth.users. Two triggers on the same table for the same purpose is how
-- you end up debugging why some accounts have twenty credits and some have
-- forty.
--
-- The idempotency key is derived from the user id, so a re-fired trigger grants
-- once and the second attempt returns the duplicate rather than doubling the
-- balance.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profiles (id) values (new.id)
    on conflict (id) do nothing;

  insert into public.wallet (user_id) values (new.id)
    on conflict (user_id) do nothing;

  -- Unit price 0: these credits were not paid for, so spending them must not
  -- book revenue. See the header note.
  perform public.wallet_apply_grant(
    p_user_id         => new.id,
    p_credits         => 20,
    p_source          => 'grant',
    p_unit_price_usd  => 0,
    p_payment_order_id => null,
    p_idempotency_key => 'welcome:' || new.id::text,
    p_expires_at      => null,
    p_metadata        => jsonb_build_object('reason', 'welcome credits')
  );

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Existing workspaces that predate this
--
-- Only those with nothing at all. A workspace that has already paid for credits,
-- or already spent the twenty it would have been given, is left exactly as it
-- is — retroactively topping everyone up would mean giving the same thing twice
-- to anyone who happened to subscribe in between.
--
-- Routed through wallet_apply_grant rather than inserting rows by hand, so the
-- wallet totals, the grant and the ledger entry are produced by the one code
-- path that is tested to keep them consistent. Writing the three tables
-- separately is how a balance ends up disagreeing with its own history.
-- ---------------------------------------------------------------------------
insert into public.wallet (user_id)
select id from auth.users
on conflict (user_id) do nothing;

do $backfill$
declare
  v_user uuid;
begin
  for v_user in
    select u.id
      from auth.users u
     where not exists (select 1 from public.credit_grants g where g.user_id = u.id)
       and coalesce((select balance from public.wallet w where w.user_id = u.id), 0) = 0
  loop
    perform public.wallet_apply_grant(
      p_user_id         => v_user,
      p_credits         => 20,
      p_source          => 'grant',
      p_unit_price_usd  => 0,
      p_payment_order_id => null,
      p_idempotency_key => 'welcome:' || v_user::text,
      p_expires_at      => null,
      p_metadata        => jsonb_build_object('reason', 'welcome credits (backfill)')
    );
  end loop;
end;
$backfill$;

-- ---------------------------------------------------------------------------
-- The grant is a plain function call, so make sure the trigger can make it.
-- handle_new_user is SECURITY DEFINER, which is what lets it reach a function
-- that is revoked from anon and authenticated.
-- ---------------------------------------------------------------------------
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant  execute on function public.handle_new_user() to service_role;