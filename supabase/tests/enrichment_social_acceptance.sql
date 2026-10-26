-- ============================================================================
-- Enrichment and social replies — acceptance tests
-- ----------------------------------------------------------------------------
-- What 20261130-20261204 promise at the database level:
--   * the company cache, OAuth handshakes and Vault helpers are server-only;
--   * a client can read its connected accounts but never their secret id;
--   * a post holds at most one live reply (sending, sent or uncertain), while
--     a failed one can be retried;
--   * an account's tokens round-trip through Vault and leave with the account;
--   * user_leads keeps industry and a well-formed country code;
--   * every new operation has an enabled price.
--
-- Runs inside ONE transaction that ends in ROLLBACK, with a throwaway user, the
-- same way credit_wallet_acceptance.sql does. Nothing it writes survives.
-- ============================================================================

begin;

insert into auth.users (id, email, aud, role)
values ('00000000-0000-4000-8000-0000000acc02', 'acceptance-social@echo.invalid', 'authenticated', 'authenticated');

create function pg_temp.acc() returns uuid language sql immutable as
  $$ select '00000000-0000-4000-8000-0000000acc02'::uuid $$;

create temp table _results (
  ord    serial,
  test   text,
  ok     boolean,
  detail jsonb
);

-- --- Privileges --------------------------------------------------------------
insert into _results (test, ok, detail)
select 'companies_cache_is_server_only',
       not has_table_privilege('authenticated', 'public.companies', 'select')
       and not has_table_privilege('anon', 'public.companies', 'select'),
       '{}'::jsonb;

insert into _results (test, ok, detail)
select 'oauth_states_are_server_only',
       not has_table_privilege('authenticated', 'public.social_oauth_states', 'select'),
       '{}'::jsonb;

insert into _results (test, ok, detail)
select 'accounts_readable_but_not_their_secret',
       has_column_privilege('authenticated', 'public.social_accounts', 'handle', 'select')
       and not has_column_privilege('authenticated', 'public.social_accounts', 'vault_secret_id', 'select')
       and not has_table_privilege('authenticated', 'public.social_accounts', 'insert')
       and not has_table_privilege('authenticated', 'public.social_accounts', 'update'),
       '{}'::jsonb;

insert into _results (test, ok, detail)
select 'replies_read_only_for_clients',
       has_table_privilege('authenticated', 'public.social_replies', 'select')
       and not has_table_privilege('authenticated', 'public.social_replies', 'insert'),
       '{}'::jsonb;

insert into _results (test, ok, detail)
select 'vault_helpers_not_callable_by_clients',
       not has_function_privilege('authenticated', 'public.get_social_secret(uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public.store_social_secret(text, text)', 'execute')
       and not has_function_privilege('authenticated', 'public.update_social_secret(uuid, text)', 'execute')
       and has_function_privilege('service_role', 'public.get_social_secret(uuid)', 'execute'),
       '{}'::jsonb;

-- --- One live reply per post -------------------------------------------------
insert into public.monitored_posts (id, user_id, matched_keyword, platform, post_url)
values ('00000000-0000-4000-8000-00000000a001', pg_temp.acc(), 'crm', 'twitter', 'https://x.com/jane/status/1790000000000000001');

create function pg_temp.try_reply(p_status text) returns boolean language plpgsql as $$
begin
  insert into public.social_replies (user_id, post_id, platform, body, status)
  values (pg_temp.acc(), '00000000-0000-4000-8000-00000000a001', 'x', 'hello', p_status);
  return true;
exception when unique_violation then
  return false;
end;
$$;

insert into _results (test, ok, detail)
select 'first_reply_claims_the_post', pg_temp.try_reply('sending'), '{}'::jsonb;
insert into _results (test, ok, detail)
select 'second_live_reply_refused', not pg_temp.try_reply('sending'), '{}'::jsonb;

update public.social_replies set status = 'uncertain' where post_id = '00000000-0000-4000-8000-00000000a001';
insert into _results (test, ok, detail)
select 'uncertain_reply_still_blocks', not pg_temp.try_reply('sending'), '{}'::jsonb;

update public.social_replies set status = 'failed' where post_id = '00000000-0000-4000-8000-00000000a001';
insert into _results (test, ok, detail)
select 'failed_reply_can_be_retried', pg_temp.try_reply('sending'), '{}'::jsonb;

-- --- Tokens round-trip through Vault and leave with the account ---------------
create temp table _secret as
select public.store_social_secret('{"access_token":"a1"}', null) as id;

insert into public.social_accounts (id, user_id, platform, handle, external_user_id, vault_secret_id)
select '00000000-0000-4000-8000-00000000b001', pg_temp.acc(), 'x', 'jane', '42', id from _secret;

select public.update_social_secret((select id from _secret), '{"access_token":"a2"}');

insert into _results (test, ok, detail)
select 'vault_update_replaces_tokens',
       public.get_social_secret((select id from _secret)) = '{"access_token":"a2"}',
       jsonb_build_object('got', public.get_social_secret((select id from _secret)));

delete from public.social_accounts where id = '00000000-0000-4000-8000-00000000b001';
insert into _results (test, ok, detail)
select 'disconnect_drops_the_secret',
       not exists (select 1 from vault.secrets where id = (select id from _secret)),
       '{}'::jsonb;

-- --- user_leads industry / country --------------------------------------------
-- null when the row is accepted, else the constraint that refused it.
create function pg_temp.try_lead(p_country text) returns text language plpgsql as $$
begin
  insert into public.user_leads (user_id, full_name, company_domain, industry, country_code)
  values (pg_temp.acc(), 'Probe ' || coalesce(p_country, 'none'), 'probe.example', 'Software', p_country);
  return null;
exception when check_violation then
  return sqlerrm;
end;
$$;

create temp table _lead_try as select pg_temp.try_lead('US') as err;

insert into _results (test, ok, detail)
select 'lead_keeps_industry_and_country',
       (select err from _lead_try) is null
       and exists (select 1 from public.user_leads where user_id = pg_temp.acc() and industry = 'Software' and country_code = 'US'),
       jsonb_build_object('error', (select err from _lead_try));
insert into _results (test, ok, detail)
select 'lead_country_must_be_iso2_upper',
       pg_temp.try_lead('usa') like '%user_leads_country_code_format%'
       and pg_temp.try_lead('us') like '%user_leads_country_code_format%',
       '{}'::jsonb;

-- --- Prices -----------------------------------------------------------------------
insert into _results (test, ok, detail)
select 'new_operations_priced',
       count(*) = 7 and bool_and(enabled) and bool_and(credits > 0),
       jsonb_agg(jsonb_build_object('op', operation, 'credits', credits, 'enabled', enabled))
  from public.pricing_config
 where operation in ('treg.companies.enrich', 'treg.people.enrich', 'treg.companies.news',
                     'treg.companies.funding', 'treg.companies.jobs',
                     'social.reply.x', 'social.reply.reddit');

-- ===========================================================================
-- Verdict, then undo everything
-- ===========================================================================
select row_to_json(r)::text as result
  from (select ord, test, ok, detail from _results order by ord) r;

select count(*) filter (where not ok) as failed, count(*) as total from _results;

rollback;
