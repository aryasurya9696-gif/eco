/**
 * Typechecks the leads edge function without Deno.
 *
 * The function is ordinary TypeScript that happens to reach for two things the
 * Node compiler has never heard of: the `Deno` global for secrets and timers,
 * and a bare `https://` specifier for the Supabase client. Neither is worth
 * installing a second runtime for, and neither can be typechecked by ignoring
 * the file — which is how a 1,500-line worker that moves money ends up
 * unchecked.
 *
 * So the modules are copied out and given a declaration for the two things they
 * reach for. Everything else is checked as written: the step planner's return
 * types against the worker's destructuring, the credit function's argument shape
 * against the object literal that is passed to it, and the registry's entry type
 * against the entries it indexes.
 *
 *   node scripts/typecheck-leads-function.cjs
 *
 * Run it after touching anything under supabase/functions/leads/.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'supabase', 'functions', 'leads');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'leads-typecheck');

const MODULES = [
  'steps.ts',
  'pricing-row.ts',
  'billing.ts',
  'registry.ts',
  'treg.ts',
  'discover.ts',
  'choose-person.ts',
  'attribution.ts',
  'api-usage.ts',
  'endpoints.ts',
  'scoring.ts',
  'workspace.ts',
  'index.ts',
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const name of MODULES) {
  const src = fs.readFileSync(path.join(SRC, name), 'utf8');
  // The .ts extension on relative imports is required by Deno and not resolvable
  // by Node's resolver. Confined to import statements.
  const rewritten = src.replace(/from '(\.\/[^']+)\.ts'/g, "from '$1'");
  fs.writeFileSync(path.join(OUT, name), rewritten, 'utf8');
}

// What Deno provides. Deliberately narrow: everything the function actually
// touches, so that a new use of Deno is a type error rather than silently
// permitted and undefined at runtime.
fs.writeFileSync(
  path.join(OUT, 'deno-shim.d.ts'),
  `
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): { finished: Promise<void> };
};
`.trimStart(),
  'utf8',
);

// The bare https specifier. Typed as any because the real client's generics are
// not what is being checked here; what is being checked is that the code uses it
// consistently.
fs.writeFileSync(
  path.join(OUT, 'remote-shim.d.ts'),
  `
declare module 'https://esm.sh/@supabase/supabase-js@2' {
  export const createClient: any;
}
`.trimStart(),
  'utf8',
);

fs.writeFileSync(
  path.join(OUT, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'preserve',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noImplicitReturns: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      include: [...MODULES, 'deno-shim.d.ts', 'remote-shim.d.ts'],
    },
    null,
    2,
  ),
);

let failed = false;
try {
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(OUT, 'tsconfig.json')],
    { stdio: 'pipe', cwd: ROOT },
  );
  console.log(`leads function: typecheck clean (${MODULES.length} modules)`);
} catch (e) {
  failed = true;
  const out = String(e.stdout || e.message);
  console.log(out.split('\n').filter((l) => l.trim()).slice(0, 30).join('\n'));
}

process.exit(failed ? 1 : 0);