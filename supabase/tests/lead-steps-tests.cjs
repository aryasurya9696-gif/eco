// Tests the step planner: the one place that decides what a run's mode means.
//
//   node supabase/tests/lead-steps-tests.cjs
//
// This file exists because lead_runs.mode was a column nothing read. The estimate
// priced three clean modes apart, the UI described them apart, and the worker did
// the identical email waterfall for all three — so the cheapest mode was neither
// cheapest nor what it said. A planner with no tests is how that comes back.
//
// Compiled inside the project so module resolution walks up to node_modules. The
// file has no imports at all, which is why it lives in supabase/functions and not
// in src: it is loaded by Deno, and a test runner is the only other consumer.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'supabase', 'functions', 'leads');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-steps-test');

fs.mkdirSync(OUT, { recursive: true });

// Three files, not one, and they have to be copied together rather than imported
// in place.
//
// The edge function modules import each other with explicit .ts extensions,
// which Deno requires. Node's resolver does not find them, so the copies are
// rewritten to extensionless specifiers. The rewrite is confined to import
// statements, so nothing that affects behaviour differs between what is tested
// here and what Deno runs — and a test that compiled a modified copy would be
// testing the modification.
for (const name of ['steps.ts', 'pricing-row.ts', 'billing.ts']) {
  const src = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
  const rewritten = src.replace(/from '(\.\/[^']+)\.ts'/g, "from '$1'");
  fs.writeFileSync(path.join(OUT, name), rewritten, 'utf8');
}

// billing.ts reaches for the Supabase client only through a structural type, so
// it compiles standalone. Its one non-type import is the wallet shape it shares
// with pricing-row.ts, which the copy above already resolved.
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
        noEmitOnError: true,
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
  console.error(String(e.stdout || e.message).split('\n').slice(0, 12).join('\n'));
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

// Prices exactly as seeded in pricing_config: company.found 0.02, person.found
// 0.20, email.verified 1.00, email.catch_all 0.40, verify.only 0.10, phone.found
// 8.00, company.enrich 1.00. Read off the table rather than invented, because the
// assertions below are about these numbers adding up and inventing them would let
// a seed change pass unnoticed.
const P = {
  company: 0.02,
  person: 0.2,
  emailVerified: 1.0,
  emailCatchAll: 0.4,
  verifyOnly: 0.1,
  phone: 8.0,
  enrich: 1.0,
};

// --- planSteps: what each mode is allowed to do ---------------------------

{
  // The bug. verify_only promised to leave failing rows alone; the worker looked
  // up replacements for all of them and charged the find price.
  const p = S.planSteps('verify_only');
  check('verify_only does not look up a new address', p.findEmail === false);
  check('verify_only does not refind on failure', p.refindOnFailure === false);
  check('verify_only does verify what it was given', p.verifyExisting === true);
  check('verify_only charges verification on its own', p.chargeVerifySeparately === true);
  check('verify_only does not enrich', p.enrich === false);
}

{
  const p = S.planSteps('verify_refind');
  check('verify_refind may look up a replacement', p.findEmail === true);
  check('verify_refind only does so on failure', p.refindOnFailure === true);
  check('verify_refind verifies first', p.verifyExisting === true);
}

{
  const p = S.planSteps('full_enrich');
  check('full_enrich enriches', p.enrich === true);
  check('full_enrich also refinds', p.refindOnFailure === true);
}

// --- planSteps: a find run is not a clean run -----------------------------

{
  // An address found by a find run is verified as part of being found, so a
  // separate verification line would charge twice for one piece of work.
  const p = S.planSteps(null);
  check('a find run does not charge verification separately', p.chargeVerifySeparately === false);
  check('a find run does not verify separately', p.verifyExisting === false);
  check('a find run does find emails', p.findEmail === true);
}

// Rows inserted before modes existed have no mode at all, and kind defaults to
// 'find'. They must behave exactly like a find run or old runs change meaning.
{
  const p = S.planSteps(undefined);
  check('a run with no mode behaves as a find', p.findEmail === true && p.verifyExisting === false);
}

{
  // A mode the worker does not recognise is treated as no mode. Doing less work
  // because of a typo in a column is the worse of the two failures: the user
  // silently gets nothing instead of their leads.
  const p = S.planSteps('verify_onlyy');
  check('an unknown mode falls back to the full waterfall', p.findEmail === true);
  check('an unknown mode does not charge verification twice', p.chargeVerifySeparately === false);
}

{
  const p = S.planSteps(null);
  check('kind and mode both null still finds emails', p.findEmail === true);
}

// --- stepsFor: the order -----------------------------------------------

