/**
 * Echo Leads — reading what a provider said
 * ---------------------------------------------------------------------------
 * The two places where a provider's answer becomes the contents of a row.
 *
 * Both are pure functions over a JSON body. Both were untestable inside a file
 * that reaches for Deno.env and imports the Supabase client over https, and both
 * fail silently when they are wrong: a reader that finds nothing produces a row
 * that quietly did not find an address, and a verdict reader that reads nothing
 * produces a row whose address was never checked while its badge says it was.
 * Neither shows up as an error anywhere, which is the problem.
 *
 * So both walk the body breadth-first instead of trusting a path. The path is
 * the part that is unverified — no endpoint has been called against a live
 * response yet, so every shape here is a guess — and the shape of a nested
 * object is not. Keys are checked by name at every level on the way down, so a
 * verdict three objects deep is still found.
 *
 * Both return null rather than guessing. A reader that invents an answer is
 * worse than one that declines: a miss is free on a per-success provider and the
 * next provider is tried, but a fabricated verdict is charged for, trusted, and
 * shown to the user as a check that never happened.
 */

export type Verdict = 'deliverable' | 'catch_all' | 'undeliverable';

/**
 * What a verifier said about an address.
 *
 * null means nothing could be read, and that is a real fourth answer rather than a
 * failure to parse. It is the one that costs the user nothing: a verifier that
 * could not be reached is Echo's outage, not evidence about the address, and
 * billing for it would charge the user for our downtime while producing a row
 * that reads as checked when nothing was checked.
 *
 * The vocabulary is a guess until an endpoint is verified against a real
 * response — see the banner in registry.ts. So this walks the body rather than
 * trusting a path, and returns null rather than guessing when nothing matches.
 * Guessing here is the one mistake with no free failure mode: reading a
 * deliverable as undeliverable throws away a good lead and charges the user for
 * the privilege.
 */
export function readVerdict(body: unknown): Verdict | null {
  if (!body || typeof body !== 'object') return null;

  const DELIVERABLE = new Set([
    'valid', 'deliverable', 'ok', 'safe', 'good', 'pass', 'passed',
    'high', 'confirmed', 'real', 'true', 'exists', 'live',
  ]);
  const CATCH_ALL = new Set([
    'catch_all', 'catchall', 'catch-all', 'catch all', 'role', 'generic',
    'pattern', 'role_address', 'team', 'info',
  ]);
  const UNDELIVERABLE = new Set([
    'invalid', 'undeliverable', 'risky', 'bad', 'fail', 'failed', 'failure',
    'bounce', 'bounced', 'no_email', 'no-email', 'none', 'unknown_address',
    'do_not_send', 'do-not-send', 'disposable', 'spamtrap', 'false',
  ]);

  // A bare boolean is the cleanest signal a verifier can give, so it is read
  // before any of the vocabulary.
  const asBool = (v: unknown): Verdict | null => {
    if (v === true) return 'deliverable';
    if (v === false) return 'undeliverable';
    return null;
  };

  const asWord = (v: unknown): Verdict | null => {
    if (typeof v !== 'string') return null;
    const w = v.trim().toLowerCase();
    if (DELIVERABLE.has(w)) return 'deliverable';
    if (CATCH_ALL.has(w)) return 'catch_all';
    if (UNDELIVERABLE.has(w)) return 'undeliverable';
    return null;
  };

  // Keys worth reading by name. Checked on every object visited, so a verdict
  // nested three levels deep under a provider-specific key is still found.
  const KEYS = [
    'status', 'result', 'verdict', 'outcome', 'deliverability',
    'valid', 'is_valid', 'isValid', 'deliverable', 'is_deliverable',
    'isDeliverable', 'email_valid', 'type', 'classification', 'quality', 'flag',
  ];

  const seen = new Set<unknown>();
  const queue: unknown[] = [body];

  while (queue.length && queue.length < 400) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    for (const key of KEYS) {
      const v = (cur as Record<string, unknown>)[key];
      const hit = asBool(v) ?? asWord(v);
      if (hit) return hit;
    }

    for (const v of Object.values(cur as Record<string, unknown>)) {
      if (v && typeof v === 'object') queue.push(v);
    }
  }

  return null;
}
/**
 * Pulls an address out of a provider body.
 *
 * The shape is a guess until an endpoint is verified against a real response —
 * see the banner in registry.ts. Wrong here costs a miss, which is free on a
 * per-success provider, so the failure mode is a row that quietly finds nothing
 * rather than an overcharge. The next provider is always tried.
 */
export function readEmail(body: unknown, hint: string): string | null {
  if (!body || typeof body !== 'object') return null;

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const looksLikeEmail = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim().toLowerCase();
    if (!EMAIL_RE.test(t)) return null;
    // An example address from a provider's placeholder field is not a lead.
    if (/example\.(com|org|net)$/.test(t)) return null;
    if (t.startsWith('test@')) return null;
    return t;
  };

  // Walk the body breadth-first rather than guessing at a path, because the path
  // is the part that is unverified and the shape of a nested object is not.
  const seen = new Set<unknown>();
  const queue: unknown[] = [body];

  while (queue.length && queue.length < 400) {
    const cur = queue.shift();

    if (typeof cur === 'string') {
      const hit = looksLikeEmail(cur);
      if (hit) return hit;
      continue;
    }

    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    // Keys worth checking by name, before descending: most providers put the
    // address under one of these.
    for (const key of ['email', 'email_address', 'work_email', 'business_email', 'contact_email']) {
      const hit = looksLikeEmail((cur as any)[key]);
      if (hit) return hit;
    }

    for (const v of Object.values(cur as Record<string, unknown>)) {
      if (typeof v === 'object' && v !== null) queue.push(v);
      else if (typeof v === 'string') queue.push(v);
    }
  }

  void hint;
  return null;
}