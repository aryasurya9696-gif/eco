// Runs a SQL acceptance suite against the linked project and reports the result.
//
//   node scripts/run-sql-test.cjs credit_wallet_acceptance --yes
//   node scripts/run-sql-test.cjs credit_wallet_concurrency --yes --local
//
// The suites in supabase/tests/ are not unit tests. They run against the live
// database, because most of what they assert — that a reserve refuses rather
// than overdrawing, that a settle draws grants FIFO, that a cross-workspace
// delete is refused — only means anything against the real schema, the real
// RLS and the real constraints. Each suite runs inside a single transaction that
// ends in ROLLBACK, so nothing it writes survives the run.
//
// Requires psql and a connection string in the environment:
//
//   PSQL_PATH=C:\Program Files\PostgreSQL\17\bin\psql.exe
//   PGHOST=... PGPORT=5432 PGDATABASE=postgres PGUSER=postgres PGPASSWORD=...
//
// The suites create helper functions in pg_temp and a throwaway test user, all
// inside a transaction that is rolled back. They are still refused without --yes
// unless CI is set, because they run against whatever database PG* points at.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const name = process.argv[2];

if (!name) {
  console.error('usage: node scripts/run-sql-test.cjs <suite-name> [--yes]');
  console.error('');
  const dir = path.join(ROOT, 'supabase', 'tests');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.sql')) console.error('  ' + f.replace(/\.sql$/, ''));
  }
  process.exit(1);
}

const file = path.join(ROOT, 'supabase', 'tests', name + '.sql');
if (!fs.existsSync(file)) {
  console.error('no such suite:', name);
  process.exit(1);
}

const psql = process.env.PSQL_PATH;
if (!psql) {
  console.error('PSQL_PATH is not set. Point it at psql and put the connection');
  console.error('string in PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD.');
  process.exit(1);
}

// credit_wallet_concurrency COMMITS a synthetic fixture (parallel dblink
// connections cannot see uncommitted rows) and deletes it afterwards, so it is
// refused unless --local is passed and PGHOST is a local address.
const COMMITS_FIXTURES = new Set(['credit_wallet_concurrency']);
if (COMMITS_FIXTURES.has(name)) {
  const host = String(process.env.PGHOST || 'localhost').toLowerCase();
  const local = ['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.localhost');
  if (!process.argv.includes('--local') || !local) {
    console.error(`${name} commits fixture rows and needs dblink: local or CI databases only.`);
    console.error('Point PGHOST at a local database and pass --local.');
    process.exit(1);
  }
}

if (!process.argv.includes('--yes') && !process.env.CI) {
  console.error('This runs against the live database. The suite works on a');
  console.error('throwaway test user inside one transaction and rolls it back,');
  console.error('but it still takes row locks while it runs. Re-run with --yes.');
  process.exit(1);
}

// -v ON_ERROR_STOP makes the first failing statement abort the run, which is what
// a suite needs: a check that cannot even execute must not be reported as a
// pass, and every later assertion is then meaningless.
let sql;
let out;
try {
  out = execFileSync(
    psql,
    ['-X', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-f', file],
    { encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024 },
  );
  sql = out;
} catch (e) {
  // ON_ERROR_STOP aborts, and psql puts the failing statement on stderr.
  console.error('suite aborted:');
  console.error(String(e.stderr || e.message).trim().split('\n').slice(-6).join('\n'));
  process.exit(1);
}

// Each suite prints one JSON object per check, from
//   select row_to_json(r)::text from (select ord, test, ok, detail ...) r
// With -A -t each is one line starting with {"ord". Everything else psql prints
// (function results, counts) is ignored. The old parser expected JSON while the
// suites printed pipe-separated rows, so it could never read a result (N11).
let rows;
try {
  rows = sql.split(/\r?\n/).filter((l) => l.startsWith('{"ord"')).map((l) => JSON.parse(l));
} catch (e) {
  console.error('could not parse a result row: ' + e.message);
  process.exit(1);
}
if (rows.length === 0) {
  console.error('no result rows found. Raw tail:\n' + sql.slice(-2000));
  process.exit(1);
}

const failed = rows.filter((r) => !r.ok);
const pad = (s, n) => String(s).padEnd(n);

for (const r of rows) {
  console.log(
    (r.ok ? '  ok  ' : '  FAIL') +
      '  ' +
      pad(r.ord, 4) +
      pad(r.test, 52) +
      (r.ok ? '' : '  ' + JSON.stringify(r.detail)),
  );
}

console.log('-'.repeat(78));
console.log(`${rows.length - failed.length}/${rows.length} passed`);

if (failed.length) {
  console.log(`\n${failed.length} failed:`);
  for (const f of failed) {
    console.log('  ' + pad(f.ord, 4) + f.test);
    console.log('        ' + JSON.stringify(f.detail));
  }
  process.exit(1);
}