{
  // The clean case: address verifies, so there is nothing else to do. One call.
  const steps = S.maxStepsFor(S.planSteps('verify_only'), true);
  check('a row that verifies is done in one step', JSON.stringify(steps) === JSON.stringify(['verify']));
}

{
  // Nothing to verify. verify_only must do nothing at all rather than paying a
  // verification price for a row with no address.
  const steps = S.maxStepsFor(S.planSteps('verify_only'), false);
  check('verify_only with no address does nothing', steps.length === 0);
}

{
  // verify_refind: the find is planned, but whether it runs is the worker's call
  // once the verification has answered. A plan cannot know the verdict in advance
  // — that was the bug the old stepsFor had, silently dropping the find.
  const steps = S.maxStepsFor(S.planSteps('verify_refind'), true);
  check('verify_refind plans verify before the find', steps[0] === 'verify');
  check('verify_refind has a find', steps.includes('email'));
  check(
    'the replacement is verified too — an unverified new address is how a row ends up holding something unchecked',
    steps[steps.length - 1] === 'verify',
  );

  // And here is the gate, which is what the old function was trying to be.
  const plan = S.planSteps('verify_refind');
  check('a good address means no refind', S.shouldFindEmail(plan, true) === false);
  check('a failed address means refind', S.shouldFindEmail(plan, false) === true);
  check('no verdict still refinds — an unreachable verifier is not a reason to give up', S.shouldFindEmail(plan, null) === true);

  const only = S.planSteps('verify_only');
  check('verify_only never finds, whatever the verdict', S.shouldFindEmail(only, false) === false);
  check('verify_only never finds, even with no verdict', S.shouldFindEmail(only, null) === false);

  const find = S.planSteps(null);
  check('a find run always finds, verdict or not', S.shouldFindEmail(find, false) === true && S.shouldFindEmail(find, null) === true);
}

{
  // The most expensive order. Nothing to start with, so the find runs first and
  // what it finds is then checked.
  const steps = S.maxStepsFor(S.planSteps('verify_refind'), false);
  check('with no starting address the find comes first', steps[0] === 'email');
  check('the found address is then verified', steps.includes('verify'));
}

{
  const steps = S.maxStepsFor(S.planSteps('full_enrich'), true);
  check('full_enrich ends with enrich', steps[steps.length - 1] === 'enrich');
}

{
  // A find run never emits a verify step, because it would be charging for work
  // the find already did. It does emit the decision-maker step, because that is
  // how a row that has no person on it gets one: every email endpoint in the
  // registry is keyed on a name or a profile URL.
  const steps = S.maxStepsFor(S.planSteps(null), false);
  check('a find run never plans a verify step', !steps.includes('verify'));
  check('a find run plans the decision maker then the address', JSON.stringify(steps) === JSON.stringify(['person', 'email']));
  check('a find run does not re-look-up a person it already has', JSON.stringify(S.maxStepsFor(S.planSteps(null), false, true)) === JSON.stringify(['email']));
}

{
  // A clean run's rows came from the user's file with a person already on them,
  // so no plan may claim it went looking for one. This is the assertion that
  // keeps a clean run from being billed for a decision-maker lookup.
  const steps = S.maxStepsFor(S.planSteps('full_enrich'), true);
  check('a clean run never plans a decision-maker step', !steps.includes('person'));
  check('a clean run never plans a company step', !steps.includes('company'));
}

// --- shouldDiscover: when a find run goes looking for companies ------------
//
// The bug this guards against is the expensive one. The worker re-invokes
// itself per chunk, so "discover whenever it looks" makes a 2000-row run make
// 400 company searches, each asking for the ~1995 rows it has not created yet.

{
  // The case that used to be broken: rows exist and work is waiting, so nothing
  // should be discovered even though the target is far from met.
  check(
    'a run with rows waiting does not discover',
    S.shouldDiscover({ kind: 'find', have: 5, waiting: 5, target: 2000 }) === false,
  );

  check(
    'a run with one row waiting does not discover',
    S.shouldDiscover({ kind: 'find', have: 1999, waiting: 1, target: 2000 }) === false,
  );

  // The case that needs it: the queue has drained and the target is unmet, so
  // the providers are asked again. Without this a run that found 20 of 50 would
  // stop at 20 for ever.
  check(
    'a drained run below its target discovers',
    S.shouldDiscover({ kind: 'find', have: 20, waiting: 0, target: 50 }) === true,
  );

  check(
    'a brand new run discovers',
    S.shouldDiscover({ kind: 'find', have: 0, waiting: 0, target: 50 }) === true,
  );

  // Reaching the target stops it, even with an empty queue - otherwise the
  // worker searches forever for rows it does not need.
  check(
    'a run that met its target does not discover',
    S.shouldDiscover({ kind: 'find', have: 2000, waiting: 0, target: 2000 }) === false,
  );
  check(
    'a run past its target does not discover',
    S.shouldDiscover({ kind: 'find', have: 2500, waiting: 0, target: 2000 }) === false,
  );
}

