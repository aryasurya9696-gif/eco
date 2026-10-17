// Repairs dollar-quote delimiters in a migration, by position.
//
// A literal $$ written through a shell pipeline has twice arrived as a single $
// — once as `do $` and once as `as $` — which turns valid Postgres into a syntax
// error somewhere other than the character that changed. Rather than hunt for the
// cause each time, this walks the file and rebuilds any delimiter that is one
// character short, matching on line content rather than on a search string (a
// search string containing $$ is what gets mangled in the first place).

const fs = require('fs');

const D = String.fromCharCode(36);
const Q = D + D;

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/fix-dollar-quotes.cjs <file.sql>');
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const OPENERS = ['do ', 'as '];
let fixed = 0;

for (let i = 0; i < lines.length; i++) {
  const trimmed = lines[i].trim();

  // An opener that ended up one short: `do $` or `as $`.
  for (const kw of OPENERS) {
    if (trimmed === kw + D) {
      lines[i] = lines[i].replace(kw + D, kw + Q);
      fixed++;
    }
  }

  // A closer that ended up one short, at the start of a line.
  if (trimmed === D + ';') {
    lines[i] = lines[i].replace(D + ';', Q + ';');
    fixed++;
  }
}

fs.writeFileSync(file, lines.join('\n'), 'utf8');

const after = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const malformed = [];
for (const l of after) {
  const t = l.trim();
  if (t === D + ';' || t === D || t === 'do ' + D || t === 'as ' + D) malformed.push(JSON.stringify(l));
}

console.log(file);
console.log('  delimiters repaired:', fixed);
console.log('  malformed left:', malformed.length, malformed.join(' '));

process.exit(malformed.length ? 1 : 0);
