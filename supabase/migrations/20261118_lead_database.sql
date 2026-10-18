-- ============================================================================
-- Echo Leads: a lead database, not a pile of run results
-- ----------------------------------------------------------------------------
-- Until now every lead lived on the run that found it. The same person found by
-- two runs was two rows; nothing could be tagged, noted, listed or qualified;
-- and there was nowhere for "enrich these five again" to write its answer.
--
-- This adds the records a sales workflow is built on:
--
--   lead_companies      one per workspace and domain
--   lead_contacts       one per workspace and person, merged from run rows by
--                       email, then LinkedIn URL, then name + domain
--   lead_lists          people or company lists, with lead_list_members
--   lead_saved_searches saved filter sets for the search and the database views
--   lead_search_log     what was searched, for history
--   lead_scoring        the workspace's scoring rules
--
-- Runs are unchanged: a run still owns its rows, its receipt and its charges.
-- When a row finishes, lead_contact_upsert_from_row merges it into the contact
-- and company it belongs to. The merge never overwrites a value with null and
-- never replaces a checked address with an unchecked one.
--
-- Same tenancy as every other lead_* table: user_id on every row, RLS select-own,
-- no client write policies - all writes go through the leads function.
--
-- Email statuses gain two values:
--   unchecked   an address nothing has verified (imports, unverified finds).
--               Previously stored as 'unknown', which also meant "a verifier
--               tried and could not tell" - two different claims in one word.
--   disposable  a throwaway mailbox, which verifiers report separately
-- ============================================================================

-- ---------------------------------------------------------------------------
-- lead_rows: the new statuses, freshness, and a re-check generation
-- ---------------------------------------------------------------------------
alter table public.lead_rows
  drop constraint if exists lead_rows_email_status_check;
alter table public.lead_rows
  add constraint lead_rows_email_status_check
  check (email_status in ('verified', 'catch_all', 'invalid', 'unknown', 'not_found', 'unchecked', 'disposable'));

alter table public.lead_rows
  add column if not exists email_checked_at timestamptz,
  add column if not exists email_verifier   text,
  -- Part of every provider idempotency key, so a deliberate re-check is a new
  -- call rather than a replay of the old answer.
  add column if not exists generation       integer not null default 0;

-- Imported addresses that nothing has ever verified were stored as 'unknown'.
-- A row with no verify attempt at all was not checked; say so.
update public.lead_rows r
   set email_status = 'unchecked'
 where r.email_status = 'unknown'
   and not exists (
     select 1 from public.lead_attempts a where a.row_id = r.id and a.step = 'verify'
   );

-- ---------------------------------------------------------------------------
-- Normalisation used for matching
-- ---------------------------------------------------------------------------
create or replace function public.lead_norm_email(p text)
returns text language sql immutable as $$
  select nullif(lower(trim(p)), '');
$$;

create or replace function public.lead_norm_linkedin(p text)
returns text language sql immutable as $$
  -- https://www.linkedin.com/in/Jane-Doe/?x=1 -> in/jane-doe. Anything that is
  -- not a personal profile URL does not identify a person and is null.
  select nullif(substring(lower(trim(coalesce(p, ''))) from 'linkedin.com/(in/[^/?#]+)'), '');
$$;

create or replace function public.lead_norm_name(p text)
returns text language sql immutable as $$
  select nullif(regexp_replace(lower(trim(coalesce(p, ''))), '\s+', ' ', 'g'), '');
$$;

create or replace function public.lead_norm_domain(p text)
returns text language sql immutable as $$
  -- Idempotent: normalising a normalised value changes nothing, which the check
  -- constraint on lead_companies.domain relies on. All whitespace, any number of
  -- leading "www.", and any port or path are dropped.
  select nullif(
    regexp_replace(
      regexp_replace(lower(regexp_replace(coalesce(p, ''), '\s+', '', 'g')), '^(https?://)?(www\.)*', ''),
      '[/?#:].*$', ''
    ),
    ''
  );
$$;

