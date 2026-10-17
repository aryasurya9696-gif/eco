// Bisects a plpgsql function body to find the first line that stops parsing.
//
// Used when Postgres reports a syntax error at a closing delimiter, which means
// something earlier left the parser inside a string or a parenthesis and the
// reported position is nowhere near the cause. Truncating the body one line at a
// time and asking Postgres to parse it finds the real line.
//
//   node scripts/bisect-plpgsql.cjs <file.sql> <function-name>

const fs = require('fs');

const file = process.argv[2];
const fnName = process.argv[3];

const sql = fs.readFileSync(file, 'utf8');
const startAt = sql.indexOf(`create or replace function ${fnName}`);
if (startAt === -1) {
  console.error('function not found:', fnName);
  process.exit(1);
}

const fnText = sql.slice(startAt);
const lines = fnText.split(/\r?\n/);

// The body starts after the `as $tag$` line and ends before the closing tag.
const bodyStart = lines.findIndex((l) => /^\s*as\s+\$/.test(l)) + 1;
let bodyEnd = lines.length;
for (let i = bodyStart; i < lines.length; i++) {
  if (/^\s*\$\w+\s*;\s*$/.test(lines[i])) {
    bodyEnd = i;
    break;
  }
}

console.log(`${fnName}: body lines ${bodyStart + 1}..${bodyEnd}`);

const head = lines.slice(0, bodyStart);
const tail = lines.slice(bodyEnd);

// Emit a runnable function around the first `count` body lines. Statement
// boundaries are respected: a partial `if` is itself a syntax error and would
// mask the thing being looked for, so incomplete constructs are skipped.
const OPENERS = /^\s*(if|for|while|case)\b/i;

async function main() {
  const D = String.fromCharCode(36);
  const Q = D + 'bisect' + D;

  let lastGood = 0;
  let firstBad = null;

  for (let n = 1; n <= bodyEnd - bodyStart; n++) {
    const chunk = lines.slice(bodyStart, bodyStart + n);
    const text = chunk.join('\n');

    // Skip when the chunk clearly ends mid-construct.
    const ifs = (text.match(/^\s*if\b.*\bthen\s*$/gim) || []).length;
    const ends = (text.match(/^\s*end if;\s*$/gim) || []).length;
    if (ifs > ends) continue;
    if (/\bthen\s*$/i.test(text) && ends < ifs) continue;
    if (/\bcase\b[^;]*$/i.test(text.split('\n').slice(-3).join('\n')) && !/end\s*;/.test(text)) continue;

    const sqlText =
      head.join('\n') +
      '\n' +
      text +
      '\nreturn null;\n' +
      tail.join('\n');

    const res = await tools.supabase['execute_sql']({ query: sqlText.replace(/\$fn\$/g, Q) });
    void res;
    lastGood = n;
  }

  console.log('last body line that parsed:', bodyStart + lastGood);
  if (lastGood < bodyEnd - bodyStart) {
    const i = bodyStart + lastGood;
    console.log('\nthe line after it:');
    console.log('  ' + (i + 1) + ': ' + JSON.stringify(lines[i]));
    for (let k = i - 2; k <= i + 3; k++) {
      if (k >= 0 && k < lines.length) console.log('  ' + (k + 1) + ': ' + JSON.stringify(lines[k]));
    }
  } else {
    console.log('\nwhole body parsed — the error is in the header or the tail');
  }
}

main().catch((e) => {
  console.error('bisect aborted:', String(e?.message ?? e).slice(0, 300));
  process.exit(1);
});
