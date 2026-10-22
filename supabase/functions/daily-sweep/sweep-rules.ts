// ============================================================================
// daily-sweep: pure scheduling, billing and chunking rules.
// ----------------------------------------------------------------------------
// No I/O and no Deno.env here, so sweep-rules_test.ts can exercise every rule
// without permissions or a network. A sibling module inside the function's own
// folder is bundled with the entrypoint on deploy.
// ============================================================================

export type Billable = 'billed' | 'free' | 'uncertain';

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** Matches the `profiles.sweep_time_utc` column default. */
export const DEFAULT_SWEEP_HOUR_UTC = 6;

/** Interval length in hours for a stored cadence string. */
export function cadenceHoursOf(frequency: string | null | undefined): number {
  if (frequency === '6h') return 6;
  if (frequency === '12h') return 12;
  return 24;
}

/**
 * Parses the workspace's "HH:MM" sweep time into an hour of day.
 * Returns null when unset or malformed; the caller falls back to the default hour.
 */
export function sweepHourOf(sweepTime: string | null | undefined): number | null {
  if (!sweepTime) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(sweepTime.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}

/**
 * The cron fires every hour, so a cadence is just a predicate over the hour of
 * day. A 6h cadence is due whenever the hour is congruent to the chosen hour
 * modulo 6 (four times a day); 12h gives two, 24h gives exactly one.
 */
export function isSweepDue(currentHourUtc: number, sweepHour: number, cadenceHours: number): boolean {
  if (cadenceHours >= 24) return currentHourUtc === sweepHour;
  return currentHourUtc % cadenceHours === sweepHour % cadenceHours;
}

/** `profiles.sweep_frequency` value that turns automatic sweeps off. */
export const SWEEP_OFF = 'off';

/**
 * Whether a profile is due in the given UTC hour. A missing or malformed hour
 * falls back to the column default (06:00), never "any hour". A workspace with
 * automatic sweeps turned off is never due; it can still sweep manually.
 */
export function isProfileDue(
  profile: { sweep_time_utc?: string | null; sweep_frequency?: string | null },
  hourUtc: number,
): boolean {
  if (profile.sweep_frequency === SWEEP_OFF) return false;
  const dueHour = sweepHourOf(profile.sweep_time_utc) ?? DEFAULT_SWEEP_HOUR_UTC;
  return isSweepDue(hourUtc, dueHour, cadenceHoursOf(profile.sweep_frequency));
}

/**
 * Applies the due filter to a page of profiles BEFORE any cap, so a cap can
 * only ever defer due workspaces, never crowd them out with ones that are not.
 */
export function filterDue<T extends { sweep_time_utc?: string | null; sweep_frequency?: string | null }>(
  profiles: T[],
  hourUtc: number,
): T[] {
  return profiles.filter((p) => isProfileDue(p, hourUtc));
}

// ---------------------------------------------------------------------------
// Slots and run claims (overlap prevention)
// ---------------------------------------------------------------------------
//
// A slot is the UTC hour a cron tick belongs to ("2026-10-21T06"). Every chunk
// of a slot claims a sweep_runs row whose primary key is derived from
// (slot, chunk). The insert is atomic: a second invocation for the same chunk —
// a pg_net retry, a manual call, a duplicated chain hop — hits the primary key
// and stops before anything is reserved or called.

const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

export function slotOf(date: Date): string {
  return date.toISOString().slice(0, 13);
}

export function slotHour(slot: string): number {
  return Number(slot.slice(11, 13));
}

export function slotStartMs(slot: string): number {
  return Date.parse(`${slot}:00:00Z`);
}

/** Deterministic UUID for a (slot, chunk) claim, from SHA-256. */
export async function claimIdFor(slot: string, chunk: number): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`echo-daily-sweep:${slot}:${chunk}`)),
  );
  const b = digest.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80; // version 8 (custom)
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Hard ceiling on chain hops per slot, so a bug cannot chain forever. */
export const MAX_CHUNKS_PER_SLOT = 40;
/** A chained hop for a slot older than this is stale and refused. */
export const MAX_SLOT_AGE_MS = 3 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChunkRequest {
  slot: string;
  chunk: number;
  /** Users with id <= after were handled by earlier chunks of this slot. */
  after: string | null;
}

