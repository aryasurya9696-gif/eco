-- ============================================================================
-- Migration: 20261125_mail.sql
-- Description: Echo Mail — domains, mailboxes, threads and messages.
--
-- Every write that matters goes through the `mail` edge function (service
-- role): connecting a mailbox, sending, saving drafts, adding and verifying a
-- domain. The client reads its own rows under RLS and may only change the
-- per-thread view state (folder, star, unread) and delete its own threads.
--
-- Sending:
--   hosted       mailbox on a domain verified with Resend; sent via Resend.
--   app_password Gmail / Zoho / custom SMTP; sent over SMTPS (port 465).
--                The password lives in Supabase Vault. The mailbox row keeps
--                only the vault secret id, and that column is not readable by
--                the client.
--
-- Credits: mail.send.hosted / mail.send.connected in pricing_config, charged
-- per sent message through wallet_reserve / wallet_settle, the same two-phase
-- path the Leads feature uses. A send that fails is released, not charged.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Domains
-- ---------------------------------------------------------------------------
create table if not exists public.mail_domains (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  domain              text not null,
  status              text not null default 'pending'
                        check (status in ('pending', 'verifying', 'verified', 'failed', 'suspended')),
  provider            text not null default 'resend'
                        check (provider in ('resend', 'ses', 'brevo', 'custom')),
  -- Resend's domain id. Needed to trigger verification and to delete it.
  provider_domain_id  text,
  dkim_tokens         jsonb not null default '[]'::jsonb,
  dns_records         jsonb not null default '[]'::jsonb,
  inbound_provider    text not null default 'none'
                        check (inbound_provider in ('cloudflare', 'ses', 'none')),
  verified_at         timestamptz,
  last_checked_at     timestamptz,
  created_at          timestamptz not null default now()
);

-- One Echo account per domain. Resend keys domains account-wide, so a second
-- workspace adding the same domain would collide there anyway; refusing it here
-- also stops one workspace sending as another's verified domain.
create unique index if not exists uq_mail_domains_domain on public.mail_domains (lower(domain));
create index if not exists idx_mail_domains_user_id on public.mail_domains (user_id);

-- ---------------------------------------------------------------------------
-- 2. Mailboxes
-- ---------------------------------------------------------------------------
create table if not exists public.mailboxes (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  kind              text not null check (kind in ('hosted', 'app_password', 'oauth_send')),
  provider          text not null default 'custom'
                      check (provider in ('google', 'microsoft', 'zoho', 'resend', 'ses', 'brevo', 'custom')),
  address           text not null,
  display_name      text not null,
  domain_id         uuid references public.mail_domains(id) on delete set null,
  status            text not null default 'active'
                      check (status in ('active', 'paused', 'needs_reauth', 'disabled')),
  pause_reason      text,

  -- app_password only. Server-side columns: not granted to the client.
  smtp_host         text,
  smtp_port         int not null default 465,
  smtp_user         text,
  vault_secret_id   uuid,

  daily_send_limit  int not null default 40 check (daily_send_limit >= 0),
  sent_today        int not null default 0 check (sent_today >= 0),
  -- sent_today counts sends on this (UTC) date; a stale date means zero.
  sent_today_date   date not null default current_date,

  is_default        boolean not null default false,
  created_at        timestamptz not null default now(),
  constraint uq_mailboxes_user_address unique (user_id, address)
);

create index if not exists idx_mailboxes_user_id on public.mailboxes (user_id);

