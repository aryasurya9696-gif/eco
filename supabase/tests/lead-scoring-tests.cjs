// Tests fit scoring.
//
//   node supabase/tests/lead-scoring-tests.cjs
//
// The three promises the score makes, each asserted: missing data is not counted
// against a lead, too little data produces no number, and every point has a
// reason the user can read.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-scoring-test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'supabase', 'functions', 'leads', 'scoring.ts'), path.join(OUT, 'scoring.ts'));
fs.writeFileSync(path.join(OUT, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'ES2022', lib: ['ES2022'], module: 'preserve', moduleResolution: 'bundler', strict: true, noEmitOnError: true, outDir: path.join(OUT, 'dist') },
  files: ['scoring.ts'],
}));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(OUT, 'tsconfig.json')], { stdio: 'pipe', cwd: ROOT });
} catch (e) {
  console.error(String(e.stdout || e.message).split('\n').slice(0, 20).join('\n'));
  process.exit(1);
}
const S = require(path.join(OUT, 'dist', 'scoring.js'));

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
};

const rules = S.rulesFromSegment({
  targetTitles: ['Marketing Director', 'Head of Marketing'],
  industries: ['software'],
  countries: ['US'],
  employeeRange: [50, 500],
});

// --- a lead that matches everything ------------------------------------------
const ideal = {
  title: 'Head of Marketing',
  location: 'Austin, United States',
  email_status: 'verified',
  phone: '+15550100',
  company: { industry: 'Software Development', employee_count: 120, country_code: 'US' },
};
const r1 = S.scoreLead(ideal, rules);
check('ideal lead scores 100', r1.score === 100, r1);
check('ideal lead is a strong fit', r1.label === 'Strong fit');
check('every factor has a reason', r1.reasons.length === 7 && r1.reasons.every((x) => x.note && x.max > 0), r1.reasons);
check('reasons add up to the score', Math.round((100 * r1.reasons.reduce((a, x) => a + x.points, 0)) / r1.reasons.reduce((a, x) => a + x.max, 0)) === r1.score);

// --- missing data is neutral -------------------------------------------------
// Same lead without industry, size or phone: scored on what is known, not marked down.
const partial = { title: 'Head of Marketing', location: 'United States', email_status: 'verified' };
const r2 = S.scoreLead(partial, rules);
check('missing industry/size/phone does not lower the score', r2.score === 100, r2);
check('missing factors produce no reason line', !r2.reasons.some((x) => ['Industry', 'Company size', 'Phone'].includes(x.factor)));
check('coverage reflects what was checked', r2.coverage < 1 && r2.coverage > 0.5, r2.coverage);

// An unchecked or absent email is missing data, not a negative.
const r3 = S.scoreLead({ ...ideal, email_status: 'unchecked' }, rules);
const r3b = S.scoreLead({ ...ideal, email_status: 'not_found' }, rules);
check('unchecked email is neutral', r3.score === 100 && !r3.reasons.some((x) => x.factor === 'Email'));
check('no email is neutral', r3b.score === 100);
// But a known-bad address is a real negative.
const r4 = S.scoreLead({ ...ideal, email_status: 'invalid' }, rules);
check('invalid email costs points', r4.score < 100 && r4.reasons.find((x) => x.factor === 'Email').points === 0);
check('catch-all earns half', S.scoreLead({ ...ideal, email_status: 'catch_all' }, rules).reasons.find((x) => x.factor === 'Email').points === Math.round(rules.email.weight / 2));

// --- too little data ---------------------------------------------------------
const r5 = S.scoreLead({ phone: '+1555' }, rules);
check('almost nothing known -> no number', r5.score === null && r5.label === 'Not enough data', r5);
const r6 = S.scoreLead({}, rules);
check('nothing known -> no number', r6.score === null);

// --- a poor fit --------------------------------------------------------------
const poor = { title: 'Software Engineer', location: 'Berlin, Germany', email_status: 'verified', company: { industry: 'Retail', employee_count: 20000 } };
const r7 = S.scoreLead(poor, rules);
check('poor fit is weak', r7.label === 'Weak fit' && r7.score < 40, r7);
check('poor fit explains itself', r7.reasons.find((x) => x.factor === 'Title').note.includes('not one of'));

// --- seniority ---------------------------------------------------------------
check('CEO -> c_suite', S.seniorityOf('CEO & Co-founder') === 'c_suite');
check('Co-founder -> founder', S.seniorityOf('Co-Founder') === 'founder');
check('VP Sales -> vp', S.seniorityOf('VP Sales') === 'vp');
check('Head of Growth -> head', S.seniorityOf('Head of Growth') === 'head');
check('Marketing Manager -> manager', S.seniorityOf('Marketing Manager') === 'manager');
check('provider attribute wins over title', S.seniorityOf('Engineer', 'director') === 'director');
check('unknown title -> null', S.seniorityOf('Wizard') === null);
check('empty title -> null', S.seniorityOf('') === null);

// --- location matching -------------------------------------------------------
const loc = S.cleanRules({ ...S.DEFAULT_RULES, locations: { include: ['GB'], weight: 10 } });
check('GB matches United Kingdom', S.scoreLead({ location: 'London, United Kingdom', email_status: 'verified', title: 'CEO' }, loc).reasons.find((x) => x.factor === 'Location').points === 10);
check('GB does not match Germany', S.scoreLead({ location: 'Berlin, Germany', email_status: 'verified', title: 'CEO' }, loc).reasons.find((x) => x.factor === 'Location').points === 0);

// --- headcount from a range ---------------------------------------------------
const sz = S.scoreLead({ title: 'CEO', email_status: 'verified', company: { employee_range: '51-200' } }, rules);
check('employee range midpoint used', sz.reasons.find((x) => x.factor === 'Company size').points === rules.employees.weight);

// --- rule cleaning -----------------------------------------------------------
const c = S.cleanRules({ titles: { include: ['CEO', 5, ''], weight: 999 }, seniority: { levels: ['vp', 'emperor'] }, thresholds: { strong: 50, possible: 80 } });
check('weights clamped to 100', c.titles.weight === 100);
check('non-strings dropped from lists', JSON.stringify(c.titles.include) === JSON.stringify(['CEO']));
check('unknown seniority dropped', JSON.stringify(c.seniority.levels) === JSON.stringify(['vp']));
check('possible threshold never above strong', c.thresholds.possible <= c.thresholds.strong);
check('garbage rules fall back to defaults', S.cleanRules('nonsense').email.weight === S.DEFAULT_RULES.email.weight);
check('label never claims probability', ['Strong fit', 'Possible fit', 'Weak fit', 'Not enough data'].includes(r1.label));

console.log(`${pass}/${pass + fails.length} assertions passed`);
if (fails.length) {
  for (const x of fails) console.log('  FAIL ' + x);
  process.exit(1);
}
