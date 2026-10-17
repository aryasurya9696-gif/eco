const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'supabase', 'functions', 'ai', 'index.ts');
const TMP = process.env.TEMP || os.tmpdir();
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const source = fs.readFileSync(SRC, 'utf8');

// Everything between the ICP helper block and the pre-existing fallbackIcp that
// follows it. The start marker is the prompt constant rather than the banner
// comment so the slice does not depend on the prose above it.
const start = source.indexOf('const ICP_SYSTEM_PROMPT');
const end = source.indexOf('function fallbackIcp(offerText: string)');
if (start === -1 || end === -1 || end < start) {
  console.error('could not locate the ICP helper block in ai/index.ts');
  process.exit(1);
}

const OUT = path.join(TMP, 'icp-under-test');
fs.mkdirSync(OUT, { recursive: true });

const tsPath = path.join(OUT, 'helpers.ts');
fs.writeFileSync(
  tsPath,
  source.slice(start, end) +
    `\nexport { parseJsonLoose, normaliseIcp, condensePages, fallbackIcpDocument, regionToCode, sizeToRange, asStringList };\n`,
  'utf8',
);

// A tsconfig rather than flags: without moduleResolution alongside module, tsc
// refuses the outDir outright, and passing that as a flag pair is fiddly enough
// to be worth a file.
const cfgPath = path.join(OUT, 'tsconfig.json');
fs.writeFileSync(
  cfgPath,
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        // bundler + preserve rather than commonjs + node10: node10 is
        // deprecated and hard-errors on this TypeScript. The program has no
        // imports, so the emit is loadable as CJS either way.
        module: 'preserve',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        outDir: path.join(OUT, 'dist'),
      },
      include: ['helpers.ts'],
    },
    null,
    2,
  ),
  'utf8',
);

try {
  execFileSync(process.execPath, [TSC, '-p', cfgPath], { stdio: 'pipe' });
} catch (e) {
  console.error('compile failed:');
  console.error(String(e.stdout || e.message).split('\n').slice(0, 12).join('\n'));
  process.exit(1);
}

const M = require(path.join(OUT, 'dist', 'helpers.js'));

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// --- parseJsonLoose: what a model actually sends back ------------------------

check('parses clean json', M.normaliseIcp(M.parseJsonLoose('{"summary":"a","segments":[{"name":"x"}]}')) !== null);
check('strips a code fence', M.normaliseIcp(M.parseJsonLoose('```json\n{"segments":[{"name":"y"}]}\n```')) !== null);
check(
  'finds the object inside prose',
  M.normaliseIcp(M.parseJsonLoose('Sure! Here is your profile:\n{"segments":[{"name":"z"}]}\nHope that helps.')) !== null,
);
check(
  'a brace inside a string value does not end the object early',
  M.parseJsonLoose('p {"summary":"use {braces} freely","segments":[{"name":"ok"}]} s')?.summary === 'use {braces} freely',
);
check(
  'an escaped quote does not break string state',
  M.parseJsonLoose('{"summary":"a \\" brace } here","segments":[{"name":"ok"}]}')?.summary === 'a " brace } here',
);
check('returns null for unparseable text', M.parseJsonLoose('no json at all') === null);

// --- normaliseIcp ----------------------------------------------------------

check('rejects a non-object', M.normaliseIcp(null) === null && M.normaliseIcp([]) === null && M.normaliseIcp('x') === null);
check(
  'rejects a document with no usable segment',
  M.normaliseIcp({ segments: [] }) === null &&
    M.normaliseIcp({ segments: [{}] }) === null &&
    M.normaliseIcp({ segments: ['a string'] }) === null,
);
check('keeps a segment that has only a name', M.normaliseIcp({ segments: [{ name: 'Solo' }] })?.segments?.[0]?.name === 'Solo');

check(
  'missing lists become empty lists, not undefined',
  (() => {
    const s = M.normaliseIcp({ segments: [{ name: 'a' }] }).segments[0];
    return s.keywords.length === 0 && s.countries.length === 0 && s.pains.length === 0 && s.employeeRange === null;
  })(),
);
check(
  'a wrong-typed list is dropped, not spread',
  (() => {
    const s = M.normaliseIcp({ segments: [{ name: 'a', keywords: 'accounting', countries: 42 }] }).segments[0];
    return s.keywords.length === 0 && s.countries.length === 0;
  })(),
);
check('countries are uppercased', M.normaliseIcp({ segments: [{ name: 'a', countries: ['gb', 'us'] }] }).segments[0].countries.join() === 'GB,US');

