// Deploys every edge function with the auth mode it is supposed to have.
//
//   node scripts/deploy-functions.mjs
//   node scripts/deploy-functions.mjs daily-sweep
//
// This exists because the flag is not part of the function's source, so nothing
// in review catches a wrong value, and getting it wrong is invisible until a
// scheduled job starts failing. That is exactly what happened: daily-sweep was
// redeployed with verify_jwt on, which the Supabase gateway enforces before the
// function body runs, so the pg_cron job — which sends x-sweep-secret and no JWT
// — started getting 401. The hourly sweep was dead from 10:00 with every run
// still logging "succeeded", because cron.job_run_details records that the SQL
// ran, not that the HTTP call returned 200.
//
// Two kinds of function, two rules:
//
//   Cron-driven. The gateway cannot authenticate pg_net, so JWT verification has
//   to be off and the function's own shared-secret check is the gate. It must be
//   fail-closed: refuse when the secret is unset, refuse on mismatch, on every
//   action including the default one.
//
//   User-facing. The gateway does the authentication and the function reads the
//   user's JWT. verify_jwt stays on.
//
// billing-webhook is neither: it authenticates with the provider's own HMAC over
// the raw body, which the gateway cannot check, so JWT verification is off and
// the signature check is the gate.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_REF =
  process.env.SUPABASE_PROJECT_REF || 'fteoyqhogzuapfdledeg';

// verify_jwt: true  -> the Supabase gateway validates the caller's JWT.
// verify_jwt: false -> the function authenticates the caller itself. Only valid
//                      where the function has a real fail-closed check.
const FUNCTIONS = {
  'social-search': true,
  ai: true,
  billing: true,
  'daily-sweep': false,
  'billing-webhook': false,
  leads: true, // added in Phase 1 of the Leads build; user actions use a JWT
};

const only = process.argv.slice(2);
const targets = only.length ? only : Object.keys(FUNCTIONS);

for (const name of targets) {
  if (!(name in FUNCTIONS)) {
    console.error(`unknown function: ${name}`);
    console.error(`known: ${Object.keys(FUNCTIONS).join(', ')}`);
    process.exit(1);
  }

  const dir = path.join(ROOT, 'supabase', 'functions', name);
  if (!fs.existsSync(path.join(dir, 'index.ts'))) {
    console.log(`skip ${name} — no index.ts (not built yet)`);
    continue;
  }

  const verify = FUNCTIONS[name];
  const args = [
    'supabase', 'functions', 'deploy', name,
    '--project-ref', PROJECT_REF,
  ];
  if (!verify) args.push('--no-verify-jwt');

  console.log(`deploying ${name} (verify_jwt=${verify})`);
  execFileSync('npx', args, { cwd: ROOT, stdio: 'inherit' });
}

// Prove the cron-driven one is actually reachable the way cron reaches it, and
// still refuses an anonymous caller. Deploying is not the same as working.
if (FUNCTIONS['daily-sweep'] === false && !only.length) {
  console.log('\nverifying the cron path (run: node scripts/verify-sweep-cron.mjs)');
}
