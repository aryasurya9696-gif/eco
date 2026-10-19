// Reports which migrations' database objects are actually present in
// supabase/deploy-all.sql.
//
// Checks for the objects each migration creates (tables, functions, views)
// rather than any distinctive line, because a comment line is not evidence that
// a migration's DDL made it into the file.
//
// deploy-all.sql is a curated file, not a concatenation of every migration. Two
// blocks are deliberately left out of it, for different reasons, and both are
// listed explicitly so that "missing" for them reads as intended rather than as
// fresh drift:
//   * 20261024 - 20261101. The abandoned subscription and admin-pricing design,
//     which 20261101_remove_billing took back out. Including it would bring back
//     plan tables, admin_set_* functions and an is_admin column - the opposite
//     of what this schema is.
//   * 20261108 - 20261120. The Leads feature, removed from the app and from this
//     file by 20261121_remove_leads.sql. The migrations stay in the repository
//     because they are the record of what Leads created, but every object in
//     them is dropped, so none of them may reappear in a fresh install.
//
//   node scripts/check-deploy-all.cjs     exits 1 if anything drifted
//
// This check exists because the topup_packages policy was widened on the running
// database, written into its migration, and missed here: three descriptions of
// one policy, two of them wrong, and no error anywhere.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const DEPLOY = path.join(ROOT, 'supabase', 'deploy-all.sql');

const BILLING_REASON = 'excluded by design (abandoned plan/admin design)';
const LEADS_REASON = 'excluded — feature removed by 20261121_remove_leads.sql';

const DELIBERATELY_EXCLUDED = new Map([
  ['20261024_billing_economics.sql', BILLING_REASON],
  ['20261025_credit_billing.sql', BILLING_REASON],
  ['20261026_credit_functions.sql', BILLING_REASON],
  ['20261027_billing_reports.sql', BILLING_REASON],
  ['20261028_refunds.sql', BILLING_REASON],
  ['20261029_admin_reader.sql', BILLING_REASON],
  ['20261030_credit_fixes.sql', BILLING_REASON],
  ['20261031_admin_pricing.sql', BILLING_REASON],
  ['20261101_remove_billing.sql', BILLING_REASON],

  ['20261108_leads.sql', LEADS_REASON],
  ['20261109_leads_pricing.sql', LEADS_REASON],
  ['20261110_leads_cron.sql', LEADS_REASON],
  ['20261111_estimate_breakdown.sql', LEADS_REASON],
  ['20261112_verify_only_ceiling.sql', LEADS_REASON],
  ['20261113_row_provider_cost.sql', LEADS_REASON],
  ['20261114_attempt_api_usage_link.sql', LEADS_REASON],
  ['20261115_estimate_matches_plan.sql', LEADS_REASON],
  ['20261116_leads_worker_lease.sql', LEADS_REASON],
  ['20261117_estimate_for_user.sql', LEADS_REASON],
  ['20261118_lead_database.sql', LEADS_REASON],
  ['20261119_leads_economics.sql', LEADS_REASON],
  ['20261120_lead_automations.sql', LEADS_REASON],
]);

const deploy = fs.readFileSync(DEPLOY, 'utf8').toLowerCase();

const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

const rows = [];

for (const file of files) {
  const body = fs.readFileSync(path.join(MIG, file), 'utf8').toLowerCase();

  const objects = new Set();
  for (const m of body.matchAll(
    /create\s+(?:or\s+replace\s+)?(?:table|function|materialized\s+view|view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/g,
  )) {
    objects.add(m[1]);
  }

  const names = [...objects];
  const missing = names.filter((n) => !deploy.includes(n));

  rows.push({
    file,
    created: names.length,
    missing,
    excluded: DELIBERATELY_EXCLUDED.get(file),
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('migration', 40) + pad('objects', 9) + 'state');
console.log('-'.repeat(100));

let drift = 0;

for (const r of rows) {
  let state;
  if (r.excluded) {
    state = r.excluded;
  } else if (r.created === 0) {
    state = 'no CREATE statements — nothing to check';
  } else if (r.missing.length === 0) {
    state = 'complete';
  } else {
    state = 'DRIFT — missing: ' + r.missing.join(', ');
    drift++;
  }
  console.log(pad(r.file, 40) + pad(r.created, 9) + state);
}

console.log('-'.repeat(100));
if (drift === 0) {
  console.log('no drift: every included migration is represented in deploy-all.sql');
} else {
  console.log(`${drift} migration(s) drifted. For each: node scripts/append-migration.cjs <file>`);
}

process.exit(drift === 0 ? 0 : 1);
