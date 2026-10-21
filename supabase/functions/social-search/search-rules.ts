// ============================================================================
// social-search: pure billing and CORS rules.
// ----------------------------------------------------------------------------
// No I/O and no Deno.env here, so search-rules_test.ts can exercise every rule
// without permissions or a network. A sibling module inside the function's own
// folder is bundled with the entrypoint on deploy.
// ============================================================================

export type Billable = 'billed' | 'free' | 'uncertain';

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

/**
 * Operations that are free to the customer (owner decision: News). They run
 * whether or not pricing_config has a row for them and are always charged 0,
 * so the UI's "Free" label and the ledger cannot disagree.
 */
export const FREE_OPERATIONS: ReadonlySet<string> = new Set(['treg.news.search']);

/** Whether an operation may run: priced in pricing_config, or free by policy. */
export function isOperationAvailable(op: string, pricing: Map<string, number>): boolean {
  return FREE_OPERATIONS.has(op) || pricing.has(op);
}

/** Credits per keyword for an operation. Free operations are always 0. */
export function creditsFor(op: string, pricing: Map<string, number>): number {
  if (FREE_OPERATIONS.has(op)) return 0;
  const c = pricing.get(op);
  return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : 0;
}

/**
 * Reddit's fallback runs only when the primary provider produced nothing AND
 * treg reported that it charged nothing for it. A billed empty answer, or one
 * whose charge is uncertain, has already cost money: paying a second provider
 * for the same search is what N9 was.
 */
export function shouldTryRedditFallback(primary: { billable: Billable }, primaryItemCount: number): boolean {
  return primaryItemCount === 0 && primary.billable === 'free';
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/** Vite's dev server, used only when no origin is configured at all. */
export const DEV_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];

const stripSlash = (s: string) => s.trim().replace(/\/+$/, '');

/**
 * The allowlist: ALLOWED_ORIGIN (comma-separated) plus APP_ORIGIN. With neither
 * set it is the local dev server only, never `*`. `*` is honoured only when
 * ALLOWED_ORIGIN is explicitly set to it.
 */
export function allowedOrigins(allowedOriginEnv: string | undefined, appOriginEnv: string | undefined): string[] {
  const list = [
    ...(allowedOriginEnv ?? '').split(','),
    appOriginEnv ?? '',
  ].map(stripSlash).filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : [...DEV_ORIGINS];
}

/**
 * The Access-Control-Allow-Origin value for a request: the request's Origin when
 * it is on the allowlist, otherwise the first allowed origin (so the browser
 * refuses the cross-origin read).
 */
export function corsOriginFor(requestOrigin: string | null, allowed: string[]): string {
  if (allowed.includes('*')) return '*';
  if (requestOrigin && allowed.includes(stripSlash(requestOrigin))) return stripSlash(requestOrigin);
  return allowed[0];
}

/**
 * Credits are fractional (e.g. 0.1 per keyword per channel). Totals are rounded
 * to 2 decimals so float noise (0.1 * 3 = 0.30000000000000004) never reaches
 * wallet_reserve / wallet_settle or the response. Never rounded to integers.
 */
export function roundCredits(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
