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
// Run check-deploy-all.cjs after this to confirm nothing else is missing.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const OUT = path.join(ROOT, 'supabase', 'deploy-all.sql');

const migration = process.argv[2];
if (!migration) {
  console.error('usage: node scripts/append-migration.cjs <migration-file>.sql');
  process.exit(1);
}

const src = path.join(MIG, migration);
if (!fs.existsSync(src)) {
  console.error('no such migration:', migration);
  process.exit(1);
}

const body = fs.readFileSync(src, 'utf8').trimEnd();
const current = fs.readFileSync(OUT, 'utf8');

const marker = ` ${migration}`;
if (current.includes(marker)) {
  console.error(`refusing to append: ${migration} already appears in deploy-all.sql`);
  process.exit(1);
}

const rule = '='.repeat(78);
const thin = '-'.repeat(75);

const section = [
  '',
  rule,
  marker,
  thin,
  '',
  body,
  '',
].join('\n');

fs.writeFileSync(OUT, current.replace(/\s*$/, '\n') + section, 'utf8');

console.log(`appended ${migration} to supabase/deploy-all.sql`);
console.log('now run: node scripts/check-deploy-all.cjs');
