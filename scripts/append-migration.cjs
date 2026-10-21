// Appends one migration to supabase/deploy-all.sql, verbatim, under a section
// header.
//
// deploy-all.sql is a curated file, not a concatenation of every migration: the
// 20261024..20261101 block (the abandoned subscription and admin-pricing design)
// is deliberately excluded, because including it would reintroduce plan tables,
// admin functions and an admin column. So it cannot be regenerated — it has to be
// kept in step by hand, which is how the topup_packages policy drifted between
// this file, the migration and the running database without anyone noticing.
//
//   node scripts/append-migration.cjs <file>.sql             append once
//   node scripts/append-migration.cjs <file>.sql --replace   re-append the
//       current file in place of an earlier copy (only when it is the LAST
//       section, i.e. the migration is still being written)
//
// Run check-deploy-all.cjs after this to confirm nothing else is missing.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const OUT = path.join(ROOT, 'supabase', 'deploy-all.sql');

const migration = process.argv[2];
if (!migration || migration.startsWith('--')) {
  console.error('usage: node scripts/append-migration.cjs <migration-file>.sql [--replace]');
  process.exit(1);
}

const src = path.join(MIG, migration);
if (!fs.existsSync(src)) {
  console.error('no such migration:', migration);
  process.exit(1);
}

const body = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const current = fs.readFileSync(OUT, 'utf8');

// Every header line is an SQL comment. This script used to emit bare "====" and
// " <file>" lines, and psql then swallowed the statement after each (audit C1).
const rule = '-- ' + '='.repeat(75);
const thin = '-- ' + '-'.repeat(72);
const marker = `-- ${migration}`;
const header = `\n${rule}\n${marker}\n`;

let base = current;
if (process.argv.includes('--replace')) {
  const at = current.lastIndexOf(header);
  if (at < 0) {
    console.error(`--replace: no appended section for ${migration}`);
    process.exit(1);
  }
  const rest = current.slice(at + header.length);
  if (/\n-- =+\n-- +\d{8}[0-9]*_[a-z0-9_]+\.sql\n/.test(rest)) {
    console.error(`--replace: ${migration} is not the last section; edit deploy-all.sql by hand`);
    process.exit(1);
  }
  base = current.slice(0, at);
} else if (current.includes(`\n${marker}\n`) || current.includes(`\n ${migration}\n`)) {
  console.error(`refusing to append: ${migration} already appears in deploy-all.sql`);
  process.exit(1);
}

const section = ['', rule, marker, thin, '', body, ''].join('\n');

fs.writeFileSync(OUT, base.replace(/\s*$/, '\n') + section, 'utf8');

console.log(`${base === current ? 'appended' : 'replaced'} ${migration} in supabase/deploy-all.sql`);
console.log('now run: node scripts/check-deploy-all.cjs');