-- ---------------------------------------------------------------------------
-- 3. Threads
-- ---------------------------------------------------------------------------
create table if not exists public.mail_threads (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  mailbox_id       uuid not null references public.mailboxes(id) on delete cascade,
  lead_id          uuid references public.user_leads(id) on delete set null,
  lead_name        text,
  lead_company     text,
  subject          text not null default '',
  snippet          text not null default '',
  participants     jsonb not null default '[]'::jsonb,
  folder           text not null default 'inbox'
                     check (folder in ('inbox', 'sent', 'drafts', 'archive', 'trash', 'spam')),
  unread_count     int not null default 0 check (unread_count >= 0),
  starred          boolean not null default false,
  has_attachments  boolean not null default false,
  last_message_at  timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index if not exists idx_mail_threads_user_last
  on public.mail_threads (user_id, last_message_at desc);
create index if not exists idx_mail_threads_mailbox on public.mail_threads (mailbox_id);
create index if not exists idx_mail_threads_lead_id on public.mail_threads (lead_id) where lead_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Messages
-- ---------------------------------------------------------------------------
create table if not exists public.mail_messages (
  id                   uuid primary key default gen_random_uuid(),
  thread_id            uuid not null references public.mail_threads(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  mailbox_id           uuid not null references public.mailboxes(id) on delete cascade,
  lead_id              uuid references public.user_leads(id) on delete set null,
  direction            text not null check (direction in ('in', 'out')),
  status               text not null default 'sent'
                         check (status in ('draft', 'queued', 'sending', 'sent', 'delivered',
                                           'bounced', 'complained', 'failed', 'received')),
  is_auto_reply        boolean not null default false,
  from_addr            text not null,
  to_addrs             jsonb not null default '[]'::jsonb,
  cc_addrs             jsonb not null default '[]'::jsonb,
  bcc_addrs            jsonb not null default '[]'::jsonb,
  subject              text not null default '',
  snippet              text not null default '',
  text_body            text not null default '',
  html_body            text not null default '',
  message_id_header    text,
  in_reply_to          text,
  references_hdr       text,
  provider_message_id  text,
  credits_charged      numeric(20,6) not null default 0,
  error_message        text,
  sent_at              timestamptz,
  received_at          timestamptz,
  read_at              timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists idx_mail_messages_thread on public.mail_messages (thread_id, created_at);
create unique index if not exists uq_mail_messages_message_id_header
  on public.mail_messages (message_id_header) where message_id_header is not null;

-- ---------------------------------------------------------------------------
-- 5. Attachments (read-only for now; nothing writes them yet)
-- ---------------------------------------------------------------------------
create table if not exists public.mail_attachments (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid not null references public.mail_messages(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  filename      text not null,
  content_type  text not null,
  size_bytes    bigint not null,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_mail_attachments_message on public.mail_attachments (message_id);

-- ---------------------------------------------------------------------------
-- 6. RLS and grants
-- ---------------------------------------------------------------------------
alter table public.mail_domains     enable row level security;
alter table public.mailboxes        enable row level security;
alter table public.mail_threads     enable row level security;
alter table public.mail_messages    enable row level security;
alter table public.mail_attachments enable row level security;

revoke all on public.mail_domains, public.mailboxes, public.mail_threads,
              public.mail_messages, public.mail_attachments from anon, authenticated;

-- Column-level select on mailboxes: the SMTP login and vault id stay server-side.
grant select (id, user_id, kind, provider, address, display_name, domain_id, status,
              pause_reason, daily_send_limit, sent_today, sent_today_date, is_default, created_at)
  on public.mailboxes to authenticated;

grant select (id, user_id, domain, status, provider, dkim_tokens, dns_records,
              inbound_provider, verified_at, last_checked_at, created_at)
  on public.mail_domains to authenticated;

grant select on public.mail_threads, public.mail_messages, public.mail_attachments to authenticated;

-- The thread list's own view state is the only thing the client may change.
grant update (folder, starred, unread_count) on public.mail_threads to authenticated;
grant delete on public.mail_threads to authenticated;

drop policy if exists mail_domains_select_own on public.mail_domains;
create policy mail_domains_select_own on public.mail_domains
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists mailboxes_select_own on public.mailboxes;
create policy mailboxes_select_own on public.mailboxes
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists mail_threads_select_own on public.mail_threads;
create policy mail_threads_select_own on public.mail_threads
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists mail_threads_update_own on public.mail_threads;
create policy mail_threads_update_own on public.mail_threads
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists mail_threads_delete_own on public.mail_threads;
create policy mail_threads_delete_own on public.mail_threads
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists mail_messages_select_own on public.mail_messages;
create policy mail_messages_select_own on public.mail_messages
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists mail_attachments_select_own on public.mail_attachments;
create policy mail_attachments_select_own on public.mail_attachments
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 7. Daily send limit
-- Atomic take/return of one send slot. The row lock serialises concurrent
-- sends from the same mailbox, so two parallel requests cannot both pass a
-- limit that has room for one.
-- ---------------------------------------------------------------------------
create or replace function public.mail_take_send_slot(p_mailbox_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_mb public.mailboxes%rowtype;
  v_sent int;
begin
  select * into v_mb from public.mailboxes
   where id = p_mailbox_id and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'mailbox_not_found');
  end if;

  v_sent := case when v_mb.sent_today_date = current_date then v_mb.sent_today else 0 end;

  if v_sent >= v_mb.daily_send_limit then
    return jsonb_build_object('ok', false, 'error', 'daily_limit',
                              'sent_today', v_sent, 'daily_send_limit', v_mb.daily_send_limit);
  end if;

  update public.mailboxes
     set sent_today = v_sent + 1, sent_today_date = current_date
   where id = p_mailbox_id;

  return jsonb_build_object('ok', true, 'sent_today', v_sent + 1, 'daily_send_limit', v_mb.daily_send_limit);
end;
$fn$;

create or replace function public.mail_return_send_slot(p_mailbox_id uuid, p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $fn$
  update public.mailboxes
     set sent_today = greatest(sent_today - 1, 0)
   where id = p_mailbox_id and user_id = p_user_id and sent_today_date = current_date;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Vault helpers for app passwords (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.store_mailbox_secret(p_secret text, p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $fn$
begin
  return vault.create_secret(p_secret, p_name, 'Echo Mail app password');
end;
$fn$;

create or replace function public.get_mailbox_secret(p_secret_id uuid)
returns text
language sql
security definer
set search_path = public, vault
as $fn$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$fn$;

create or replace function public.delete_mailbox_secret(p_secret_id uuid)
returns void
language sql
security definer
set search_path = public, vault
as $fn$
  delete from vault.secrets where id = p_secret_id;
$fn$;

-- A disconnected mailbox takes its password with it, whichever path deleted it
-- (the edge function, a user cascade, or SQL by hand).
create or replace function public.mailboxes_drop_secret()
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

drop trigger if exists trg_mailboxes_drop_secret on public.mailboxes;
create trigger trg_mailboxes_drop_secret
  after delete on public.mailboxes
  for each row execute function public.mailboxes_drop_secret();

revoke all on function public.mail_take_send_slot(uuid, uuid)   from public, anon, authenticated;
revoke all on function public.mail_return_send_slot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.store_mailbox_secret(text, text)  from public, anon, authenticated;
revoke all on function public.get_mailbox_secret(uuid)          from public, anon, authenticated;
revoke all on function public.delete_mailbox_secret(uuid)       from public, anon, authenticated;
revoke all on function public.mailboxes_drop_secret()           from public, anon, authenticated;
grant execute on function public.mail_take_send_slot(uuid, uuid)   to service_role;
grant execute on function public.mail_return_send_slot(uuid, uuid) to service_role;
grant execute on function public.store_mailbox_secret(text, text)  to service_role;
grant execute on function public.get_mailbox_secret(uuid)          to service_role;
grant execute on function public.delete_mailbox_secret(uuid)       to service_role;

-- ---------------------------------------------------------------------------
-- 9. Pricing
-- Resend Pro is $20 per 50,000 emails ($0.0004 each). Connected mailboxes send
-- through the user's own provider, so the provider cost is zero.
-- ---------------------------------------------------------------------------
insert into public.pricing_config (
  operation, display_name, provider_endpoint, provider_cost_usd,
  cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
)
values
  ('mail.send.hosted', 'Email send (Echo hosted)', 'resend.emails.send', 0.00040000,
   true, 'rate_card', 0.100000, true, 1, now(), now()),
  ('mail.send.connected', 'Email send (connected mailbox)', 'smtp', 0.00000000,
   true, 'rate_card', 0.050000, true, 1, now(), now())
on conflict (operation) do update
set display_name      = excluded.display_name,
    provider_endpoint = excluded.provider_endpoint,
    provider_cost_usd = excluded.provider_cost_usd,
    enabled           = excluded.enabled,
    updated_at        = now();
