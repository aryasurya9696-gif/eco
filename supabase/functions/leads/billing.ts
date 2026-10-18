/**
 * Echo Leads — the credit spine
 * ----------------------------------------------------------------------------
 * Nothing here decides what a lead is worth. estimate_lead_run does, in the
 * database, from pricing_config. This module only moves credits, and it does so
 * through the six wallet RPCs and nothing else.
 *
 * The shape is Echo's existing one: reserve before spending, settle after, release
 * what was not earned. Per chunk rather than per run, because a run can take
 * minutes and a hold that long is a hold that outlives the isolate that made it.
 * A chunk is bounded by a wall-clock budget and ends well inside it, so the hold
 * is always closed by the code that took it — and if that code dies anyway,
 * reap_stale_reservations closes it an hour later.
 */

const FN = 'leads';

// Written out rather than imported, for the same reason round6 is duplicated
// below: pricing-row.ts imports a type from steps.ts using a .ts extension, which
// Deno needs and Node cannot resolve. A type-only import with inline structural
// duplication is not worth a build step that runs in both runtimes.
export interface LeadPrices {
  company: number;
  person: number;
  emailVerified: number;
  emailCatchAll: number;
  verifyOnly: number;
  phone: number;
  enrich: number;
}

export interface WalletApi {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface ChunkHold {
  reservationId: string | null;
  /** What was held. */
  reserved: number;
  ok: boolean;
  reason?: 'insufficient_credits' | 'rpc_error';
  /** The database's own message, when the failure was not an expected refusal. */
  error?: string;
  shortfall?: number;
  available?: number;
}

export interface ChunkSettlement {
  charged: number;
  released: number;
  balanceAfter: number | null;
  ok: boolean;
  reason?: string;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Holds a chunk's worst case.
 *
 * The worst case, not the estimate. A chunk that cannot be paid for in full must
 * not run, and holding the maximum is the only way to know that before the first
 * provider call rather than after it. The unspent part comes back at settle.
 */
export async function reserveChunk(
  db: WalletApi,
  userId: string,
  runId: string,
  chunkIndex: number,
  maxCredits: number,
  nonce = '',
): Promise<ChunkHold> {
  const hold = round6(maxCredits);
  if (hold <= 0) return { reservationId: null, reserved: 0, ok: true };

  const { data, error } = await db.rpc('wallet_reserve', {
    p_user_id: userId,
    p_credits: hold,
    p_idempotency_key: `${FN}:${runId}:chunk:${chunkIndex}${nonce ? ":" + nonce : ""}`,
    // p_context is wallet_reserve's name for it. This was sent as p_metadata,
    // which PostgREST cannot match to any signature, so every reserve failed with
    // "function not found" and no chunk of any run could ever be paid for.
    p_context: { run_id: runId, chunk: chunkIndex, source: 'leads' },
  });

  if (error) return { reservationId: null, reserved: 0, ok: false, reason: 'rpc_error', error: error.message };

  const out = (data ?? {}) as Record<string, unknown>;

  // A refusal is not an error to swallow. It means the workspace is out of
  // credits, and the run has to stop at a boundary the user can see and fix,
  // rather than half-serving rows it cannot pay for.
  if (out.ok === false || out.error === 'insufficient_credits') {
    return {
      reservationId: null,
      reserved: 0,
      ok: false,
      reason: 'insufficient_credits',
      shortfall: num(out.shortfall),
      available: num(out.available),
    };
  }

  return {
    reservationId: typeof out.reservation_id === 'string' ? out.reservation_id : null,
    reserved: num(out.reserved, hold),
    ok: true,
  };
}

/**
 * Charges what was earned and gives the rest back.
 *
 * Settle takes the credits actually earned by successful results and releases the
 * remainder in the same call, which is what makes the hold close. A miss costs
 * nothing, so the released portion is normally large — and that is the correct
 * outcome, not a refund.
 *
 * The amount passed is a hard ceiling in the RPC: it is clipped to what was
 * reserved. So a bug that over-charges cannot take more than the hold.
 */
export async function settleChunk(
  db: WalletApi,
  holdId: string,
  earnedCredits: number,
  providerCostUsd: number,
  runId: string,
  chunkIndex: number,
  nonce = '',
): Promise<ChunkSettlement> {
  const { data, error } = await db.rpc('wallet_settle', {
    p_reservation_id: holdId,
    p_credits_charged: round6(Math.max(0, earnedCredits)),
    // p_provider_cost, not p_provider_cost_usd: the same signature mismatch as
    // the reserve above.
    p_provider_cost: round6(Math.max(0, providerCostUsd)),
    p_idempotency_key: `${FN}:${runId}:chunk:${chunkIndex}${nonce ? ":" + nonce : ""}:settle`,
    p_note: `leads run ${runId.slice(0, 8)} chunk ${chunkIndex}`,
    // On the ledger row, so revenue can be attributed to the run it was earned on.
    p_metadata: { run_id: runId, chunk: chunkIndex, source: 'leads' },
  });

  if (error) {
    return { charged: 0, released: 0, balanceAfter: null, ok: false, reason: error.message };
  }

  const out = (data ?? {}) as Record<string, unknown>;
  return {
    charged: num(out.credits_charged),
    released: num(out.credits_released),
    balanceAfter: typeof out.balance_after === 'number' ? out.balance_after : null,
    ok: out.ok === true,
  };
}

/**
 * Returns a hold in full.
 *
 * Used when a chunk aborted before earning anything: a provider error, a 402, a
 * time budget that ran out with the rows untouched. Whatever was held goes back
 * in full, because nothing was delivered and nothing was charged for.
 */
export async function releaseChunk(
  db: WalletApi,
  holdId: string,
  runId: string,
  note: string,
): Promise<{ ok: boolean; released: number }> {
  const { data, error } = await db.rpc('wallet_release', {
    p_reservation_id: holdId,
    // p_reason is wallet_release's parameter; p_note does not exist on it.
    p_reason: `leads run ${runId.slice(0, 8)}: ${note}`,
  });

  if (error) return { ok: false, released: 0 };

  const out = (data ?? {}) as Record<string, unknown>;
  return { ok: out.ok === true, released: num(out.released) };
}

/**
 * numeric(20,6) has six decimals; sending more is noise and can be rejected.
 *
 * Duplicated from pricing-row.ts rather than imported, because that module
 * imports a type from steps.ts with a .ts extension, which Deno requires and
 * Node does not resolve. Two four-line helpers is a smaller problem than one
 * file that only compiles in one runtime.
 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Reads the leads prices the wallet needs, from pricing_config. */
export async function loadLeadPrices(db: WalletApi): Promise<LeadPrices | null> {
  // Read through PostgREST rather than an RPC: pricing_config is a plain table
  // and the service role can select it directly.
  const { data: rows } = await (db as unknown as {
    from(t: string): {
      select(c: string): {
        in(f: string, v: string[]): Promise<{ data: Array<Record<string, unknown>> | null }>;
      };
    };
  })
    .from('pricing_config')
    .select('operation, credits')
    .in('operation', [
      'leads.company.found',
      'leads.person.found',
      'leads.email.verified',
      'leads.email.catch_all',
      'leads.verify.only',
      'leads.phone.found',
      'leads.company.enrich',
    ]);

  const byOp = new Map<string, number>();
  for (const r of rows ?? []) byOp.set(String(r.operation), num(r.credits));

  const needed = ['leads.company.found', 'leads.person.found', 'leads.email.verified', 'leads.verify.only'];
  // A missing price means the operation is not being sold. Continuing would price
  // it at zero and serve it free.
  if (needed.some((op) => !byOp.has(op))) return null;

  return {
    company: byOp.get('leads.company.found') ?? 0,
    person: byOp.get('leads.person.found') ?? 0,
    emailVerified: byOp.get('leads.email.verified') ?? 0,
    emailCatchAll: byOp.get('leads.email.catch_all') ?? byOp.get('leads.email.verified') ?? 0,
    verifyOnly: byOp.get('leads.verify.only') ?? 0,
    phone: byOp.get('leads.phone.found') ?? 0,
    enrich: byOp.get('leads.company.enrich') ?? 0,
  };
}
