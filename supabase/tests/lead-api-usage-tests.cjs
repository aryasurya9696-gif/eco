// Tests the transport-to-billing vocabulary mapping.
//
//   node supabase/tests/lead-api-usage-tests.cjs
//
// This exists because two vocabularies did not match and nothing noticed. treg.ts
// reports six outcomes, api_usage's CHECK constraint accepts five, and the two
// that were missing were exactly the two failure paths — every 402 and every 429.
// The insert raised a check violation, logAttempt did not read the error, and the
// row disappeared. The margin views read that table, so the failures were invisible
// everywhere, and the attempt history could not show an HTTP status because there
// was no row to read it from.
//
// Every case here is one that actually happened, or one that would have.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-api-usage-test');

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'supabase', 'functions', 'leads', 'api-usage.ts'), path.join(OUT, 'api-usage.ts'));
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
      files: ['api-usage.ts'],
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

const A = require(path.join(OUT, 'dist', 'api-usage.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// The constraint's list, written out here on purpose. If somebody widens the
// database and does not widen this, the tests should still be asserting the
// database's rule rather than the mapper's — so the allowed set is quoted, not
// imported.
const ALLOWED = new Set(['success', 'free', 'upstream_failed', 'not_billed', 'uncertain']);

const outcomes = [
  // The happy paths.
  { outcome: 'success', httpStatus: 200 },
  { outcome: 'free', httpStatus: 200 },
  { outcome: 'upstream_failed', httpStatus: 500 },
  { outcome: 'uncertain', httpStatus: 409 },

  // The two that were silently dropped.
  { outcome: 'error', httpStatus: 402, error: 'route_max_cost_or_balance' },
  { outcome: 'error', httpStatus: 429, error: 'rate_limited' },
  { outcome: 'not_found', httpStatus: 200 },

  // And the edges.
  { outcome: 'error', httpStatus: 503 },
  { outcome: 'error', httpStatus: 400, error: 'bad_request' },
  { outcome: 'error', httpStatus: 401, error: 'unauthorized' },
  { outcome: 'error', httpStatus: 410, error: 'answer_lost' },
  { outcome: 'error' },
];

// --- every outcome maps to something the database accepts -----------------
// The assertion that was missing. If any case below produced a value outside the
// constraint's list, the insert would fail exactly as it did in production.

for (const r of outcomes) {
  const label = `${r.outcome}${r.httpStatus ? '/' + r.httpStatus : ''}`;
  const mapped = A.billingOutcome(r);
  check(`${label} maps to an allowed outcome (got "${mapped}")`, ALLOWED.has(mapped));
}

// --- the specific semantics ----------------------------------------------

check('a success stays a success', A.billingOutcome({ outcome: 'success' }) === 'success');
check('a free call stays free', A.billingOutcome({ outcome: 'free' }) === 'free');
check('upstream_failed stays itself', A.billingOutcome({ outcome: 'upstream_failed' }) === 'upstream_failed');
check('uncertain stays itself', A.billingOutcome({ outcome: 'uncertain' }) === 'uncertain');

// A miss on a per-success provider is the expensive case, not the free one.
// Recording it as anything but a success understates what a run costs, which is
// the number the whole margin model rests on.
check(
  'a not_found is still a billed success',
  A.billingOutcome({ outcome: 'not_found', httpStatus: 200 }) === 'success',
);

// 402 is us being out of credit at the provider. Nothing was taken.
check(
  'a 402 is not_billed',
  A.billingOutcome({ outcome: 'error', httpStatus: 402 }) === 'not_billed',
);

// 429 is the provider refusing to serve right now. Nothing charged, and nothing
// about the workspace is wrong.
check(
  'a 429 is upstream_failed',
  A.billingOutcome({ outcome: 'error', httpStatus: 429 }) === 'upstream_failed',
);

for (const status of [502, 503, 504]) {
  check(`a ${status} is upstream_failed`, A.billingOutcome({ outcome: 'error', httpStatus: status }) === 'upstream_failed');
}

// A 4xx that is our fault is not an upstream problem and should not be counted
// as one in a report about how reliable the providers are.
check('a 400 is not_billed, not upstream_failed', A.billingOutcome({ outcome: 'error', httpStatus: 400 }) === 'not_billed');
check('a 401 is not_billed, not upstream_failed', A.billingOutcome({ outcome: 'error', httpStatus: 401 }) === 'not_billed');

// 410 means the answer was lost after being charged. treg.ts already reports it
// as uncertain, so reaching this arm would mean a new code path or a bug — and
// answering it with anything else would be a guess about whether we were charged.
// Auto-refunding on our own initiative is how a workspace gets served for free.
check(
  'a lost answer is uncertain even when the transport called it an error',
  A.billingOutcome({ outcome: 'error', httpStatus: 410 }) === 'uncertain',
);
check(
  'a still-running call is uncertain too',
  A.billingOutcome({ outcome: 'error', httpStatus: 409 }) === 'uncertain',
);

// And the two agree, because treg.ts reports them that way in the first place.
check(
  'both paths for a lost answer land on the same outcome',
  A.billingOutcome({ outcome: 'uncertain', httpStatus: 410 }) ===
    A.billingOutcome({ outcome: 'error', httpStatus: 410 }),
);

// An error with no status at all. Not billed is the safe default: we cannot
// substantiate a cost, and claiming one we cannot prove is the worse mistake.
check('an error with no status is not_billed', A.billingOutcome({ outcome: 'error' }) === 'not_billed');

// --- error codes ---------------------------------------------------------

check(
  'the transport error code is kept',
  A.errorCodeFor({ outcome: 'error', httpStatus: 429, error: 'rate_limited' }) === 'rate_limited',
);
check(
  'an error with no code falls back to the status',
  A.errorCodeFor({ outcome: 'error', httpStatus: 402 }) === 'http_402',
);
check('a success has no error code', A.errorCodeFor({ outcome: 'success', httpStatus: 200 }) === null);

// The point of keeping the two separate: the row reads "upstream_failed, rate
// limited" rather than losing one to get the other.
check(
  'a 429 is recorded as upstream_failed and still says why',
  A.billingOutcome({ outcome: 'error', httpStatus: 429, error: 'rate_limited' }) === 'upstream_failed' &&
    A.errorCodeFor({ outcome: 'error', httpStatus: 429, error: 'rate_limited' }) === 'rate_limited',
);

// --- hits ----------------------------------------------------------------

// A verifier that answers "this mailbox does not exist" is a successful call and
// a failed lead. Counting it as a hit feeds both smart order and the smoothed hit
// rate that prices the whole waterfall.
check(
  'a 200 that found nothing is not a hit',
  A.countsAsHit({ outcome: 'success', httpStatus: 200 }, false) === false,
);
check(
  'a 200 that found something is a hit',
  A.countsAsHit({ outcome: 'success', httpStatus: 200 }, true) === true,
);

// An uncertain answer is not a hit. The answer was lost; we do not know, and
// recording a guess would corrupt the rate that prices everything.
check(
  'an uncertain call is never a hit, even if something was found',
  A.countsAsHit({ outcome: 'uncertain', httpStatus: 409 }, true) === false,
);
check('an error is never a hit', A.countsAsHit({ outcome: 'error', httpStatus: 429 }, true) === false);

// A free call that found something is still a hit — the provider did not charge
// for it, which is not a statement about whether the answer was any good.
check(
  'a free call that found something is a hit',
  A.countsAsHit({ outcome: 'free', httpStatus: 200 }, true) === true,
);

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);