{
  // Never a clean run. Its rows came from the user's file; searching for more
  // companies would silently turn a clean into a find, which is the exact
  // conflation steps.ts exists to prevent.
  check('a clean run never discovers', S.shouldDiscover({ kind: 'clean', have: 0, waiting: 0, target: 50 }) === false);
  check('a lab run never discovers', S.shouldDiscover({ kind: 'lab', have: 0, waiting: 0, target: 50 }) === false);

  // And a mode on a find run does not change the answer - the kind decides, not
  // the mode, which is the same rule planSteps follows.
  check('the mode is not an input', S.shouldDiscover({ kind: 'find', have: 0, waiting: 0, target: 0 }) === true);
}

// --- worstCasePerRow: matches what the wallet is checked against ---------

{
  // 0.10 + 0.40 for the replacements it may make. The SQL's max for
  // verify_refind is target * (verify + email) = 1.10, so this has to agree.
  const w = S.worstCasePerRow(S.planSteps('verify_refind'), P);
  check('verify_refind worst case is verify + email', Math.abs(w - 1.1) < 1e-9);
}

{
  // This is the number that changes: once verify_only genuinely never finds an
  // address, its worst case is the verification alone. Previously the estimator
  // reserved target * (verify + email) for it, so a user with 300 credits could
  // not start a 2000-row check that would have cost them 200.
  const w = S.worstCasePerRow(S.planSteps('verify_only'), P);
  check('verify_only worst case is verification alone', Math.abs(w - 0.1) < 1e-9);
}

{
  // This is the number that changed twice, and the second time is the bug this
  // file exists to catch.
  //
  // It was 1.00: the find price and nothing else. But a find row is charged
  // company + person + email by creditsForRow, and the SQL estimator quotes
  // max = target * (company + person + email) = 1.22. So a five-row chunk held
  // 5.00 and could settle 6.10, which settle refuses - and the run pauses itself
  // with 'settlement_failed' and the user loses the credits in between.
  //
  // It has to equal the estimator's max, because the estimator's max is what the
  // wallet was checked against when the run started. One rule, two readers.
  const w = S.worstCasePerRow(S.planSteps(null), P);
  check('a find run reserves the company and person lines too', Math.abs(w - 1.22) < 1e-9);
}

{
  // The guard against the obvious over-correction: adding company + person
  // unconditionally would reserve for decision-maker lookups on clean runs, whose
  // rows came from the user's file with a person already on them.
  const clean = S.worstCasePerRow(S.planSteps('full_enrich'), P);
  check('a clean run does not reserve the company or person line', Math.abs(clean - 2.1) < 1e-9);
}

{
  const w = S.worstCasePerRow(S.planSteps('full_enrich'), P);
  check('full_enrich reserves verify + email + enrich', Math.abs(w - 2.1) < 1e-9);
}

// --- creditsForRow: what is actually charged ------------------------------

{
  // The whole point of verify_only: an address that is checked and is good, and
  // nothing else happens.
  const plan = S.planSteps('verify_only');
  const c = R.creditsForRow({ verified: true }, P, plan);
  check('a verified address in verify_only costs the verify price', Math.abs(c - 0.1) < 1e-9);
}

{
  // An address that fails verification still cost a verification. The provider
  // answered and the answer was no. What must not be charged is a replacement
  // that this mode never went looking for.
  const plan = S.planSteps('verify_only');
  const c = R.creditsForRow({ invalid: true }, P, plan);
  check('an invalid address still costs the verify price', Math.abs(c - 0.1) < 1e-9);
}

{
  // A supplied address that verifies as a catch-all costs only the verification.
  // Not 0.40: that price is for an address the waterfall *found* and which turned
  // out to be a pattern. Here the user brought the address, so no find happened
  // and nothing is owed for one.
  const plan = S.planSteps('verify_only');
  const c = R.creditsForRow({ catchAll: true }, P, plan);
  check('a supplied catch-all costs only the verification', Math.abs(c - 0.1) < 1e-9);
}

// A supplied address that is merely fine costs the same as one that is a
// catch-all, which is worth stating: the user is buying a check, not an outcome.
{
  const plan = S.planSteps('verify_only');
  const good = R.creditsForRow({ verified: true }, P, plan);
  const pattern = R.creditsForRow({ catchAll: true }, P, plan);
  const dead = R.creditsForRow({ invalid: true }, P, plan);
  check('the user is buying a check, not an outcome', good === pattern && pattern === dead);
}

