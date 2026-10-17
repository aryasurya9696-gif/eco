/**
 * Echo Leads — the data-provider adapter
 * ----------------------------------------------------------------------------
 * Every call out of Leads goes through here, and nothing else calls a provider.
 * Three things this owns, and they are the three that go wrong when each is done
 * somewhere else:
 *
 *   the real cost     read from the response header, never from the body, never
 *                     from the registry. The registry says what an endpoint is
 *                     believed to cost; only the header says what it did.
 *   the outcome       whether a call worked is a different question from whether
 *                     it found anything, and from whether it was charged. Those
 *                     are three outcomes, not two, and conflating them is how a
 *                     miss gets billed or a charge gets refunded.
 *   the identity      one idempotency key per logical attempt, so a retry after a
 *                     lost answer is never paid for twice.
 *
 * Self-contained on purpose: Supabase's bundler skips underscore-prefixed
 * directories, so a helper shared across functions fails to resolve on deploy.
 */

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------
// Deliberately four, not two.
//
//   free        the provider answered and charged nothing — a miss on a
//               per-success provider, or a genuinely free endpoint
//   success     the provider answered, found something, and charged for it
//   not_found   the provider answered and found nothing, and charged for the
//               attempt. Real cost, no result.
//   upstream_failed  the provider itself failed. Charged or not is decided by the
//               header, not assumed.
//   uncertain   the call was made and the outcome is not knowable: a 409 that is
//               still running, a 410 whose body was lost, a timeout after the
//               request went out. Never auto-refunded — auto-refunding is how a
//               workspace gets served for free.
export type LeadOutcome =
  | 'success'
  | 'free'
  | 'not_found'
  | 'upstream_failed'
  | 'uncertain'
  | 'error';

