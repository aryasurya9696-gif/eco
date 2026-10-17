// Tests the CSV import and export logic.
//
//   node supabase/tests/leads-csv-tests.cjs
//
// Run against the TypeScript source rather than a copy: a copy would keep passing
// after the real file changed, which is the failure this whole suite exists to
// catch.
//
// The cases here are the ones that lose user data. A column that maps to the
// wrong field, a duplicate that deletes a real person, a spreadsheet formula in
// the user's own notes executing when they open their own export.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src', 'lib', 'leads-csv.ts');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'leads-csv-test');

// Compiled inside the project rather than the temp directory, because the file
// imports papaparse and xlsx at module scope and Node/TypeScript resolve those
// by walking up from the file. A temp dir outside the project cannot see them,
// which shows up as seven unrelated errors, four of them implicit-any in code
// that typechecks fine in place.
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(SRC, path.join(OUT, 'leads-csv.ts'));
fs.writeFileSync(
  path.join(OUT, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        // bundler + preserve rather than commonjs + node10: node10 is
        // deprecated and hard-errors on this TypeScript. The program has no
        // imports of its own beyond papaparse, which resolves from
        // node_modules either way.
        module: 'preserve',
        moduleResolution: 'bundler',
        esModuleInterop: true,
        skipLibCheck: true,
        strict: true,
        outDir: path.join(OUT, 'dist'),
      },
      include: ['leads-csv.ts'],
    },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(OUT, 'node_modules.txt'), path.join(ROOT, 'node_modules'));

