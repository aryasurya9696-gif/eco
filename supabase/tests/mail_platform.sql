-- ============================================================================
-- Echo platform mailboxes — acceptance tests (20261129_platform_mailboxes)
-- ----------------------------------------------------------------------------
-- Asserts: global address uniqueness, reserved names, the 3-mailbox cap on the
-- platform domain, platform-row visibility under RLS, and the delivery-event
-- auto-pause. Runs inside ONE transaction that ends in ROLLBACK, with
-- throwaway users and a throwaway platform domain; nothing survives.
--
--   node scripts/run-sql-test.cjs mail_platform --yes
-- ============================================================================

begin;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000a01', 'mail-a@echo.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000a02', 'mail-b@echo.invalid', 'authenticated', 'authenticated');

create temp table _results (
  ord    serial,
  test   text,
  ok     boolean,
  detail jsonb
);

-- Runs a statement and returns its SQLSTATE and message, or 'ok'.
create function pg_temp.try_sql(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$$;

create function pg_temp.ua() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-000000000a01'::uuid $$;
create function pg_temp.ub() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-000000000a02'::uuid $$;

-- A test platform domain (any real one in this database is set aside first).
update public.mail_domains set is_platform = false, user_id = pg_temp.ua() where is_platform;

create temp table _cfg as
select public.configure_platform_mail_domain('echotest.example', 're_dom_test') as res;

insert into _results (test, ok, detail)
select 'configure_platform_mail_domain_creates_verified_row',
       (res->>'ok')::boolean
       and exists (select 1 from public.mail_domains
                    where is_platform and domain = 'echotest.example' and status = 'verified'
                      and inbound_provider = 'resend' and user_id is null),
       res
  from _cfg;

insert into _results (test, ok, detail)
select 'configure_platform_mail_domain_is_idempotent',
       (public.configure_platform_mail_domain('echotest.example', 're_dom_test')->>'id')
         = (select res->>'id' from _cfg)
       and (select count(*) from public.mail_domains where is_platform) = 1,
       '{}'::jsonb;

create function pg_temp.pid() returns uuid language sql stable as
  $$ select id from public.mail_domains where is_platform $$;

create function pg_temp.add_mb(p_user uuid, p_address text)
returns text
language plpgsql
as $$
begin
  return pg_temp.try_sql(format(
    'insert into public.mailboxes (user_id, kind, provider, address, display_name, domain_id, daily_send_limit)
     values (%L, ''hosted'', ''resend'', %L, ''Test'', %L, 40)', p_user, p_address, pg_temp.pid()));
end;
$$;

-- --- Reserved names -------------------------------------------------------
insert into _results (test, ok, detail)
select 'reserved_function',
       public.mail_is_reserved_local_part('admin')
       and public.mail_is_reserved_local_part('No.Reply')
       and public.mail_is_reserved_local_part('mailer_daemon')
       and public.mail_is_reserved_local_part('postmaster')
       and not public.mail_is_reserved_local_part('rahul')
       and not public.mail_is_reserved_local_part('administrators'),
       '{}'::jsonb;

create temp table _r1 as select pg_temp.add_mb(pg_temp.ua(), 'support@echotest.example') as r;
insert into _results (test, ok, detail)
select 'reserved_name_refused_on_platform', r like '23514%mail_reserved_local_part%', to_jsonb(r) from _r1;

create temp table _r1b as select pg_temp.add_mb(pg_temp.ua(), 'rahul@other.example') as r;
insert into _results (test, ok, detail)
select 'platform_mailbox_must_use_platform_domain', r like '23514%mail_platform_address_domain%', to_jsonb(r) from _r1b;

-- --- Global uniqueness ----------------------------------------------------
create temp table _r2 as
select pg_temp.add_mb(pg_temp.ua(), 'rahul@echotest.example') as a,
       pg_temp.add_mb(pg_temp.ub(), 'RAHUL@echotest.example') as b;
insert into _results (test, ok, detail)
select 'global_address_unique_across_users', a = 'ok' and b like '23505%', jsonb_build_object('a', a, 'b', b) from _r2;

insert into _results (test, ok, detail)
select 'global_unique_index_exists', to_regclass('public.mailboxes_address_global_uidx') is not null, '{}'::jsonb;

-- --- Cap of 3 per user ----------------------------------------------------
create temp table _r3 as
select pg_temp.add_mb(pg_temp.ua(), 'rahul.k@echotest.example') as two,
       pg_temp.add_mb(pg_temp.ua(), 'rahul2@echotest.example')  as three,
       pg_temp.add_mb(pg_temp.ua(), 'rahul3@echotest.example')  as four,
       pg_temp.add_mb(pg_temp.ub(), 'priya@echotest.example')   as other_user;
insert into _results (test, ok, detail)
select 'platform_cap_three_per_user',
       two = 'ok' and three = 'ok' and four like '23514%mail_platform_mailbox_cap%' and other_user = 'ok'
       and (select count(*) from public.mailboxes where user_id = pg_temp.ua() and domain_id = pg_temp.pid()) = 3,
       to_jsonb(_r3) from _r3;

-- A mailbox on a user's own domain is not capped.
insert into public.mail_domains (user_id, domain, status, provider)
values (pg_temp.ua(), 'own-a.example', 'verified', 'resend');
create temp table _r4 as
select pg_temp.try_sql(format(
  'insert into public.mailboxes (user_id, kind, provider, address, display_name, domain_id)
   values (%L, ''hosted'', ''resend'', ''admin@own-a.example'', ''A'', %L)',
  pg_temp.ua(), (select id from public.mail_domains where domain = 'own-a.example'))) as r;
insert into _results (test, ok, detail)
select 'own_domain_not_capped_or_reserved', r = 'ok', to_jsonb(r) from _r4;

-- Moving an existing mailbox onto the platform domain is checked too.
create temp table _r5 as
select pg_temp.try_sql(format(
  'update public.mailboxes set domain_id = %L, address = ''rahul9@echotest.example'' where address = ''admin@own-a.example''',
  pg_temp.pid())) as r;
insert into _results (test, ok, detail)
select 'cap_enforced_on_update', r like '23514%mail_platform_mailbox_cap%', to_jsonb(r) from _r5;

-- --- Platform row visible to any signed-in user (RLS) ---------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000a02', true);
create temp table _r6 as
select (select count(*) from public.mail_domains where is_platform)::int as platform_rows,
       (select count(*) from public.mail_domains where domain = 'own-a.example')::int as others_rows;
reset role;
insert into _results (test, ok, detail)
select 'platform_row_readable_by_authenticated', platform_rows = 1 and others_rows = 0, to_jsonb(_r6) from _r6;

-- --- Delivery events and auto-pause ---------------------------------------
create function pg_temp.mb(p_address text) returns uuid language sql stable as
  $$ select id from public.mailboxes where address = p_address $$;

insert into public.mail_threads (id, user_id, mailbox_id, subject)
values ('00000000-0000-4000-8000-00000000ff01', pg_temp.ua(), pg_temp.mb('rahul@echotest.example'), 'test'),
       ('00000000-0000-4000-8000-00000000ff02', pg_temp.ub(), pg_temp.mb('priya@echotest.example'), 'test');

-- 10 sends from rahul@ and 10 from priya@.
insert into public.mail_messages (thread_id, user_id, mailbox_id, direction, status, from_addr,
                                  provider_message_id, sent_at)
select '00000000-0000-4000-8000-00000000ff01'::uuid, pg_temp.ua(), pg_temp.mb('rahul@echotest.example'),
       'out', 'sent', 'rahul@echotest.example', 're_a_' || g, now()
  from generate_series(1, 10) g
union all
select '00000000-0000-4000-8000-00000000ff02'::uuid, pg_temp.ub(), pg_temp.mb('priya@echotest.example'),
       'out', 'sent', 'priya@echotest.example', 're_b_' || g, now()
  from generate_series(1, 10) g;

create temp table _ev (step text, res jsonb);
insert into _ev select 'delivered1', public.mail_record_delivery_event('re_a_1', 'delivered');
insert into _ev select 'b1', public.mail_record_delivery_event('re_a_1', 'bounced');
insert into _ev select 'late_delivered', public.mail_record_delivery_event('re_a_1', 'delivered');
insert into _ev select 'b2', public.mail_record_delivery_event('re_a_2', 'bounced');
insert into _ev select 'b3', public.mail_record_delivery_event('re_a_3', 'bounced');
insert into _ev select 'b4', public.mail_record_delivery_event('re_a_4', 'bounced');
insert into _ev select 'b5', public.mail_record_delivery_event('re_a_5', 'bounced');
insert into _ev select 'b6', public.mail_record_delivery_event('re_a_6', 'bounced');
insert into _ev select 'c1', public.mail_record_delivery_event('re_b_1', 'complained');
insert into _ev select 'c2', public.mail_record_delivery_event('re_b_2', 'complained');
insert into _ev select 'unknown', public.mail_record_delivery_event('re_nope', 'bounced');
insert into _ev select 'bad_event', public.mail_record_delivery_event('re_a_7', 'opened');

insert into _results (test, ok, detail)
select 'delivered_then_bounced_stays_bounced',
       (select status from public.mail_messages where provider_message_id = 're_a_1') = 'bounced'
       and (select res->>'status' from _ev where step = 'delivered1') = 'delivered',
       (select jsonb_agg(res) from _ev where step in ('delivered1', 'b1', 'late_delivered'));

insert into _results (test, ok, detail)
select 'four_bounces_do_not_pause',
       (select bool_and(not (res->>'mailbox_paused')::boolean) from _ev where step in ('b1', 'b2', 'b3', 'b4')),
       (select jsonb_agg(res) from _ev where step like 'b%');

insert into _results (test, ok, detail)
select 'fifth_bounce_pauses_once',
       (select (res->>'mailbox_paused')::boolean from _ev where step = 'b5')
       and not (select (res->>'mailbox_paused')::boolean from _ev where step = 'b6')
       and (select status = 'paused' and pause_reason = 'deliverability'
              from public.mailboxes where address = 'rahul@echotest.example'),
       (select jsonb_agg(res) from _ev where step in ('b5', 'b6'));

insert into _results (test, ok, detail)
select 'two_complaints_pause',
       not (select (res->>'mailbox_paused')::boolean from _ev where step = 'c1')
       and (select (res->>'mailbox_paused')::boolean from _ev where step = 'c2')
       and (select status from public.mailboxes where address = 'priya@echotest.example') = 'paused'
       and (select status from public.mail_messages where provider_message_id = 're_b_1') = 'complained',
       (select jsonb_agg(res) from _ev where step like 'c%');

insert into _results (test, ok, detail)
select 'unknown_message_and_bad_event_refused',
       (select res->>'error' from _ev where step = 'unknown') = 'message_not_found'
       and (select res->>'error' from _ev where step = 'bad_event') = 'invalid_event',
       (select jsonb_agg(res) from _ev where step in ('unknown', 'bad_event'));

-- Low bounce rate does not pause: 5 bounces out of 100 sends is 5%.
insert into public.mailboxes (user_id, kind, provider, address, display_name, domain_id)
values (pg_temp.ub(), 'hosted', 'resend', 'bulk@own-b.example', 'B', null);
insert into public.mail_messages (thread_id, user_id, mailbox_id, direction, status, from_addr, provider_message_id, sent_at)
select '00000000-0000-4000-8000-00000000ff02'::uuid, pg_temp.ub(), pg_temp.mb('bulk@own-b.example'),
       'out', 'sent', 'bulk@own-b.example', 're_c_' || g, now()
  from generate_series(1, 100) g;
create temp table _ev2 as
select g, public.mail_record_delivery_event('re_c_' || g, 'bounced') as res from generate_series(1, 5) g;
insert into _results (test, ok, detail)
select 'low_bounce_rate_does_not_pause',
       (select bool_and(not (res->>'mailbox_paused')::boolean) from _ev2)
       and (select status from public.mailboxes where address = 'bulk@own-b.example') = 'active',
       (select jsonb_agg(res) from _ev2);

-- --- Privileges -----------------------------------------------------------
insert into _results (test, ok, detail)
select 'service_role_only_rpcs',
       not has_function_privilege('authenticated', 'public.configure_platform_mail_domain(text, text)', 'execute')
       and not has_function_privilege('authenticated', 'public.mail_record_delivery_event(text, text)', 'execute')
       and not has_function_privilege('anon', 'public.mail_record_delivery_event(text, text)', 'execute')
       and has_function_privilege('service_role', 'public.mail_record_delivery_event(text, text)', 'execute')
       and has_function_privilege('service_role', 'public.configure_platform_mail_domain(text, text)', 'execute'),
       '{}'::jsonb;

-- ===========================================================================
-- Verdict, then undo everything
-- ===========================================================================
select row_to_json(r)::text as result
  from (select ord, test, ok, detail from _results order by ord) r;

select count(*) filter (where not ok) as failed, count(*) as total from _results;

rollback;
