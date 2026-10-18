// Checks every database RPC the leads function calls against the SQL that
// defines it.
//
//   node supabase/tests/lead-rpc-signature-tests.cjs
//
// PostgREST resolves a function by the names of the arguments it is sent, so an
// argument named differently from the SQL parameter is not a type error anywhere
// - it is a "function not found" at runtime, on every call. That is exactly how
// the worker shipped: wallet_reserve was sent p_metadata (the parameter is
// p_context), wallet_settle p_provider_cost_usd (p_provider_cost), wallet_release
// p_note (p_reason), and estimate_lead_run was called with no user at all. No run
// could be priced, and no chunk could reserve.
//
// For each `.rpc('name', { ... })` in supabase/functions/leads/*.ts this asserts
// that the function exists in some migration, that every argument sent is one of
// its parameters, and that every parameter without a default is sent. The latest
// migration's definition of a function wins, which is how they apply.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FN_DIR = path.join(ROOT, 'supabase', 'functions', 'leads');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

// Excluded exactly as deploy-all.sql excludes them: the abandoned subscription
// design, never applied to a fresh install.
const EXCLUDED = new Set([
  '20261024_billing_economics.sql', '20261025_credit_billing.sql', '20261026_credit_functions.sql',
  '20261027_billing_reports.sql', '20261028_refunds.sql', '20261029_admin_reader.sql',
  '20261030_credit_fixes.sql', '20261031_admin_pricing.sql',
]);

// --- SQL: name -> [{ name, hasDefault }] -----------------------------------
const signatures = new Map();
for (const file of fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && !EXCLUDED.has(f)).sort()) {
  const sql = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
  const re = /create\s+or\s+replace\s+function\s+public\.([a-z_0-9]+)\s*\(([\s\S]*?)\)\s*returns/gi;
  let m;
  while ((m = re.exec(sql))) {
    const params = m[2]
      .split(/,(?![^()]*\))/)
      .map((p) => p.replace(/--.*$/gm, '').trim())
      .filter(Boolean)
      .map((p) => ({ name: p.split(/\s+/)[0].toLowerCase(), hasDefault: /\bdefault\b/i.test(p) }));
    // Later files overwrite earlier ones, as applying them in order does.
    signatures.set(m[1].toLowerCase(), { params, file });
  }
  // A dropped signature with nothing after it is gone.
  const drop = /drop\s+function\s+if\s+exists\s+public\.([a-z_0-9]+)\s*\(/gi;
  let d;
  while ((d = drop.exec(sql))) {
    const later = sql.slice(d.index).match(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${d[1]}\\s*\\(`, 'i'));
    if (!later) signatures.delete(d[1].toLowerCase());
  }
}

// --- TS: every rpc call and the keys of its argument object ----------------
const calls = [];
for (const file of fs.readdirSync(FN_DIR).filter((f) => f.endsWith('.ts'))) {
  const src = fs.readFileSync(path.join(FN_DIR, file), 'utf8');
  const re = /\.rpc\(\s*'([a-z_0-9]+)'\s*(?:,\s*\{([\s\S]*?)\}\s*)?\)/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    // Top-level keys only: strip nested objects first.
    let body = m[2] ?? '';
    let prev;
    do {
      prev = body;
      body = body.replace(/\{[^{}]*\}/g, '');
    } while (body !== prev);
    const keys = [...body.matchAll(/(?:^|,|\n)\s*(p_[a-z_0-9]+)\s*(?::|,|$)/g)].map((k) => k[1]);
    calls.push({ file, line, name: m[1], keys });
  }
}

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
};

check('found rpc calls to check', calls.length >= 10, calls.length);

for (const c of calls) {
  const where = `${c.file}:${c.line} ${c.name}`;
  const sig = signatures.get(c.name);
  check(`${where}: function is defined in a migration`, Boolean(sig));
  if (!sig) continue;
  const names = sig.params.map((p) => p.name);
  const unknown = c.keys.filter((k) => !names.includes(k));
  check(`${where}: every argument is a parameter (${sig.file})`, unknown.length === 0, { unknown, params: names });
  const missing = sig.params.filter((p) => !p.hasDefault && !c.keys.includes(p.name)).map((p) => p.name);
  check(`${where}: every required parameter is sent`, missing.length === 0, missing);
}

// The specific ones this file was written after, by name, so a regression reads plainly.
const named = (n) => calls.filter((c) => c.name === n);
check('wallet_reserve sends p_context', named('wallet_reserve').every((c) => c.keys.includes('p_context')));
check('wallet_settle sends p_provider_cost', named('wallet_settle').every((c) => c.keys.includes('p_provider_cost')));
check('wallet_release sends p_reason', named('wallet_release').every((c) => !c.keys.includes('p_note')));
check('estimate_lead_run always sends p_user', named('estimate_lead_run').length > 0 && named('estimate_lead_run').every((c) => c.keys.includes('p_user')));

// Automations (20261120). Both are called from automations.ts and must be the
// service-role functions the migration defines.
check('lead_automations_claim_due is called', named('lead_automations_claim_due').length === 1);
check('lead_automations_claim_due sends p_limit and p_seconds',
  named('lead_automations_claim_due').every((c) => c.keys.includes('p_limit') && c.keys.includes('p_seconds')));
check('lead_automation_month_committed is called', named('lead_automation_month_committed').length >= 1);
check('lead_automation_month_committed sends p_automation and p_since',
  named('lead_automation_month_committed').every((c) => c.keys.includes('p_automation') && c.keys.includes('p_since')));
check('lead_automations_claim_due defined in 20261120', signatures.get('lead_automations_claim_due')?.file === '20261120_lead_automations.sql');
check('lead_automation_month_committed defined in 20261120', signatures.get('lead_automation_month_committed')?.file === '20261120_lead_automations.sql');

// A PostgREST builder is a thenable: an async function that returns one, or an
// await on one, runs the query and yields its result instead of the builder.
// contactsFilter shipped that way once, which broke every People query.
{
  const ws = fs.readFileSync(path.join(FN_DIR, 'workspace.ts'), 'utf8');
  check('contactsFilter is not async', !ws.includes('async function contactsFilter'));
  check('contactsFilter is never awaited', !ws.includes('await contactsFilter('));
}

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);
process.exit(fails.length ? 1 : 0);