-- ---------------------------------------------------------------------------
-- lead_companies
-- ---------------------------------------------------------------------------
create table if not exists public.lead_companies (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  domain       text not null,
  name         text,
  logo_url     text,
  -- Provider-reported firmographics, normalised by endpoints.ts. `source` names
  -- the endpoint; `enriched_at` is when it was fetched.
  data         jsonb not null default '{}'::jsonb,
  enriched_at  timestamptz,
  tags         text[] not null default '{}',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint lead_companies_domain_norm check (domain = public.lead_norm_domain(domain)),
  constraint lead_companies_user_domain_key unique (user_id, domain)
);

-- ---------------------------------------------------------------------------
-- lead_contacts
-- ---------------------------------------------------------------------------
create table if not exists public.lead_contacts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  company_id       uuid references public.lead_companies (id) on delete set null,

  person_name      text,
  title            text,
  linkedin_url     text,
  location         text,
  company_name     text,
  domain           text,

  email            text,
  email_status     text not null default 'not_found',
  email_checked_at timestamptz,
  email_verifier   text,
  email_provider   text,

  phone            text,
  phone_provider   text,

  -- Matching keys, kept in step with the fields above by the upsert.
  email_norm       text,
  linkedin_norm    text,
  name_norm        text,

  -- Provider attributes that are not columns: seniority, department, the
  -- LeadsForge id, the company snapshot a search returned. Never user input.
  attributes       jsonb not null default '{}'::jsonb,

  -- The user's own fields.
  tags             text[] not null default '{}',
  notes            text,
  status           text not null default 'new',
  custom           jsonb not null default '{}'::jsonb,

  score            integer,
  score_label      text,
  score_reasons    jsonb not null default '[]'::jsonb,
  scored_at        timestamptz,

  source           text not null default 'run',
  last_run_id      uuid references public.lead_runs (id) on delete set null,
  last_row_id      uuid references public.lead_rows (id) on delete set null,
  last_enriched_at timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint lead_contacts_email_status_check
    check (email_status in ('verified', 'catch_all', 'invalid', 'unknown', 'not_found', 'unchecked', 'disposable')),
  constraint lead_contacts_email_implies_address
    check (email_status = 'not_found' or email is not null),
  constraint lead_contacts_status_check
    check (status in ('new', 'qualified', 'contacted', 'nurture', 'disqualified')),
  constraint lead_contacts_score_range check (score is null or (score between 0 and 100)),
  constraint lead_contacts_source_check check (source in ('run', 'search', 'import')),
  constraint lead_contacts_identity
    check (email_norm is not null or linkedin_norm is not null or (name_norm is not null and domain is not null))
);

create index if not exists lead_contacts_user_updated_idx on public.lead_contacts (user_id, updated_at desc, id);
create index if not exists lead_contacts_user_email_idx   on public.lead_contacts (user_id, email_norm) where email_norm is not null;
create index if not exists lead_contacts_user_li_idx      on public.lead_contacts (user_id, linkedin_norm) where linkedin_norm is not null;
create index if not exists lead_contacts_user_name_idx    on public.lead_contacts (user_id, name_norm, domain) where name_norm is not null;
create index if not exists lead_contacts_user_domain_idx  on public.lead_contacts (user_id, domain);
create index if not exists lead_contacts_user_score_idx   on public.lead_contacts (user_id, score desc nulls last);
create index if not exists lead_contacts_company_idx      on public.lead_contacts (company_id);
create index if not exists lead_contacts_tags_idx         on public.lead_contacts using gin (tags);

-- ---------------------------------------------------------------------------
-- Lists
-- ---------------------------------------------------------------------------
create table if not exists public.lead_lists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  kind        text not null default 'people',
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lead_lists_kind_check check (kind in ('people', 'companies')),
  constraint lead_lists_name_len check (char_length(trim(name)) between 1 and 80),
  constraint lead_lists_user_name_key unique (user_id, kind, name)
);

create table if not exists public.lead_list_members (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  list_id     uuid not null references public.lead_lists (id) on delete cascade,
  contact_id  uuid references public.lead_contacts (id) on delete cascade,
  company_id  uuid references public.lead_companies (id) on delete cascade,
  added_at    timestamptz not null default now(),
  constraint lead_list_members_one_target check ((contact_id is null) <> (company_id is null))
);

create unique index if not exists lead_list_members_contact_key on public.lead_list_members (list_id, contact_id) where contact_id is not null;
create unique index if not exists lead_list_members_company_key on public.lead_list_members (list_id, company_id) where company_id is not null;
create index if not exists lead_list_members_contact_idx on public.lead_list_members (contact_id);
create index if not exists lead_list_members_company_idx on public.lead_list_members (company_id);

