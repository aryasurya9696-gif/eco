// Reports parenthesis balance across a SQL file, ignoring strings and comments.
//
// A plpgsql syntax error reported at a closing delimiter almost always means an
// earlier line left the parser inside a string or an unclosed paren, and the
// reported position is nowhere near the cause. This finds the line where the
// running depth stops returning to where it should.
//
//   node scripts/paren-balance.cjs <file.sql>

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/paren-balance.cjs <file.sql>');
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

let depth = 0;
let inString = false;
let inDollarQuote = null;
let inBlockComment = false;
const suspect = [];

lines.forEach((line, i) => {
  const before = depth;
  let j = 0;

  while (j < line.length) {
    const two = line.slice(j, j + 2);

    if (inBlockComment) {
      if (two === '*/') { inBlockComment = false; j += 2; continue; }
      j++;
      continue;
    }

    if (inDollarQuote) {
      if (line.startsWith(inDollarQuote, j)) { j += inDollarQuote.length; inDollarQuote = null; continue; }
      j++;
      continue;
    }

    if (inString) {
      if (line[j] === '\\') { j += 2; continue; }
      if (line[j] === "'") { inString = false; }
      j++;
      continue;
    }

    if (two === '--') break;                       // rest of line is a comment
    if (two === '/*') { inBlockComment = true; j += 2; continue; }

    const c = line[j];

    // Dollar quote opener: $tag$ where tag is an identifier.
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(line.slice(j));
      if (m) { inDollarQuote = m[0]; j += m[0].length; continue; }
    }

    if (c === "'") { inString = true; j++; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;

    j++;
  }

  const isComment = line.trim().startsWith('--');
  if (!isComment && depth !== before && before === 0 && depth !== 0) {
    suspect.push({ line: i + 1, depth, text: line.slice(0, 90) });
  }
  if (!isComment && depth < 0) {
    suspect.push({ line: i + 1, depth, text: line.slice(0, 90) });
  }
});

console.log(file);
console.log('  final depth:', depth, depth === 0 ? '(balanced)' : '(UNBALANCED)');
console.log('  unterminated string:', inString);
console.log('  unterminated dollar quote:', inDollarQuote);
console.log('  unterminated block comment:', inBlockComment);
console.log('');
if (suspect.length) {
  console.log('  lines that opened a paren that never closed at that level:');
  for (const s of suspect) console.log(`    L${s.line} depth=${s.depth}  ${JSON.stringify(s.text)}`);
} else {
  console.log('  no unbalanced openers found');
}
