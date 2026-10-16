-- ============================================================================
-- Echo — Complete Multi-Platform Production Schema
-- Supports X, LinkedIn, Reddit, Facebook, Google Discussions
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- profiles
-- One row per user. Auto-created on signup via trigger below.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                     uuid primary key references auth.users(id) on delete cascade,
  full_name              text,
  website                text,
  core_offer             text,
  onboarding_completed   boolean not null default false,
  onboarding_step        smallint not null default 0,
  email_digest           boolean not null default true,
  slack_webhook          text,
  lookback_hours         int not null default 24,
  sweep_time_utc         text not null default '06:00',
  sweep_frequency        text not null default '24h',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- auto-create a profile row whenever a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- keywords
-- Up to 10 active rows per user, enforced server-side.
-- ---------------------------------------------------------------------------
create table if not exists public.keywords (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  keyword     text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (user_id, keyword)
);

create index if not exists idx_keywords_user on public.keywords(user_id) where is_active;

alter table public.keywords enable row level security;

create policy "keywords_select_own"
  on public.keywords for select
  using (auth.uid() = user_id);

create policy "keywords_insert_own"
  on public.keywords for insert
  with check (auth.uid() = user_id);

create policy "keywords_update_own"
  on public.keywords for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "keywords_delete_own"
  on public.keywords for delete
  using (auth.uid() = user_id);

-- hard cap of 10 active keywords per user
create or replace function public.enforce_keyword_limit()
returns trigger
language plpgsql
as $$
declare
  active_count int;
begin
  if new.is_active then
    select count(*) into active_count
    from public.keywords
    where user_id = new.user_id
      and is_active = true
      and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

    if active_count >= 10 then
      raise exception 'Keyword limit reached: a user may have at most 10 active keywords';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_keyword_limit on public.keywords;
create trigger trg_keyword_limit
  before insert or update on public.keywords
  for each row execute function public.enforce_keyword_limit();

-- ---------------------------------------------------------------------------
-- monitored_posts
-- Written by Edge Function (service role) or user sweep.
-- ---------------------------------------------------------------------------
create table if not exists public.monitored_posts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  keyword_id        uuid references public.keywords(id) on delete set null,
  matched_keyword   text not null,
  platform          text not null check (platform in ('twitter', 'linkedin', 'reddit', 'facebook', 'google')),
  channel_source    text,
  post_url          text not null,
  author_name       text,
  author_handle     text,
  author_avatar_url text,
  body              text,
  posted_at         timestamptz,
  intent_score      int default 85,
  status            text default 'new' check (status in ('new', 'saved', 'contacted', 'dismissed')),
  engagement        jsonb,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  unique (user_id, post_url)
);

create index if not exists idx_monitored_posts_user_created
  on public.monitored_posts(user_id, created_at desc);

create index if not exists idx_monitored_posts_user_platform
  on public.monitored_posts(user_id, platform);

alter table public.monitored_posts enable row level security;

create policy "monitored_posts_select_own"
  on public.monitored_posts for select
  using (auth.uid() = user_id);

create policy "monitored_posts_insert_own"
  on public.monitored_posts for insert
  with check (auth.uid() = user_id);

create policy "monitored_posts_update_own"
  on public.monitored_posts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "monitored_posts_delete_own"
  on public.monitored_posts for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- sweep_runs
-- Audit log for automated runs.
-- ---------------------------------------------------------------------------
create table if not exists public.sweep_runs (
  id               uuid primary key default gen_random_uuid(),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  users_processed  int not null default 0,
  posts_inserted   int not null default 0,
  errors           jsonb not null default '[]'::jsonb
);

alter table public.sweep_runs enable row level security;
