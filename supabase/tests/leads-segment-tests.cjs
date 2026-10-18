// Tests the segment arithmetic: company size, and saving without data loss.
//
//   node supabase/tests/leads-segment-tests.cjs
//
// Both of these fail silently on screen. A size that parses to NaN still renders,
// it just renders as "no size selected" and the saved profile carries a value
// the backend then refuses. A save that drops the other segments looks like a
// successful save, because it is one — of the wrong document.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src', 'lib', 'leads-segment.ts');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'leads-segment-test');

// The module is plain TypeScript with no imports, so the project's own compiler
// can turn it into something requireable rather than this file re-implementing it.
const { execFileSync } = require('child_process');
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(SRC, path.join(OUT, 'leads-segment.ts'));
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
      files: ['leads-segment.ts'],
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

const S = require(path.join(OUT, 'dist', 'leads-segment.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// --- the bug: '1000+' has no hyphen in it -----------------------------------

{
  const b = S.sizeBoundsOf('1001+');
  check('the open-ended band is a number, not NaN', Number.isFinite(b[0]) && Number.isFinite(b[1]));
  check('the open-ended band starts above the one below it', b[0] === 1001);
  check('the open-ended band has an open top', b[1] > b[0]);
}

{
  // A profile saved by the previous build holds [1000, 999999] under the old
  // "1000+" label. It must resolve to something rather than showing nothing
  // selected - that was the silent half of the same bug.
  check('a profile saved with the old open band still shows its size',
    S.sizeLabelOf([1000, 999999]) === '1000+');
}

{
  // The round trip is the assertion that matters. The old code could not do this
  // for the open-ended band, which is why a profile that had it could never be
  // shown as having it.
  for (const band of S.SIZE_BANDS) {
    check(
      'band ' + band.label + ' round-trips',
      S.sizeLabelOf(S.sizeBoundsOf(band.label)) === band.label,
    );
  }
}

{
  // Every band must be a number. One NaN in this table is enough to write a
  // profile the backend refuses to search.
  check(
    'no band has a non-number bound',
    S.SIZE_BANDS.every((b) => Number.isFinite(b.lo) && Number.isFinite(b.hi)),
  );
  check(
    'bands do not overlap',
    S.SIZE_BANDS.every((b, i) => i === 0 || S.SIZE_BANDS[i - 1].hi < b.lo),
  );
}

// --- a range that is not a band ---------------------------------------------

check('a custom range has no band', S.sizeLabelOf([5, 25]) === null);
check('a custom range is still readable back', S.sizeBoundsOf(S.SIZE_BANDS[0].label)[0] === 1);
check('a missing range is not a band', S.sizeLabelOf(null) === null);
check('a missing range is not junk', S.sizeIsJunk(null) === false);
check('an undefined range is not junk', S.sizeIsJunk(undefined) === false);

// --- junk ranges are called junk --------------------------------------------

check('NaN is junk', S.sizeIsJunk([NaN, NaN]) === true);
check('a null bound is junk', S.sizeIsJunk([null, 50]) === true);
check('a stringy bound is junk', S.sizeIsJunk(['abc', 50]) === true);
check('a one-sided range is junk', S.sizeIsJunk([10]) === true);
check('a real range is not junk', S.sizeIsJunk([11, 50]) === false);
check('a numeric-string range is not junk', S.sizeIsJunk(['11', '50']) === false);

{
  // A junk range must stop the run rather than quietly widening it. Dropping an
  // unreadable size filter searches every company instead of the large ones.
  check('a junk range is not searchable', S.isSearchable({ name: 'UK firms', employeeRange: [NaN, NaN] }) === false);
}

// --- what the search will actually ask for ----------------------------------

{
  check('keywords and industries are what get searched',
    S.searchTextOf({ name: 'Series A founders', keywords: ['VAT', 'year-end'], industries: ['Accounting'] }) === 'VAT year-end Accounting');
  check('industries alone are enough',
    S.searchTextOf({ name: 'ignored', industries: ['Accounting'] }) === 'Accounting');
  check('the name stands in when there is nothing else',
    S.searchTextOf({ name: 'UK accounting firms', keywords: [], industries: [] }) === 'UK accounting firms');
  check('blank fields are not searched for',
    S.searchTextOf({ name: 'x', keywords: ['  ', ''], industries: [] }) === 'x');
}

{
  check('a named segment is searchable', S.isSearchable({ name: 'UK accounting firms' }) === true);
  check('an empty segment is not', S.isSearchable({ name: '', keywords: [], industries: [] }) === false);
  check('a whitespace name is not', S.isSearchable({ name: '   ' }) === false);
  check('industries alone are searchable', S.isSearchable({ industries: ['Accounting'] }) === true);
}

// --- saving without losing the other segments -------------------------------

{
  // The bug. One segment in, one segment out, and the other two gone with no
  // confirmation and no way back.
  const doc = { segments: [{ name: 'first' }, { name: 'second' }, { name: 'third' }], primarySegment: 1 };
  const out = S.mergeSegment(doc, { name: 'second, edited' });

  check('a three-segment document keeps its three segments', out.segments.length === 3);
  check('the edited one is the one that changed', out.segments[1].name === 'second, edited');
  check('the ones not being edited are untouched', out.segments[0].name === 'first' && out.segments[2].name === 'third');
  check('the primary index is kept', out.primarySegment === 1);
}

{
  const doc = { segments: [{ name: 'only' }], primarySegment: 0 };
  const out = S.mergeSegment(doc, { name: 'edited' });
  check('a one-segment document still works', out.segments.length === 1 && out.segments[0].name === 'edited');
}

{
  check('no document at all creates one', S.mergeSegment(null, { name: 'new' }).segments.length === 1);
  check('an empty document creates one', S.mergeSegment({ segments: [] }, { name: 'new' }).segments.length === 1);
  check('a document with no segments key creates one', S.mergeSegment({}, { name: 'new' }).segments.length === 1);
}

{
  // A malformed primarySegment must not throw away the edit.
  const out = S.mergeSegment({ segments: [{ a: 1 }, { a: 2 }], primarySegment: 7 }, { name: 'edited' });
  check('a primarySegment past the end appends rather than losing the edit',
    out.segments.length === 3 && out.segments[2].name === 'edited');
  check('and points at it', out.primarySegment === 2);
}

{
  check('a negative primarySegment does not write to index -1',
    S.mergeSegment({ segments: [{ a: 1 }], primarySegment: -3 }, { name: 'edited' }).segments.length === 1);
}

{
  // The input must not be mutated. It is the state object the form holds, and a
  // save that edited it would make the form's next change start from the wrong
  // document.
  const doc = { segments: [{ name: 'a' }], primarySegment: 0 };
  S.mergeSegment(doc, { name: 'b' });
  check('the original document is not mutated', doc.segments[0].name === 'a');
}

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);