try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(OUT, 'tsconfig.json')], {
    stdio: 'pipe',
    cwd: ROOT,
  });
} catch (e) {
  console.error('compile failed:');
  console.error(String(e.stdout || e.message).split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}

const dist = path.join(OUT, 'dist');

const M = require(path.join(dist, 'leads-csv.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// --- autoMap ---------------------------------------------------------------

{
  const { mapping, unmapped } = M.autoMap(['First Name', 'Last Name', 'Email', 'Company', 'Job Title', 'Notes']);
  check('first name maps', mapping.first_name === 'First Name');
  check('last name maps', mapping.last_name === 'Last Name');
  check('email maps', mapping.email === 'Email');
  check('company maps', mapping.company_name === 'Company');
  check('title maps', mapping.title === 'Job Title');
  check('unknown column is passthrough', unmapped.length === 1 && unmapped[0] === 'Notes');
}

{
  // "email" is a substring of both "work email address" and "email status". An
  // exact match has to win over column order.
  const { mapping } = M.autoMap(['email status', 'work email address']);
  check('exact email beats a column that merely contains it', mapping.email === 'work email address');
}

{
  const { mapping } = M.autoMap(['Full Name', 'Company Name']);
  check('full name maps to person_name', mapping.person_name === 'Full Name');
  check('company name maps to company_name', mapping.company_name === 'Company Name');
}

{
  const { mapping } = M.autoMap(['name', 'company']);
  check('bare "name" maps to person_name', mapping.person_name === 'name');
  check('bare "company" maps to company_name', mapping.company_name === 'company');
}

{
  // One column cannot satisfy two fields.
  const { mapping } = M.autoMap(['Name']);
  check('a header is claimed only once', Object.values(mapping).filter((v) => v === 'Name').length === 1);
}

// --- domain normalisation --------------------------------------------------

check('url reduces to a domain', M.normaliseDomain('https://acme.com/pricing?a=1') === 'acme.com');
check('bare domain is unchanged', M.normaliseDomain('ACME.com') === 'acme.com');
check('domain with a port is trimmed', M.normaliseDomain('acme.com:8080') === 'acme.com');
check('email reduces to its domain', M.normaliseDomain('jo@acme.com') === 'acme.com');
check('a word is not a domain', M.normaliseDomain('Acme') === undefined);
check('empty is not a domain', M.normaliseDomain('') === undefined);

// --- email normalisation ---------------------------------------------------

check('valid email lowercased', M.normaliseEmail('Jo@Acme.com') === 'jo@acme.com');
check('missing at sign rejected', M.normaliseEmail('joacme.com') === undefined);
check('two addresses in one cell rejected', M.normaliseEmail('a@x.com;b@y.com') === undefined);
check('example.com accepted — it is a real shape', M.normaliseEmail('a@example.com') === 'a@example.com');

// --- mapping + dedupe ------------------------------------------------------

{
  const headers = ['First Name', 'Last Name', 'Email', 'Website', 'Notes'];
  const rows = [
    { 'First Name': 'Alison', 'Last Name': 'Fenwick', Email: 'a@fenwick.example', Website: 'https://fenwick.example', Notes: 'met at expo' },
    { 'First Name': 'Alison', 'Last Name': 'Fenwick', Email: 'a@fenwick.example', Website: 'https://fenwick.example', Notes: 'duplicate' },
    { 'First Name': 'Raj', 'Last Name': 'Patel', Email: 'A@Hartley.example', Website: 'https://hartley.example', Notes: '' },
    { 'First Name': 'Raj', 'Last Name': 'Patel', Email: 'x@other.example', Website: 'https://hartley.example', Notes: 'same person, other address' },
  ];

  const { mapping, unmapped } = M.autoMap(headers);
  const mapped = M.applyMapping(rows, mapping, unmapped);
  check('first and last are joined into a person', mapped.rows[0].person_name === 'Alison Fenwick');
  check('notes survive as passthrough', mapped.rows[0].extra.Notes === 'met at expo');
  check('website yields a domain', mapped.rows[0].domain === 'fenwick.example');

  const d = M.dedupe(mapped.rows);
  check('exact duplicate removed', d.removed === 1);
  check('same person, different email kept — that is two addresses not two people', d.rows.length === 3);
}

{
  // Three people at one company are three leads. Merging on domain would delete
  // two of them.
  const rows = [
    { person_name: 'A One', domain: 'acme.example' },
    { person_name: 'B Two', domain: 'acme.example' },
    { person_name: 'C Three', domain: 'acme.example' },
  ];
  const d = M.dedupe(rows.map((r) => ({ ...r, extra: {} })));
  check('three people at one domain are all kept', d.rows.length === 3 && d.removed === 0);
}

{
  // The same person at the same domain with no email is a duplicate.
  const rows = [
    { person_name: 'Dana Quill', domain: 'qv.example', extra: {} },
    { person_name: 'dana  quill', domain: 'qv.example', extra: {} },
  ];
  const d = M.dedupe(rows);
  check('name+domain duplicate removed, case and spacing insensitive', d.removed === 1 && d.rows.length === 1);
}

{
  // Nothing to look anyone up with. Kept, and counted apart from duplicates,
  // because silently dropping a row the user can see is worse than keeping one
  // that will fail.
  const rows = [{ extra: {} }, { person_name: 'Someone', domain: 'x.example', extra: {} }];
  const d = M.dedupe(rows);
  check('a row with nothing usable is kept and counted as unusable', d.unusable === 1 && d.rows.length === 2);
}

// --- CSV output ------------------------------------------------------------

{
  const cols = [
    { header: 'Email', value: (r) => r.email },
    { header: 'Notes', value: (r) => r.extra?.Notes },
  ];

  const csv = M.toCsv(cols, [{ email: 'a@b.com', extra: { Notes: 'plain' } }]);
  check('plain row exports', csv.includes('a@b.com') && csv.includes('plain'));
}

{
  // A cell starting with = is executable in Excel and Sheets. A lead list is
  // exactly the data that arrives from outside.
  const cols = [{ header: 'Notes', value: (r) => r.notes }];
  const csv = M.toCsv(cols, [
    { notes: '=HYPERLINK("http://evil.example","click")' },
    { notes: '+1 555 0100' },
    { notes: '@someone' },
  ]);
  check('a formula is neutralised', csv.includes(`'=HYPERLINK`) && !/^[=+@]/m.test(csv.split('\r\n')[1]));
  check('a plus-prefixed value is neutralised', csv.includes(`'+1 555`));
  check('an at-prefixed value is neutralised', csv.includes(`'@someone`));
}

{
  const cols = [{ header: 'Note', value: (r) => r.n }];
  const csv = M.toCsv(cols, [{ n: 'has, comma' }, { n: 'has "quotes"' }, { n: 'has\nnewline' }]);
  check('a comma is quoted', csv.includes('"has, comma"'));
  check('an inner quote is doubled', csv.includes('"has ""quotes"""'));
  check('a newline is quoted', csv.includes('"has\nnewline"'));
}

{
  const cols = [{ header: 'A', value: (r) => r.a }];
  const csv = M.toCsv(cols, [{ a: null }, { a: undefined }]);
  check('a missing value is empty, not "null"', !csv.includes('null') && !csv.includes('undefined'));
}

// --- filenames -------------------------------------------------------------

{
  const name = M.exportFilename('78fb7e5c-aad1-4af9-9df1-bbc71ee26eb6', 50, 'csv');
  check('filename carries the run and the count', name.startsWith('leads-78fb7e5c-') && name.includes('50-') && name.endsWith('.csv'));
}

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);
