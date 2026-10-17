// Proves the cron-driven path actually reaches the function.
//
//   node scripts/verify-sweep-cron.mjs
//
// cron.job_run_details.status = 'succeeded' only means the SQL ran. net.http_post
// returns a request id immediately and does not wait for the response, so a
// function that the gateway rejects with 401 still leaves every cron run looking
// green. That is how a dead hourly sweep went unnoticed: the runs were
// "succeeding" and nothing was being swept.
//
// This fires the same request cron fires, with the secret, and reads the real
// HTTP response out of net._http_response. It then fires the same request
// WITHOUT the secret, which must come back refused from the function's own check
// rather than the gateway's, because with JWT verification off the gateway is
// not doing anything and the function's check is the only gate.

const { execFileSync } = require('child_process');

const PSQL = process.env.PSQL_PATH;
if (!PSQL) {
  console.error('PSQL_PATH must point at psql, and the connection string must be');
  console.error('in the environment (PGDATABASE / PGHOST / PGPASSWORD / PGUSER).');
  console.error('The secret is read inside the query and never returned.');
  process.exit(1);
}

function sql(text) {
  return execFileSync(PSQL, ['-X', '-A', '-t', '-c', text], {
    encoding: 'utf8',
    env: process.env,
  }).trim();
}

const FIRE = `
  select net.http_post(
    url := 'https://fteoyqhogzuapfdledeg.supabase.co/functions/v1/daily-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-secret', (select value from public.service_secrets
                         where name = 'sweep_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );`;

const FIRE_NO_SECRET = `
  select net.http_post(
    url := 'https://fteoyqhogzuapfdledeg.supabase.co/functions/v1/daily-sweep',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );`;

function statusFor(id) {
  const out = sql(
    `select coalesce(status_code::text || ' ' || left(content, 200), 'pending')
       from net._http_response where id = ${id}`,
  );
  return out || 'pending (still in flight)';
}

function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  return ok ? 0 : 1;
}

let bad = 0;

console.log('firing the sweep with the cron secret');
const withId = sql(FIRE);
bad += check('cron reaches the function', statusFor(withId).startsWith('200'), statusFor(withId));

console.log('firing the same request with no secret');
const noId = sql(FIRE_NO_SECRET);
const noRes = statusFor(noId);
// Must be refused by the function, whose message is {"ok":false,...}. The
// gateway's own refusal says UNAUTHORIZED_NO_AUTH_HEADER, which would mean the
// gateway was still enforcing JWT verification and the flag is not what we think.
bad += check(
  'anonymous caller is refused',
  noRes.includes('unauthorized'),
  noRes,
);
bad += check(
  'refusal comes from the function, not the gateway',
  !noRes.includes('UNAUTHORIZED'),
  noRes.includes('UNAUTHORIZED') ? 'gateway is still enforcing JWT — deploy flag is wrong' : '',
);

process.exit(bad === 0 ? 0 : 1);