{
  // verify + replacement, both charged. This is the verify_refind shape.
  const plan = S.planSteps('verify_refind');
  const c = R.creditsForRow({ verified: true, emailFound: true }, P, plan);
  check('a row that refinds pays verify + email', Math.abs(c - 1.1) < 1e-9);
}

{
  // A found replacement that verifies as a catch-all: verify + catch_all, which
  // is cheaper than the row that verified. Correct — a worse answer, less money.
  const plan = S.planSteps('verify_refind');
  const c = R.creditsForRow({ catchAll: true, emailFound: true }, P, plan);
  check('a replaced catch-all pays verify + catch_all', Math.abs(c - 0.5) < 1e-9);
}

{
  // A find run must not be charged verification, or every lead costs twice.
  const plan = S.planSteps(null);
  const c = R.creditsForRow({ verified: true, emailFound: true, companyFound: true, personFound: true }, P, plan);
  check('a find run is charged email + company + person only', Math.abs(c - 1.22) < 1e-9);
}

{
  // The other half of that: a clean run does no company or person lookup, because
  // both arrived in the file. Charging for them is charging for work that never
  // happened — and it was, because the old creditsForResult always added them.
  const plan = S.planSteps('verify_refind');
  const c = R.creditsForRow({ verified: true, emailFound: true, companyFound: true, personFound: true }, P, plan);
  check('a clean run is never charged company or person', Math.abs(c - 1.1) < 1e-9);
}

{
  // A row where nothing resolved earns nothing. Otherwise every failing row would
  // be billed as though it had succeeded, and the miss stops being free.
  const plan = S.planSteps('verify_only');
  check('a row with no verdict earns nothing', R.creditsForRow({}, P, plan) === 0);
  check('a row that found nothing earns nothing', R.creditsForRow({ emailFound: false }, P, plan) === 0);
}

{
  // An unreachable verifier is not an answer. Charging for it would bill the user
  // for Echo's outage — and worse, would charge the same whether the address was
  // good or not, so a broken verifier would look identical to a working one on
  // the invoice.
  const plan = S.planSteps('verify_only');
  check('an unreadable verdict is not charged', R.creditsForRow({ unreadable: true }, P, plan) === 0);
}

{
  const plan = S.planSteps('full_enrich');
  const c = R.creditsForRow({ verified: true, emailFound: true, companyEnriched: true }, P, plan);
  check('full_enrich adds the enrich price', Math.abs(c - 2.1) < 1e-9);
}

{
  // Phone is opt-in, and the opt-in is part of the plan rather than a flag the
  // caller passes in separately. That is what lets creditsForRow refuse it: a
  // row from a run that never asked for phones cannot be charged eight credits
  // for a number nobody looked for, however the flags are set.
  const plan = S.planSteps(null, { phone: true });
  const c = R.creditsForRow({ emailFound: true, companyFound: true, personFound: true, phoneFound: true }, P, plan);
  check('phone adds its own price', Math.abs(c - 9.22) < 1e-9);
}

{
  // The refusal. Same flags, run that did not ask for phones.
  const plan = S.planSteps(null);
  const c = R.creditsForRow({ emailFound: true, companyFound: true, personFound: true, phoneFound: true }, P, plan);
  check('phone is refused when the run did not ask for it', Math.abs(c - 1.22) < 1e-9);
}

{
  // And the hold follows the same plan, so a phone run holds the phone money.
  const withPhone = S.worstCasePerRow(S.planSteps(null, { phone: true }), P);
  const without = S.worstCasePerRow(S.planSteps(null), P);
  check('a phone run holds the phone price', Math.abs(withPhone - without - P.phone) < 1e-9);
  check('a run without phones holds none', Math.abs(without - 1.22) < 1e-9);
}

{
  // Phone is in the plan, so it appears in the receipt too. It used to be in
  // neither, which is why the step list was incomplete for a phone run.
  const steps = S.maxStepsFor(S.planSteps(null, { phone: true }), false);
  check('a phone run plans the phone step', steps.includes('phone'));
  check('phone is planned last', steps[steps.length - 1] === 'phone');
  check('a run without phones does not plan it', !S.maxStepsFor(S.planSteps(null), false).includes('phone'));
}

{
  // Floating point. Credits go into numeric(20,6); a 0.7000000000000001 that
  // reaches the RPC is a rounding error that shows up in the wallet.
  const plan = S.planSteps('verify_refind');
  const c = R.creditsForRow(
    { verified: true, emailFound: true },
    { verifyOnly: 0.1, emailVerified: 0.3, emailCatchAll: 0.2, phone: 0, enrich: 0.7, company: 0, person: 0 },
    plan,
  );
  check('credits are rounded to six decimals', c === Math.round(c * 1e6) / 1e6);
  check('a fractional total is still right', Math.abs(c - 0.4) < 1e-9);
}

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);