-- ============================================================================
-- Echo — SocialFetch integration fixes
-- ----------------------------------------------------------------------------
-- Found while reading the SocialFetch OpenAPI spec (api.socialfetch.dev):
--
--   1. /v1/twitter/search      has NO date filter. Passing `timeframe` was
--                              silently ignored, so `section=top` returned
--                              all-time top posts — including a tweet from
--                              2021. `section=latest` is the correct param.
--   2. /v1/web/search         takes `datePosted` (last-hour … last-year), not
--                              `timeframe`, and paginates with `page` (1-based
--                              integer), not a cursor.
--   3. /v1/linkedin/posts/search takes `datePosted` + `cursor`. It does NOT
--                              accept `timeframe`, `startDate` or `endDate`.
--   4. /v1/web/search results carry NO date field at all — only
--                              title/url/content. The edge function was
--                              stamping them with `now()`, which made every web
--                              result look like it was found today.
--
-- This migration enables LinkedIn as a channel, stores the vendor key where
-- the browser can never reach it, and indexes the feed's sort key.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. LinkedIn as a first-class channel
-- ---------------------------------------------------------------------------
alter table public.profiles
  drop constraint if exists profiles_enabled_channels_supported;

alter table public.profiles
  add constraint profiles_enabled_channels_supported
  check (enabled_channels <@ array['twitter', 'reddit', 'google', 'linkedin']);

-- The previous constraint was strictly tighter than this one, so no existing
-- row can violate it and no backfill is needed.

-- ---------------------------------------------------------------------------
-- 2. Vendor keys, stored server-side only
-- ---------------------------------------------------------------------------
-- Supabase Edge Function secrets are the right home for the SocialFetch key,
-- but there is no way to set them from inside the app. This table is the
-- fallback: RLS is ON and NO policies are created, so the anon and
-- authenticated roles have no SELECT path at all. Only the service role,
-- which bypasses RLS, can read it — same trust boundary as an edge secret.
--
-- The edge functions still prefer Deno.env first; this is only consulted when
-- SOCIALFETCH_API_KEY is not set as an edge secret.
create table if not exists public.service_secrets (
  name       text primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

alter table public.service_secrets enable row level security;

revoke all on table public.service_secrets from anon, authenticated;
revoke all on table public.service_secrets from public;
grant select on table public.service_secrets to service_role;

-- ---------------------------------------------------------------------------
-- 3. Feed indexes
-- ---------------------------------------------------------------------------
-- loadPosts() orders by posted_at desc; web-search rows have a NULL posted_at
-- and must sort last rather than first, so created_at is the tiebreaker.
create index if not exists monitored_posts_user_posted_at_idx
  on public.monitored_posts (user_id, posted_at desc nulls last, created_at desc);

-- Retention scans the same key.
create index if not exists monitored_posts_user_created_at_idx
  on public.monitored_posts (user_id, created_at);