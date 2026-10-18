// Tests the list readers: companies, people, phone, company records.
//
//   node supabase/tests/lead-read-lists-tests.cjs
//
// A company search is the step that creates every row a run will ever have, so a
// reader that returns nothing here is not a missed opportunity — it is a run that
// completes instantly with zero leads and looks like it worked.
//
// The other failure is worse: returning something that is not a company. "title"
// appears in both a company record and a person's job title, and taking the wrong
// one puts a job title in the domain column, which every later step then trusts.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-read-lists-test');

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'supabase', 'functions', 'leads', 'read-lists.ts'), path.join(OUT, 'read-lists.ts'));
fs.writeFileSync(
  path.join(OUT, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022'],
        module: 'preserve',
        moduleResolution: 'bundler',
        strict: true,
        outDir: path.join(OUT, 'dist'),
      },
      files: ['read-lists.ts'],
    },
    null,
    2,
  ),
);

try {
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(OUT, 'tsconfig.json')],
    { stdio: 'pipe', cwd: ROOT },
  );
} catch (e) {
  console.error('compile failed:');
  console.error(String(e.stdout || e.message).split('\n').slice(0, 12).join('\n'));
  process.exit(1);
}

const R = require(path.join(OUT, 'dist', 'read-lists.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// --- nothing to read ------------------------------------------------------

check('null body', R.readCompanies(null).length === 0);
check('an empty object', R.readCompanies({}).length === 0);
check('an error envelope', R.readCompanies({ error: 'quota exceeded', code: 429 }).length === 0);
check('a string', R.readCompanies('nope').length === 0);
check('people from nothing', R.readPeople({}).length === 0);
check('phone from nothing', R.readPhone({}) === null);
check('a record from nothing', R.readCompanyRecord({}) === null);

// --- companies: the shapes providers actually use --------------------------

check('results array', R.readCompanies({ results: [{ name: 'Acme', domain: 'acme.com' }] }).length === 1);
check('data array', R.readCompanies({ data: [{ name: 'Acme', domain: 'acme.com' }] }).length === 1);
check('companies array', R.readCompanies({ companies: [{ domain: 'acme.com' }] }).length === 1);
check('items array', R.readCompanies({ items: [{ domain: 'acme.com' }] }).length === 1);

// One level of nesting, which several providers use.
check('nested one level', R.readCompanies({ data: { results: [{ domain: 'acme.com' }] } }).length === 1);
check('nested two levels', R.readCompanies({ data: { results: { items: [{ domain: 'acme.com' }] } } }).length === 1);

// A bare array as the whole body.
check('a bare array body', R.readCompanies([{ domain: 'acme.com' }]).length === 1);

// A single company rather than a list.
check('a single company object', R.readCompanies({ name: 'Acme', domain: 'acme.com' }).length === 1);

// --- companies: the domain is what makes a row workable -------------------

check('a url becomes a domain', R.readCompanies({ url: 'https://www.acme.com/about' })[0]?.domain === 'acme.com');
check('a www host loses the prefix', R.readCompanies({ website: 'www.acme.com' })[0]?.domain === 'acme.com');
check('a port is trimmed', R.readCompanies({ domain: 'acme.com:8443' })[0]?.domain === 'acme.com');
check('uppercase is lowered', R.readCompanies({ domain: 'ACME.COM' })[0]?.domain === 'acme.com');

// The dangerous one. "title" is a company name in some shapes and a job title in
// others, and a job title in the domain column is trusted by every later step.
check('a job title is not a domain', R.readCompanies({ title: 'Chief Executive Officer', name: 'Acme' }).length === 0);
check('a bare word is not a domain', R.readCompanies({ name: 'Acme' }).length === 0);
check('a trailing dot is not a domain', R.readCompanies({ domain: 'acme.' }).length === 0);
check('a domain with a space is refused', R.readCompanies({ domain: 'my acme' }).length === 0);

check('the name is read', R.readCompanies({ name: 'Acme Ltd', domain: 'acme.com' })[0]?.name === 'Acme Ltd');
check('a missing name is null, not blank', R.readCompanies({ domain: 'acme.com' })[0]?.name === null);
check('the logo is read', R.readCompanies({ domain: 'acme.com', logo_url: 'https://x/l.png' })[0]?.logoUrl === 'https://x/l.png');
check('a missing logo is null', R.readCompanies({ domain: 'acme.com' })[0]?.logoUrl === null);

// --- companies: duplicates are one company's worth of lookups --------------

check(
  'the same domain twice is one row',
  R.readCompanies({ results: [{ domain: 'acme.com' }, { domain: 'https://acme.com/x' }] }).length === 1,
);
check(
  'two companies are two rows',
  R.readCompanies({ results: [{ domain: 'a.com' }, { domain: 'b.com' }] }).length === 2,
);

// --- people ---------------------------------------------------------------

check('people from a results array', R.readPeople({ results: [{ full_name: 'Ada Lovelace', job_title: 'Founder' }] }).length === 1);
check('the title is read', R.readPeople({ results: [{ name: 'Ada', title: 'Founder' }] })[0]?.title === 'Founder');
check('first and last are split', (() => {
  const p = R.readPeople({ results: [{ name: 'Ada Lovelace' }] })[0];
  return p.firstName === 'Ada' && p.lastName === 'Lovelace';
})());
check('explicit first and last win', (() => {
  const p = R.readPeople({ results: [{ first_name: 'Ada', last_name: 'Lovelace' }] })[0];
  return p.firstName === 'Ada' && p.lastName === 'Lovelace';
})());
check('a one-word name has no last', (() => {
  const p = R.readPeople({ results: [{ name: 'Prince' }] })[0];
  return p.firstName === 'Prince' && p.lastName === null;
})());

// Nobody the email step could look up. Every email endpoint keys on a name or a
// profile URL, so a row with neither is a row that costs a discovery call and
// delivers nothing.
check('a person with no name at all is refused', R.readPeople({ results: [{ title: 'Founder' }] }).length === 0);
check('a LinkedIn URL is enough to be a person', R.readPeople({ results: [{ linkedin: 'https://li/x' }] }).length === 1);

check('the same person twice is one', R.readPeople({ results: [{ name: 'Ada' }, { name: 'ada' }] }).length === 1);
check('two people are two', R.readPeople({ results: [{ name: 'Ada' }, { name: 'Grace' }] }).length === 2);

// --- phone ---------------------------------------------------------------

check('a plain number', R.readPhone({ phone: '+44 7700 900123' }) === '+447700900123');
check('a formatted number keeps its shape', R.readPhone({ phone_number: '(020) 7946-0958' }) === '(020)79460958'.replace(/[()]/g, ''));
check('a nested number', R.readPhone({ data: { contact: { mobile: '07700900123' } } }) === '07700900123');

// Too short to dial, or long enough to be a tracking id. Both would otherwise
// land in the table and then in the export.
check('too short is refused', R.readPhone({ phone: '12345' }) === null);
check('far too long is refused', R.readPhone({ phone: '12345678901234567890' }) === null);
check('a tracking url is not a number', R.readPhone({ phone: 'https://tracker.example/click?id=123456789' }) === null);
check('a non-string is not a number', R.readPhone({ phone: 447700900123 }) === null);

// --- company record -------------------------------------------------------

check('a flat record is kept', (() => {
  const r = R.readCompanyRecord({ name: 'Acme', employees: 50, industry: 'Accounting' });
  return r && r.name === 'Acme' && r.employees === 50 && r.industry === 'Accounting';
})());

check('nested one level is flattened', (() => {
  const r = R.readCompanyRecord({ company: { name: 'Acme', size: 50 } });
  return r && r.name === 'Acme';
})());

check('a cyclic record terminates', (() => {
  const c = { name: 'Acme' };
  c.self = c;
  const r = R.readCompanyRecord(c);
  return r && r.name === 'Acme';
})());

check('a very long value is dropped rather than stored', (() => {
  const r = R.readCompanyRecord({ blurb: 'x'.repeat(5000), name: 'Acme' });
  return r && r.blurb === undefined && r.name === 'Acme';
})());

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);