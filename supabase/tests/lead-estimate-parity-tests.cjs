// The estimate must agree with what the worker actually does.
//
//   node supabase/tests/lead-estimate-parity-tests.cjs
//
// This is the invariant the pricing was missing. Three places decide what a row
// costs and they have to give the same answer:
//
//   supabase/functions/leads/steps.ts          worstCasePerRow  (the hold)
//   supabase/functions/leads/pricing-row.ts    creditsForRow     (the charge)
//   supabase/migrations/20261115_*.sql         estimate_lead_run  (the quote)
//
// They did not. The quote charged company + person for every clean mode, which
// none of them perform, and left company.enrich out of full_enrich's figure
// entirely, which the worker charges. max_credits is what the wallet is checked
// against, so a wrong max does not just misquote a price - it decides who gets
// to start a run.
//
// There is no database in this harness, so the SQL's arithmetic is mirrored
// below rather than executed. The mirror is written from the migration's
// conditionals, not from its prose, and the shape of the migration is asserted
// at the end so a revert of the branches cannot pass this quietly.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-estimate-parity-test');

fs.mkdirSync(OUT, { recursive: true });
// pricing-row.ts imports its types from billing.ts and steps.ts. billing.ts has
// no imports of its own, so copying it is enough to compile all three together -
// and compiling the real billing.ts rather than a stub means the prices object
// below is checked against the real type.
for (const f of ['steps.ts', 'pricing-row.ts', 'billing.ts']) {
  fs.copyFileSync(path.join(ROOT, 'supabase', 'functions', 'leads', f), path.join(OUT, f));
}
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
        // steps.ts is imported for its types only by pricing-row.ts; no runtime
        // import, so nothing has to be rewritten to .js.
        rewriteRelativeImportExtensions: true,
        outDir: path.join(OUT, 'dist'),
      },
      files: ['steps.ts', 'pricing-row.ts', 'billing.ts'],
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
  console.error(String(e.stdout || e.message).split('\n').slice(0, 14).join('\n'));
  process.exit(1);
}

