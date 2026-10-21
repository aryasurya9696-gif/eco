// Checks supabase/deploy-all.sql against the migrations, and checks the file
// itself for the defects that have broken it before.
//
//   node scripts/check-deploy-all.cjs     exits 1 on any drift or defect
//
// 1. Drift. For each included migration, every object it creates (table,
//    function, view, index, trigger, policy) must be created in deploy-all.sql
//    too. Names are matched as whole identifiers in CREATE statements, not as
//    substrings anywhere in the file, so a comment mentioning a name is not
//    evidence that the DDL made it in.
//
// 2. Structure (audit C1, M9, N6). Lexed with SQL quoting rules:
//    * no unterminated '...' string, "..." identifier or $tag$ body
//    * no bare separator or file-name line outside comments ("=====",
//      " 20261126_x.sql"): psql swallowed the statement after each of these
//    * every CREATE POLICY is preceded by DROP POLICY IF EXISTS for the same
//      policy and table, so a re-run cannot fail on an existing policy
//    * pricing_config / topup_packages seeds are insert-only (no ON CONFLICT
//      ... DO UPDATE), so a re-run never reverts a price
//    * no REPLACE_WITH_PROJECT_REF placeholder in executable SQL
//
// deploy-all.sql is a curated file, not a concatenation of every migration. Two
// blocks are deliberately left out of it:
//   * 20261024 - 20261101. The abandoned subscription and admin-pricing design,
//     which 20261101_remove_billing took back out.
//   * The old Leads feature (20261108 - 20261120) has been deleted from the
//     repository; 20261121_remove_leads.sql drops its objects and is inlined.
// 20261023_scheduled_sweeps.sql is replaced by configure_echo_cron() in
// 20261127 (its literal project-ref URL could never work), so its cron job is
// not expected verbatim.
//
// This check is a static one. scripts/verify-deploy-local.cjs actually applies
// the file (fresh + two re-runs) on a throwaway Postgres.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const DEPLOY = path.join(ROOT, 'supabase', 'deploy-all.sql');

const BILLING_REASON = 'excluded by design (abandoned plan/admin design)';
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
  ['20261016_lead_selling_credits.sql', 'excluded: legacy upgrade path; 20261018 drops its tables'],
]);

// Objects later migrations retired. deploy-all.sql only DROPS these (audit C2,
// L3), so their CREATE in an older migration is not drift.
const RETIRED_OBJECTS = new Set([
  'function guard_profile_server_columns', 'trigger trg_profiles_server_columns',
  'function apply_subscription_plan', 'function guard_profile_webhook',
  'trigger trg_profiles_webhook_guard', 'function plan_keyword_limit',
]);

// ---------------------------------------------------------------------------
// A small SQL lexer: returns the executable text with comments and string
// contents blanked out (same length, newlines kept), plus any lexing errors.
// Dollar-quoted bodies are kept, because function bodies contain DDL that
// matters (e.g. EXECUTE format(...) is still checked by the regexes below only
// where it is literal SQL).
// ---------------------------------------------------------------------------
function lex(src) {
  let out = '';
  const errors = [];
  let i = 0;
  const lineAt = (pos) => src.slice(0, pos).split('\n').length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '-' && next === '-') {
      const e = src.indexOf('\n', i);
      const j = e < 0 ? src.length : e;
      out += blank(src.slice(i, j));
      i = j;
    } else if (ch === '/' && next === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) { errors.push(`unterminated /* comment at line ${lineAt(i)}`); break; }
      out += blank(src.slice(i, e + 2));
      i = e + 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length && !(src[j] === ch && src[j + 1] !== ch)) j += src[j] === ch ? 2 : 1;
      if (j >= src.length) { errors.push(`unterminated ${ch} quote at line ${lineAt(i)}`); break; }
      // String contents are blanked; quoted identifiers are kept.
      out += ch === '"' ? src.slice(i, j + 1) : ch + blank(src.slice(i + 1, j)) + ch;
      i = j + 1;
    } else if (ch === '$' && /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.test(src.slice(i, i + 64)) && !/[A-Za-z0-9_]/.test(src[i - 1] || '')) {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(src.slice(i, i + 64))[0];
      const e = src.indexOf(tag, i + tag.length);
      if (e < 0) { errors.push(`unterminated ${tag} body at line ${lineAt(i)}`); break; }
      // Keep the body (it is SQL) but lex it on its own for quote balance.
      const inner = lex(src.slice(i + tag.length, e));
      for (const err of inner.errors) errors.push(`${err} (inside ${tag} body starting line ${lineAt(i)})`);
      out += tag + inner.text + tag;
      i = e + tag.length;
    } else {
      out += ch;
      i++;
    }
  }
  return { text: out, errors };
}