-- ---------------------------------------------------------------------------
-- Saved searches, search history, scoring
-- ---------------------------------------------------------------------------
create table if not exists public.lead_saved_searches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  -- people_search: provider filters. people_view / companies_view: database filters.
  kind        text not null,
  filters     jsonb not null default '{}'::jsonb,
  last_total  integer,
  last_run_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lead_saved_searches_kind_check check (kind in ('people_search', 'people_view', 'companies_view')),
  constraint lead_saved_searches_name_len check (char_length(trim(name)) between 1 and 80),
  constraint lead_saved_searches_user_name_key unique (user_id, kind, name)
);

create table if not exists public.lead_search_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  filters     jsonb not null,
  total       integer,
  created_at  timestamptz not null default now()
);
create index if not exists lead_search_log_user_idx on public.lead_search_log (user_id, created_at desc);

create table if not exists public.lead_scoring (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  rules       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: select-own, no client writes
-- ---------------------------------------------------------------------------
alter table public.lead_companies      enable row level security;
alter table public.lead_contacts       enable row level security;
alter table public.lead_lists          enable row level security;
alter table public.lead_list_members   enable row level security;
alter table public.lead_saved_searches enable row level security;
alter table public.lead_search_log     enable row level security;
alter table public.lead_scoring        enable row level security;

do $$
declare t text;
begin
  foreach t in array array['lead_companies', 'lead_contacts', 'lead_lists', 'lead_list_members',
                           'lead_saved_searches', 'lead_search_log', 'lead_scoring']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_select_own', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_company_upsert: one company per workspace and domain
-- ---------------------------------------------------------------------------
create or replace function public.lead_company_upsert(
  p_user uuid, p_domain text, p_name text, p_logo text, p_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_domain text := public.lead_norm_domain(p_domain);
  v_id uuid;
  v_has_data boolean := p_data is not null and p_data <> '{}'::jsonb;
  v_at timestamptz := nullif(p_data ->> 'enriched_at', '')::timestamptz;
begin
  if v_domain is null then
    return null;
  end if;

  insert into public.lead_companies (user_id, domain, name, logo_url, data, enriched_at)
  values (p_user, v_domain, nullif(trim(p_name), ''), nullif(trim(p_logo), ''),
          case when v_has_data then p_data else '{}'::jsonb end,
          case when v_has_data then coalesce(v_at, now()) end)
  on conflict (user_id, domain) do update
     set name     = coalesce(public.lead_companies.name, excluded.name),
         logo_url = coalesce(public.lead_companies.logo_url, excluded.logo_url),
         -- Newer provider data replaces older; nothing replaces data with nothing.
         data = case
                  when v_has_data and (public.lead_companies.enriched_at is null
                                       or excluded.enriched_at >= public.lead_companies.enriched_at)
                    then public.lead_companies.data || p_data
                  else public.lead_companies.data
                end,
         enriched_at = case
                  when v_has_data and (public.lead_companies.enriched_at is null
                                       or excluded.enriched_at >= public.lead_companies.enriched_at)
                    then excluded.enriched_at
                  else public.lead_companies.enriched_at
                end,
         updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_contact_merge: fold one set of person fields into the workspace's record
-- ---------------------------------------------------------------------------
-- Matching order: an explicit contact id (a run made from saved contacts), then
-- email, then LinkedIn URL, then name + domain. Returns the contact as jsonb with
-- its company's data, so the caller can score it without a second read.
create or replace function public.lead_contact_merge(p_user uuid, p_fields jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := public.lead_norm_email(p_fields ->> 'email');
  v_li      text := public.lead_norm_linkedin(p_fields ->> 'linkedin_url');
  v_name    text := public.lead_norm_name(p_fields ->> 'person_name');
  v_domain  text := public.lead_norm_domain(p_fields ->> 'domain');
  v_status  text := coalesce(nullif(p_fields ->> 'email_status', ''), 'not_found');
  v_checked timestamptz := nullif(p_fields ->> 'email_checked_at', '')::timestamptz;
  -- Only a real uuid is a hint. extra can carry a CSV's own "contact_id" column,
  -- and casting "12345" would fail the merge (and the backfill with it).
  v_hint    uuid := case
                      when p_fields ->> 'contact_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        then (p_fields ->> 'contact_id')::uuid
                    end;
  v_company uuid;
  v_id      uuid;
  c         public.lead_contacts;
  v_take_email boolean;
begin
  if v_email is null and v_li is null and (v_name is null or v_domain is null) then
    return null; -- nothing that identifies a person
  end if;

  v_company := public.lead_company_upsert(p_user, v_domain, p_fields ->> 'company_name', p_fields ->> 'logo_url',
                                          coalesce(p_fields -> 'company_data', '{}'::jsonb));

  if v_hint is not null then
    select * into c from public.lead_contacts where id = v_hint and user_id = p_user;
  end if;
  if c.id is null and v_email is not null then
    select * into c from public.lead_contacts where user_id = p_user and email_norm = v_email
      order by created_at limit 1;
  end if;
  if c.id is null and v_li is not null then
    select * into c from public.lead_contacts where user_id = p_user and linkedin_norm = v_li
      order by created_at limit 1;
  end if;
  if c.id is null and v_name is not null and v_domain is not null then
    select * into c from public.lead_contacts where user_id = p_user and name_norm = v_name and domain = v_domain
      order by created_at limit 1;
  end if;

  if c.id is null then
    insert into public.lead_contacts (
      user_id, company_id, person_name, title, linkedin_url, location, company_name, domain,
      email, email_status, email_checked_at, email_verifier, email_provider, phone, phone_provider,
      email_norm, linkedin_norm, name_norm, attributes, source, last_run_id, last_row_id, last_enriched_at
    ) values (
      p_user, v_company, nullif(p_fields ->> 'person_name', ''), nullif(p_fields ->> 'title', ''), nullif(p_fields ->> 'linkedin_url', ''),
      nullif(p_fields ->> 'location', ''), nullif(p_fields ->> 'company_name', ''), v_domain,
      case when v_email is not null then v_email end,
      case when v_email is not null then v_status else 'not_found' end,
      v_checked, nullif(p_fields ->> 'email_verifier', ''), nullif(p_fields ->> 'email_provider', ''),
      nullif(p_fields ->> 'phone', ''), nullif(p_fields ->> 'phone_provider', ''),
      v_email, v_li, v_name, coalesce(p_fields -> 'attributes', '{}'::jsonb),
      coalesce(nullif(p_fields ->> 'source', ''), 'run'),
      nullif(p_fields ->> 'run_id', '')::uuid, nullif(p_fields ->> 'row_id', '')::uuid,
      case when v_checked is not null or p_fields ? 'company_data' then now() end
    )
    returning id into v_id;
  else
    -- Take the incoming address when:
    --   none is held;
    --   it is the same address with a newer check, i.e. a fresher verdict on it;
    --   it is a different address a verifier accepted, replacing one that failed
    --   or was never confirmed (or a verified one checked longer ago).
    -- Never: an unchecked copy of the same address over a known verdict - a
    -- phone run carries the address unchecked and must not clear "invalid" - and
    -- never a rejected or unchecked address over a different one.
    v_take_email := v_email is not null and (
         c.email_norm is null
      or (v_email = c.email_norm and v_checked is not null
          and (c.email_checked_at is null or v_checked > c.email_checked_at))
      or (v_email <> c.email_norm and v_status in ('verified', 'catch_all')
          and (c.email_status not in ('verified', 'catch_all')
               or (v_status = 'verified' and v_checked is not null
                   and (c.email_checked_at is null or v_checked > c.email_checked_at))))
    );

    update public.lead_contacts set
      company_id     = coalesce(v_company, company_id),
      person_name    = coalesce(person_name, nullif(p_fields ->> 'person_name', '')),
      title          = coalesce(nullif(p_fields ->> 'title', ''), title),
      linkedin_url   = coalesce(linkedin_url, nullif(p_fields ->> 'linkedin_url', '')),
      linkedin_norm  = coalesce(linkedin_norm, v_li),
      location       = coalesce(nullif(p_fields ->> 'location', ''), location),
      company_name   = coalesce(company_name, nullif(p_fields ->> 'company_name', '')),
      domain         = coalesce(domain, v_domain),
      name_norm      = coalesce(name_norm, v_name),
      email          = case when v_take_email then v_email else email end,
      email_norm     = case when v_take_email then v_email else email_norm end,
      email_status   = case when v_take_email then v_status else email_status end,
      email_checked_at = case when v_take_email then v_checked else email_checked_at end,
      email_verifier = case when v_take_email then nullif(p_fields ->> 'email_verifier', '') else email_verifier end,
      email_provider = case when v_take_email then coalesce(nullif(p_fields ->> 'email_provider', ''), email_provider) else email_provider end,
      phone          = coalesce(nullif(p_fields ->> 'phone', ''), phone),
      phone_provider = case when nullif(p_fields ->> 'phone', '') is not null then nullif(p_fields ->> 'phone_provider', '') else phone_provider end,
      attributes     = attributes || coalesce(p_fields -> 'attributes', '{}'::jsonb),
      last_run_id    = coalesce(nullif(p_fields ->> 'run_id', '')::uuid, last_run_id),
      last_row_id    = coalesce(nullif(p_fields ->> 'row_id', '')::uuid, last_row_id),
      last_enriched_at = case when v_checked is not null or p_fields ? 'company_data' then now() else last_enriched_at end,
      updated_at     = now()
    where id = c.id
    returning id into v_id;
  end if;

  return (
    select to_jsonb(ct) || jsonb_build_object('company', coalesce(to_jsonb(co.data), '{}'::jsonb))
    from public.lead_contacts ct
    left join public.lead_companies co on co.id = ct.company_id
    where ct.id = v_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_contact_upsert_from_row: what the worker calls when a row finishes
-- ---------------------------------------------------------------------------
create or replace function public.lead_contact_upsert_from_row(p_row_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.lead_rows;
begin
  select * into r from public.lead_rows where id = p_row_id;
  if r.id is null or r.state <> 'done' then
    return null;
  end if;

  -- A row with a company and no person still records the company.
  if r.person_name is null and r.email is null and r.linkedin_url is null then
    perform public.lead_company_upsert(r.user_id, r.domain, r.company_name, r.logo_url, r.company_data);
    return null;
  end if;

  return public.lead_contact_merge(r.user_id, jsonb_strip_nulls(jsonb_build_object(
    'contact_id',       r.extra ->> 'contact_id',
    'person_name',      r.person_name,
    'title',            r.title,
    'linkedin_url',     r.linkedin_url,
    'company_name',     r.company_name,
    'domain',           r.domain,
    'logo_url',         r.logo_url,
    'email',            r.email,
    'email_status',     r.email_status,
    'email_checked_at', r.email_checked_at,
    'email_verifier',   r.email_verifier,
    'email_provider',   r.email_provider,
    'phone',            r.phone,
    'phone_provider',   r.phone_provider,
    'company_data',     case when r.company_data <> '{}'::jsonb then r.company_data end,
    'attributes',       case when r.extra ? 'leadsforge_id'
                             then jsonb_build_object('leadsforge_id', r.extra ->> 'leadsforge_id') end,
    'source',           case when (select kind from public.lead_runs where id = r.run_id) = 'clean'
                               and not (r.extra ? 'contact_id') then 'import' else 'run' end,
    'run_id',           r.run_id,
    'row_id',           r.id
  )));
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_contacts_merge: fold duplicates into one record the user chose
-- ---------------------------------------------------------------------------
create or replace function public.lead_contacts_merge(p_user uuid, p_keep uuid, p_drop uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k public.lead_contacts;
  d public.lead_contacts;
  n integer := 0;
begin
  select * into k from public.lead_contacts where id = p_keep and user_id = p_user for update;
  if k.id is null then
    raise exception 'keep_not_found';
  end if;

  for d in
    select * from public.lead_contacts
     where user_id = p_user and id = any(p_drop) and id <> p_keep
     for update
  loop
    update public.lead_contacts set
      person_name  = coalesce(person_name, d.person_name),
      title        = coalesce(title, d.title),
      linkedin_url = coalesce(linkedin_url, d.linkedin_url),
      linkedin_norm = coalesce(linkedin_norm, d.linkedin_norm),
      location     = coalesce(location, d.location),
      company_id   = coalesce(company_id, d.company_id),
      company_name = coalesce(company_name, d.company_name),
      domain       = coalesce(domain, d.domain),
      phone        = coalesce(phone, d.phone),
      phone_provider = case when phone is null then d.phone_provider else phone_provider end,
      -- The kept record's address wins unless it has none.
      email        = coalesce(email, d.email),
      email_norm   = coalesce(email_norm, d.email_norm),
      email_status = case when email is null then d.email_status else email_status end,
      email_checked_at = case when email is null then d.email_checked_at else email_checked_at end,
      tags         = (select array(select distinct unnest(tags || d.tags))),
      notes        = nullif(concat_ws(E'\n\n', notes, d.notes), ''),
      custom       = d.custom || custom,
      attributes   = d.attributes || attributes,
      updated_at   = now()
    where id = p_keep;

    -- List memberships move to the kept record; a duplicate membership is dropped.
    insert into public.lead_list_members (user_id, list_id, contact_id, added_at)
      select user_id, list_id, p_keep, added_at
        from public.lead_list_members
       where contact_id = d.id
      on conflict do nothing;

    delete from public.lead_contacts where id = d.id;
    n := n + 1;
  end loop;

  return n;
end;
$$;

revoke execute on function public.lead_company_upsert(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.lead_contact_merge(uuid, jsonb)                      from public, anon, authenticated;
revoke execute on function public.lead_contact_upsert_from_row(uuid)                  from public, anon, authenticated;
revoke execute on function public.lead_contacts_merge(uuid, uuid, uuid[])             from public, anon, authenticated;
grant  execute on function public.lead_company_upsert(uuid, text, text, text, jsonb) to service_role;
grant  execute on function public.lead_contact_merge(uuid, jsonb)                      to service_role;
grant  execute on function public.lead_contact_upsert_from_row(uuid)                  to service_role;
grant  execute on function public.lead_contacts_merge(uuid, uuid, uuid[])             to service_role;

-- ---------------------------------------------------------------------------
-- Backfill: every finished row into the database, oldest first
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select id from public.lead_rows where state = 'done' order by created_at, id loop
    perform public.lead_contact_upsert_from_row(r.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_companies_summary: a company with what the workspace holds at it
-- ---------------------------------------------------------------------------
-- Read by the leads function only. A view runs as its owner and would bypass
-- RLS, so it is revoked from every client role and always filtered by user_id.
create or replace view public.lead_companies_summary as
select
  co.*,
  count(ct.id)::integer                                                    as contacts,
  count(ct.id) filter (where ct.email_status = 'verified')::integer         as verified_emails,
  count(ct.id) filter (where ct.email is null)::integer                    as missing_emails,
  count(ct.id) filter (where ct.score is not null and ct.score >= 70)::integer as strong_fits,
  max(ct.score)                                                            as best_score
from public.lead_companies co
left join public.lead_contacts ct on ct.company_id = co.id
group by co.id;

revoke all on public.lead_companies_summary from public, anon, authenticated;
grant select on public.lead_companies_summary to service_role;

-- updated_at upkeep for the new tables, with the trigger function the other
-- lead_* tables already use.
do $$
declare t text;
begin
  foreach t in array array['lead_companies', 'lead_contacts', 'lead_lists', 'lead_saved_searches']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The free people search is logged to api_usage like every other provider
-- call, under its own operation, so its traffic shows in the margin views. It is
-- sold at 0 credits: the provider does not charge for it either.
-- ---------------------------------------------------------------------------
insert into public.pricing_config
  (operation, display_name, credits, provider_endpoint, provider_cost_usd, cost_source, cost_verified, enabled)
values
  ('leads.search', 'People search', 0, 'leadsforge.people.search', 0, 'catalog', false, true)
on conflict (operation) do nothing;

-- ---------------------------------------------------------------------------
-- One run per paid request
-- ---------------------------------------------------------------------------
-- Bulk actions send a request id so a double click or a retried request gets
-- the run it already started instead of a second one. The function checks for a
-- prior run first, but two requests arriving together both pass that check;
-- this index is what makes the second insert fail, and the function then
-- returns the run that won.
create unique index if not exists lead_runs_user_request_key
  on public.lead_runs (user_id, (options ->> 'request_id'))
  where options ? 'request_id';