const S = require(path.join(OUT, 'dist', 'steps.js'));
const R = require(path.join(OUT, 'dist', 'pricing-row.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// The seeded prices. Read from here rather than the registry so a price change
// shows up as a failing number rather than a silently different expectation.
const P = {
  company: 0.02,
  person: 0.2,
  emailVerified: 1.0,
  emailCatchAll: 0.4,
  verifyOnly: 0.1,
  phone: 8.0,
  enrich: 1.0,
};
const RATE = 0.7; // the shipped default, used until a user has 50 attempts

/** The migration's arithmetic, mirrored. */
function estimate(mode, target, withPhone) {
  const plan = S.planSteps(mode);
  let min = 0;
  let expected = 0;
  let max = 0;
  const lines = [];

  if (plan.findCompany) {
    min += target * P.company;
    expected += target * P.company;
    max += target * P.company + target * P.person;
    lines.push(target * P.company);
    expected += target * RATE * P.person;
    lines.push(target * RATE * P.person);
  }
  if (plan.verifyExisting) {
    min += target * P.verifyOnly;
    expected += target * P.verifyOnly;
    max += target * P.verifyOnly;
    lines.push(target * P.verifyOnly);
  }
  if (plan.findEmail) {
    expected += target * RATE * P.emailVerified;
    max += target * P.emailVerified;
    lines.push(target * RATE * P.emailVerified);
  }
  if (plan.enrich) {
    expected += target * RATE * P.enrich;
    max += target * P.enrich;
    lines.push(target * RATE * P.enrich);
  }
  if (withPhone) {
    expected += target * RATE * P.phone;
    max += target * P.phone;
    lines.push(target * RATE * P.phone);
  }

  return { min, expected, max, lines, plan };
}

const MODES = [null, 'verify_only', 'verify_refind', 'full_enrich'];

// --- max_credits is the number the wallet is checked against ----------------
//
// This is the assertion that matters. The old estimate said 2.32 per row for
// full_enrich while the worker holds 2.10, and 2.44 for a find while the worker
// held 1.00 - so the quote and the hold were two different numbers for the same
// row, and only one of them had ever been executed.

for (const mode of MODES) {
  const name = mode ?? 'find';
  const e = estimate(mode, 100, false);
  const held = S.worstCasePerRow(e.plan, P);
  check(
    'max_credits per row matches the worker hold (' + name + ')',
    Math.abs(e.max / 100 - held) < 1e-9,
  );
}

// --- the phone option is held too ------------------------------------------

{
  // The plan now carries the phone opt-in, so the parity is checked through it
  // rather than by adding the price on the side. Adding it outside is what let
  // the quote and the hold become two separate calculations of one row.
  const plan = S.planSteps(null, { phone: true });
  const held = S.worstCasePerRow(plan, P);
  const e = estimate(null, 100, true);
  check('a phone run holds the phone price', Math.abs(e.max / 100 - held) < 1e-9);
  check('and it is the find worst case plus the phone price',
    Math.abs(held - (P.company + P.person + P.emailVerified + P.phone)) < 1e-9);
}

// --- the breakdown adds up to the number above it ---------------------------

for (const mode of MODES) {
  for (const withPhone of [false, true]) {
    const e = estimate(mode, 2000, withPhone);
    const sum = e.lines.reduce((a, b) => a + b, 0);
    check(
      'the lines sum to expected_credits (' + (mode ?? 'find') + (withPhone ? ' + phone' : '') + ')',
      Math.abs(sum - e.expected) < 1e-6,
    );
  }
}

// --- and never exceeds max ---------------------------------------------------

for (const mode of MODES) {
  const e = estimate(mode, 2000, false);
  check('expected never exceeds max (' + (mode ?? 'find') + ')', e.expected <= e.max + 1e-9);
  check('min never exceeds expected (' + (mode ?? 'find') + ')', e.min <= e.expected + 1e-9);
}

// --- the numbers, so a price change is visible rather than absorbed ---------

{
  const e = estimate(null, 50, false);
  check('find @50 min is the company line alone', Math.abs(e.min - 1) < 1e-9);
  check('find @50 expected is 43', Math.abs(e.expected - 43) < 1e-9);
  check('find @50 max is 61, unchanged', Math.abs(e.max - 61) < 1e-9);
}

{
  const e = estimate('verify_only', 2000, false);
  check('verify_only @2000 is 200 flat', Math.abs(e.max - 200) < 1e-9);
}

{
  const e = estimate('verify_refind', 2000, false);
  check('verify_refind @2000 is 200 / 1600 / 2200',
    Math.abs(e.min - 200) < 1e-9 && Math.abs(e.expected - 1600) < 1e-9 && Math.abs(e.max - 2200) < 1e-9);
}

{
  // 2000 * (verify 0.10 + email 1.00 + enrich 1.00). Enrichment is the line that
  // was missing entirely, which is why this used to come back as 2440.
  const e = estimate('full_enrich', 2000, false);
  check('full_enrich @2000 max includes enrichment', Math.abs(e.max - 4200) < 1e-9);
  check('full_enrich @2000 expected is 3000', Math.abs(e.expected - 3000) < 1e-9);
  check('full_enrich @2000 min is verification alone', Math.abs(e.min - 200) < 1e-9);
}

// --- a clean run is never charged for a company or a person -----------------
//
// The 440 credits per 2000 rows that a find run was being billed for work it
// never did.

for (const mode of ['verify_only', 'verify_refind', 'full_enrich']) {
  const plan = S.planSteps(mode);

  check('a ' + mode + ' row with a bad address costs only the verification',
    Math.abs(R.creditsForRow({ invalid: true }, P, plan) - P.verifyOnly) < 1e-9);

  // The strong version: a caller that lies and claims every piece of work was
  // done still cannot produce a company or a person charge on a clean run. The
  // plan has the last word, which is the whole point of the gate - trusting the
  // caller's flags is how a clean run ends up billed as a find in the first
  // place.
  const everything = R.creditsForRow(
    {
      companyFound: true,
      personFound: true,
      emailFound: true,
      verified: true,
      catchAll: true,
      invalid: true,
      unreadable: false,
      phoneFound: true,
      companyEnriched: true,
    },
    P,
    plan,
  );

  const withVerify = mode === 'verify_only' ? P.verifyOnly : P.verifyOnly + P.emailVerified;
  const withEnrich = mode === 'full_enrich' ? P.enrich : 0;
  check(
    'a lying caller cannot charge company or person on ' + mode,
    Math.abs(everything - (withVerify + withEnrich)) < 1e-9,
  );
}

// --- a find row is charged for the person only when one was found -----------

{
  const plan = S.planSteps(null);
  const withPerson = R.creditsForRow({ companyFound: true, personFound: true, emailFound: true }, P, plan);
  const without = R.creditsForRow({ companyFound: true, personFound: false, emailFound: true }, P, plan);
  check('a find row with a person costs more than one without', withPerson - without > 0.19);
  check('the difference is exactly the decision-maker price', Math.abs(withPerson - without - P.person) < 1e-9);
}

// --- the migration itself, so a revert cannot pass quietly ------------------

{
  const MIG = path.join(ROOT, 'supabase', 'migrations', '20261115_estimate_matches_plan.sql');
  const sql = fs.readFileSync(MIG, 'utf8');

  check('the migration exists', sql.length > 0);
  check('it prices enrichment from the table, not a constant', /leads\.company\.enrich/.test(sql));
  check('it measures a hit rate per step', /leads_step_hit_rate/.test(sql));
  check('the person rate is not the email rate', /leads_step_hit_rate\(v_user, 'person'\)/.test(sql));
  check('enrichment has its own rate', /leads_step_hit_rate\(v_user, 'enrich'\)/.test(sql));
  check('it reads the plan rather than re-deriving it', /v_find_company\s+boolean/.test(sql));
  // The specific double-count this file was written after: the company branch
  // adding the email worst case that the address branch adds again.
  const companyBranch = /v_max\s*:=\s*v_min \+ v_target \* v_person;/.test(sql);
  check('the company branch does not also add the email worst case', companyBranch);
  check('the helper is not callable by the browser',
    /revoke execute on function public\.leads_step_hit_rate\(uuid, text\)[\s\S]*?from public, anon, authenticated;/.test(sql));
}

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);