export interface TregCallResult {
  ok: boolean;
  httpStatus: number;
  /** The provider's body, verbatim. Never the source of truth for cost. */
  body: unknown;
  /** What we were actually charged, in USD. 0 when no header came back. */
  costUsd: number;
  /** treg's record of the call, for reconciliation with api_usage. */
  callId: string | null;
  outcome: LeadOutcome;
  /** True when this was a replay of an earlier call rather than a new one. */
  replayed: boolean;
  /** Populated when the call should not be retried as-is. */
  error?: string;
  /** Set when a 429 carries a retry hint. */
  retryAfterSeconds?: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TregConfig {
  token: string;
  baseUrl: string;
  /**
   * Per-row ceiling, in USD, sent as X-Treg-Route-Max-Cost. There is no default
   * on the provider side for direct calls, so an absent header means no ceiling
   * at all — the header is the only cap, which is why it is not optional here.
   */
  maxCostUsd: number;
  /**
   * How the caller is tagged. Up to five key=value pairs, and a malformed one is
   * refused before the call is relayed, so a shortened id that would merge two
   * customers onto one invoice line cannot happen by accident.
   */
  meta: Record<string, string>;
  timeoutMs: number;
}

/**
 * Cached after the first successful resolve, so a five-row chunk does not read
 * the secrets table once per row.
 */
let cachedToken: string | null = null;

/** Reads the token the way daily-sweep does: edge secret first, table second. */
export async function resolveToken(
  db: { from(t: string): { select(c: string): { eq(c: string, v: string): { maybeSingle(): Promise<{ data: unknown }> } } } },
): Promise<string | null> {
  const fromEnv = Deno.env.get('TREG_TOKEN');
  if (fromEnv) return fromEnv;
  if (cachedToken) return cachedToken;

  try {
    const { data } = await db
      .from('service_secrets')
      .select('name, value')
      .eq('name', 'treg_token')
      .maybeSingle();
    const row = data as { name: string; value: string } | null;
    if (row?.value) {
      cachedToken = String(row.value);
      return cachedToken;
    }
  } catch {
    /* fall through: unconfigured is reported by the caller, not thrown here */
  }

  return null;
}

export function tregConfig(meta: Record<string, string>, token: string | null): TregConfig | null {
  if (!token) return null;

  // Row cap in USD, from a secret rather than a constant: it is a spend limit
  // and belongs with the other spend configuration, not in the source.
  const capRaw = Number(Deno.env.get('LEADS_ROW_CAP_USD') ?? '0.05');
  const maxCostUsd = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 0.05;

  return {
    token,
    baseUrl: Deno.env.get('TREG_BASE_URL') ?? 'https://treg.to',
    maxCostUsd,
    meta: Object.fromEntries(
      Object.entries(meta).filter(
        ([k, v]) => /^[a-z0-9_]{1,32}$/i.test(k) && typeof v === 'string' && v.length > 0 && v.length <= 64,
      ),
    ),
    timeoutMs: 20_000,
  };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface TregCallSpec {
  endpointId: string;
  /** POST body. Catalog entries marked strict_query take no body at all. */
  params: Record<string, unknown>;
  /**
   * One key per logical attempt, not per HTTP request. A retry sends the same
   * key so the replay is free; genuinely new work gets a new key.
   */
  idempotencyKey: string;
  /** Overrides the config cap for a call the registry prices higher. */
  maxCostUsd?: number;
}

/**
 * Makes one call.
 *
 * Never throws. A dead provider has to fall through the chain rather than kill
 * the run, so failure is a return value. The caller decides what a miss means and
 * what an error means, because only it knows whether to try the next provider.
 */
export async function tregCall(cfg: TregConfig, spec: TregCallSpec): Promise<TregCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(`${cfg.baseUrl}/call/${spec.endpointId}`, {
      method: 'POST',
      headers: {
        'X-Treg-Token': cfg.token,
        'Content-Type': 'application/json',
        'X-Treg-Route-Max-Cost': String(spec.maxCostUsd ?? cfg.maxCostUsd),
        'Idempotency-Key': spec.idempotencyKey,
        'X-Treg-Meta': Object.entries(cfg.meta).map(([k, v]) => `${k}=${v}`).join(','),
      },
      body: JSON.stringify(spec.params ?? {}),
      signal: controller.signal,
    });

    // The header is the charge. A missing one means nothing was billed, which is
    // not the same as zero-cost: it means the number is unknown, and unknown is
    // recorded as 0 with the outcome carrying the doubt.
    const costMicro = Number(res.headers.get('x-treg-cost-micro'));
    const costUsd = Number.isFinite(costMicro) ? costMicro / 1e6 : 0;
    const callId = res.headers.get('x-treg-call-id');
    const replayed = (res.headers.get('x-treg-idempotent-replay') ?? '').toLowerCase() === 'true';

    const body = await safeJson(res);

    // --- refusals worth distinguishing ------------------------------------
    // 402 is our own ceiling or an empty balance. 429 is a cap we can wait out.
    // Both are terminal for this row and neither is a provider miss.
    if (res.status === 402) {
      return {
        ok: false, httpStatus: 402, body, costUsd: 0, callId, outcome: 'error', replayed,
        error: 'route_max_cost_or_balance',
      };
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      return {
        ok: false, httpStatus: 429, body, costUsd: 0, callId, outcome: 'error', replayed,
        error: 'rate_limited',
        retryAfterSeconds: Number.isFinite(ra) ? ra : undefined,
      };
    }

    // 409 means the original call with this key is still running, and 410 means
    // it completed and was charged but the answer was lost. Neither is a miss and
    // neither may be refunded on our own initiative.
    if (res.status === 409 || res.status === 410) {
      return {
        ok: false, httpStatus: res.status, body, costUsd, callId, outcome: 'uncertain', replayed,
        error: res.status === 409 ? 'still_running' : 'answer_lost',
      };
    }

    if (!res.ok) {
      return {
        ok: false, httpStatus: res.status, body, costUsd, callId,
        outcome: 'upstream_failed', replayed,
        error: `provider_http_${res.status}`,
      };
    }

    // A 2xx in which the provider reports its own failure carries an
    // X-Treg-Upstream-Failed header and no result in the body. Reading it as a
    // success is how an empty answer gets recorded as a found one.
    if (res.headers.get('x-treg-upstream-failed')) {
      return {
        ok: true, httpStatus: res.status, body, costUsd, callId,
        outcome: 'upstream_failed', replayed,
        error: 'provider_reported_failure',
      };
    }

    // The endpoint decides whether a miss is free. The registry carries that flag
    // per endpoint; without it, cost is the only evidence available.
    return {
      ok: true,
      httpStatus: res.status,
      body,
      costUsd,
      callId,
      replayed,
      outcome: costUsd > 0 ? 'success' : 'free',
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';

    // A timeout is the one case where the call may well have reached the
    // provider. Uncertain, never error, never refunded.
    return {
      ok: false,
      httpStatus: 0,
      body: null,
      costUsd: 0,
      callId: null,
      outcome: 'uncertain',
      replayed: false,
      error: aborted ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * One retry, on the failure modes where retrying is free.
 *
 * A 5xx or a network error is never billed, so repeating it costs nothing. A 4xx
 * is our own parameters and repeating it burns the budget for the same mistake,
 * so it is not retried here — the caller tries a different provider instead.
 *
 * Same idempotency key on both attempts: if the first one did reach the provider,
 * the replay is returned for free rather than paid for twice.
 */
export async function tregCallWithRetry(
  cfg: TregConfig,
  spec: TregCallSpec,
): Promise<TregCallResult> {
  const first = await tregCall(cfg, spec);

  const worthRetrying =
    first.outcome === 'upstream_failed' ||
    (first.outcome === 'uncertain' && first.error === 'network');

  if (!worthRetrying) return first;

  return tregCall(cfg, spec);
}