const OBJECT_RE = new RegExp(
  String.raw`create\s+(?:or\s+replace\s+)?(?:unique\s+)?` +
  String.raw`(table|function|materialized\s+view|view|index|trigger|policy)\s+` +
  String.raw`(?:if\s+not\s+exists\s+)?(?:(?:public|auth)\.)?"?([a-z_][a-z0-9_]*)"?`,
  'g',
);

function objectsOf(sqlLower) {
  const set = new Set();
  for (const m of sqlLower.matchAll(OBJECT_RE)) set.add(`${m[1].replace(/\s+/g, ' ')} ${m[2]}`);
  return set;
}

const deployRaw = fs.readFileSync(DEPLOY, 'utf8').replace(/\r\n/g, '\n');
const deployLex = lex(deployRaw);
const deploySql = deployLex.text.toLowerCase();
const deployObjects = objectsOf(deploySql);

const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const pad = (s, n) => String(s).padEnd(n);

console.log(pad('migration', 40) + pad('objects', 9) + 'state');
console.log('-'.repeat(100));

let drift = 0;
for (const file of files) {
  const excluded = DELIBERATELY_EXCLUDED.get(file);
  const body = lex(fs.readFileSync(path.join(MIG, file), 'utf8').replace(/\r\n/g, '\n')).text.toLowerCase();
  const names = [...objectsOf(body)];
  const missing = names.filter((n) => !deployObjects.has(n) && !RETIRED_OBJECTS.has(n));
  let state;
  if (excluded) state = excluded;
  else if (names.length === 0) state = 'no CREATE statements — nothing to check';
  else if (missing.length === 0) state = 'complete';
  else { state = 'DRIFT — missing: ' + missing.join(', '); drift++; }
  console.log(pad(file, 40) + pad(names.length, 9) + state);
}
console.log('-'.repeat(100));

// ---------------------------------------------------------------------------
// Structural checks on deploy-all.sql
// ---------------------------------------------------------------------------
const defects = [...deployLex.errors];
const rawLines = deployRaw.split('\n');
const lexLines = deployLex.text.split('\n');

lexLines.forEach((line, idx) => {
  const t = line.trim();
  if (!t) return;
  // Comment lines are blank after lexing, so any separator left is bare SQL.
  if (/^[=-]{3,}$/.test(t)) {
    defects.push(`line ${idx + 1}: bare separator outside a comment: ${rawLines[idx].trim().slice(0, 40)}`);
  }
  if (/^\d{8,14}_[a-z0-9_]+\.sql$/i.test(t)) {
    defects.push(`line ${idx + 1}: bare migration file name outside a comment: ${t}`);
  }
});

// CREATE POLICY needs a DROP POLICY IF EXISTS for the same (policy, table) first.
const policyRe = /create\s+policy\s+("?)([a-z_][a-z0-9_ ]*?)\1\s+on\s+(?:public\.)?([a-z_][a-z0-9_]*)/g;
for (const m of deploySql.matchAll(policyRe)) {
  const [, , pol, table] = m;
  const before = deploySql.slice(0, m.index);
  const dropRe = new RegExp(String.raw`drop\s+policy\s+if\s+exists\s+"?` + pol.replace(/ /g, '\\s+') +
                            String.raw`"?\s+on\s+(?:public\.)?` + table + String.raw`\b`);
  if (!dropRe.test(before)) {
    const line = deploySql.slice(0, m.index).split('\n').length;
    defects.push(`line ${line}: create policy ${pol} on ${table} without a prior drop policy if exists`);
  }
}
// Seeds must be insert-only.
const seedRe = /insert\s+into\s+(?:public\.)?(pricing_config|topup_packages)\b[\s\S]*?;/g;
for (const m of deploySql.matchAll(seedRe)) {
  if (/on\s+conflict[\s\S]*?do\s+update/.test(m[0])) {
    const line = deploySql.slice(0, m.index).split('\n').length;
    defects.push(`line ${line}: ${m[1]} seed upserts (ON CONFLICT DO UPDATE); seeds must be insert-only (M9)`);
  }
}

// Placeholder URLs in executable SQL (dollar bodies are kept by the lexer).
lexLines.forEach((line, idx) => {
  if (/replace_with_project_ref/i.test(line) && !/like\s*\$\d/i.test(line)) {
    defects.push(`line ${idx + 1}: REPLACE_WITH_PROJECT_REF placeholder in executable SQL`);
  }
});

if (defects.length) {
  console.log(`${defects.length} structural defect(s) in deploy-all.sql:`);
  for (const d of defects) console.log('  ' + d);
} else {
  console.log('structure: quotes balanced, no bare separators, policies re-runnable, seeds insert-only');
}

if (drift === 0) {
  console.log('no drift: every included migration is represented in deploy-all.sql');
} else {
  console.log(`${drift} migration(s) drifted. For each: node scripts/append-migration.cjs <file>`);
}

process.exit(drift === 0 && defects.length === 0 ? 0 : 1);
