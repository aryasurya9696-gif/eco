// Runs a SQL acceptance suite against the linked project and reports the result.
//
//   node scripts/run-sql-test.mjs credit_wallet_acceptance
//   node scripts/run-sql-test.mjs credit_wallet_acceptance --yes
//
// The suites in supabase/tests/ are not unit tests. They run against the live
// database, because most of what they assert — that a reserve refuses rather
// than overdrawing, that a settle draws grants FIFO, that a cross-workspace
// delete is refused — only means anything against the real schema, the real
// RLS and the real constraints. They clean up after themselves.
//
// Requires psql and a connection string in the environment:
//
//   PSQL_PATH=C:\Program Files\PostgreSQL\17\bin\psql.exe
//   PGHOST=... PGPORT=5432 PGDATABASE=postgres PGUSER=postgres PGPASSWORD=...
//
// The suites create helper functions in pg_temp and write to a real test user,
// so they are refused without --yes unless CI is set: it replaces the test user
// with the one named at the top of the suite and writes real rows.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const name = process.argv[2];

if (!name) {
  console.error('usage: node scripts/run-sql-test.mjs <suite-name> [--yes]');
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

if (!process.argv.includes('--yes') && !process.env.CI) {
  console.error('This writes to the live database (it reserves, settles and');
  console.error('releases real credits on a test user) and it truncates nothing');
  console.error('outside that user. Re-run with --yes to proceed.');
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

// The suites end with `select * from _results order by ord`. Each row is
// (ord, test, ok, detail-as-json).
const start = sql.lastIndexOf('\n{');
const tail = start >= 0 ? sql.slice(start) : sql.trim();
let rows;
try {
  rows = tail.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch (e) {
  console.error('could not parse the result rows. Raw tail:\n' + tail.slice(0, 2000));
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
