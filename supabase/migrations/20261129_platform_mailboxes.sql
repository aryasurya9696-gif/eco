-- ============================================================================
-- Migration: 20261129_platform_mailboxes.sql
-- Description: Echo mailboxes on the shared platform domain, custom-domain
--              auto-setup, delivery events and the domain verification cron.
--
--   1. mail_domains: is_platform (one shared Echo domain, no owner),
--      auto_local_part (mailbox to create when a custom domain verifies),
--      dns_provider / domain_connect (detected setup path), inbound_provider
--      'resend'. Every authenticated user can read the
--      platform row; it carries only its name and status (no DNS records).
--   2. mailboxes: one address per Echo, globally (lower(address)).
--   3. mail_is_reserved_local_part(): admin, postmaster, noreply, ...
--   4. Platform mailboxes: reserved names refused and at most 3 per user,
--      enforced by a trigger so no API path can skip it.
--   5. configure_platform_mail_domain(): one-off ops RPC (service role).
--   6. mail_record_delivery_event(): delivered / bounced / complained from the
--      Resend webhook; pauses a mailbox whose bounces or complaints run high.
--   7. echo-verify-domains cron (every 10 minutes) -> mail verify_pending_domains.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. mail_domains
-- ---------------------------------------------------------------------------
alter table public.mail_domains add column if not exists is_platform boolean not null default false;
alter table public.mail_domains add column if not exists auto_local_part text;
-- Detected at add_domain, so the provider badge and "Set up automatically"
-- survive a reload: {id, name, dns_url} and {supported, provider_name}.
alter table public.mail_domains add column if not exists dns_provider jsonb;
alter table public.mail_domains add column if not exists domain_connect jsonb;

-- The platform row has no owner; every other row keeps one.
alter table public.mail_domains alter column user_id drop not null;

