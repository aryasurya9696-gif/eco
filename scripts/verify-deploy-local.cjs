// Applies supabase/deploy-all.sql to a throwaway in-memory Postgres (PGlite),
// fresh and then twice more, and runs the SQL acceptance suite. Never touches a
// real database.
//
//   npm i --no-save @electric-sql/pglite@0.2.17     (once, or set PGLITE_MODULE)
//   node scripts/verify-deploy-local.cjs
//
// PGLITE_MODULE may point at an installed @electric-sql/pglite directory, e.g.
// a copy in a scratch folder, so nothing has to be added to package.json.
//
// What it checks:
//   * deploy-all.sql applies on a fresh database, and re-applies twice (C1)
//   * a re-run leaves pricing_config and topup_packages exactly as they were,
//     including an operator edit made between runs (M9)
//   * the retired profile guard trigger is absent (C2)
//   * with pg_cron / pg_net stand-ins, the reaper job and the sweep job are
//     scheduled from service_secrets.project_url, and a placeholder job is
//     removed (N6, H6)
//   * credit_wallet_acceptance.sql and enrichment_social_acceptance.sql pass inside
//     BEGIN ... ROLLBACK and leave
//     no rows behind
//
// PGlite is single-connection, so credit_wallet_concurrency.sql cannot run here;
// it needs a real Postgres with dblink (see that file).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let PGlite;
try {
  ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite'));
} catch {
  console.error('PGlite not found. npm i --no-save @electric-sql/pglite@0.2.17, or set PGLITE_MODULE.');
  process.exit(2);
}

// Minimal stand-ins for the parts of Supabase the schema references.
const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (
  id uuid primary key, email text, aud text, role text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text, description text, secret text not null,
  created_at timestamptz default now()
);
create view vault.decrypted_secrets as select *, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid language sql as
  $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
returns void language sql as
  $$ update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
       description = coalesce(new_description, description) where id = secret_id $$;
grant usage on schema public to anon, authenticated, service_role;
`;

// pg_cron / pg_net look-alikes: enough surface for configure_echo_cron().
const CRON_STUBS = `
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint
language sql as $$
  insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid $$;
create function cron.unschedule(p_jobid bigint) returns boolean
language sql as $$ delete from cron.job where jobid = p_jobid returning true $$;
create schema net;
create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}',
                              params jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language sql as $$ select 1::bigint $$;