/**
 * Reads the chain parameters from an (already authenticated) request body. An
 * empty body is the cron tick: chunk 0 of the current hour's slot.
 */
export function parseChunkRequest(body: unknown, now: Date): ChunkRequest | { error: string } {
  const b = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  if (b.slot === undefined && b.chunk === undefined && b.after === undefined) {
    return { slot: slotOf(now), chunk: 0, after: null };
  }
  const slot = b.slot;
  const chunk = b.chunk;
  const after = b.after ?? null;
  if (typeof slot !== 'string' || !SLOT_RE.test(slot) || Number.isNaN(slotStartMs(slot))) {
    return { error: 'invalid slot' };
  }
  if (typeof chunk !== 'number' || !Number.isInteger(chunk) || chunk < 0 || chunk >= MAX_CHUNKS_PER_SLOT) {
    return { error: 'invalid chunk' };
  }
  if (after !== null && (typeof after !== 'string' || !UUID_RE.test(after))) {
    return { error: 'invalid cursor' };
  }
  const age = now.getTime() - slotStartMs(slot);
  if (age > MAX_SLOT_AGE_MS || age < -5 * 60 * 1000) {
    return { error: 'stale slot' };
  }
  return { slot, chunk, after: after as string | null };
}

// ---------------------------------------------------------------------------
// Time budget
// ---------------------------------------------------------------------------
//
// Supabase stops an edge function at about 150 s of wall clock and pg_net gives
// up at 180 s. A chunk only starts a batch of users when even the worst case of
// that batch still finishes inside CHUNK_BUDGET_MS; the rest goes to the next
// chunk.

/** Per provider call. Above treg's ~2 s queue wait, below "hangs the run". */
export const CALL_TIMEOUT_MS = 20_000;
/** Keywords of one user searched at once (each fans out to its channels). */
export const KEYWORD_CONCURRENCY = 4;
/** Users swept at once. */
export const USER_CONCURRENCY = 5;
export const MAX_KEYWORDS_PER_USER = 8;
/** Wall clock a chunk may use, with margin under the ~150 s platform limit. */
export const CHUNK_BUDGET_MS = 140_000;
/** Database writes after the provider calls (upsert, settle, prune). */
const USER_OVERHEAD_MS = 5_000;

/**
 * Worst case for one user: keyword waves x the longest provider chain (Reddit:
 * primary then fallback, both at the full timeout), plus the writes after.
 */
export function worstCaseUserMs(keywordCount = MAX_KEYWORDS_PER_USER): number {
  const waves = Math.ceil(Math.max(1, keywordCount) / KEYWORD_CONCURRENCY);
  return waves * 2 * CALL_TIMEOUT_MS + USER_OVERHEAD_MS;
}

/** Whether a batch of users may start at `elapsedMs` into the chunk. */
export function canStartBatch(elapsedMs: number, maxKeywordsInBatch = MAX_KEYWORDS_PER_USER): boolean {
  return elapsedMs + worstCaseUserMs(maxKeywordsInBatch) <= CHUNK_BUDGET_MS;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * Groups keyword rows (already ordered by user_id, created_at, id) per user,
 * keeping each user's first `cap`: the oldest keywords, as social-search does.
 */
export function groupKeywords<K extends { user_id: string; id: string; keyword: string }>(
  rows: K[],
  cap = MAX_KEYWORDS_PER_USER,
): Map<string, Array<{ id: string; keyword: string }>> {
  const byUser = new Map<string, Array<{ id: string; keyword: string }>>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    if (list.length < cap) list.push({ id: r.id, keyword: r.keyword });
    byUser.set(r.user_id, list);
  }
  return byUser;
}

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

/**
 * Credits are fractional (e.g. 0.1 per keyword per channel). Totals are rounded
 * to 2 decimals so float noise (0.1 * 3 = 0.30000000000000004) never reaches
 * wallet_reserve / wallet_settle or the response. Never rounded to integers.
 */
export function roundCredits(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
