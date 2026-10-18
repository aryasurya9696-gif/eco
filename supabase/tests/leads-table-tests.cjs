// Tests the arithmetic that stops an expanded row from landing on top of the
// rows below it.
//
//   node supabase/tests/leads-table-tests.cjs
//
// This is a rendering bug and it is guarded by an arithmetic test on purpose.
// There is no browser in this harness, so the only thing standing between a
// regression and the same screenshot again is a check on the numbers that decide
// where each row is drawn.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'leads-table-test');

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'src', 'lib', 'leads-table.ts'), path.join(OUT, 'leads-table.ts'));
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
      files: ['leads-table.ts'],
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

const T = require(path.join(OUT, 'dist', 'leads-table.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// --- the bug: nothing moved ------------------------------------------------

{
  // Six rows, the second one open, the panel 200px tall. Rows 3 to 6 were all
  // drawn at their own offsets, straight through it.
  const H = 200;
  const shifts = [0, 1, 2, 3, 4, 5].map((i) => T.rowShift(i, 1, H));
  check('the row above the open one does not move', shifts[0] === 0);
  check('the open row itself does not move', shifts[1] === 0);
  check('the row directly below moves by the panel height', shifts[2] === H);
  check('every row below moves by the panel height', shifts.slice(2).every((s) => s === H));

  // Nothing may overlap anything: the gap between any two consecutive rows has
  // to be the row height plus the panel if the panel sits between them.
  const rowH = 44;
  const tops = [0, 1, 2, 3, 4, 5].map((i) => i * rowH + shifts[i]);
  let overlaps = 0;
  for (let i = 0; i < tops.length - 1; i++) {
    if (tops[i + 1] < tops[i] + rowH) overlaps++;
  }
  check('no two rows overlap once the panel is placed', overlaps === 0);
}

// --- nothing open ----------------------------------------------------------

{
  check('nothing open, nothing moves', T.rowShift(4, -1, 0) === 0);
  // The index of a row that has left the list. -1 >= every index is false in the
  // right direction and true in the wrong one, and getting it wrong offsets the
  // whole table by a panel nobody is rendering.
  check('a stale index moves nothing', T.rowShift(0, -1, 300) === 0);
  check('a stale index moves nothing for the last row either', T.rowShift(99, -1, 300) === 0);
}

// --- the open row at either end --------------------------------------------

{
  check('the first row open moves every other row', T.rowShift(3, 0, 150) === 150);
  check('but not itself', T.rowShift(0, 0, 150) === 0);
  check('the last row open moves nothing', T.rowShift(5, 5, 150) === 0);
  check('because there is nothing below it', T.rowShift(4, 5, 150) === 0);
}

// --- before the panel has been measured ------------------------------------

{
  // One frame on mount the panel exists but has not been measured. Shifting by
  // an unknown height would be worse than not shifting, and the panel carries a
  // z-index so it is legible for that frame.
  check('an unmeasured panel shifts nothing', T.rowShift(3, 1, 0) === 0);
  check('a negative height shifts nothing', T.rowShift(3, 1, -5) === 0);
}

// --- scroll range ----------------------------------------------------------

{
  check('an open row adds its panel to the scroll height', T.extraScrollHeight(1, 220) === 220);
  check('nothing open adds nothing', T.extraScrollHeight(-1, 220) === 0);
  check('an unmeasured panel adds nothing', T.extraScrollHeight(1, 0) === 0);

  // The last row of the list, expanded. Without this the panel is drawn below
  // the end of what the scroll container thinks exists, and the user cannot
  // scroll to read it.
  const rows = 8;
  const rowH = 44;
  const last = rows - 1;
  const contentTop = last * rowH + rowH;
  const contentHeight = rows * rowH + T.extraScrollHeight(last, 220);
  check('the panel on the last row is inside the scrollable area', contentTop + 220 <= contentHeight);
}

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);