`;

// PGlite ships no pgcrypto; the schema only needs gen_random_uuid(), which is core.
const deployAll = read('supabase/deploy-all.sql')
  .replace(/create extension if not exists "?pgcrypto"?[^;]*;/gi, '-- (pgcrypto skipped in harness)');

let failures = 0;
const pass = (m) => console.log('PASS  ' + m);
const fail = (m) => { failures++; console.log('FAIL  ' + m); };

async function step(db, label, sql) {
  try {
    const res = await db.exec(sql);
    pass(label);
    return res;
  } catch (err) {
    fail(`${label}: ${err.message}`);
    if (err.position) {
      const line = sql.slice(0, Number(err.position)).split('\n').length;
      console.log(`      at line ${line}: ${sql.split('\n')[line - 1]?.trim().slice(0, 160)}`);
    }
    return null;
  }
}

const snapshot = async (db) => JSON.stringify((await db.query(`
  select (select jsonb_agg(to_jsonb(p) - 'updated_at' - 'effective_from' order by operation) from public.pricing_config p) as pricing,
         (select jsonb_agg(to_jsonb(t) order by code) from public.topup_packages t) as packages`)).rows[0]);

async function main() {
  // ---- Run A: plain Supabase stand-ins, no pg_cron -------------------------
  const db = new PGlite();
  await step(db, 'supabase stubs', SUPABASE_STUBS);
  if (!(await step(db, 'deploy-all.sql on a fresh database', deployAll))) return;

  // An operator edit between runs must survive the re-runs (M9).
  await db.exec(`update public.pricing_config set credits = 4 where operation = 'treg.people.email.find';
                 update public.topup_packages set active = false where code = 'pack_1000';`);
  const before = await snapshot(db);
  await step(db, 'deploy-all.sql re-run #1', deployAll);
  await step(db, 'deploy-all.sql re-run #2', deployAll);
  const after = await snapshot(db);
  if (before === after) pass('re-runs left pricing_config and topup_packages unchanged (operator edits kept)');
  else fail('re-run changed pricing:\n  before ' + before + '\n  after  ' + after);
  await db.exec(`update public.pricing_config set credits = 1 where operation = 'treg.people.email.find';
                 update public.topup_packages set active = true where code = 'pack_1000';`);

  const prices = (await db.query(`select operation, credits::float8 as credits, enabled,
                                         provider_cost_usd::float8 as cost, cost_source, version
                                    from public.pricing_config order by operation`)).rows;
  console.log('      pricing_config after deploy:');
  for (const p of prices) {
    console.log(`        ${p.operation.padEnd(26)} credits=${String(p.credits).padEnd(5)} enabled=${String(p.enabled).padEnd(5)} cost=${p.cost} ${p.cost_source} v${p.version}`);
  }

  await step(db, 'profile update after deploy', `
    insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000b1', 'p@x.invalid');
    update public.profiles set full_name = 'Probe' where id = '00000000-0000-4000-8000-0000000000b1';`);
  const guard = await db.query(`select tgname from pg_trigger where tgname = 'trg_profiles_server_columns'`);
  guard.rows.length ? fail('retired profile guard trigger present') : pass('retired profile guard trigger absent');

  const overloads = await db.query(`select count(*)::int n from pg_proc where proname = 'wallet_reserve'`);
  overloads.rows[0].n === 1 ? pass('exactly one wallet_reserve') : fail(`wallet_reserve overloads: ${overloads.rows[0].n}`);

  const suite = await step(db, 'credit_wallet_acceptance.sql', read('supabase/tests/credit_wallet_acceptance.sql'));
  if (suite) {
    const set = suite.find((r) => r.fields?.some((f) => f.name === 'result'));
    const rows = (set?.rows ?? []).map((r) => JSON.parse(r.result));
    const bad = rows.filter((r) => !r.ok);
    (rows.length && !bad.length ? pass : fail)(`acceptance checks ${rows.length - bad.length}/${rows.length}`);
    for (const r of bad) console.log(`      FAILED ${r.test}: ${JSON.stringify(r.detail)}`);
    const left = await db.query(`select count(*)::int n from auth.users where id = '00000000-0000-4000-8000-0000000acc01'`);
    left.rows[0].n === 0 ? pass('suite rolled back (no test user left)') : fail('suite left its test user behind');
  }

  const billing = await step(db, 'billing_review_acceptance.sql', read('supabase/tests/billing_review_acceptance.sql'));
  if (billing) {
    const set = billing.find((r) => r.fields?.some((f) => f.name === 'result'));
    const rows = (set?.rows ?? []).map((r) => JSON.parse(r.result));
    const bad = rows.filter((r) => !r.ok);
    (rows.length && !bad.length ? pass : fail)(`refund/dispute checks ${rows.length - bad.length}/${rows.length}`);
    for (const r of bad) console.log(`      FAILED ${r.test}: ${JSON.stringify(r.detail)}`);
  }

  const social = await step(db, 'enrichment_social_acceptance.sql', read('supabase/tests/enrichment_social_acceptance.sql'));
  if (social) {
    const set = social.find((r) => r.fields?.some((f) => f.name === 'result'));
    const rows = (set?.rows ?? []).map((r) => JSON.parse(r.result));
    const bad = rows.filter((r) => !r.ok);
    (rows.length && !bad.length ? pass : fail)(`enrichment/social checks ${rows.length - bad.length}/${rows.length}`);
    for (const r of bad) console.log(`      FAILED ${r.test}: ${JSON.stringify(r.detail)}`);
    const left = await db.query(`select count(*)::int n from auth.users where id = '00000000-0000-4000-8000-0000000acc02'`);
    left.rows[0].n === 0 ? pass('enrichment/social suite rolled back') : fail('enrichment/social suite left its test user behind');
  }

  // ---- Run B: with pg_cron / pg_net stand-ins --------------------------------
  const db2 = new PGlite();
  await step(db2, 'supabase + cron stubs', SUPABASE_STUBS + CRON_STUBS);
  await db2.exec(`create table public.service_secrets (name text primary key, value text not null, updated_at timestamptz not null default now());`);
  await db2.exec(`select cron.schedule('echo-daily-sweep', '0 * * * *',
                    'select net.http_post(url := ''https://REPLACE_WITH_PROJECT_REF.supabase.co/functions/v1/daily-sweep'')');`);
  if (await step(db2, 'deploy-all.sql with pg_cron, no project_url', deployAll)) {
    const jobs = (await db2.query(`select jobname from cron.job order by jobname`)).rows.map((r) => r.jobname);
    jobs.includes('echo-reap-stale') ? pass('reaper has its own cron job') : fail('no echo-reap-stale job: ' + jobs);
    !jobs.includes('echo-daily-sweep') ? pass('placeholder sweep job removed') : fail('placeholder sweep job kept');
    await db2.exec(`insert into public.service_secrets (name, value) values ('project_url', 'https://abcdefgh.supabase.co/')`);
    await step(db2, 'deploy-all.sql re-run with project_url set', deployAll);
    const sweep = (await db2.query(`select schedule, command from cron.job where jobname = 'echo-daily-sweep'`)).rows[0];
    sweep && sweep.command.includes("'https://abcdefgh.supabase.co/functions/v1/daily-sweep'") && sweep.schedule === '0 * * * *'
      ? pass('sweep job built from service_secrets.project_url')
      : fail('sweep job not built from config: ' + JSON.stringify(sweep));
    const reap = (await db2.query(`select schedule, command from cron.job where jobname = 'echo-reap-stale'`)).rows[0];
    reap && reap.command.includes('reap_stale_reservations')
      ? pass(`reaper job: ${reap.schedule} ${reap.command}`)
      : fail('reaper job missing after re-run');
  }
}

main().then(() => {
  console.log('-'.repeat(78));
  console.log(failures ? `${failures} failure(s)` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