do $mdc$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.mail_domains'::regclass and conname = 'mail_domains_owner_check') then
    alter table public.mail_domains
      add constraint mail_domains_owner_check check (is_platform or user_id is not null);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.mail_domains'::regclass and conname = 'mail_domains_auto_local_part_check') then
    alter table public.mail_domains
      add constraint mail_domains_auto_local_part_check
      check (auto_local_part is null or auto_local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$');
  end if;
end
$mdc$;

-- Replies to custom and platform domains arrive through Resend inbound.
alter table public.mail_domains drop constraint if exists mail_domains_inbound_provider_check;
alter table public.mail_domains
  add constraint mail_domains_inbound_provider_check
  check (inbound_provider in ('cloudflare', 'ses', 'resend', 'none'));

-- At most one platform domain.
create unique index if not exists uq_mail_domains_platform
  on public.mail_domains (is_platform) where is_platform;

-- The cron's work list: unverified custom domains, newest first.
create index if not exists idx_mail_domains_pending
  on public.mail_domains (created_at) where status in ('pending', 'verifying') and not is_platform;

grant select (is_platform, auto_local_part, dns_provider, domain_connect) on public.mail_domains to authenticated;

-- Any signed-in user may see the platform domain's name and status. Its DNS
-- columns are kept empty by configure_platform_mail_domain(), so the granted
-- columns reveal nothing else.
drop policy if exists mail_domains_select_platform on public.mail_domains;
create policy mail_domains_select_platform on public.mail_domains
  for select to authenticated using (is_platform);

-- ---------------------------------------------------------------------------
-- 2. One address per Echo
-- Two users on the shared domain must never hold the same name. Built only
-- when the existing rows allow it, so a duplicate already in production
-- reports itself instead of aborting the whole deploy.
-- ---------------------------------------------------------------------------
do $mbu$
begin
  if to_regclass('public.mailboxes_address_global_uidx') is null then
    if exists (select 1 from public.mailboxes group by lower(address) having count(*) > 1) then
      raise warning 'mailboxes_address_global_uidx not created: duplicate addresses exist (select lower(address), count(*) from public.mailboxes group by 1 having count(*) > 1)';
    else
      create unique index mailboxes_address_global_uidx on public.mailboxes (lower(address));
    end if;
  end if;
end
$mbu$;

-- Delivery events look messages up by Resend's email id.
create index if not exists idx_mail_messages_provider_message_id
  on public.mail_messages (provider_message_id) where provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Reserved names. Separators are ignored ("no.reply", "mailer_daemon").
-- Mirrors RESERVED_LOCAL_PARTS in supabase/functions/mail/rules.ts.
-- ---------------------------------------------------------------------------
create or replace function public.mail_is_reserved_local_part(p_local text)
returns boolean
language sql
immutable
parallel safe
set search_path = public
as $fn$
  select regexp_replace(lower(coalesce(p_local, '')), '[._-]', '', 'g') = any (array[
    'admin', 'administrator', 'root', 'support', 'abuse', 'postmaster', 'hostmaster',
    'webmaster', 'noreply', 'billing', 'security', 'info', 'hello', 'sales',
    'team', 'echo', 'help', 'contact', 'mail', 'mailerdaemon', 'privacy', 'legal', 'press'
  ]);
$fn$;

grant execute on function public.mail_is_reserved_local_part(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Platform mailbox guard: address on the platform domain, not reserved,
-- at most 3 per user. The advisory lock serialises one user's concurrent
-- claims, so two parallel inserts cannot both pass a cap with room for one.
-- ---------------------------------------------------------------------------
create or replace function public.mailboxes_platform_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_platform boolean;
  v_domain   text;
  v_count    int;
begin
  if new.domain_id is null then
    return new;
  end if;
  select d.is_platform, d.domain into v_platform, v_domain
    from public.mail_domains d where d.id = new.domain_id;
  if not coalesce(v_platform, false) then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.domain_id is not distinct from new.domain_id
     and old.user_id = new.user_id
     and lower(old.address) = lower(new.address) then
    return new;
  end if;

  if lower(split_part(new.address, '@', 2)) <> lower(v_domain) then
    raise exception 'mail_platform_address_domain: % is not on %', new.address, v_domain
      using errcode = '23514';
  end if;
  if public.mail_is_reserved_local_part(split_part(new.address, '@', 1)) then
    raise exception 'mail_reserved_local_part: % is reserved', split_part(new.address, '@', 1)
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mail_platform_cap:' || new.user_id::text, 0));
  select count(*) into v_count
    from public.mailboxes m
    join public.mail_domains d on d.id = m.domain_id
   where m.user_id = new.user_id and d.is_platform and m.id <> new.id;
  if v_count >= 3 then
    raise exception 'mail_platform_mailbox_cap: at most 3 Echo mailboxes per user'
      using errcode = '23514';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_mailboxes_platform_guard on public.mailboxes;
create trigger trg_mailboxes_platform_guard
  before insert or update of domain_id, user_id, address on public.mailboxes
  for each row execute function public.mailboxes_platform_guard();

revoke all on function public.mailboxes_platform_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The platform domain (ops, once, after the domain is verified in Resend):
--   select public.configure_platform_mail_domain('echomail.io', '<resend domain id>');
-- ---------------------------------------------------------------------------
create or replace function public.configure_platform_mail_domain(p_domain text, p_provider_domain_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_domain text := lower(trim(coalesce(p_domain, '')));
  v_row    public.mail_domains%rowtype;
  v_id     uuid;
begin
  if v_domain !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_domain');
  end if;
  if exists (select 1 from public.mail_domains where lower(domain) = v_domain and not is_platform) then
    return jsonb_build_object('ok', false, 'error', 'domain_in_use');
  end if;

  select * into v_row from public.mail_domains where is_platform for update;
  if not found then
    insert into public.mail_domains (user_id, domain, status, provider, provider_domain_id,
                                     dkim_tokens, dns_records, inbound_provider, is_platform,
                                     verified_at, last_checked_at)
    values (null, v_domain, 'verified', 'resend', nullif(trim(p_provider_domain_id), ''),
            '[]'::jsonb, '[]'::jsonb, 'resend', true, now(), now())
    returning id into v_id;
  else
    -- Moving the platform to another domain would strand every address on it.
    if lower(v_row.domain) <> v_domain
       and exists (select 1 from public.mailboxes where domain_id = v_row.id) then
      return jsonb_build_object('ok', false, 'error', 'platform_domain_has_mailboxes', 'domain', v_row.domain);
    end if;
    update public.mail_domains
       set domain             = v_domain,
           status             = 'verified',
           provider           = 'resend',
           provider_domain_id = coalesce(nullif(trim(p_provider_domain_id), ''), provider_domain_id),
           inbound_provider   = 'resend',
           dkim_tokens        = '[]'::jsonb,
           dns_records        = '[]'::jsonb,
           verified_at        = coalesce(verified_at, now()),
           last_checked_at    = now()
     where id = v_row.id;
    v_id := v_row.id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'domain', v_domain);
end;
$fn$;

revoke all on function public.configure_platform_mail_domain(text, text) from public, anon, authenticated;
grant execute on function public.configure_platform_mail_domain(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Delivery events (Resend email.delivered / email.bounced / email.complained)
--
-- A complaint outranks a bounce, which outranks a delivery; a late "delivered"
-- never clears either. The mailbox is paused (pause_reason 'deliverability')
-- when, over the last 7 days of its sends, bounces >= 5 and the bounce rate is
-- above 8%, or complaints >= 2. mailbox_paused is true only for the call that
-- paused it.
-- ---------------------------------------------------------------------------
create or replace function public.mail_record_delivery_event(p_provider_message_id text, p_event text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_msg        record;
  v_new        text;
  v_sent       int;
  v_bounced    int;
  v_complained int;
  v_paused     boolean := false;
begin
  if p_event is null or p_event not in ('delivered', 'bounced', 'complained') then
    return jsonb_build_object('ok', false, 'error', 'invalid_event', 'mailbox_paused', false);
  end if;
  if coalesce(trim(p_provider_message_id), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'message_not_found', 'mailbox_paused', false);
  end if;

  select id, mailbox_id, status into v_msg
    from public.mail_messages
   where provider_message_id = p_provider_message_id and direction = 'out'
   order by created_at desc
   limit 1
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'message_not_found', 'mailbox_paused', false);
  end if;

  v_new := case p_event
    when 'complained' then 'complained'
    when 'bounced'    then case when v_msg.status = 'complained' then v_msg.status else 'bounced' end
    else case when v_msg.status in ('queued', 'sending', 'sent') then 'delivered' else v_msg.status end
  end;
  if v_new is distinct from v_msg.status then
    update public.mail_messages set status = v_new where id = v_msg.id;
  end if;

  if p_event in ('bounced', 'complained') then
    select count(*) filter (where status in ('sent', 'delivered', 'bounced', 'complained')),
           count(*) filter (where status = 'bounced'),
           count(*) filter (where status = 'complained')
      into v_sent, v_bounced, v_complained
      from public.mail_messages
     where mailbox_id = v_msg.mailbox_id
       and direction = 'out'
       and coalesce(sent_at, created_at) >= now() - interval '7 days';

    if (v_bounced >= 5 and v_bounced::numeric / greatest(v_sent, 1) > 0.08) or v_complained >= 2 then
      update public.mailboxes
         set status = 'paused', pause_reason = 'deliverability'
       where id = v_msg.mailbox_id and status = 'active';
      v_paused := found;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'mailbox_paused', v_paused,
                            'message_id', v_msg.id, 'mailbox_id', v_msg.mailbox_id, 'status', v_new);
end;
$fn$;

revoke all on function public.mail_record_delivery_event(text, text) from public, anon, authenticated;
grant execute on function public.mail_record_delivery_event(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. echo-verify-domains: every 10 minutes, POST <project_url>/functions/v1/mail
--    {"action":"verify_pending_domains"}.
--
-- The mail function keeps verify_jwt on (it is user-facing), so the gateway
-- needs a valid project JWT: the job sends the project's anon key from
-- service_secrets 'project_anon_key' (public by design; it grants nothing).
-- The real gate is x-cron-secret (service_secrets 'sweep_cron_secret', the
-- daily-sweep secret), compared in constant time inside the function. Both
-- are read when the job fires, not baked into cron.job.
--
-- Without pg_cron / pg_net / project_url / project_anon_key nothing is
-- scheduled. Re-run after setting them:  select public.configure_mail_cron();
-- ---------------------------------------------------------------------------
create or replace function public.configure_mail_cron()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_cmd text;
begin
  if to_regclass('cron.job') is null
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'cron' and p.proname = 'schedule') then
    return jsonb_build_object('ok', false, 'skipped', 'pg_cron not installed');
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'net' and p.proname = 'http_post') then
    return jsonb_build_object('ok', true, 'echo-verify-domains', 'left as is: pg_net not installed');
  end if;

  select rtrim(trim(value), '/') into v_url from public.service_secrets where name = 'project_url';
  if v_url is null or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
    return jsonb_build_object('ok', true, 'echo-verify-domains',
      case when v_url is null then 'left as is: service_secrets.project_url not set'
           else 'left as is: project_url is not https://host' end);
  end if;
  if not exists (select 1 from public.service_secrets where name = 'project_anon_key' and length(value) > 20) then
    return jsonb_build_object('ok', true, 'echo-verify-domains', 'left as is: service_secrets.project_anon_key not set');
  end if;

  v_cmd := format(
    $cmd$select net.http_post(
  url := %L,
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || coalesce((select value from public.service_secrets where name = 'project_anon_key'), ''),
    'x-cron-secret', coalesce((select value from public.service_secrets where name = 'sweep_cron_secret'), '')),
  body := '{"action":"verify_pending_domains"}'::jsonb,
  timeout_milliseconds := 120000);$cmd$,
    v_url || '/functions/v1/mail');
  execute 'select cron.unschedule(jobid) from cron.job where jobname = $1' using 'echo-verify-domains';
  execute 'select cron.schedule($1, $2, $3)' using 'echo-verify-domains', '*/10 * * * *', v_cmd;
  return jsonb_build_object('ok', true, 'echo-verify-domains', 'scheduled: ' || v_url);
end;
$fn$;

revoke execute on function public.configure_mail_cron() from public, anon, authenticated;
grant  execute on function public.configure_mail_cron() to service_role;

do $mailcron$
declare
  v_out jsonb;
begin
  begin
    v_out := public.configure_mail_cron();
    raise notice 'configure_mail_cron: %', v_out;
  exception when others then
    -- Scheduling must never abort the schema; report it and carry on.
    raise warning 'configure_mail_cron failed: %', sqlerrm;
  end;
end
$mailcron$;