check(
  'an inverted employee range is dropped rather than sorted',
  M.normaliseIcp({ segments: [{ name: 'a', employeeRange: [200, 10] }] }).segments[0].employeeRange === null,
);
check(
  'a valid employee range survives',
  JSON.stringify(M.normaliseIcp({ segments: [{ name: 'a', employeeRange: [10, 50] }] }).segments[0].employeeRange) === '[10,50]',
);

check(
  'an out-of-bounds primarySegment falls back to 0',
  M.normaliseIcp({ segments: [{ name: 'a' }], primarySegment: 7 }).primarySegment === 0 &&
    M.normaliseIcp({ segments: [{ name: 'a' }], primarySegment: -3 }).primarySegment === 0,
);
check(
  'a valid primarySegment is kept',
  M.normaliseIcp({ segments: [{ name: 'a' }, { name: 'b' }], primarySegment: 1 }).primarySegment === 1,
);
check(
  'confidence is clamped into 0..1',
  M.normaliseIcp({ segments: [{ name: 'a' }], confidence: 4 }).confidence === 1 &&
    M.normaliseIcp({ segments: [{ name: 'a' }], confidence: -1 }).confidence === 0 &&
    M.normaliseIcp({ segments: [{ name: 'a' }], confidence: 'x' }).confidence === 0.5,
);

check(
  'at most five segments are kept',
  M.normaliseIcp({ segments: Array.from({ length: 12 }, (_, i) => ({ name: 's' + i })) }).segments.length === 5,
);
check(
  'an over-long string is truncated rather than rejected',
  M.normaliseIcp({ segments: [{ name: 'n'.repeat(500) }] }).segments[0].name.length === 120,
);

// --- condensePages ---------------------------------------------------------

check('empty input yields empty output', M.condensePages([]).text === '' && M.condensePages([]).usedPages === 0);
check('a page with no body is skipped', M.condensePages([{ title: 'T' }, { markdown: 'words here' }]).usedPages === 1);
check(
  'a page is kept whole or not at all',
  (() => {
    const big = Array.from({ length: 8000 }, () => 'w').join(' ');
    const r = M.condensePages([{ markdown: big }, { markdown: big }, { markdown: big }]);
    return r.usedPages === 1;
  })(),
);
check('a title becomes a heading', M.condensePages([{ title: 'Pricing', markdown: 'we charge' }]).text.startsWith('## Pricing'));

// --- the fallback ----------------------------------------------------------

check('region codes map', M.regionToCode('UK') === 'GB' && M.regionToCode('united states') === 'US' && M.regionToCode('Nowhere') === null);
check(
  'size chips map to ranges',
  JSON.stringify(M.sizeToRange('11-50')) === '[11,50]' && M.sizeToRange('nonsense') === null && M.sizeToRange(undefined) === null,
);

check(
  'the fallback invents no country the user did not pick',
  M.fallbackIcpDocument({ website: '', offer: 'a CRM for accountants', regions: [], sizes: [], pricePoint: '', hypothesis: '', note: '' })
    .segments[0].countries.length === 0,
);
check(
  'the fallback uses only the regions given',
  M.fallbackIcpDocument({
    website: '', offer: 'x', regions: ['UK', 'India'], sizes: ['11-50'],
    pricePoint: '$50 to $500/mo', hypothesis: 'accounting firms', note: '',
  }).segments[0].countries.join() === 'GB,IN',
);
check(
  'the fallback is marked low confidence and says so',
  (() => {
    const d = M.fallbackIcpDocument({ website: '', offer: 'x', regions: [], sizes: [], pricePoint: '', hypothesis: '', note: '' });
    return d.confidence < 0.5 && d.assumptions.some((a) => /did not respond/i.test(a));
  })(),
);

// ---------------------------------------------------------------------------

console.log('-'.repeat(70));
for (const f of fails) console.log('  FAIL  ' + f);
console.log('-'.repeat(70));
console.log(`${pass}/${pass + fails.length} assertions passed`);

process.exit(fails.length ? 1 : 0);
