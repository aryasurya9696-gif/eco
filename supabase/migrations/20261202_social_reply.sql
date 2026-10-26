-- ============================================================================
-- Migration: 20261202_social_reply.sql
-- Description: 1-click social replies from the feed, through the user's own
--              X or Reddit account (supabase/functions/social).
--
--   1. social_accounts: one row per connected account. The OAuth tokens live
--      in Supabase Vault; the row holds only the secret id. Owners can read
--      their rows; every write goes through the edge function.
--   2. social_oauth_states: in-flight OAuth handshakes (state + PKCE
--      verifier), service role only, valid for 10 minutes.
--   3. social_replies: every reply sent (or tried). One live reply per post.
--   4. Vault helpers for the tokens (service role only).
--   5. Prices: social.reply.x, social.reply.reddit.
--
-- The platform's post id is read from monitored_posts.post_url when a reply
-- is sent, so the sweep functions and the feed table are unchanged.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. social_accounts
-- ---------------------------------------------------------------------------
create table if not exists public.social_accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  platform          text not null check (platform in ('x', 'reddit')),
  handle            text not null check (length(handle) between 1 and 100),
  external_user_id  text not null check (length(external_user_id) between 1 and 100),
  vault_secret_id   uuid,
  scopes            text[] not null default '{}',
  status            text not null default 'active' check (status in ('active', 'needs_reauth')),
  daily_reply_cap   integer not null default 50 check (daily_reply_cap between 1 and 500),
  last_used_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, platform, external_user_id)
);

create index if not exists idx_social_accounts_user on public.social_accounts (user_id);

alter table public.social_accounts enable row level security;
revoke all on public.social_accounts from public, anon, authenticated;
grant select (id, user_id, platform, handle, status, daily_reply_cap, last_used_at, created_at)
  on public.social_accounts to authenticated;
grant select, insert, update, delete on public.social_accounts to service_role;

drop policy if exists "social_accounts_select_own" on public.social_accounts;
create policy "social_accounts_select_own" on public.social_accounts for select
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 2. social_oauth_states
-- ---------------------------------------------------------------------------
create table if not exists public.social_oauth_states (
  state          text primary key check (length(state) between 32 and 128),
  user_id        uuid not null references auth.users(id) on delete cascade,
  platform       text not null check (platform in ('x', 'reddit')),
  code_verifier  text not null,
  created_at     timestamptz not null default now()
);

alter table public.social_oauth_states enable row level security;
revoke all on public.social_oauth_states from public, anon, authenticated;
grant select, insert, delete on public.social_oauth_states to service_role;

-- ---------------------------------------------------------------------------
-- 3. social_replies
-- ---------------------------------------------------------------------------
create table if not exists public.social_replies (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  post_id            uuid references public.monitored_posts(id) on delete set null,
  account_id         uuid references public.social_accounts(id) on delete set null,
  platform           text not null check (platform in ('x', 'reddit')),
  body               text not null check (length(body) between 1 and 10000),
  external_reply_id  text,
  reply_url          text,
  status             text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  error_code         text,
  credits_charged    numeric(12, 6) not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One live reply per post: a second click while the first is in flight, or
-- after it went out, is refused by the database. A failed one can be retried.
create unique index if not exists uq_social_replies_live_post
  on public.social_replies (post_id) where status in ('sending', 'sent');
create index if not exists idx_social_replies_user on public.social_replies (user_id, created_at desc);
create index if not exists idx_social_replies_account on public.social_replies (account_id);

alter table public.social_replies enable row level security;
revoke all on public.social_replies from public, anon, authenticated;
grant select on public.social_replies to authenticated;
grant select, insert, update, delete on public.social_replies to service_role;

drop policy if exists "social_replies_select_own" on public.social_replies;
create policy "social_replies_select_own" on public.social_replies for select
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 4. Vault helpers for OAuth tokens (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.store_social_secret(p_secret text, p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $fn$
begin
  return vault.create_secret(p_secret, p_name, 'Echo social account OAuth tokens');
end;
$fn$;

create or replace function public.get_social_secret(p_secret_id uuid)
returns text
language sql
security definer
set search_path = public, vault
as $fn$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$fn$;

-- Refreshed tokens replace the old ones in place, so the row's secret id stays valid.
create or replace function public.update_social_secret(p_secret_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $fn$
begin
  perform vault.update_secret(p_secret_id, p_secret);
end;
$fn$;

create or replace function public.delete_social_secret(p_secret_id uuid)
returns void
language sql
security definer
set search_path = public, vault
as $fn$
  delete from vault.secrets where id = p_secret_id;
$fn$;

-- A disconnected account takes its tokens with it, whichever path deleted it.
create or replace function public.social_accounts_drop_secret()
returns trigger
language plpgsql
security definer
set search_path = public, vault
as $fn$
begin
  if old.vault_secret_id is not null then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return old;
end;
$fn$;

drop trigger if exists trg_social_accounts_drop_secret on public.social_accounts;
create trigger trg_social_accounts_drop_secret
  after delete on public.social_accounts
  for each row execute function public.social_accounts_drop_secret();

revoke all on function public.store_social_secret(text, text)    from public, anon, authenticated;
revoke all on function public.get_social_secret(uuid)            from public, anon, authenticated;
revoke all on function public.update_social_secret(uuid, text)   from public, anon, authenticated;
revoke all on function public.delete_social_secret(uuid)         from public, anon, authenticated;
revoke all on function public.social_accounts_drop_secret()      from public, anon, authenticated;
grant execute on function public.store_social_secret(text, text)  to service_role;
grant execute on function public.get_social_secret(uuid)          to service_role;
grant execute on function public.update_social_secret(uuid, text) to service_role;
grant execute on function public.delete_social_secret(uuid)       to service_role;

-- ---------------------------------------------------------------------------
-- 5. Prices, seeded once
-- ---------------------------------------------------------------------------
do $social_pricing$
begin
  insert into public.data_migrations (name) values ('20261202_social_pricing')
    on conflict (name) do nothing;
  if not found then
    return;
  end if;

  perform set_config('echo.changed_by', 'migration:20261202_social_reply', true);
  perform set_config('echo.change_reason', 'social reply launch', true);

  -- X bills the app owner $0.015 per post ($0.20 with a URL, which the
  -- function refuses). Reddit's API has no per-call price; the 0.1 credit
  -- keeps replies deliberate.
  insert into public.pricing_config (
      operation, display_name, provider_endpoint, provider_cost_usd,
      cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
  )
  values
      ('social.reply.x', 'Reply on X', 'POST api.x.com/2/tweets', 0.01500000,
       false, 'rate_card', 1.000000, true, 1, now(), now()),
      ('social.reply.reddit', 'Reply on Reddit', 'POST oauth.reddit.com/api/comment', 0.00000000,
       false, 'rate_card', 0.100000, true, 1, now(), now())
  on conflict (operation) do nothing;
end
$social_pricing$;
