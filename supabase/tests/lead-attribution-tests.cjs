// Tests who gets credited for a find.
//
//   node supabase/tests/lead-attribution-tests.cjs
//
// The bug this file exists for was quiet and total. The lab credited a provider
// for a find only when the address the row ended up with was one that provider
// had supplied - a comparison against the row's final email. That is a
// definition that only works for the two steps that write an email. On the
// person, company, phone and enrich steps it was structurally zero, so every
// provider read as having found nothing, forever, however well it performed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-attribution-test');

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'supabase', 'functions', 'leads', 'attribution.ts'), path.join(OUT, 'attribution.ts'));
fs.writeFileSync(
  path.join(OUT, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022'],
        module: 'commonjs',
        moduleResolution: 'bundler',
        strict: true,
        outDir: path.join(OUT, 'dist'),
      },
      files: ['attribution.ts'],
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

const A = require(path.join(OUT, 'dist', 'attribution.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

const hit = (id, row) => ({ endpoint_id: id, hit: true, row_id: row });
const miss = (id, row) => ({ endpoint_id: id, hit: false, row_id: row });

// --- the waterfall case the screen exists for -------------------------------

{
  // Kitt answers first. Tomba is asked afterwards and answers too, having found
  // nothing of its own. Only Kitt earned it.
  const acc = A.foldAttempts([hit('kitt', 'r1'), hit('tomba', 'r1')]);
  check('the first answerer is credited', acc.get('kitt').firstToFind === 1);
  check('the second is not', acc.get('tomba').firstToFind === 0);
  check('both are still counted as attempts', acc.get('kitt').attempts === 1 && acc.get('tomba').attempts === 1);
  check('both are still counted as hits', acc.get('kitt').hits === 1 && acc.get('tomba').hits === 1);
}

{
  // Misses cost nothing and credit nothing, and the next provider to answer
  // gets the find.
  const acc = A.foldAttempts([miss('kitt', 'r1'), hit('tomba', 'r1')]);
  check('a miss is not credited', acc.get('kitt').firstToFind === 0);
  check('the provider after a miss is credited', acc.get('tomba').firstToFind === 1);
}

{
  // The whole chain misses. Nobody earned anything, and the cost is still
  // counted - which is what makes the two providers rank badly rather than
  // invisibly.
  const acc = A.foldAttempts([miss('kitt', 'r1'), miss('tomba', 'r1')]);
  check('a full miss credits nobody', acc.get('kitt').firstToFind === 0 && acc.get('tomba').firstToFind === 0);
  check('a full miss still counts the attempts', acc.get('kitt').attempts === 1 && acc.get('tomba').attempts === 1);
}

// --- the old definition's blind spot ---------------------------------------

{
  // The steps that do not write an email. Nothing here carries an address, and
  // under the old rule every one of these providers scored zero forever.
  const acc = A.foldAttempts([
    hit('icypeas', 'r1'),
    hit('findymail', 'r1'),
    hit('leadmagic', 'r2'),
  ]);
  check('a person search credits its first provider', acc.get('icypeas').firstToFind === 1);
  check('a person search credits nobody else', acc.get('findymail').firstToFind === 0);
  check('a second row is a second find', acc.get('leadmagic').firstToFind === 1);
}

{
  const acc = A.foldAttempts([hit('tomba', 'r1'), hit('icypeas', 'r2')]);
  check('company discovery is credited like anything else', acc.get('tomba').firstToFind === 1);
  check('and so is the fallback', acc.get('icypeas').firstToFind === 1);
}

// --- discovery, which has no row -------------------------------------------

{
  // A discovery call happens before any row exists. It cost real money and its
  // provider should appear in the spend, but it did not supply an answer for a
  // row, so crediting it would claim a find it cannot have made.
  const acc = A.foldAttempts([
    { endpoint_id: 'tomba', hit: true, row_id: null },
    { endpoint_id: 'icypeas', hit: true, row_id: null },
  ]);
  check('a row-less attempt is counted', acc.get('tomba').attempts === 1);
  check('a row-less attempt is never credited', acc.get('tomba').firstToFind === 0);
  check('and not the second one either', acc.get('icypeas').firstToFind === 0);
}

// --- one row, one credit --------------------------------------------------

{
  // A row worked twice because a chunk died after the provider was called. The
  // provider was paid twice and the work was done once, so it must be credited
  // once - otherwise its cost per find halves for no reason a user can see.
  const acc = A.foldAttempts([hit('kitt', 'r1'), hit('kitt', 'r1')]);
  check('a repeated row is credited once', acc.get('kitt').firstToFind === 1);
  check('but charged twice', acc.get('kitt').attempts === 2);
}

{
  // Many rows, one provider: the find count has to scale, or cost per find goes
  // up as history accumulates and the lab's ranking inverts itself.
  const acc = A.foldAttempts(Array.from({ length: 10 }, (_, i) => hit('kitt', 'r' + i)));
  check('each row is its own find', acc.get('kitt').firstToFind === 10);
}

// --- totals ---------------------------------------------------------------

{
  // The figure above the list is the sum of the per-provider ones. Computing it
  // separately is how a screen ends up showing "12 finds" next to rows adding up
  // to 9.
  const acc = A.foldAttempts([hit('kitt', 'r1'), hit('tomba', 'r2'), miss('aiark', 'r3'), hit('icypeas', 'r4')]);
  check('the total is the sum of the parts', A.totalFinds(acc) === 3);
  check('and the parts add up to it',
    acc.get('kitt').firstToFind + acc.get('tomba').firstToFind + acc.get('icypeas').firstToFind === A.totalFinds(acc));
}

{
  check('nothing attempted is nothing found', A.totalFinds(A.foldAttempts([])) === 0);
  check('only misses is nothing found', A.totalFinds(A.foldAttempts([miss('kitt', 'r1')])) === 0);
}

// --- order is load-bearing ------------------------------------------------

{
  // Same events, two orders, one credit. This is why the query orders by
  // created_at: without it the credit goes to whichever row the database
  // happened to return first, which is an arbitrary answer presented as a
  // measurement.
  const a = A.foldAttempts([hit('kitt', 'r1'), hit('tomba', 'r1')]);
  const b = A.foldAttempts([hit('tomba', 'r1'), hit('kitt', 'r1')]);
  check('order decides who is credited', a.get('kitt').firstToFind === 1 && b.get('tomba').firstToFind === 1);
  check('and never both', a.get('kitt').firstToFind + a.get('tomba').firstToFind === 1);
  check('and the total is unaffected', A.totalFinds(a) === 1 && A.totalFinds(b) === 1);
}

// --- nothing at all -------------------------------------------------------

{
  check('no attempts', A.totalFinds(A.foldAttempts([])) === 0);
  check('no attempts, no keys', A.foldAttempts([]).size === 0);
  check('a hit with no row id at all is still a hit', A.foldAttempts([hit('kitt', null)]).get('kitt').hits === 1);
}

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);