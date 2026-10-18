// Tests the decision-maker ranking.
//
//   node supabase/tests/lead-choose-person-tests.cjs
//
// The failure this guards against is quiet. A people search returns whoever the
// provider had; taking the first one produces a run full of engineers, every row
// looks complete, and the user's conclusion is that the search is broken rather
// than that the ranking is. Nothing errors and nothing is missing, so it would
// ship.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-choose-person-test');

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'supabase', 'functions', 'leads', 'choose-person.ts'), path.join(OUT, 'choose-person.ts'));
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
      files: ['choose-person.ts'],
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

const C = require(path.join(OUT, 'dist', 'choose-person.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// --- no candidates ---------------------------------------------------------

check('an empty list picks nobody', C.pickPerson([], ['CEO']) === null);
check('a list of nameless people picks nobody', C.pickPerson([{ name: null, title: 'CEO' }], ['CEO']) === null);
check('whitespace is not a name', C.pickPerson([{ name: '   ', title: 'CEO' }], ['CEO']) === null);
check('an untitled person is still a person', C.pickPerson([{ name: 'Ada', title: null }], ['CEO']).name === 'Ada');

// --- the actual bug: first is not best -------------------------------------

{
  // A provider returns employees in whatever order its index has them. The
  // founder is fourth and the run is for founders.
  const people = [
    { name: 'Grace', title: 'Software Engineer' },
    { name: 'Alan', title: 'Account Manager' },
    { name: 'Edsger', title: 'QA Tester' },
    { name: 'Ada', title: 'Founder & CEO' },
  ];
  check('the decision maker is found past the first result', C.pickPerson(people, ['Founder & CEO']).name === 'Ada');
  check('the default pick is still a real person', typeof C.pickPerson(people, []).name === 'string');
}

{
  // A marketing brief against an engineering-heavy list.
  const people = [
    { name: 'Linus', title: 'Kernel Engineer' },
    { name: 'Grace', title: 'Head of Marketing' },
  ];
  check('a partial title match beats no match', C.pickPerson(people, ['Marketing Director']).name === 'Grace');
}

{
  // "VP, Sales" and "Vice President of Sales" are the same job written two ways,
  // and providers disagree about which they return.
  const people = [
    { name: 'A', title: 'Regional Sales Manager' },
    { name: 'B', title: 'VP, Sales' },
  ];
  check('an abbreviation is expanded before matching', C.pickPerson(people, ['Vice President of Sales']).name === 'B');
}

{
  const people = [
    { name: 'A', title: 'Chief Executive Officer' },
    { name: 'B', title: 'CTO' },
  ];
  check('every chief abbreviation expands', C.pickPerson(people, ['CEO']).name === 'A');
}

// --- seniority when no titles were asked for -------------------------------

{
  const people = [
    { name: 'A', title: 'Marketing Intern' },
    { name: 'B', title: 'Head of Growth' },
  ];
  check('an intern is not picked as the decision maker', C.pickPerson(people, []).name === 'B');
}

{
  // Neither of these carries any word the ranking reacts to, and no titles were
  // asked for, so there is genuinely no signal and the tie-break is the only
  // thing deciding. Deliberately not "Junior Developer" - that carries an
  // exclusion and would test the seniority rule instead of the tie-break.
  const people = [
    { name: 'A', title: 'Analyst' },
    { name: 'B', title: 'Designer' },
  ];
  check('with no signal at all the first is kept, stably', C.pickPerson(people, []).name === 'A');
  check('and it is the same one both times', C.pickPerson(people, []).name === C.pickPerson([...people], []).name);
}

// --- exclusions beat seniority ---------------------------------------------

{
  // "Director" matches a wanted title, and "Assistant" should still lose.
  const people = [
    { name: 'A', title: 'Assistant to the Director' },
    { name: 'B', title: 'Director of Operations' },
  ];
  check('an assistant is not the director', C.pickPerson(people, ['Director']).name === 'B');
}

{
  const people = [
    { name: 'A', title: 'Marketing Coordinator' },
    { name: 'B', title: 'Marketing Assistant' },
  ];
  check('both excluded, one still returned', ['A', 'B'].includes(C.pickPerson(people, []).name));
}

// --- stability -------------------------------------------------------------

{
  // The same response twice must give the same person. A row whose decision
  // maker changes between chunks reads as the search finding different answers.
  const people = [
    { name: 'A', title: 'Founder' },
    { name: 'B', title: 'Founder' },
  ];
  check('the same response picks the same person twice', C.pickPerson(people, []).name === C.pickPerson(people, []).name);
  check('a tie goes to the first', C.pickPerson(people, []).name === 'A');
}

// --- scoreTitle ------------------------------------------------------------

check('a missing title scores nothing rather than failing', C.scoreTitle(null, ['CEO']) === 0);
check('an exact title scores highest', C.scoreTitle('CEO', ['CEO']) > C.scoreTitle('Sales Lead', ['CEO']));
check('a disjoint title scores low', C.scoreTitle('Warehouse Operative', ['Chief Financial Officer']) < 40);
check('scoring is case insensitive', C.scoreTitle('ceo', ['CEO']) === C.scoreTitle('CEO', ['ceo']));
check('punctuation does not hide a match', C.scoreTitle('Sr. Director, Marketing', ['Director']) > 40);

// --- describeChoice --------------------------------------------------------

check('no choice has nothing to describe', C.describeChoice(null, 5, ['CEO']) === null);
check('a single candidate needs no explanation', C.describeChoice({ name: 'A', title: 'CEO' }, 1, ['CEO']) === null);
check('a choice among many says how many', /4 people/.test(C.describeChoice({ name: 'A', title: 'CEO' }, 4, ['CEO']) || ''));
check('with no titles it does not imply a match', /closest to/.test(C.describeChoice({ name: 'A', title: 'CEO' }, 4, []) || '') === false);

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);