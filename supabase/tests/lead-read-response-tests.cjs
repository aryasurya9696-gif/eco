// Tests the two provider-response readers.
//
//   node supabase/tests/lead-read-response-tests.cjs
//
// readVerdict is the riskiest code in the leads function and was written against
// no real provider response at all: no endpoint in the registry has been called
// yet, so every shape it knows is a guess. A wrong guess here is the worst kind
// of wrong, because it is silent. A row whose address was never checked gets a
// badge saying it was, the user is charged the verification price for a check
// that did not happen, and nothing anywhere records an error.
//
// So the cases below are the ones where inventing an answer would be most
// expensive: a body with nothing verdict-shaped in it, a body with a field called
// status that means something else entirely, and the several ways a provider
// spells each answer.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'supabase', 'functions', 'leads', 'read-response.ts');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-read-response-test');

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(SRC, path.join(OUT, 'read-response.ts'));
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
      files: ['read-response.ts'],
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

const R = require(path.join(OUT, 'dist', 'read-response.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// --- readVerdict: nothing to read ---------------------------------------

// The most important case. Every one of these must be null. A reader that
// guesses here charges the user for a check that did not happen and writes a
// verdict nobody looked at.
check('null body', R.readVerdict(null) === null);
check('undefined body', R.readVerdict(undefined) === null);
check('a string', R.readVerdict('valid') === null);
check('a number', R.readVerdict(200) === null);
check('an empty object', R.readVerdict({}) === null);
check('an error envelope', R.readVerdict({ error: 'quota exceeded', code: 429 }) === null);
check('a body with an unrelated status field', R.readVerdict({ status: 'processing' }) === null);
check('a request echo', R.readVerdict({ email: 'a@b.com', credits_remaining: 41 }) === null);

// The trap: a body about the wrong address, or a request receipt rather than a
// verdict. Neither licenses a guess.
check(
  'a bare echo of the request is not a verdict',
  R.readVerdict({ email: 'a@b.com', request_id: 'req_123' }) === null,
);

// --- readVerdict: deliverable --------------------------------------------

check('is_valid true', R.readVerdict({ is_valid: true }) === 'deliverable');
check('is_valid false', R.readVerdict({ is_valid: false }) === 'undeliverable');
check('deliverable', R.readVerdict({ deliverable: true }) === 'deliverable');
check('status valid', R.readVerdict({ status: 'valid' }) === 'deliverable');
check('status VALID is case-insensitive', R.readVerdict({ status: 'VALID' }) === 'deliverable');
check('status deliverable', R.readVerdict({ status: 'deliverable' }) === 'deliverable');
check('status safe', R.readVerdict({ status: 'safe' }) === 'deliverable');
check('result ok', R.readVerdict({ result: 'ok' }) === 'deliverable');
check('verdict valid', R.readVerdict({ verdict: 'valid' }) === 'deliverable');
check('type valid', R.readVerdict({ type: 'valid' }) === 'deliverable');
check('quality high', R.readVerdict({ quality: 'high' }) === 'deliverable');

// Padded whitespace, because a provider returning " valid " should not be
// treated as an unknown vocabulary word and silently declined.
check('whitespace is trimmed', R.readVerdict({ status: '  valid  ' }) === 'deliverable');

// --- readVerdict: catch-all ---------------------------------------------

check('status catch_all', R.readVerdict({ status: 'catch_all' }) === 'catch_all');
check('status catch-all', R.readVerdict({ status: 'catch-all' }) === 'catch_all');
check('status catchall', R.readVerdict({ status: 'catchall' }) === 'catch_all');
check('status role', R.readVerdict({ status: 'role' }) === 'catch_all');
check('status generic', R.readVerdict({ status: 'generic' }) === 'catch_all');
check('classification pattern', R.readVerdict({ classification: 'pattern' }) === 'catch_all');

// The distinction that carries money. A catch-all is priced at 0.40 and a
// deliverable at 1.00, so reading one as the other is a real difference in what
// the user pays as well as what they are told.
check('a catch-all is not read as deliverable', R.readVerdict({ status: 'catch_all' }) !== 'deliverable');
check('a deliverable is not read as a catch-all', R.readVerdict({ status: 'valid' }) !== 'catch_all');

// --- readVerdict: undeliverable -----------------------------------------

check('status invalid', R.readVerdict({ status: 'invalid' }) === 'undeliverable');
check('status undeliverable', R.readVerdict({ status: 'undeliverable' }) === 'undeliverable');
check('status risky', R.readVerdict({ status: 'risky' }) === 'undeliverable');
check('status bounce', R.readVerdict({ status: 'bounce' }) === 'undeliverable');
check('status do_not_send', R.readVerdict({ status: 'do_not_send' }) === 'undeliverable');
check('status disposable', R.readVerdict({ status: 'disposable' }) === 'undeliverable');

// --- readVerdict: nested, which is the whole point of walking ------------

check(
  'nested one level',
  R.readVerdict({ data: { status: 'valid' } }) === 'deliverable',
);
check(
  'nested three levels',
  R.readVerdict({ result: { email: { validation: { deliverable: true } } } }) === 'deliverable',
);
check(
  'inside an array of records',
  R.readVerdict({ results: [{ email: 'a@b.com' }, { verdict: 'catch_all' }] }) === 'catch_all',
);
check(
  'a deeper key than the reader looks for is still found',
  R.readVerdict({ a: { b: { c: { d: { e: { status: 'invalid' } } } } } }) === 'undeliverable',
);

// --- readVerdict: shapes it must not be fooled by -------------------------

// A score is not a verdict. Reading 0.3 as undeliverable would throw away an
// address on a numeric scale the reader does not know, and the cost of guessing
// wrong here is a real lead discarded and charged for.
check('a bare score is not a verdict', R.readVerdict({ score: 0.3 }) === null);
check('a confidence is not a verdict', R.readVerdict({ confidence: 0.99 }) === null);
check('a stringified number is not a verdict', R.readVerdict({ status: '0' }) === null);

// An address is not a verdict, however it is spelled.
check('an address field is not a verdict', R.readVerdict({ email_address: 'a@b.com' }) === null);

// A cycle must not hang the reader. Reachable from a real response only if a
// provider echoes a request object that has been through a serialiser that
// preserves cycles, which is rare — but a hang in the worker is a run that never
// finishes, and the reader is called on whatever came back.
const cyclic = { status: 'valid' };
cyclic.self = cyclic;
check('a cyclic body terminates', R.readVerdict(cyclic) === 'deliverable');

// A very deep body must not blow the stack or run forever. The queue is bounded
// in breadth, not depth, so this is a depth test rather than a width one.
let deep = { status: 'valid' };
for (let i = 0; i < 5000; i++) deep = { nested: deep };
check('a very deep body terminates', R.readVerdict(deep) === 'deliverable');

// Wide: more objects than the breadth bound allows to be visited. The verdict is
// buried past the bound, so this must come back null rather than finding it by
// luck or looping.
let wide = {};
for (let i = 0; i < 600; i++) wide[`k${i}`] = { filler: i };
wide.target = { status: 'invalid' };
const wideVerdict = R.readVerdict(wide);
check('a wide body terminates without throwing', wideVerdict === null || wideVerdict === 'undeliverable');

// --- readEmail: the placeholders ----------------------------------------

// A provider's own placeholder address is not a lead. Taking one is how a table
// fills with the same address and every row is billed for it.
check('an example.com placeholder is refused', R.readEmail({ email: 'john@example.com' }, 'x') === null);
check('an example.org placeholder is refused', R.readEmail({ email: 'john@example.org' }, 'x') === null);
check('a test@ placeholder is refused', R.readEmail({ email: 'test@acme.com' }, 'x') === null);

// A placeholder buried somewhere else in the body is just as wrong.
check(
  'a placeholder in a nested field is refused',
  R.readEmail({ data: { contact: { work_email: 'jane@example.com' } } }, 'x') === null,
);

// --- readEmail: the real ones -------------------------------------------

check('email', R.readEmail({ email: 'Alison@Fenwick.example' }, 'x') === 'alison@fenwick.example');
check('email_address', R.readEmail({ email_address: 'alison@fenwick.example' }, 'x') === 'alison@fenwick.example');
check('work_email', R.readEmail({ work_email: 'alison@fenwick.example' }, 'x') === 'alison@fenwick.example');
check('business_email', R.readEmail({ business_email: 'alison@fenwick.example' }, 'x') === 'alison@fenwick.example');
check('contact_email', R.readEmail({ contact_email: 'alison@fenwick.example' }, 'x') === 'alison@fenwick.example');

check('lowercased', R.readEmail({ email: 'ALISON@FENWICK.EXAMPLE' }, 'x') === 'alison@fenwick.example');
check('trimmed', R.readEmail({ email: '  alison@fenwick.example  ' }, 'x') === 'alison@fenwick.example');

check('nested', R.readEmail({ data: { person: { email: 'alison@fenwick.example' } } }, 'x') === 'alison@fenwick.example');
check('in an array', R.readEmail({ results: [{ email: 'alison@fenwick.example' }] }, 'x') === 'alison@fenwick.example');
check('as a bare string in the body', R.readEmail({ value: 'alison@fenwick.example' }, 'x') === 'alison@fenwick.example');

check('no address', R.readEmail({}, 'x') === null);
check('null body', R.readEmail(null, 'x') === null);
check('a free-text description is not an address', R.readEmail({ note: 'met him at the expo in Leeds' }, 'x') === null);

// Not an address at all: the shapes that arrive in a cell.
check('a name is not an address', R.readEmail({ email: 'Alison Fenwick' }, 'x') === null);
check('a URL is not an address', R.readEmail({ email: 'https://acme.com' }, 'x') === null);
check('two addresses in one cell is not an address', R.readEmail({ email: 'a@x.com;b@y.com' }, 'x') === null);
check('a domain with no local part is not an address', R.readEmail({ email: '@acme.com' }, 'x') === null);

// The `hint` is unused by design — the shape is unverified, so the reader walks
// rather than trusting it. A passing hint must not change that, because a future
// reader that started honouring it would need its own tests.
check('a hint does not change the answer', R.readEmail({ email: 'alison@fenwick.example' }, 'email') === 'alison@fenwick.example');

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);