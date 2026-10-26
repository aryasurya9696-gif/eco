-- ============================================================================
-- Migration: 20261204_enrichment_social_fixes.sql
-- Description: Review fixes for company/person enrichment and social replies.
--
--   1. social_replies: an 'uncertain' status for a reply whose platform call
--      timed out (it may have been posted). It is charged, and it blocks the
--      post like a sent reply until the user confirms a resend.
--   2. social_oauth_states.code: the callback parks the authorization code
--      here; the signed-in user who started the connection finishes it. A
--      consent URL forwarded to someone else can no longer attach their
--      account to the sender's workspace.
--   3. social_accounts.refreshing_until: a short lease so only one request
--      refreshes an account's tokens at a time (X refresh tokens are single-use).
--   4. user_leads.industry / country_code: kept from search results instead
--      of being dropped on save.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- 1. social_replies.status 'uncertain' -------------------------------------
alter table public.social_replies drop constraint if exists social_replies_status_check;
alter table public.social_replies add constraint social_replies_status_check
  check (status in ('sending', 'sent', 'uncertain', 'failed'));

drop index if exists public.uq_social_replies_live_post;
create unique index uq_social_replies_live_post
  on public.social_replies (post_id) where status in ('sending', 'sent', 'uncertain');

-- 2. social_oauth_states.code ----------------------------------------------
alter table public.social_oauth_states add column if not exists code text;
grant update on public.social_oauth_states to service_role;

-- 3. social_accounts.refreshing_until --------------------------------------
alter table public.social_accounts add column if not exists refreshing_until timestamptz;

-- 4. user_leads.industry / country_code ------------------------------------
alter table public.user_leads add column if not exists industry text;
alter table public.user_leads add column if not exists country_code text;

do $ul_checks$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.user_leads'::regclass and conname = 'user_leads_industry_length') then
    alter table public.user_leads add constraint user_leads_industry_length
      check (industry is null or length(industry) <= 200);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.user_leads'::regclass and conname = 'user_leads_country_code_format') then
    alter table public.user_leads add constraint user_leads_country_code_format
      check (country_code is null or country_code ~ '^[A-Z]{2}$');
  end if;
end
$ul_checks$;
