// ============================================================================
// Supabase Edge Function: leads
// ----------------------------------------------------------------------------
// B2B Leads Discovery, Email Reveal, Phone Extraction & Contact Intelligence
// Supports bulk prospecting (25, 50, 100, 200 leads) & batch email reveals.
// Powered by Treg.to catalog routing (26+ upstream providers).
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  acceptNameOnlyMatch,
  affordableSearchLimit,
  allowedOrigins,
  corsOriginFor,
  classifyEmail,
  cleanDomain,
  dedupeLeads,
  hasRevealedEmail,
  hasUsableEmail,
  isEmailAddress,
  leadKey,
  linkedinSlug,
  MAX_PROVIDER_CALLS,
  MAX_SEARCH_DOMAINS,
  maxSearchProviderCalls,
  mergeLeadRecord,
  PAID_CREDITS_MESSAGE,
  UsageLog,
} from './lib.ts';

/**
 * CORS allow-list, never `*` by default: ALLOWED_ORIGIN (comma-separated) and
 * APP_ORIGIN form the list; with neither set only the local dev server is
 * allowed. `*` only when ALLOWED_ORIGIN is set to it explicitly.
 */
const ALLOWED_ORIGINS = allowedOrigins(Deno.env.get('ALLOWED_ORIGIN'), Deno.env.get('APP_ORIGIN'));

/** Static CORS headers; the origin itself is set per request in Deno.serve (withCors). */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

/** Stamps the request-specific Access-Control-Allow-Origin onto a response. */
function withCors(res: Response, req: Request): Response {
  res.headers.set('Access-Control-Allow-Origin', corsOriginFor(req.headers.get('Origin'), ALLOWED_ORIGINS));
  res.headers.set('Vary', 'Origin');
  return res;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra }, status);
}

/** Verifies the caller's JWT server-side. */
async function requireUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) return null;

  try {
    // Bounded: a hung auth endpoint otherwise holds the request open until the
    // gateway kills it, and the caller sees a generic failure.
    const res = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: anonKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

const TREG_BASE = 'https://treg.to';
let tregToken = Deno.env.get('TREG_TOKEN') || '';

/**
 * Search quantity bounds.
 *
 * These mirror MIN_LIMIT / MAX_LIMIT in the Prospector view. They drifted apart
 * before — the client accepted 5 while the server floored at 10, so a request for
 * 5 came back as 10 with no indication — which is why they are named here rather
 * than left as bare literals inside the clamp.
 */
const MIN_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 1000;

/** One rule for the quantity, matching the client's sanitiser. */
function sanitizeSearchLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(MIN_SEARCH_LIMIT, Math.round(n)));
}

/**
 * How many provider calls may be made to satisfy a large request.
 *
 * The provider returns at most 100 people per call, so a 1000-lead request
 * needs ten. They are issued in parallel rather than one after another, which
 * is what keeps a large request inside the request timeout: sequentially, ten
 * calls would take ten times as long.
 */
// MAX_PROVIDER_CALLS (12) and MAX_SEARCH_DOMAINS (10) live in lib.ts with
// maxSearchProviderCalls, which mirrors how the search spends them.

/**
 * Upper bounds on a single provider call.
 *
 * None of the provider fetches had a timeout, so one hung upstream call held
 * the whole request open until the gateway killed it — the browser then saw a
 * generic failure and any credit hold taken for the run sat unsettled.
 */
const SEARCH_TIMEOUT_MS = 25_000;
const ENRICH_TIMEOUT_MS = 20_000;

/** Longest free-text filter forwarded to the provider. */
const MAX_FILTER_LENGTH = 200;

function cleanFilter(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_FILTER_LENGTH) : '';
}

// isEmailAddress, hasRevealedEmail, hasUsableEmail and classifyEmail live in
// lib.ts (unit tested there).

/**
 * One provider search call.
 *
 * A failure is reported as `null` rather than an empty list so the caller can
 * tell "the provider has nobody for these filters" apart from "the provider
 * call failed". Treating the two the same is how a provider outage on a
 * multi-company search came back as a successful search with zero results.
 */
/**
 * Headers for one Treg call. Every call carries an `Idempotency-Key` (audit
 * N13): without one, a retry after a timeout paid the provider twice for the
 * same lookup. Callers derive the key from the request's own reservation key
 * plus the lead / call index, so a retried request replays rather than re-buys.
 */
function tregHeaders(
  token: string,
  userId: string,
  feature: string,
  maxCost: string,
  idempotencyKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'X-Treg-Token': token,
    'X-Treg-Meta': `customer=${userId}, feature=${feature}`,
    'X-Treg-Route-Max-Cost': maxCost,
    'Idempotency-Key': idempotencyKey.slice(0, 255),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

async function tregPeopleSearch(
  token: string,
  userId: string,
  payload: Record<string, any>,
  feature: string,
  tagDomain: string | undefined,
  usage: UsageLog,
  reservationId: string | null,
  idempotencyKey: string,
): Promise<any[] | null> {
  try {
    const res = await fetch(`${TREG_BASE}/call/treg.people.search`, {
      method: 'POST',
      headers: tregHeaders(token, userId, feature, MAX_COST.search, idempotencyKey),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    usage.track('treg.people.search', res, { feature, batch: true }, reservationId);
    if (!res.ok) {
      console.warn('[leads] treg.people.search batch failed:', res.status);
      return null;
    }
    const data = await res.json();
    const people = data?.output?.people || data?.raw?.data || [];
    if (!Array.isArray(people)) return [];
    return tagDomain ? people.map((p: any) => ({ ...p, _searched_domain: tagDomain })) : people;
  } catch (err: any) {
    usage.track('treg.people.search', null, { feature, batch: true, error: err?.name || 'error' }, reservationId);
    console.warn('[leads] treg.people.search batch error:', err?.name || err?.message);
    return null;
  }
}

/**
 * Extra query shapes used to satisfy a request larger than the provider's
 * per-call ceiling.
 *
 * The provider returns at most 100 people per call, and the only extra call
 * the search used to make was the same query with the title and keyword
 * swapped. That returned largely the same people, so the result set never
 * grew past roughly 200 no matter what was asked for — asking for 400
 * quietly produced 200.
 *
 * These variations each move the query along a different axis so the extra
 * batches are genuinely different people rather than a re-ranking of the first
 * hundred.
 *
 * A variation may only narrow or re-rank inside the filters the user asked
 * for — never drop or replace one. The previous version dropped the role
 * filter and then rotated through other roles, so a 200-lead "Founder" search
 * came back half full of Directors and Managers while the summary bar still
 * said "Role: Founder". Roles rotate only when the user gave no role at all.
 */
function buildSearchVariations(base: Record<string, any>, count: number): Record<string, any>[] {
  if (count <= 0) return [];
  const variants: Record<string, any>[] = [];
  const title = String(base.title || '').trim();
  const q = String(base.q || '').trim();

  // Rotate the role — a different title surfaces a different person. Only
  // when the user left the role open, so it cannot contradict their filter.
  const rolePool = [
    'Director',
    'Manager',
    'Founder',
    'CEO',
    'VP',
    'Head of Department',
    'President',
    'Partner',
    'Officer',
    'Lead',
  ];
  let i = 0;
  while (!title && variants.length < count && i < rolePool.length) {
    variants.push({ ...base, title: rolePool[i++] });
  }

  // Add a keyword on top of the user's own, once the roles are exhausted (or
  // when the role was fixed by the user). The user's keyword is kept in full.
  const keywordPool = [
    'founder',
    'ceo',
    'leadership',
    'executive',
    'director',
    'head',
    'growth',
    'operations',
  ];
  // One pass over the pool: repeating it would only resend identical queries
  // and pay the provider for duplicates the dedupe step throws away.
  for (const keyword of keywordPool) {
    if (variants.length >= count) break;
    if (title && title.toLowerCase().includes(keyword)) continue;
    variants.push({ ...base, q: q ? `${q} ${keyword}` : keyword });
  }

  return variants.slice(0, count);
}

async function resolveToken(admin: any): Promise<string> {
  if (tregToken) return tregToken;
  const { data, error } = await admin
    .from('service_secrets')
    .select('value')
    .eq('name', 'treg_token')
    .maybeSingle();
  if (error || !data?.value) {
    console.warn('[leads] secret lookup failed:', error?.message);
    return '';
  }
  tregToken = data.value;
  return tregToken;
}


// ---------------------------------------------------------------------------
// Pricing and cost caps
// ---------------------------------------------------------------------------

/**
 * Most Treg may spend on one routed call. Treg's default is $1, and the
 * search route used to send no cap at all. These are routing caps, not
 * prices: every credit price is read from pricing_config (1 credit = $0.05).
 *
 * Set from treg's catalog prices (cheapest email providers $0.0005–$0.011,
 * phone $0.0005–$0.026, people search free–$0.0026 per call) so that each
 * cap keeps at least ~60–70% margin at the configured prices: search $0.015
 * per call vs 1 credit per billed call, email $0.015 vs 1 credit, phone
 * $0.03 vs 2 credits. A route that would cost more is not taken.
 */
const MAX_COST = { search: '0.015', email: '0.015', phone: '0.03' } as const;

/**
 * Credit prices, all from pricing_config. A price is null when its row is
 * missing, disabled or unreadable: the action that needs it is then refused
 * rather than charged at a guessed price. (There used to be hardcoded 1 / 2 /
 * 1 fallbacks, which silently under-charged whenever the table read failed.)
 */
interface Prices {
  /** Credits per verified email (`treg.people.email.find`). */
  email: number | null;
  /** Credits per phone number found (`treg.people.phone.find`). */
  phone: number | null;
  /**
   * Credits per BILLED provider search call (`treg.people.search`). A search
   * makes 1–12 provider calls and is charged for each one the provider billed
   * (audit H4). `leads.search.extra_50` is no longer read.
   */
  search: number | null;
}

let priceCache: { at: number; prices: Prices } | null = null;

async function loadPrices(admin: any): Promise<Prices> {
  if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache.prices;
  const prices: Prices = { email: null, phone: null, search: null };
  try {
    const { data, error } = await admin
      .from('pricing_config')
      .select('operation, credits, enabled')
      .in('operation', ['treg.people.email.find', 'treg.people.phone.find', 'treg.people.search']);
    if (error || !Array.isArray(data)) {
      console.warn('[leads] pricing lookup failed:', error?.message);
      return prices; // not cached: the next request retries the read
    }
    for (const row of data) {
      const credits = Number(row.credits);
      if (!row.enabled || !Number.isFinite(credits) || credits < 0) continue;
      if (row.operation === 'treg.people.email.find') prices.email = credits;
      if (row.operation === 'treg.people.phone.find') prices.phone = credits;
      if (row.operation === 'treg.people.search') prices.search = credits;
    }
  } catch (err: any) {
    console.warn('[leads] pricing lookup failed:', err?.message);
    return prices;
  }
  priceCache = { at: Date.now(), prices };
  return prices;
}

function pricingUnavailable(): Response {
  return fail('This feature is temporarily unavailable (pricing is not configured). Please try again later.', 503, {
    pricing_unavailable: true,
  });
}

/**
 * The 402 for a reserve the wallet could not cover. Every leads reserve is
 * paid-only (welcome credits only cover feed sweeps), so the message says so.
 */
function insufficientCredits(hold: { required: number; available: number }, extra: Record<string, unknown> = {}): Response {
  return fail(`${PAID_CREDITS_MESSAGE} Needed: ${hold.required}, purchased credits available: ${hold.available}.`, 402, {
    insufficient_credits: true,
    paid_credits_required: true,
    required: hold.required,
    available: hold.available,
    ...extra,
  });
}

// UsageLog / UsageRow live in lib.ts.


/** Credits this user can spend right now (balance minus held credits). */
async function walletAvailable(admin: any, userId: string): Promise<number> {
  const { data, error } = await admin.from('wallet').select('balance, reserved').eq('user_id', userId).maybeSingle();
  if (error || !data) return 0;
  return Math.max(0, Number(data.balance ?? 0) - Number(data.reserved ?? 0));
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

interface RateLimit {
  bucket: string;
  limit: number;
  windowSeconds: number;
  message: string;
}

/**
 * Durable, atomic limits (take_rate_limit). The old search limiter counted
 * api_usage rows that were only written after the work finished, so a burst of
 * parallel searches all read the same count and all passed, and a failed count
 * query let everything through.
 *
 * Reveals are limited too. Only `valid` addresses are charged, so a lookup
 * that returns an unconfirmed or no address costs us the provider fee and the
 * user nothing. That is deliberate (users never pay for misses); these limits
 * are what bound how much free provider spend one account can generate.
 */
const RATE_LIMITS = {
  search: {
    bucket: 'leads.search',
    limit: 30,
    windowSeconds: 3600,
    message: 'You have run 30 searches in the last hour. Please wait a few minutes and try again.',
  },
  searchBurst: {
    bucket: 'leads.search.burst',
    limit: 3,
    windowSeconds: 10,
    message: 'Too many searches at once. Please wait a few seconds and try again.',
  },
  reveal: {
    bucket: 'leads.reveal',
    limit: 300,
    windowSeconds: 3600,
    message: 'You have reached the hourly contact lookup limit. Please try again later.',
  },
  revealBurst: {
    bucket: 'leads.reveal.burst',
    limit: 10,
    windowSeconds: 10,
    message: 'Too many lookups at once. Please wait a few seconds and try again.',
  },
  bulkReveal: {
    bucket: 'leads.bulk-reveal',
    limit: 30,
    windowSeconds: 3600,
    message: 'You have reached the hourly bulk lookup limit. Please try again later.',
  },
  bulkRevealBurst: {
    bucket: 'leads.bulk-reveal.burst',
    limit: 2,
    windowSeconds: 10,
    message: 'A bulk lookup is already running. Please wait a few seconds and try again.',
  },
  bulkSave: {
    bucket: 'leads.bulk-save',
    limit: 120,
    windowSeconds: 3600,
    message: 'Too many saves in the last hour. Please try again later.',
  },
} satisfies Record<string, RateLimit>;

/** One slot from a bucket: true taken, false over the limit, null RPC error. */
async function takeRateLimit(admin: any, userId: string, rl: RateLimit): Promise<boolean | null> {
  try {
    const { data, error } = await admin.rpc('take_rate_limit', {
      p_user_id: userId,
      p_bucket: rl.bucket,
      p_limit: rl.limit,
      p_window_seconds: rl.windowSeconds,
    });
    if (error) {
      console.error('[leads] take_rate_limit failed:', error.message);
      return null;
    }
    return data === true;
  } catch (err: any) {
    console.error('[leads] take_rate_limit error:', err?.name || err?.message);
    return null;
  }
}

/**
 * Takes a slot from each bucket in order. Fails CLOSED: when the limiter
 * cannot be reached the request is refused, because the requests it guards
 * spend provider money.
 */
async function enforceRateLimits(admin: any, userId: string, limits: RateLimit[]): Promise<Response | null> {
  for (const rl of limits) {
    const ok = await takeRateLimit(admin, userId, rl);
    if (ok === null) {
      return fail('The service is busy. Please try again in a moment.', 503, { rate_limited: true });
    }
    if (!ok) return fail(rl.message, 429, { rate_limited: true });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Identity hashing and input sanitising
// ---------------------------------------------------------------------------

/**
 * Short, stable, non-reversible reference. Used in ledger notes, reservation
 * context and idempotency keys instead of names or LinkedIn URLs, which are
 * personal data that the billing tables should not carry.
 */
async function shortHash(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Identity of one lead, for hashing: domain, name, LinkedIn slug, email. */
function leadIdentity(l: any): string {
  return [
    cleanDomain(l?.company_domain),
    String(l?.full_name || '').toLowerCase().trim(),
    linkedinSlug(l?.linkedin_url) || '',
    String(l?.work_email || '').toLowerCase().trim(),
  ].join('|');
}

/**
 * Window used in reveal idempotency keys.
 *
 * Keys are deterministic per (user, lead, action) so a double-click lands on
 * the same reservation (wallet_reserve returns the existing hold) instead of
 * holding and charging twice. The window is needed because reservation keys
 * are unique forever: without it, retrying a lead after a miss would forever
 * hit the old, already-settled hold.
 */
const REVEAL_KEY_WINDOW_MS = 60_000;
function revealWindow(): number {
  return Math.floor(Date.now() / REVEAL_KEY_WINDOW_MS);
}
// A retry inside the same window after the earlier request FINISHED used to
// get the closed hold back as a duplicate and a 409 (audit M2). reserveOnce
// below now opens a fresh hold in that case; only a hold still in flight is
// refused as a duplicate.

const MAX_TEXT_FIELD = 200;
const MAX_URL_FIELD = 500;
const MAX_NOTES = 2000;
const MAX_BULK_SAVE = 500;
const ALLOWED_STATUS = ['new', 'contacted', 'replied', 'dismissed'];

/** Trimmed, length-capped text; '' for anything that is not text. */
function clampText(value: unknown, max = MAX_TEXT_FIELD): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * A LinkedIn profile URL we are willing to store or forward: https, on
 * linkedin.com, an /in/ or /pub/ path, at most 500 characters. Anything else is
 * dropped, since user_leads is now written only by this function and a stored
 * javascript: or look-alike URL would be rendered as a link.
 */
function safeLinkedin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_FIELD * 2) return null;
  const normalized = normalizeLinkedin(value);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL(normalized.replace(/^http:\/\//i, 'https://'));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') return null;
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  if (!/^\/(?:in|pub)\/[^/]+/i.test(url.pathname)) return null;
  const out = `https://${host}${url.pathname}`.replace(/\/+$/, '');
  return out.length <= MAX_URL_FIELD ? out : null;
}

function safeEmail(value: unknown): string | null {
  return isEmailAddress(value) && value.trim().length <= 254 ? value.trim() : null;
}

function isAllowedStatus(value: unknown): value is string {
  return typeof value === 'string' && ALLOWED_STATUS.includes(value);
}

/** The key the client uses for a lead, computed from what it sent. */
function clientKeyOf(l: any): string {
  return `${String(l?.company_domain || '').toLowerCase().trim()}::${String(l?.full_name || '').toLowerCase().trim()}`;
}

/**
 * One lead from a request body, with every field clamped. Bulk endpoints map
 * their input through this before anything reaches the provider or the table.
 * `client_key` keeps the key the client computed so per-lead results
 * (not_found_keys, failed_keys) still match its rows.
 *
 * Verification fields are server-owned (audit N13): the client's
 * work_email / email_status / phone_number are never written to user_leads.
 * A client-sent address survives only as `email_hint`, a lookup hint for the
 * phone provider; what gets stored comes from a lookup or the stored row.
 */
function sanitizeLead(l: any) {
  const hint = l?.email_status === 'preview' ? null : safeEmail(l?.revealed_email) || safeEmail(l?.work_email);
  return {
    client_key: clientKeyOf(l),
    full_name: clampText(l?.full_name),
    first_name: clampText(l?.first_name),
    last_name: clampText(l?.last_name),
    title: clampText(l?.title),
    company_name: clampText(l?.company_name),
    company_domain: cleanDomain(typeof l?.company_domain === 'string' ? l.company_domain : ''),
    company_size: clampText(l?.company_size) || null,
    company_revenue: clampText(l?.company_revenue) || null,
    company_phone: clampText(l?.company_phone, 50) || null,
    location: clampText(l?.location) || null,
    linkedin_url: safeLinkedin(l?.linkedin_url),
    email_hint: hint,
    status: isAllowedStatus(l?.status) ? l.status : null,
  };
}

// ---------------------------------------------------------------------------
// Credit Accounting via wallet_reserve & wallet_settle
// ---------------------------------------------------------------------------

interface Reservation {
  /** null when nothing needed holding (a zero-credit price). */
  id: string | null;
  reserved: number;
  /**
   * The key already had a hold: this is a duplicate of a request that is in
   * flight (or just finished). The hold belongs to that request, so this one
   * must neither use nor settle it.
   */
  duplicate: boolean;
}

/**
 * Holds that this request opened and has not closed yet. Anything still here
 * when the request ends (an unexpected exception) is released by the top-level
 * handler, so a crash cannot leave credits held until the reaper runs.
 */
type HoldSet = Set<string>;

type Shortfall = { shortfall: number; required: number; available: number };

/**
 * Every leads hold is paid-only (`p_paid_only: true`): the owner's decision is
 * that welcome credits only cover feed sweeps, so only purchased grants count
 * toward a leads reserve. A shortfall is reported with PAID_CREDITS_MESSAGE.
 */
async function reserveCredits(
  admin: any,
  userId: string,
  credits: number,
  key: string,
  context: Record<string, unknown>,
  holds?: HoldSet,
): Promise<Reservation | Shortfall> {
  const { data, error } = await admin.rpc('wallet_reserve', {
    p_user_id: userId,
    p_credits: credits,
    p_idempotency_key: key,
    p_context: context,
    p_paid_only: true,
  });
  if (error) {
    console.error('[billing] wallet_reserve failed:', error.message);
    return { shortfall: credits, required: credits, available: 0 };
  }
  const r = data as any;
  if (r?.ok) {
    const id = typeof r.reservation_id === 'string' ? r.reservation_id : null;
    const duplicate = r.duplicate === true;
    if (id && !duplicate) holds?.add(id);
    return { id, reserved: Number(r.reserved ?? credits), duplicate };
  }
  return {
    shortfall: Number(r?.shortfall ?? credits),
    required: Number(r?.required ?? credits),
    available: Number(r?.available ?? 0),
  };
}

/**
 * Reserve under a deterministic key, but only refuse a duplicate whose hold is
 * still open (a double-click in flight). When the key's hold is already
 * settled or released, the earlier request finished, so a retry gets its own
 * hold instead of a 409 (audit M2). Returns the key actually used, which is
 * the one to settle with.
 */
async function reserveOnce(
  admin: any,
  userId: string,
  credits: number,
  key: string,
  context: Record<string, unknown>,
  holds?: HoldSet,
): Promise<{ hold: Reservation | Shortfall; key: string }> {
  const hold = await reserveCredits(admin, userId, credits, key, context, holds);
  if ('shortfall' in hold || !hold.duplicate || !hold.id) return { hold, key };
  const { data, error } = await admin.from('reservations').select('status').eq('id', hold.id).maybeSingle();
  if (error || !data || data.status === 'held') return { hold, key };
  const retryKey = `${key}:retry:${crypto.randomUUID()}`;
  return { hold: await reserveCredits(admin, userId, credits, retryKey, context, holds), key: retryKey };
}

/** Gives a hold back untouched: nothing was billed by the provider. */
async function releaseCredits(
  admin: any,
  reservationId: string | null,
  reason: string,
  holds?: HoldSet,
): Promise<void> {
  if (!reservationId) return;
  holds?.delete(reservationId);
  const { error } = await admin.rpc('wallet_release', {
    p_reservation_id: reservationId,
    p_reason: reason,
  });
  if (error) console.error('[billing] wallet_release failed:', error.message);
}

/** Closes a hold. Call through `settleHold` in the handler, which flushes usage first. */
async function settleCredits(
  admin: any,
  reservationId: string | null,
  creditsCharged: number,
  providerCostUsd: number,
  key: string,
  note: string,
  holds?: HoldSet,
): Promise<number | null> {
  if (!reservationId) return null;
  // Removed before the call, not after: if the RPC commits but the response is
  // lost, releasing it again in the crash path would undo a real charge.
  holds?.delete(reservationId);
  const { data, error } = await admin.rpc('wallet_settle', {
    p_reservation_id: reservationId,
    p_credits_charged: creditsCharged,
    p_provider_cost: providerCostUsd,
    p_idempotency_key: key,
    p_note: note,
  });
  if (error) {
    console.error('[billing] wallet_settle failed:', error.message);
    return null;
  }
  return Number((data as any)?.balance_after ?? 0);
}

/**
 * Every saved row for the domains of `leads`, plus the empty-domain
 * (LinkedIn-only) rows when any lead has no domain. The bulk phone path used
 * to fetch only by domain, so an empty-domain lead never matched its saved
 * row and its number was bought again on every run (audit M2).
 */
async function loadExistingRows(admin: any, userId: string, leads: any[]): Promise<any[]> {
  const domains = [...new Set(leads.map((l: any) => cleanDomain(l?.company_domain)).filter(Boolean))];
  const rows: any[] = [];
  const PAGE = 500;
  for (let i = 0; i < domains.length; i += 100) {
    // Paged: one PostgREST response is capped, and a short map here means an
    // upsert writes over (or re-buys) contacts it should have seen.
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('user_leads')
        .select('*')
        .eq('user_id', userId)
        .in('company_domain', domains.slice(i, i + 100))
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`existing-lead lookup failed: ${error.message}`);
      if (data) rows.push(...data);
      if (!data || data.length < PAGE) break;
    }
  }
  if (leads.some((l: any) => !cleanDomain(l?.company_domain))) {
    const { data: emptyRows, error } = await admin
      .from('user_leads')
      .select('*')
      .eq('user_id', userId)
      .eq('company_domain', '');
    if (error) throw new Error(`existing-lead lookup failed: ${error.message}`);
    if (emptyRows) rows.push(...emptyRows);
  }
  return rows;
}

/**
 * Index of saved rows by (domain, name) key, and by LinkedIn slug, so a lead
 * can be matched to its stored row. A slug match also requires the same name.
 */
function indexExistingRows(rows: any[]) {
  const byKey = new Map<string, any>();
  const bySlug = new Map<string, any>();
  for (const r of rows) {
    byKey.set(leadKey(r), r);
    const slug = linkedinSlug(r?.linkedin_url);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, r);
  }
  return {
    find(l: any): any | null {
      const hit = byKey.get(leadKey(l));
      if (hit) return hit;
      const slug = linkedinSlug(l?.linkedin_url);
      const bySlugHit = slug ? bySlug.get(slug) : null;
      const sameName = (a: any, b: any) =>
        String(a?.full_name || '').toLowerCase().trim() === String(b?.full_name || '').toLowerCase().trim();
      return bySlugHit && sameName(bySlugHit, l) ? bySlugHit : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers: URL, Domain & Lead Normalization (cleanDomain, linkedinSlug in lib.ts)
// ---------------------------------------------------------------------------

function normalizeLinkedin(url?: string | null): string | null {
  if (!url || typeof url !== 'string' || url === 'N/A' || url === 'null') return null;
  let clean = url.trim();
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = 'https://' + clean.replace(/^\/+/, '');
  }
  return clean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for a real UUID. Anything else must never reach a uuid column. */
function isUuid(value?: string | null): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Escapes the wildcards in a value used with ilike.
 *
 * `_` matches any single character, so "Ann_Smith" would otherwise also match
 * "Ann Smith" and the lookup could settle on somebody else's row.
 */
function escapeLike(value?: string | null): string {
  if (!value || typeof value !== 'string') return '';
  return value.replace(/([\\%_])/g, '\\$1');
}

function slugOfRow(row: any): string | null {
  return linkedinSlug(row?.linkedin_url);
}

/**
 * Finds an already-saved lead.
 *
 * Two things this is careful about:
 *  - company_domain is optional in a LinkedIn-only lookup. Passing undefined to
 *    .eq() serialises as the literal string "undefined" and matches nothing, so
 *    the filter is only attached when there is a value.
 *  - maybeSingle() throws when more than one row comes back, turning a routine
 *    "you already have this contact" into a 500. limit(1) takes the newest row
 *    and never errors.
 */
interface FindExistingOpts {
  companyDomain?: string | null;
  fullName?: string | null;
  linkedinUrl?: string | null;
  workEmail?: string | null;
}

/**
 * Finds an already-saved lead without guessing the wrong person.
 *
 * The old version matched on full_name alone when no domain was supplied, so a
 * LinkedIn lookup for "John Smith" could return another John Smith's paid email
 * from a different company. Now the strongest available identity signal wins:
 *   1. exact work_email
 *   2. exact LinkedIn slug
 *   3. company_domain + full_name
 * and a name-only query is post-filtered on the LinkedIn slug when one was
 * supplied, so a name match that does not also agree on LinkedIn is rejected.
 */
async function findExistingLead(
  admin: any,
  userId: string,
  optsOrDomain?: string | null | FindExistingOpts,
  fullName?: string | null,
  linkedinUrl?: string | null,
  workEmail?: string | null,
): Promise<any | null> {
  // Backwards-compatible call shapes.
  let opts: FindExistingOpts;
  if (optsOrDomain && typeof optsOrDomain === 'object') {
    opts = optsOrDomain as FindExistingOpts;
  } else {
    opts = {
      companyDomain: optsOrDomain as string | null,
      fullName,
      linkedinUrl,
      workEmail,
    };
  }

  const name = (opts.fullName || '').trim();
  const domain = (opts.companyDomain || '').trim().toLowerCase();
  const email = (opts.workEmail || '').trim().toLowerCase();
  const slug = linkedinSlug(opts.linkedinUrl);

  if (!name && !domain && !email && !slug) return null;

  // Try the identity signals in order of confidence and keep looking when one
  // of them misses. The old version stopped at the first signal it had, so a
  // stale or preview email that matched no row made the whole lookup return
  // null even though the same person was already in the pipeline under the
  // exact domain + name. Callers then upserted on
  // (user_id, company_domain, full_name) and overwrote that row's stage and
  // address.
  async function firstMatch(
    builder: () => any,
    accept: (row: any) => boolean,
  ): Promise<any | null> {
    const { data, error } = await builder()
      .order('updated_at', { ascending: false })
      .limit(25);
    if (error) {
      console.warn('[leads] existing-lead lookup failed:', error.message);
      return null;
    }
    for (const row of data || []) {
      if (accept(row)) return row;
    }
    return null;
  }

  if (email) {
    const hit = await firstMatch(
      () =>
        admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .eq('work_email', email),
      () => true,
    );
    if (hit) return hit;
  }

  if (slug) {
    const hit = await firstMatch(
      () =>
        admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .ilike('linkedin_url', `%${escapeLike(slug)}%`),
      (row) => {
        const rowSlug = slugOfRow(row);
        return !rowSlug || rowSlug === slug;
      },
    );
    if (hit) return hit;
  }

  if (name && domain) {
    const hit = await firstMatch(
      () =>
        admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .eq('company_domain', domain)
          .ilike('full_name', escapeLike(name)),
      (row) => (row.company_domain || '').toLowerCase() === domain,
    );
    if (hit) return hit;
  }

  // Name-only is the last resort. A domain with no name is deliberately not
  // attempted: it cannot identify a person and would hand back a colleague's
  // cached contact. A name alone cannot either: this stage used to accept any
  // same-name row, so "John Smith @ a.com" could get another John Smith's
  // email back as "already revealed" (audit M2). The promised post-filter is
  // now applied: the LinkedIn slug must be supplied and agree, and the row's
  // domain must not contradict the requested one.
  if (name && slug) {
    const hit = await firstMatch(
      () =>
        admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .ilike('full_name', escapeLike(name)),
      (row) => acceptNameOnlyMatch(row, slug, domain),
    );
    if (hit) return hit;
  }

  return null;
}

/**
 * A human-readable name for a LinkedIn-only lookup.
 *
 * The UI used to send the literal string "LinkedIn Prospect" with an empty
 * domain, so every LinkedIn reveal saved a junk row into the pipeline — rows
 * that could never be matched against a later search and had to be deleted by
 * hand. Deriving the name from the profile slug keeps the two halves matching.
 */
function nameFromLinkedinSlug(url?: string | null): { full_name: string; first_name: string; last_name: string } | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  const slug = match?.[1];
  if (!slug) return null;
  const spaced = slug
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const parts = spaced.split(/\s+/).filter(Boolean).map(cap);
  const first_name = parts[0] || '';
  const last_name = parts.slice(1).join(' ');
  return { full_name: `${first_name}${last_name ? ' ' + last_name : ''}`, first_name, last_name };
}

function normalizeLead(p: any, idx: number, fallbackDomain = ''): any {
  // 1. Full Name, First Name, Last Name (Handles both camelCase and snake_case)
  const rawFullName = (p.fullName || p.full_name || p.name || '').trim();
  let firstName = (p.first_name || p.firstName || '').trim();
  let lastName = (p.last_name || p.lastName || '').trim();

  if (!firstName && rawFullName) {
    const parts = rawFullName.split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  const fullName =
    rawFullName ||
    (firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || 'Decision Maker');

  // 2. Title & Role (Handles Aviato currentExperienceSummary and Quickenrich title)
  const title = (
    p.title ||
    p.currentExperienceSummary?.title ||
    p.headline ||
    p.role ||
    'Executive / Leader'
  ).trim();

  // 3. Domain & Company Name
  const domain = cleanDomain(
    p._searched_domain ||
    p.company_url ||
    p.email_domain ||
    p.currentExperienceSummary?.company?.URLs?.website ||
    p.company?.website ||
    p.company_domain ||
    p.domain ||
    fallbackDomain
  );

  const fallbackCompanyName = domain
    ? domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1)
    : 'Enterprise';

  const companyName = (
    p.company_name ||
    p.currentExperienceSummary?.company?.name ||
    p.company?.name ||
    p.company ||
    fallbackCompanyName
  ).trim();

  // 4. Location & Country
  const location =
    p.locality ||
    p.location ||
    (p.city && p.country_code ? `${p.city}, ${p.country_code}` : p.city || p.country || p.country_code || null);

  const countryCode = p.country_code || (p.city && p.country_code ? p.country_code : null);

  // 5. Headcount / Size / Industry
  const companySize =
    p.employee_count ||
    (p.currentExperienceSummary?.company?.headcount
      ? `${p.currentExperienceSummary.company.headcount} employees`
      : null) ||
    p.headcount ||
    p.company_size ||
    null;

  const industry = p.industry || p.currentExperienceSummary?.company?.industry || null;
  const revenue = p.revenue || p.company_revenue || null;

  // 6. Contact Signals
  const linkedinUrl = normalizeLinkedin(
    p.employee_linkedin ||
    p.URLs?.linkedin ||
    p.linkedin_url ||
    p.linkedin ||
    p.profile_url
  );

  // The address that comes back with a search result is the provider's
  // unverified homepage/company address (or a placeholder like "N/A"), not the
  // person's verified work email. It travels as `preview_email` so it can be
  // shown for what it is without blocking a real reveal.
  const homePageEmail = isEmailAddress(p.home_page_email)
    ? p.home_page_email.trim()
    : isEmailAddress(p.email)
      ? p.email.trim()
      : null;

  const hasEmail = Boolean(p.has_email || homePageEmail);
  const hasPhone = Boolean(p.has_phone || p.phone || p.company_phone || p.mobile_phone);
  const hasLinkedin = Boolean(safeLinkedin(linkedinUrl));

  const id = p.emp_id
    ? String(p.emp_id)
    : p.id
    ? String(p.id)
    : `lead_${idx}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Provider data is clamped like client input: these values are written to
  // user_leads by auto-enrich and echoed back by bulk-save.
  return {
    id: clampText(id, MAX_TEXT_FIELD) || `lead_${idx}`,
    first_name: clampText(firstName),
    last_name: clampText(lastName),
    full_name: clampText(fullName),
    title: clampText(title),
    company_name: clampText(companyName),
    company_domain: domain,
    company_size: clampText(companySize) || null,
    company_revenue: clampText(revenue) || null,
    industry: clampText(industry) || null,
    company_phone: clampText(p.company_phone, 50) || null,
    linkedin_url: safeLinkedin(linkedinUrl),
    location: clampText(location) || null,
    country_code: countryCode,
    has_email: hasEmail,
    has_phone: hasPhone,
    has_linkedin: hasLinkedin,
    preview_email: homePageEmail,
    revealed_email: null,
    revealed_phone: null,
    email_status: null,
    is_saved: false,
  };
}

// ---------------------------------------------------------------------------
// Main Request Handler
// ---------------------------------------------------------------------------

/**
 * Last line of defence. An exception that escaped an action used to surface as
 * the runtime's bare 500 with no CORS headers, which the browser reports as a
 * network error rather than a failed request.
 */
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return withCors(new Response(null, { headers: corsHeaders() }), req);
  }
  try {
    return withCors(await handleRequest(req), req);
  } catch (err: any) {
    console.error('[leads] unhandled error:', err?.name || 'error', String(err?.message || '').slice(0, 200));
    return withCors(fail('Internal error', 500), req);
  }
});

async function handleRequest(req: Request): Promise<Response> {
  const maybeUserId = await requireUserId(req);
  if (!maybeUserId) {
    return fail('Unauthorized', 401);
  }
  // Re-bound as a plain string: narrowing does not carry into the hoisted
  // handleAction declaration below.
  const userId: string = maybeUserId;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const token = await resolveToken(admin);
  if (!token) {
    return fail('Leads service is not configured (missing token).', 503);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return fail('Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('Invalid JSON body');
  }

  const action = body.action || 'search';
  const usage = new UsageLog(userId);
  const openHolds: HoldSet = new Set();
  try {
    return await handleAction();
  } catch (err: any) {
    console.error('[leads] action failed:', action, err?.name || 'error', String(err?.message || '').slice(0, 200));
    return fail('Internal error', 500);
  } finally {
    // Usage first, so every row is on disk with its reservation_id (audit H6).
    await usage.flush(admin);
    // Any hold still open here was abandoned by an unexpected exception. It is
    // closed now the way the reaper would close it: settled for the credits
    // its usage rows already earned, released when they earned none.
    for (const id of [...openHolds]) {
      const rows = usage.rows.filter((r) => r.reservation_id === id);
      const credits = rows.reduce((s, r) => s + r.credits_charged, 0);
      const cost = Number(rows.reduce((s, r) => s + r.provider_cost_usd, 0).toFixed(8));
      const closing = credits > 0
        ? settleCredits(admin, id, credits, cost, `leads:abort:${id}`, 'leads: settled after unexpected error', openHolds)
        : releaseCredits(admin, id, 'leads: released after unexpected error', openHolds);
      await Promise.resolve(closing).catch((e: any) => console.error('[billing] close after error failed:', e?.message));
    }
  }

  /**
   * Every settle goes through here: usage rows (each carrying its hold's
   * reservation_id) are written BEFORE the hold is closed, so a request killed
   * between the two leaves a hold the reaper can settle from usage (audit H6).
   */
  async function settleHold(
    reservationId: string | null,
    creditsCharged: number,
    providerCostUsd: number,
    key: string,
    note: string,
  ): Promise<number | null> {
    await usage.flush(admin);
    return settleCredits(admin, reservationId, creditsCharged, providerCostUsd, key, note, openHolds);
  }

  async function handleAction(): Promise<Response> {
  // =========================================================================
  // ACTION 0: PRICING — what the UI quotes, from the same source the charges use
  // =========================================================================
  if (action === 'pricing') {
    const prices = await loadPrices(admin);
    return json({
      ok: true,
      // null when the pricing_config row is missing or disabled; the action is
      // then refused rather than charged at a guessed price.
      email_credits: prices.email,
      phone_credits: prices.phone,
      // Search is charged per BILLED provider call (audit H4). A search makes
      // 1 call up to 100 leads, at most 11 for a single target and 12 for a
      // multi-company search. The block fields stay for older clients: the
      // per-block fee is gone.
      search_credits_per_call: prices.search,
      search_max_provider_calls_single: maxSearchProviderCalls(1, 1000),
      search_max_provider_calls_multi: MAX_PROVIDER_CALLS,
      search_free_leads: 0,
      search_block_leads: 100,
      search_block_credits: 0,
      // Kept for older clients; now the price of ONE billed provider call.
      searchCredits: prices.search,
      // Leads holds only draw on purchased credits.
      paid_credits_only: true,
    });
  }

  // =========================================================================
  // ACTION 1: SEARCH (Directory Prospecting with Batch & Bulk Limits)
  // =========================================================================
  if (action === 'search') {
    const rawTarget = typeof body.company_domain === 'string' ? body.company_domain.trim().slice(0, 1000) : '';
    const title = cleanFilter(body.title);
    const query = cleanFilter(body.q);
    const location = cleanFilter(body.location);
    const country = cleanFilter(body.country).toUpperCase();
    const industry = cleanFilter(body.industry);
    const requestedLimit = sanitizeSearchLimit(body.limit);
    // Treg's documented `keywords` list filter. Bounded so a client cannot
    // send an unbounded payload upstream.
    const keywords: string[] = Array.isArray(body.keywords)
      ? [...new Set(body.keywords.map((k: unknown) => cleanFilter(k).slice(0, 60)).filter(Boolean))].slice(0, 10) as string[]
      : [];

    // The provider expects an ISO 3166-1 alpha-2 code. A free-text value such
    // as "United States" was forwarded as-is and silently matched nobody.
    if (country && !/^[A-Z]{2}$/.test(country)) {
      return fail('Country must be a two-letter ISO code (for example "US").');
    }

    // Support comma-separated target domains
    const targetParts = rawTarget
      ? rawTarget.split(',').map((d: string) => cleanDomain(d)).filter(Boolean)
      : [];

    // Separate actual domains (contain a dot) from company names
    const domainList = targetParts.filter((d: string) => d.includes('.'));
    const companyNames = targetParts.filter((d: string) => !d.includes('.'));

    if (domainList.length === 0 && companyNames.length === 0 && !title && !query && !location && !country && !industry && keywords.length === 0) {
      return fail('Please provide search criteria (persona, title, company, or country).');
    }

    // A search only makes sense with credits to reveal what it finds: every
    // result is checked for a verified email/phone and charged per hit. With
    // an empty wallet the provider search would be paid for and shown nothing.
    const prices = await loadPrices(admin);
    if (prices.search === null || prices.email === null || prices.phone === null) return pricingUnavailable();
    const creditsPerCall: number = prices.search;
    const emailPrice: number = prices.email;
    const minimumCredits = Math.max(1, creditsPerCall, Math.min(emailPrice, prices.phone));
    if ((await walletAvailable(admin, userId)) < minimumCredits) {
      return fail(`Add credits to search. ${PAID_CREDITS_MESSAGE}`, 402, {
        insufficient_credits: true,
        needs_credits_to_search: true,
        paid_credits_required: true,
      });
    }

    // Searches cost provider money even when nothing is found, so they are
    // rate-limited — atomically and before any provider call. The burst bucket
    // is the concurrency guard: a script firing parallel searches is stopped
    // at three, not after the hourly count catches up.
    const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.searchBurst, RATE_LIMITS.search]);
    if (limited) return limited;

    // Charged per BILLED provider call (audit H4). The old price was a flat 1
    // credit plus a per-block fee of 0, so a 1,000-lead search making 11–12
    // provider calls was sold for 1 credit. Now the hold is the price per call
    // times the most calls THIS request can make (1 up to 100 leads, at most
    // 11 single-target / 12 multi-company), and the settle is the price times
    // the calls the provider actually billed.
    const maxCalls = maxSearchProviderCalls(domainList.length, requestedLimit);
    const maxSearchCredits = creditsPerCall * maxCalls;
    const searchKey = `search_${userId}_${crypto.randomUUID()}`;
    let searchHold: Reservation | null = null;
    let billableLeads = 0;
    // Where this search's usage rows start, so the settle can count and sum
    // exactly these calls.
    const searchUsageStart = usage.rows.length;
    if (maxSearchCredits > 0) {
      const hold = await reserveCredits(admin, userId, maxSearchCredits, searchKey, {
        feature: 'leads_search',
        requested_limit: requestedLimit,
        max_provider_calls: maxCalls,
        credits_per_call: creditsPerCall,
      }, openHolds);
      if ('shortfall' in hold) {
        return insufficientCredits(hold, {
          max_provider_calls: maxCalls,
          credits_per_call: creditsPerCall,
          affordable_limit: affordableSearchLimit(requestedLimit, domainList.length, hold.available, creditsPerCall),
        });
      }
      searchHold = hold;
    }
    const searchHoldId = searchHold?.id ?? null;
    // Each provider call gets its own Idempotency-Key under this search's key.
    let searchCallSeq = 0;
    const nextSearchIdem = () => `echo:${searchKey}:call:${searchCallSeq++}`;

    /**
     * Prices every billed call since the search started (so the rows the
     * reaper reads carry the credits) and returns the total. Called once the
     * provider calls are done, before the rows are flushed.
     */
    const priceSearchCalls = (): { charge: number; billedCalls: number } => {
      const billed = usage.billedCallsSince(searchUsageStart, 'treg.people.search');
      for (const row of usage.rows.slice(searchUsageStart)) {
        if (row.operation === 'treg.people.search') row.credits_charged = 0;
      }
      for (const row of billed) row.credits_charged = creditsPerCall;
      const charge = Math.min(billed.length * creditsPerCall, searchHold?.reserved ?? 0);
      return { charge, billedCalls: billed.length };
    };

    try {
      let allRawPeople: any[] = [];
      // Provider calls that failed outright. Reported back so a short result
      // caused by an outage is not presented as "all available leads".
      let failedBatches = 0;
      const fetchLimit = Math.min(requestedLimit, 100);

      let skippedDomains = 0;
      if (domainList.length > 1) {
        // Multi-domain search in parallel. Each domain may need more than one
        // provider call to fill its share of a large request, so the variation
        // rounds are budgeted across the target list. The old version allowed
        // up to 12 calls per domain and silently ignored every company past
        // the sixth.
        const domainsToSearch = domainList.slice(0, MAX_SEARCH_DOMAINS);
        skippedDomains = Math.max(0, domainList.length - domainsToSearch.length);
        const perDomainLimit = Math.max(10, Math.ceil(requestedLimit / domainsToSearch.length));
        const rounds = Math.max(
          1,
          Math.min(
            Math.ceil(perDomainLimit / 100),
            Math.floor(MAX_PROVIDER_CALLS / domainsToSearch.length),
          ),
        );
        const domainPromises = domainsToSearch.flatMap((domain: string) => {
          const payload: Record<string, any> = {
            company_domain: domain,
            limit: Math.min(100, perDomainLimit),
          };
          if (title) payload.title = title;
          if (query) payload.q = query;
          if (country) payload.country = country;
          if (location) payload.location = location;
          if (industry) payload.industry = industry;
          if (keywords.length) payload.keywords = keywords;
          const variants =
            rounds > 1 ? buildSearchVariations(payload, rounds - 1) : [];
          return [
            tregPeopleSearch(token, userId, payload, 'leads-multi-domain', domain, usage, searchHoldId, nextSearchIdem()),
            ...variants.map((v) =>
              tregPeopleSearch(token, userId, v, 'leads-multi-domain', domain, usage, searchHoldId, nextSearchIdem()),
            ),
          ];
        });

        const results = await Promise.all(domainPromises);
        failedBatches = results.filter((r) => r === null).length;
        if (failedBatches === results.length) {
          return fail('The lead search provider is not responding. Please try again in a moment.', 502);
        }
        allRawPeople = results.flatMap((r) => r ?? []);
      } else {
        // Single target or Persona / Topic Search
        let combinedQuery = query;
        if (companyNames.length > 0) {
          combinedQuery = combinedQuery ? `${combinedQuery} ${companyNames.join(' ')}` : companyNames.join(' ');
        }
        if (industry) {
          combinedQuery = combinedQuery ? `${combinedQuery} ${industry}` : industry;
        }

        const payload: Record<string, any> = { limit: fetchLimit };
        if (domainList[0]) payload.company_domain = domainList[0];
        if (title) payload.title = title;
        if (combinedQuery) payload.q = combinedQuery;
        if (country) payload.country = country;
        if (location) payload.location = location;
        if (keywords.length) payload.keywords = keywords;

        let tregRes: Response;
        try {
          tregRes = await fetch(`${TREG_BASE}/call/treg.people.search`, {
            method: 'POST',
            headers: tregHeaders(token, userId, 'leads-search', MAX_COST.search, nextSearchIdem()),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          });
          usage.track('treg.people.search', tregRes, { feature: 'leads-search' }, searchHoldId);
        } catch (err: any) {
          usage.track('treg.people.search', null, { feature: 'leads-search', error: err?.name || 'error' }, searchHoldId);
          console.error('[leads] treg.people.search unreachable:', err?.name || err?.message);
          return fail('The lead search provider did not respond in time. Please try again.', 504);
        }

        if (tregRes.ok) {
          const resJson = await tregRes.json();
          const firstBatch = resJson?.output?.people || resJson?.raw?.data || [];
          allRawPeople = Array.isArray(firstBatch) ? firstBatch : [];

          // More than one provider call is needed for a request above 100.
          // The extra calls run in parallel — the old sequential second call
          // was the same query with the title and keyword swapped, so it
          // returned the same people and the result set stopped at ~200.
          //
          // Below 100 the first call already asked for everything the user
          // wanted, so a short result means the provider has no more people
          // for these filters. Another call would only add provider cost.
          if (requestedLimit > 100 && allRawPeople.length < requestedLimit) {
            const remaining = requestedLimit - allRawPeople.length;
            const extraCalls = Math.min(
              MAX_PROVIDER_CALLS,
              Math.max(1, Math.ceil(remaining / 100)),
            );
            const variations = buildSearchVariations(payload, extraCalls);
            const extraResults = await Promise.all(
              variations.map((v) =>
                tregPeopleSearch(token, userId, v, 'leads-search-p2', undefined, usage, searchHoldId, nextSearchIdem()),
              ),
            );
            for (const batch of extraResults) {
              if (batch === null) failedBatches++;
              else allRawPeople = allRawPeople.concat(batch);
            }
          }
        } else {
          const errText = await tregRes.text();
          // Truncated: provider error bodies can echo the query back, and the
          // log only needs enough to identify the failure.
          console.error('[leads] treg.people.search failed:', tregRes.status, errText.slice(0, 200));
          return fail('Lead search provider error. Please try adjusting your filters.', 502);
        }
      }

      // Provider calls are done: price the billed ones onto their usage rows
      // and write them now, so a request killed later (enrichment, saving)
      // leaves a hold the reaper can settle from usage (audit H6).
      priceSearchCalls();
      await usage.flush(admin);

      // Deduplicate and normalize
      const seen = new Set<string>();
      // Ids are the client's row keys and selection keys. Two raw records with
      // the same provider id but a slightly different domain both survived the
      // name dedupe, rendered under one React key and toggled together.
      const seenIds = new Set<string>();
      const normalized: any[] = [];
      for (let i = 0; i < allRawPeople.length; i++) {
        const item = normalizeLead(allRawPeople[i], i, domainList[0] || '');
        // Filter out empty records
        if (!item.full_name || item.full_name === 'Decision Maker' && !item.company_domain) continue;

        const key = `${(item.company_domain || '').toLowerCase().trim()}::${(item.full_name || '').toLowerCase().trim()}`;
        if (!seen.has(key) && !seenIds.has(item.id)) {
          seen.add(key);
          seenIds.add(item.id);
          normalized.push(item);
        }
        if (normalized.length >= requestedLimit) break;
      }

      // Cross-check against user's already revealed/saved leads in database.
      // Fetch only the rows whose domain matches this result set: a full-table
      // select is capped by PostgREST at 1000 rows, so a power user's oldest
      // leads silently dropped out of the cross-check and re-revealing them
      // charged a second credit.
      const resultDomains = [...new Set(normalized.map((l: any) => (l.company_domain || '').trim().toLowerCase()).filter(Boolean))];
      let existingLeads: any[] = [];
      if (resultDomains.length > 0) {
        const { data } = await admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .in('company_domain', resultDomains);
        if (data) existingLeads = existingLeads.concat(data);
      }
      // LinkedIn-only leads carry an empty domain; fetch those separately so
      // they can still be matched instead of being skipped.
      if (normalized.some((l: any) => !(l.company_domain || '').trim())) {
        const { data: nullRows } = await admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .is('company_domain', null);
        if (nullRows) existingLeads = existingLeads.concat(nullRows);
        const { data: emptyRows } = await admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .eq('company_domain', '');
        if (emptyRows) existingLeads = existingLeads.concat(emptyRows);
      }

      // The saved row behind each result, for merging on a later upsert.
      const savedRowFor = new Map<any, any>();
      if (existingLeads && existingLeads.length > 0) {
        const existingMap = new Map<string, any>();
        for (const ex of existingLeads) {
          const key = `${(ex.company_domain || '').toLowerCase().trim()}::${(ex.full_name || '').toLowerCase().trim()}`;
          existingMap.set(key, ex);
        }

        for (const item of normalized) {
          const key = `${(item.company_domain || '').toLowerCase().trim()}::${(item.full_name || '').toLowerCase().trim()}`;
          const match = existingMap.get(key);
          if (match) {
            item.is_saved = true;
            item.status = match.status;
            // The saved row's own id, so downstream writes (status, phone)
            // address a row that exists. Without it every later update on this
            // lead 500s, because a provider id is not a uuid.
            item.db_id = match.id;
            savedRowFor.set(item, match);
            // Shown when the stored address is verified or a found catch-all /
            // risky one; an unknown/pending verdict is not shown as revealed.
            if (hasUsableEmail(match)) {
              item.revealed_email = match.work_email;
              item.email_status = match.email_status;
            }
            if (match.phone_number) {
              item.revealed_phone = match.phone_number;
              item.phone_type = match.phone_type;
            }
          }
        }
      }

      // =======================================================================
      // Automated Contact Enrichment: Automatically resolve & verify work emails
      // =======================================================================
      let creditsCharged = 0;
      let enrichedCount = 0;
      // Of those, the ones the verifier confirmed — the only ones charged.
      let verifiedCount = 0;
      let enrichmentPending = 0;
      // Why some contacts were left unenriched: the per-search cap, the
      // wallet, or the hourly lookup limit. The client words its notice
      // differently for each.
      let enrichmentLimitedBy: 'cap' | 'balance' | 'rate_limit' | null = null;
      const MAX_AUTO_ENRICH = 60;

      // Enrichment spends credits, so it has to be an explicit opt-in. A
      // caller that omitted the flag (an older client, a script) used to be
      // charged for up to 60 reveals it never asked for.
      if (body.auto_enrich === true && normalized.length > 0) {
        // Cap what one search may resolve, to keep it inside its time budget;
        // anything over it still comes back with a per-row reveal button.
        const leadsToEnrich = normalized
          .filter((l) => !l.revealed_email && l.company_domain)
          .slice(0, MAX_AUTO_ENRICH);

        if (leadsToEnrich.length > 0) {
          // Held at the configured email price per lead.
          // Derived from this search's own key, so a retried request reuses
          // the hold rather than stacking a second one.
          let runKey = `${searchKey}:enrich`;
          let hold = await reserveCredits(admin, userId, leadsToEnrich.length * emailPrice, runKey, {
            feature: 'auto_enrich_leads',
            requested_count: leadsToEnrich.length,
          }, openHolds);

          // Short on credits: hold what the wallet can cover instead.
          if ('shortfall' in hold) {
            const affordableLeads = emailPrice > 0
              ? Math.floor(Math.max(0, Number(hold.available) || 0) / emailPrice)
              : 0;
            if (affordableLeads > 0) {
              runKey = `${runKey}_partial`;
              hold = await reserveCredits(admin, userId, affordableLeads * emailPrice, runKey, {
                feature: 'auto_enrich_leads',
                requested_count: leadsToEnrich.length,
                partial: true,
              }, openHolds);
            }
          }

          // How many lookups the hold covers (audit H3: bounded by the credits
          // actually held). A zero price is not a licence for unbounded free
          // lookups: with nothing held, nothing is looked up.
          const maxAllowed = 'shortfall' in hold || hold.duplicate || emailPrice <= 0
            ? 0
            : Math.min(leadsToEnrich.length, Math.floor(hold.reserved / emailPrice));
          const enrichHoldId = 'shortfall' in hold || hold.duplicate ? null : hold.id;
          const enrichUsageStart = usage.rows.length;
          if (maxAllowed < leadsToEnrich.length) enrichmentLimitedBy = 'balance';

          const targetBatch = leadsToEnrich.slice(0, maxAllowed);
          // Leads the hourly lookup limit stopped before they were looked up.
          let rateLimitedLookups = 0;

          try {
            // Parallel enrichment batches of 5
            const BATCH_SIZE = 5;
            for (let i = 0; i < targetBatch.length; i += BATCH_SIZE) {
              const chunk = targetBatch.slice(i, i + BATCH_SIZE);
              await Promise.all(
                chunk.map(async (lead) => {
                  try {
                    // Each lookup takes a slot from the same hourly
                    // `leads.reveal` bucket as a manual reveal (audit H3).
                    // Auto-enrich used to run outside every reveal limit.
                    const slot = await takeRateLimit(admin, userId, RATE_LIMITS.reveal);
                    if (slot !== true) {
                      rateLimitedLookups++;
                      return;
                    }
                    const emailPayload: Record<string, string> = { domain: lead.company_domain };
                    if (lead.full_name) emailPayload.full_name = lead.full_name;
                    if (lead.linkedin_url) emailPayload.linkedin_url = lead.linkedin_url;
                    const leadRef = await shortHash(leadIdentity(lead));

                    const res = await fetch(`${TREG_BASE}/call/treg.people.email.find`, {
                      method: 'POST',
                      headers: tregHeaders(token, userId, 'auto-enrich', MAX_COST.email, `echo:${runKey}:${leadRef}`, {
                        'X-Treg-Route-Verify': 'true',
                      }),
                      body: JSON.stringify(emailPayload),
                      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
                    });
                    const autoRow = usage.track('treg.people.email.find', res, { feature: 'auto-enrich' }, enrichHoldId);

                    if (!res.ok) {
                      // Not a miss: the lookup itself failed, so the row keeps
                      // its Reveal button and the user can retry it.
                      return;
                    }
                    const data = await res.json();
                    const rawEmail = data?.output?.email || data?.raw?.data?.email || null;
                    // An unknown / pending verdict is not usable (audit H3):
                    // it is neither shown nor saved as revealed.
                    const verdict = classifyEmail(data);
                    const email = isEmailAddress(rawEmail) && verdict.usable ? rawEmail.trim() : null;
                    if (!email) {
                      lead.email_status = verdict.status === 'unknown' || verdict.status === 'pending'
                        ? verdict.status
                        : 'not_found';
                      return;
                    }
                    enrichedCount++;
                    if (verdict.charge) {
                      verifiedCount++;
                      autoRow.credits_charged = emailPrice;
                    }
                    lead.revealed_email = email;
                    lead.work_email = email;
                    lead.email_status = verdict.status;
                    lead.is_saved = true;

                    // Merged onto the saved row, if any: a blank or placeholder
                    // provider value no longer overwrites stored data (M2).
                    const record = mergeLeadRecord(savedRowFor.get(lead) ?? null, {
                      user_id: userId,
                      company_domain: lead.company_domain,
                      company_name: lead.company_name,
                      full_name: lead.full_name,
                      first_name: lead.first_name,
                      last_name: lead.last_name,
                      title: lead.title,
                      location: lead.location,
                      linkedin_url: lead.linkedin_url,
                      work_email: email,
                      email_status: verdict.status,
                      email_confidence: verdict.charge ? 0.95 : 0.5,
                      status: lead.status || null,
                      updated_at: new Date().toISOString(),
                    });
                    const { data: upserted, error: upsertErr } = await admin
                      .from('user_leads')
                      .upsert(record, { onConflict: 'user_id,company_domain,full_name' })
                      .select('id')
                      .maybeSingle();
                    if (upsertErr) {
                      // Not saved, so not charged: the address is still shown.
                      console.error('[leads] auto-enrich save failed:', upsertErr.message);
                      lead.is_saved = Boolean(lead.db_id);
                      if (verdict.charge) {
                        verifiedCount--;
                        autoRow.credits_charged = 0;
                        lead.revealed_email = null;
                        lead.work_email = null;
                        lead.email_status = null;
                        enrichedCount--;
                      }
                      return;
                    }
                    if (upserted?.id) lead.db_id = upserted.id;
                  } catch (err: any) {
                    // A timeout or network error is not a "not found" — leave
                    // the status empty so the row can still be revealed.
                    console.warn('[leads] auto-enrich lookup failed:', err?.name || err?.message);
                  }
                })
              );
            }
          } finally {
            // Settling from `finally`, so whatever happened the hold is closed.
            // Usage rows are flushed first (settleHold), each carrying this
            // hold's reservation_id (audit H6).
            creditsCharged = verifiedCount * emailPrice;
            if (!('shortfall' in hold) && !hold.duplicate) {
              await settleHold(
                hold.id,
                creditsCharged,
                usage.costSince(enrichUsageStart, 'treg.people.email.find', 'auto-enrich'),
                runKey,
                `Auto-enriched ${verifiedCount} verified emails for search (${normalized.length} leads)`,
              );
            }
          }

          if (rateLimitedLookups > 0) enrichmentLimitedBy = 'rate_limit';
          enrichmentPending = normalized.filter(
            (l) => !l.revealed_email && l.company_domain && !l.email_status,
          ).length;
          if (enrichmentPending > 0 && !enrichmentLimitedBy) enrichmentLimitedBy = 'cap';
        }
      }

      billableLeads = normalized.length;
      const { charge: searchCredits, billedCalls } = priceSearchCalls();
      // A summary row for the search itself. It carries no reservation_id and
      // no credits (the per-call rows carry those), so the reaper and the
      // margin reports never count the search twice.
      usage.track('leads.search', null, {
        requested_limit: requestedLimit,
        returned: billableLeads,
        billed_calls: billedCalls,
        credits_per_call: creditsPerCall,
        credits: searchCredits,
      }).outcome = 'free';
      return json({
        ok: true,
        people: normalized,
        count: normalized.length,
        requested_limit: requestedLimit,
        free_leads: 0,
        search_credits_charged: searchCredits,
        search_billed_calls: billedCalls,
        search_credits_per_call: creditsPerCall,
        enriched_count: enrichedCount,
        credits_charged: creditsCharged + searchCredits,
        enrichment_pending: enrichmentPending,
        enrichment_limited_by: enrichmentLimitedBy,
        skipped_domains: skippedDomains,
        failed_batches: failedBatches,
      });
    } catch (err: any) {
      console.error('[leads] search execution error:', err?.name || 'error', String(err?.message || '').slice(0, 200));
      return fail('Internal lead search error', 500);
    } finally {
      // Every exit — success, provider error, exception — closes the hold:
      // settled at the price per call times the calls the provider billed,
      // with its actual charge; released when no call was billed at all.
      if (searchHold && !searchHold.duplicate) {
        const { charge, billedCalls } = priceSearchCalls();
        const cost = usage.costSince(searchUsageStart, 'treg.people.search');
        if (charge === 0 && cost === 0) {
          await usage.flush(admin);
          await releaseCredits(admin, searchHold.id, 'Lead search: no billed provider calls', openHolds);
        } else {
          await settleHold(
            searchHold.id,
            charge,
            cost,
            searchKey,
            `Lead search: ${billableLeads} leads, ${billedCalls} billed provider calls`,
          );
        }
      }
    }
  }

  // =========================================================================
  // ACTION 2: REVEAL EMAIL (single; pricing_config `treg.people.email.find`)
  // =========================================================================
  if (action === 'reveal-email') {
    // Every field clamped before it reaches the provider or user_leads; a
    // LinkedIn URL that is not an https linkedin.com/in|pub profile is dropped.
    const input = sanitizeLead(body);
    const {
      full_name,
      first_name,
      last_name,
      company_domain,
      linkedin_url,
      title,
      company_name,
      company_size,
      company_revenue,
      location,
    } = input;

    if (!company_domain && !linkedin_url) {
      return fail('Company domain or LinkedIn URL is required to find email.');
    }
    if (!full_name && !first_name && !linkedin_url) {
      return fail('Lead name or LinkedIn URL is required.');
    }
    const emailPrice = (await loadPrices(admin)).email;
    if (emailPrice === null) return pricingUnavailable();

    // A LinkedIn-only lookup arrives with no name at all. Deriving one from the
    // profile slug keeps the saved row identifiable.
    const derived = !full_name && linkedin_url ? nameFromLinkedinSlug(linkedin_url) : null;
    const resolvedName = clampText(full_name || derived?.full_name || '');
    const resolvedFirst = clampText(first_name || derived?.first_name || resolvedName.split(' ')[0] || '');
    const resolvedLast = clampText(
      last_name ||
      derived?.last_name ||
      (resolvedName ? resolvedName.split(' ').slice(1).join(' ') : '')
    );
    let resolvedDomain = company_domain;

    // 1. Already bought? Only a VERIFIED stored address counts (audit M2): a
    // free unknown / risky one used to block buying the verified one forever.
    const existing = await findExistingLead(admin, userId, { companyDomain: resolvedDomain, fullName: resolvedName, linkedinUrl: linkedin_url });

    if (hasRevealedEmail(existing)) {
      return json({
        ok: true,
        already_revealed: true,
        lead: existing,
        credits_charged: 0,
      });
    }

    // Only lookups that reach the provider count against the limits.
    const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.revealBurst, RATE_LIMITS.reveal]);
    if (limited) return limited;

    // 2. Hold the email price. The key is deterministic per (user, lead,
    // action, minute) so a double-click in flight is refused; a retry after
    // the first request finished gets a fresh hold (reserveOnce).
    const leadRef = await shortHash(leadIdentity({ company_domain: resolvedDomain, full_name: resolvedName, linkedin_url }));
    const baseKey = `reveal_email:${userId}:${leadRef}:${revealWindow()}`;
    const { hold, key: runKey } = await reserveOnce(admin, userId, emailPrice, baseKey, {
      feature: 'lead_email_reveal',
      lead_ref: leadRef,
    }, openHolds);

    if ('shortfall' in hold) return insufficientCredits(hold);
    if (hold.duplicate) {
      return fail('This contact is already being looked up. Please wait a moment.', 409, { duplicate_request: true });
    }

    // 3. Treg email finder with verification.
    let emailFound: string | null = null;
    // Credits this reveal costs: the full price only for a verified address.
    let emailCharge = 0;
    let emailStatus: string = 'unknown';
    let emailConfidence = 0.9;
    const revealUsageStart = usage.rows.length;

    try {
      const emailPayload: Record<string, string> = {};
      if (resolvedDomain) emailPayload.domain = resolvedDomain;
      if (resolvedName) emailPayload.full_name = resolvedName;
      else if (resolvedFirst && resolvedLast) {
        emailPayload.first_name = resolvedFirst;
        emailPayload.last_name = resolvedLast;
      }
      if (linkedin_url) emailPayload.linkedin_url = linkedin_url;

      const tregRes = await fetch(`${TREG_BASE}/call/treg.people.email.find`, {
        method: 'POST',
        // Keyed on the base key, so a retry after a timeout replays the
        // provider's answer instead of paying for the lookup again.
        headers: tregHeaders(token, userId, 'lead-email', MAX_COST.email, `echo:${baseKey}`, {
          'X-Treg-Route-Verify': 'true',
        }),
        body: JSON.stringify(emailPayload),
        signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      });

      const emailRow = usage.track('treg.people.email.find', tregRes, { feature: 'lead-email' }, hold.id);

      if (tregRes.ok) {
        const resJson = await tregRes.json();
        const rawEmail = resJson?.output?.email || resJson?.raw?.data?.email || null;
        // unknown / pending / invalid → not usable: a 404, never a free reveal.
        const verdict = classifyEmail(resJson);
        emailFound = isEmailAddress(rawEmail) && verdict.usable ? rawEmail.trim() : null;
        emailCharge = emailFound && verdict.charge ? emailPrice : 0;
        emailRow.credits_charged = emailCharge;
        emailStatus = verdict.status;
        emailConfidence = resJson?.output?.confidence || (verdict.charge ? 0.95 : 0.5);

        const outputDomain = cleanDomain(
          resJson?.output?.domain ||
          resJson?.raw?.data?.domain ||
          resJson?.raw?.data?.company_domain ||
          (emailFound ? emailFound.split('@')[1] : '')
        );
        if (!resolvedDomain && outputDomain) {
          resolvedDomain = outputDomain;
        }
      }
    } catch (err: any) {
      console.warn('[leads] email find upstream warning:', err?.name || String(err?.message || '').slice(0, 200));
    }

    // 4. Settle with what Treg actually charged (usage flushed first).
    const providerCostUsd = usage.costSince(revealUsageStart, 'treg.people.email.find');
    if (emailFound) {
      await settleHold(
        hold.id,
        emailCharge,
        providerCostUsd,
        runKey,
        emailCharge > 0 ? `Revealed verified email (lead ${leadRef})` : `Unconfirmed email (lead ${leadRef}) - not charged`,
      );
    } else {
      await settleHold(hold.id, 0, providerCostUsd, runKey, `No email found (lead ${leadRef}) - refund`);
      return fail('No verified email found for this lead. Zero credits charged.', 404, { no_hit: true });
    }

    // 5. Saved merged onto the stored row: a blank or placeholder field no
    // longer overwrites what the row already had (audit M2).
    const leadRecord = mergeLeadRecord(existing, {
      user_id: userId,
      first_name: resolvedFirst,
      last_name: resolvedLast,
      full_name: resolvedName || `${resolvedFirst} ${resolvedLast}`.trim(),
      title: title && title !== 'Target Decision Maker' ? title : 'Executive',
      company_name:
        company_name && company_name !== 'Target Company'
          ? company_name
          : (resolvedDomain ? resolvedDomain.split('.')[0].toUpperCase() : 'Company'),
      company_domain: resolvedDomain,
      company_size: company_size || null,
      company_revenue: company_revenue || null,
      linkedin_url: linkedin_url || null,
      location: location || null,
      work_email: emailFound,
      email_status: emailStatus,
      email_confidence: emailConfidence,
      status: null,
      updated_at: new Date().toISOString(),
    });

    if (!leadRecord.full_name) {
      // full_name is NOT NULL, so an unidentifiable target cannot be persisted.
      return json({
        ok: true,
        lead: { ...leadRecord, full_name: 'Unknown contact', is_saved: false },
        credits_charged: emailCharge,
        persisted: false,
      });
    }

    const { data: savedLead, error: saveErr } = await admin
      .from('user_leads')
      .upsert(leadRecord, { onConflict: 'user_id,company_domain,full_name' })
      .select()
      .single();

    if (saveErr) {
      console.error('[leads] lead upsert error:', saveErr.message);
    }

    return json({
      ok: true,
      lead: savedLead || leadRecord,
      credits_charged: emailCharge,
      verified: emailCharge > 0,
      persisted: !saveErr,
    });
  }

  // =========================================================================
  // ACTION 3: BULK REVEAL EMAILS (Batch processing for 10, 50, 100 leads)
  // =========================================================================
  if (action === 'bulk-reveal-email') {
    const MAX_BULK = 100;
    const emailPrice = (await loadPrices(admin)).email;
    if (emailPrice === null) return pricingUnavailable();
    // Clamped first; a lead without a name cannot be looked up or saved.
    // Then deduped by (company_domain, full_name) BEFORE any lookup (audit
    // H5): duplicates used to be looked up and charged once each, and then the
    // batch upsert failed on them, so nothing was saved at all.
    const sanitized: any[] = (Array.isArray(body.leads) ? body.leads : [])
      .slice(0, 2000)
      .map(sanitizeLead)
      .filter((l: any) => l.full_name && (l.company_domain || l.linkedin_url));
    if (sanitized.length === 0) {
      return fail('No leads provided for bulk reveal');
    }
    const leadsToReveal = dedupeLeads(sanitized);

    const saved = indexExistingRows(await loadExistingRows(admin, userId, leadsToReveal));
    // Only a VERIFIED stored address is "already revealed" (audit M2).
    const alreadyRevealed = leadsToReveal.filter((l: any) => hasRevealedEmail(saved.find(l)));
    const neededLeads = leadsToReveal.filter((l: any) => !hasRevealedEmail(saved.find(l)));
    const existingRecords = alreadyRevealed.map((l: any) => saved.find(l));

    if (neededLeads.length === 0) {
      return json({
        ok: true,
        message: 'All selected leads were already revealed.',
        requested_count: 0,
        revealed_count: 0,
        credits_charged: 0,
        updated_records: existingRecords,
        existing_records: existingRecords,
      });
    }

    const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.bulkRevealBurst, RATE_LIMITS.bulkReveal]);
    if (limited) return limited;

    // One charge per UNIQUE lead. Deterministic key per (user, set of leads,
    // minute): a double-submitted batch in flight is refused, not charged twice.
    const batch = neededLeads.slice(0, MAX_BULK);
    const batchRefs = await Promise.all(batch.map((l: any) => shortHash(leadIdentity(l))));
    const batchRef = await shortHash([...batchRefs].sort().join(','));
    const baseKey = `bulk_reveal_email:${userId}:${batchRef}:${revealWindow()}`;
    const { hold, key: runKey } = await reserveOnce(admin, userId, batch.length * emailPrice, baseKey, {
      feature: 'bulk_lead_email_reveal',
      count: batch.length,
      batch_ref: batchRef,
    }, openHolds);

    if ('shortfall' in hold) return insufficientCredits(hold);
    if (hold.duplicate) {
      return fail('This batch is already being looked up. Please wait a moment.', 409, { duplicate_request: true });
    }

    let successfulReveals = 0;
    // Only verified addresses are charged; unconfirmed ones are returned free.
    let verifiedReveals = 0;
    const bulkUsageStart = usage.rows.length;
    const records: any[] = [];
    const chargedRows: { credits_charged: number }[] = [];
    // Leads the provider answered for but had no usable address.
    const notFoundKeys: string[] = [];
    // Lookups that errored or timed out, so the client can offer a retry.
    const failedKeys: string[] = [];
    // Leads not looked up because the hourly `leads.reveal` limit refused.
    const rateLimitedKeys: string[] = [];
    const bulkCost = () => usage.costSince(bulkUsageStart, 'treg.people.email.find', 'bulk-email');
    let closed = false;

    try {
      for (let i = 0; i < batch.length; i += 5) {
        await Promise.all(
          batch.slice(i, i + 5).map(async (lead: any, j: number) => {
            try {
              // Each lookup also takes a slot from the hourly `leads.reveal`
              // bucket, like a single reveal and auto-enrich, so bulk cannot
              // run thousands of lookups an hour outside the reveal limits.
              // Refused (or limiter down): not looked up, not charged, and
              // reported in rate_limited_keys so the client can retry later.
              if ((await takeRateLimit(admin, userId, RATE_LIMITS.reveal)) !== true) {
                rateLimitedKeys.push(...lead.client_keys);
                return;
              }
              const emailPayload: Record<string, string> = {};
              if (lead.company_domain) emailPayload.domain = lead.company_domain;
              if (lead.full_name) emailPayload.full_name = lead.full_name;
              if (lead.linkedin_url) emailPayload.linkedin_url = lead.linkedin_url;

              const tregRes = await fetch(`${TREG_BASE}/call/treg.people.email.find`, {
                method: 'POST',
                headers: tregHeaders(token, userId, 'bulk-email', MAX_COST.email, `echo:${baseKey}:${batchRefs[i + j]}`, {
                  'X-Treg-Route-Verify': 'true',
                }),
                body: JSON.stringify(emailPayload),
                signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
              });

              const bulkRow = usage.track('treg.people.email.find', tregRes, { feature: 'bulk-email' }, hold.id);
              if (!tregRes.ok) {
                failedKeys.push(...lead.client_keys);
                return;
              }
              const resJson = await tregRes.json();
              const rawEmail = resJson?.output?.email || resJson?.raw?.data?.email;
              const verdict = classifyEmail(resJson);
              const email = isEmailAddress(rawEmail) && verdict.usable ? rawEmail.trim() : null;
              if (!email) {
                notFoundKeys.push(...lead.client_keys);
                return;
              }
              if (verdict.charge) {
                verifiedReveals++;
                bulkRow.credits_charged = emailPrice;
                chargedRows.push(bulkRow);
              }
              successfulReveals++;
              // Same columns for every record (a bulk upsert nulls missing
              // ones); merged onto the stored row so blanks keep stored data.
              records.push(mergeLeadRecord(saved.find(lead), {
                user_id: userId,
                first_name: lead.first_name || lead.full_name.split(' ')[0] || '',
                last_name: lead.last_name || lead.full_name.split(' ').slice(1).join(' ') || '',
                full_name: lead.full_name,
                title: lead.title || 'Executive',
                company_name: lead.company_name || lead.company_domain.split('.')[0] || '',
                company_domain: lead.company_domain || '',
                company_size: lead.company_size || null,
                company_revenue: lead.company_revenue || null,
                linkedin_url: lead.linkedin_url || null,
                location: lead.location || null,
                work_email: email,
                email_status: verdict.status,
                email_confidence: verdict.charge ? 0.95 : 0.5,
                // The stored stage wins; 'new' only for a new row.
                status: null,
                updated_at: new Date().toISOString(),
              }));
            } catch (err: any) {
              failedKeys.push(...lead.client_keys);
              console.warn('[leads] bulk email item failed:', err?.name || err?.message);
            }
          }),
        );
      }

      let savedRows: any[] = [];
      if (records.length > 0) {
        const { data, error: saveErr } = await admin
          .from('user_leads')
          .upsert(records, { onConflict: 'user_id,company_domain,full_name' })
          .select();
        if (saveErr) {
          // Fail loudly (audit H5). Nothing was saved, so nothing is charged:
          // the hold is settled at 0 with the provider's real cost, and the
          // usage rows carry no credits for the reaper to bill.
          console.error('[leads] bulk reveal upsert failed:', saveErr.message);
          for (const row of chargedRows) row.credits_charged = 0;
          closed = true;
          await settleHold(hold.id, 0, bulkCost(), runKey, `Bulk email reveal not saved (${batch.length} leads) - not charged`);
          return fail('The contacts could not be saved. Zero credits charged; please try again.', 500, {
            save_failed: true,
            credits_charged: 0,
          });
        }
        savedRows = data || [];
      }

      closed = true;
      await settleHold(
        hold.id,
        verifiedReveals * emailPrice,
        bulkCost(),
        runKey,
        `Bulk revealed ${successfulReveals} emails, ${verifiedReveals} verified and charged (${batch.length - verifiedReveals} not charged)`,
      );

      return json({
        ok: true,
        requested_count: sanitized.length,
        unique_count: leadsToReveal.length,
        duplicate_count: sanitized.length - leadsToReveal.length,
        already_revealed_count: alreadyRevealed.length,
        processed_count: batch.length,
        capped_count: Math.max(0, neededLeads.length - batch.length),
        revealed_count: successfulReveals,
        verified_count: verifiedReveals,
        credits_charged: verifiedReveals * emailPrice,
        skipped_count: neededLeads.length - batch.length,
        // The saved rows, ids included, so the client can address them.
        updated_records: savedRows,
        existing_records: existingRecords,
        not_found_keys: notFoundKeys,
        failed_keys: failedKeys,
        rate_limited_keys: rateLimitedKeys,
        rate_limited_count: rateLimitedKeys.length,
        ...(rateLimitedKeys.length > 0
          ? { partial: true, message: RATE_LIMITS.reveal.message }
          : {}),
      });
    } finally {
      // An exception before the save: nothing saved, nothing charged.
      if (!closed) {
        for (const row of chargedRows) row.credits_charged = 0;
        await settleHold(hold.id, 0, bulkCost(), runKey, 'Bulk email reveal aborted - not charged');
      }
    }
  }

  // =========================================================================
  // ACTION 3b: BULK REVEAL PHONES (pricing_config `treg.people.phone.find`)
  // -------------------------------------------------------------------------
  // Same contract as bulk-reveal-email: deduped input, one hold for the
  // batch, only numbers actually found (and saved) are charged, and the
  // response says per lead whether it was found, not found, or failed.
  // =========================================================================
  if (action === 'bulk-reveal-phone') {
    const MAX_BULK_PHONE = 25;
    const phonePrice = (await loadPrices(admin)).phone;
    if (phonePrice === null) return pricingUnavailable();

    const sanitized: any[] = (Array.isArray(body.leads) ? body.leads : [])
      .slice(0, 2000)
      .map(sanitizeLead)
      .filter((l: any) => l.full_name && (l.company_domain || l.linkedin_url || l.email_hint));
    if (sanitized.length === 0) return fail('No leads provided for phone lookup');
    // Deduped before any lookup (audit H5).
    const requested = dedupeLeads(sanitized);

    // Includes the empty-domain (LinkedIn-only) rows: those used to be missed,
    // so their numbers were bought again on every run (audit M2).
    const saved = indexExistingRows(await loadExistingRows(admin, userId, requested));

    // A number already on file is never bought twice.
    const known = requested.filter((l: any) => saved.find(l)?.phone_number);
    const needed = requested.filter((l: any) => !saved.find(l)?.phone_number);
    const batch = needed.slice(0, MAX_BULK_PHONE);
    const existingRecords = known.map((l: any) => saved.find(l));

    if (batch.length === 0) {
      return json({
        ok: true,
        revealed_count: 0,
        credits_charged: 0,
        processed_count: 0,
        capped_count: 0,
        updated_records: [],
        existing_records: existingRecords,
        not_found_keys: [],
        failed_keys: [],
      });
    }

    const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.bulkRevealBurst, RATE_LIMITS.bulkReveal]);
    if (limited) return limited;

    const batchRefs = await Promise.all(batch.map((l: any) => shortHash(leadIdentity(l))));
    const batchRef = await shortHash([...batchRefs].sort().join(','));
    const baseKey = `bulk_reveal_phone:${userId}:${batchRef}:${revealWindow()}`;
    const { hold, key: runKey } = await reserveOnce(admin, userId, batch.length * phonePrice, baseKey, {
      feature: 'bulk_lead_phone_reveal',
      count: batch.length,
      batch_ref: batchRef,
    }, openHolds);
    if ('shortfall' in hold) return insufficientCredits(hold);
    if (hold.duplicate) {
      return fail('This batch is already being looked up. Please wait a moment.', 409, { duplicate_request: true });
    }

    const records: any[] = [];
    const chargedRows: { credits_charged: number }[] = [];
    const notFoundKeys: string[] = [];
    const failedKeys: string[] = [];
    // Leads not looked up because the hourly `leads.reveal` limit refused.
    const rateLimitedKeys: string[] = [];
    const phoneUsageStart = usage.rows.length;
    const phoneCost = () => usage.costSince(phoneUsageStart, 'treg.people.phone.find', 'bulk-phone');
    let closed = false;

    try {
      for (let i = 0; i < batch.length; i += 5) {
        await Promise.all(
          batch.slice(i, i + 5).map(async (lead: any, j: number) => {
            try {
              // Each lookup also takes a slot from the hourly `leads.reveal`
              // bucket, like a single reveal and auto-enrich, so bulk cannot
              // run thousands of lookups an hour outside the reveal limits.
              // Refused (or limiter down): not looked up, not charged, and
              // reported in rate_limited_keys so the client can retry later.
              if ((await takeRateLimit(admin, userId, RATE_LIMITS.reveal)) !== true) {
                rateLimitedKeys.push(...lead.client_keys);
                return;
              }
              const stored = saved.find(lead);
              const domain = lead.company_domain;
              // A lookup hint only; never written to the row (audit N13).
              const email = (hasUsableEmail(stored) ? stored.work_email : '') || lead.email_hint || '';
              const payload: Record<string, string> = { full_name: lead.full_name };
              if (lead.linkedin_url) payload.linkedin_url = lead.linkedin_url;
              if (email) payload.email = email;
              if (domain) payload.domain = domain;

              const res = await fetch(`${TREG_BASE}/call/treg.people.phone.find`, {
                method: 'POST',
                headers: tregHeaders(token, userId, 'bulk-phone', MAX_COST.phone, `echo:${baseKey}:${batchRefs[i + j]}`),
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
              });
              const phoneRow = usage.track('treg.people.phone.find', res, { feature: 'bulk-phone' }, hold.id);
              if (!res.ok) {
                failedKeys.push(...lead.client_keys);
                return;
              }
              const data = await res.json();
              const phone = data?.output?.phone || data?.raw?.data?.employee_phone || null;
              if (typeof phone !== 'string' || !phone.trim()) {
                notFoundKeys.push(...lead.client_keys);
                return;
              }
              phoneRow.credits_charged = phonePrice;
              chargedRows.push(phoneRow);
              records.push(mergeLeadRecord(stored, {
                user_id: userId,
                full_name: lead.full_name,
                first_name: lead.first_name || lead.full_name.split(' ')[0] || '',
                last_name: lead.last_name || lead.full_name.split(' ').slice(1).join(' ') || '',
                title: lead.title || 'Executive',
                company_name: lead.company_name || (domain ? domain.split('.')[0] : ''),
                company_domain: domain || '',
                linkedin_url: lead.linkedin_url || null,
                location: lead.location || null,
                phone_number: clampText(phone, 50),
                phone_type: clampText(data?.output?.line_type, 32) || 'mobile',
                status: null,
                updated_at: new Date().toISOString(),
              }));
            } catch (err: any) {
              failedKeys.push(...lead.client_keys);
              console.warn('[leads] bulk phone item failed:', err?.name || err?.message);
            }
          }),
        );
      }

      let savedRows: any[] = [];
      if (records.length > 0) {
        const { data, error: saveErr } = await admin
          .from('user_leads')
          .upsert(records, { onConflict: 'user_id,company_domain,full_name' })
          .select();
        if (saveErr) {
          // Fail loudly (audit H5): nothing saved, nothing charged.
          console.error('[leads] bulk phone upsert failed:', saveErr.message);
          for (const row of chargedRows) row.credits_charged = 0;
          closed = true;
          await settleHold(hold.id, 0, phoneCost(), runKey, `Bulk phone reveal not saved (${batch.length} leads) - not charged`);
          return fail('The numbers could not be saved. Zero credits charged; please try again.', 500, {
            save_failed: true,
            credits_charged: 0,
          });
        }
        savedRows = data || [];
      }

      closed = true;
      await settleHold(
        hold.id,
        records.length * phonePrice,
        phoneCost(),
        runKey,
        `Bulk revealed ${records.length} phones (${batch.length - records.length} not charged)`,
      );

      return json({
        ok: true,
        revealed_count: records.length,
        credits_charged: records.length * phonePrice,
        processed_count: batch.length,
        capped_count: Math.max(0, needed.length - batch.length),
        duplicate_count: sanitized.length - requested.length,
        updated_records: savedRows,
        existing_records: existingRecords,
        not_found_keys: notFoundKeys,
        failed_keys: failedKeys,
        rate_limited_keys: rateLimitedKeys,
        rate_limited_count: rateLimitedKeys.length,
        ...(rateLimitedKeys.length > 0
          ? { partial: true, message: RATE_LIMITS.reveal.message }
          : {}),
      });
    } finally {
      if (!closed) {
        for (const row of chargedRows) row.credits_charged = 0;
        await settleHold(hold.id, 0, phoneCost(), runKey, 'Bulk phone reveal aborted - not charged');
      }
    }
  }

  // =========================================================================
  // ACTION 4: REVEAL PHONE (single; pricing_config `treg.people.phone.find`)
  // =========================================================================
  if (action === 'reveal-phone') {
    // Every field clamped; a non-linkedin.com profile URL is dropped.
    const input = sanitizeLead(body);
    const { full_name, first_name, last_name, company_domain, linkedin_url } = input;
    // The client's address is a lookup / matching hint only. It is never
    // written to the row: verification fields are server-owned (audit N13).
    const work_email = safeEmail(body.work_email) || '';

    if (!linkedin_url && !company_domain && !work_email) {
      return fail('LinkedIn URL, email, or company domain is required.');
    }
    const phonePrice = (await loadPrices(admin)).phone;
    if (phonePrice === null) return pricingUnavailable();

    let finalDomain = company_domain;
    if (!finalDomain && work_email && work_email.includes('@')) {
      finalDomain = cleanDomain(work_email.split('@')[1]);
    }
    const derived = !full_name && linkedin_url ? nameFromLinkedinSlug(linkedin_url) : null;
    const resolvedName = clampText(full_name || derived?.full_name || '');

    const existing = await findExistingLead(admin, userId, { companyDomain: finalDomain, fullName: resolvedName, linkedinUrl: linkedin_url, workEmail: work_email });

    if (existing?.phone_number) {
      return json({
        ok: true,
        already_revealed: true,
        lead: existing,
        credits_charged: 0,
      });
    }

    const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.revealBurst, RATE_LIMITS.reveal]);
    if (limited) return limited;

    const leadRef = await shortHash(
      leadIdentity({ company_domain: finalDomain, full_name: resolvedName, linkedin_url, work_email }),
    );
    const baseKey = `reveal_phone:${userId}:${leadRef}:${revealWindow()}`;
    const { hold, key: runKey } = await reserveOnce(admin, userId, phonePrice, baseKey, {
      feature: 'lead_phone_reveal',
      lead_ref: leadRef,
    }, openHolds);

    if ('shortfall' in hold) return insufficientCredits(hold);
    if (hold.duplicate) {
      return fail('This contact is already being looked up. Please wait a moment.', 409, { duplicate_request: true });
    }

    let phoneFound: string | null = null;
    let phoneType = 'mobile';
    const phoneUsageStart = usage.rows.length;

    try {
      const phonePayload: Record<string, string> = {};
      if (linkedin_url) phonePayload.linkedin_url = linkedin_url;
      const hintEmail = (hasUsableEmail(existing) ? existing.work_email : '') || work_email;
      if (hintEmail) phonePayload.email = hintEmail;
      if (finalDomain) phonePayload.domain = finalDomain;
      if (resolvedName) phonePayload.full_name = resolvedName;

      const tregRes = await fetch(`${TREG_BASE}/call/treg.people.phone.find`, {
        method: 'POST',
        headers: tregHeaders(token, userId, 'lead-phone', MAX_COST.phone, `echo:${baseKey}`),
        body: JSON.stringify(phonePayload),
        signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      });

      const singlePhoneRow = usage.track('treg.people.phone.find', tregRes, { feature: 'lead-phone' }, hold.id);

      if (tregRes.ok) {
        const resJson = await tregRes.json();
        phoneFound = clampText(resJson?.output?.phone || resJson?.raw?.data?.employee_phone, 50) || null;
        phoneType = clampText(resJson?.output?.line_type, 32) || 'mobile';
        if (phoneFound) singlePhoneRow.credits_charged = phonePrice;
      }
    } catch (err: any) {
      console.warn('[leads] phone find error:', err?.name || String(err?.message || '').slice(0, 200));
    }

    // Settled with Treg's actual charge for the lookup, hit or miss.
    const providerCostUsd = usage.costSince(phoneUsageStart, 'treg.people.phone.find');
    if (phoneFound) {
      await settleHold(hold.id, phonePrice, providerCostUsd, runKey, `Revealed phone (lead ${leadRef})`);
    } else {
      await settleHold(hold.id, 0, providerCostUsd, runKey, `No phone found (lead ${leadRef}) - refund`);
      return fail('No direct mobile number found for this lead. Zero credits charged.', 404, { no_hit: true });
    }

    const updatePayload = {
      phone_number: phoneFound,
      phone_type: phoneType,
      updated_at: new Date().toISOString(),
    };

    let updatedLead = existing;

    if (existing?.id) {
      const { data, error } = await admin
        .from('user_leads')
        .update(updatePayload)
        .eq('id', existing.id)
        .eq('user_id', userId)
        .select()
        .maybeSingle();
      if (error) console.warn('[leads] phone update failed:', error.message);
      updatedLead = data || existing;
    } else if (resolvedName) {
      // The credits are already settled, so the number has to land somewhere
      // durable.
      const { data, error } = await admin
        .from('user_leads')
        .upsert(
          mergeLeadRecord(null, {
            user_id: userId,
            first_name: first_name || derived?.first_name || resolvedName.split(' ')[0] || '',
            last_name: last_name || derived?.last_name || resolvedName.split(' ').slice(1).join(' ') || '',
            full_name: resolvedName,
            title: input.title || 'Executive',
            company_name: input.company_name || (finalDomain ? finalDomain.split('.')[0].toUpperCase() : ''),
            company_domain: finalDomain || '',
            linkedin_url: linkedin_url || null,
            location: input.location || null,
            status: null,
            ...updatePayload,
          }),
          { onConflict: 'user_id,company_domain,full_name' }
        )
        .select()
        .maybeSingle();
      if (error) {
        console.error('[leads] phone persist failed:', error.message);
      } else {
        updatedLead = data;
      }
    }

    return json({
      ok: true,
      lead: updatedLead || { ...input, client_key: undefined, email_hint: undefined, full_name: resolvedName, ...updatePayload },
      credits_charged: phonePrice,
    });
  }

  // =========================================================================
  // ACTION 5: BULK SAVE LEADS (Bookmarks)
  // =========================================================================
  if (action === 'bulk-save') {
    const rawLeads: any[] = Array.isArray(body.leads) ? body.leads : [];
    if (rawLeads.length === 0) return fail('No leads provided');
    // user_leads is written only by this function, so this is the one place a
    // client's payload size and field contents are bounded.
    if (rawLeads.length > MAX_BULK_SAVE) {
      return fail(`At most ${MAX_BULK_SAVE} leads can be saved at once. Please save them in smaller batches.`, 400, {
        max_leads: MAX_BULK_SAVE,
      });
    }
    const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.bulkSave]);
    if (limited) return limited;
    // Clamped; invalid statuses become null (so the saved or default stage is
    // kept) and non-linkedin.com profile URLs are dropped. full_name is NOT
    // NULL and half the conflict key, so a lead without one cannot be saved.
    // Deduped by (domain, name): Postgres rejects an upsert that touches the
    // same conflict key twice.
    const leadsToSave = rawLeads.map(sanitizeLead);
    const unique = dedupeLeads(leadsToSave.filter((l) => l.full_name));
    if (unique.length === 0) return fail('No savable leads provided');

    // Stored rows, so a re-save keeps the stored stage and fields.
    const saved = indexExistingRows(await loadExistingRows(admin, userId, unique));

    // Verification and contact fields (work_email, email_status,
    // email_confidence, phone_number, phone_type) are server-owned (audit N13)
    // and deliberately absent: the client used to be able to save its own
    // `email_status: 'valid'`. An upsert leaves them as stored; a new row gets
    // them only from a reveal.
    const records = unique.map((l: any) =>
      mergeLeadRecord(saved.find(l), {
        user_id: userId,
        first_name: l.first_name || l.full_name.split(' ')[0] || '',
        last_name: l.last_name || l.full_name.split(' ').slice(1).join(' ') || '',
        full_name: l.full_name,
        title: l.title || 'Executive',
        company_name: l.company_name || l.company_domain.split('.')[0] || '',
        company_domain: l.company_domain || '',
        company_size: l.company_size,
        company_revenue: l.company_revenue,
        company_phone: l.company_phone,
        linkedin_url: l.linkedin_url,
        location: l.location,
        // An explicit, valid stage from the client wins; otherwise the stored one.
        status: l.status || null,
        updated_at: new Date().toISOString(),
      }),
    );
    // Merging onto stored rows can map two inputs to one stored key.
    const uniqueRecords = [...new Map(records.map((r) => [`${r.company_domain}::${r.full_name}`, r])).values()];

    const { data, error } = await admin
      .from('user_leads')
      .upsert(uniqueRecords, { onConflict: 'user_id,company_domain,full_name' })
      .select();

    if (error) {
      console.error('[leads] bulk save failed:', error.message);
      return fail('Failed to save leads', 500);
    }
    // How many were already in the pipeline, so the client can say "3 added,
    // 2 already saved" instead of claiming every row was newly saved.
    const alreadySaved = unique.filter((l: any) => saved.find(l)).length;
    return json({
      ok: true,
      saved_count: data?.length || 0,
      new_count: Math.max(0, (data?.length || 0) - alreadySaved),
      already_saved_count: alreadySaved,
      skipped_count: leadsToSave.length - unique.length,
      leads: data,
    });
  }

  // =========================================================================
  // ACTION 6: LIST SAVED LEADS
  // =========================================================================
  if (action === 'list-saved') {
    const status = body.status;
    const query = String(body.query || '').trim();

    let q = admin
      .from('user_leads')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      q = q.eq('status', status);
    }
    if (query) {
      // PostgREST .or() takes a filter string, so its own metacharacters have
      // to go: a comma or parenthesis in the search box would otherwise close
      // the pattern and start a new condition. The letters and digits are all
      // a name search actually needs.
      const safe = query.replace(/[^a-z0-9 ._@'-]/gi, '').slice(0, 80);
      if (safe) {
        q = q.or(
          `full_name.ilike.%${safe}%,company_name.ilike.%${safe}%,company_domain.ilike.%${safe}%,work_email.ilike.%${safe}%`
        );
      }
    }

    // A single PostgREST response is capped, so one .limit() call quietly kept
    // only the newest slice of the pipeline. With searches now reaching 1000
    // leads that slice is half the pipeline. Page through the result set
    // instead, with a ceiling high enough to hold a full large search.
    const PAGE_SIZE = 500;
    const MAX_SAVED_LEADS = 2000;
    const savedLeads: any[] = [];

    for (let from = 0; from < MAX_SAVED_LEADS; from += PAGE_SIZE) {
      const to = Math.min(from + PAGE_SIZE, MAX_SAVED_LEADS) - 1;
      const { data, error } = await q.range(from, to);
      if (error) {
        return fail('Failed to fetch saved leads', 500);
      }
      if (data && data.length > 0) savedLeads.push(...data);
      if (!data || data.length < PAGE_SIZE) break;
    }

    // Rows saved before preview addresses were kept apart can still carry one
    // (or a placeholder such as "N/A") in work_email. Hand those back as the
    // unverified preview they are, so no view presents them as revealed.
    const cleaned = savedLeads.map((row) =>
      row.work_email && !hasUsableEmail(row)
        ? {
            ...row,
            preview_email: isEmailAddress(row.work_email) ? row.work_email : null,
            work_email: null,
            email_status: null,
          }
        : row,
    );

    return json({ ok: true, leads: cleaned, limit_reached: cleaned.length >= MAX_SAVED_LEADS });
  }

  // =========================================================================
  // ACTION 7: UPDATE STATUS / NOTES
  // =========================================================================
  if (action === 'update-status') {
    const { lead_id, status, notes } = body;
    const input = sanitizeLead(body);
    const company_domain = input.company_domain;
    const full_name = input.full_name;

    if (!lead_id && !(company_domain && full_name)) {
      return fail('lead_id or company_domain + full_name is required', 400);
    }
    if (status && !isAllowedStatus(status)) {
      return fail(`Invalid status. Expected one of: ${ALLOWED_STATUS.join(', ')}`, 400);
    }
    // Matches the table's CHECK, so a bad value is a clear 400 rather than a
    // generic 500 from the constraint. null clears the notes.
    if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > MAX_NOTES)) {
      return fail(`Notes must be text of at most ${MAX_NOTES} characters.`, 400);
    }

    const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
    if (status) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;

    let query = admin.from('user_leads').select('*').eq('user_id', userId);
    if (isUuid(lead_id)) {
      query = query.eq('id', lead_id);
    } else {
      query = query.eq('company_domain', company_domain).ilike('full_name', escapeLike(full_name));
    }

    const { data: matched, error: lookupError } = await query.limit(1);
    if (lookupError) return fail('Failed to look up lead', 500);

    // If lead is not yet saved in user_leads, auto-save it with the requested status!
    if (!matched || matched.length === 0) {
      const resolvedName = full_name;
      if (!resolvedName) {
        return fail('Lead not found in your pipeline. Save it first.', 404);
      }
      const first = input.first_name || resolvedName.split(' ')[0] || '';
      const last = input.last_name || resolvedName.split(' ').slice(1).join(' ') || '';
      // Contact and verification fields are server-owned (audit N13): the
      // client's work_email / phone_number are not written here.
      const { data: inserted, error: insertError } = await admin
        .from('user_leads')
        .upsert(
          {
            user_id: userId,
            first_name: first,
            last_name: last,
            full_name: resolvedName,
            title: input.title || 'Executive',
            company_name: input.company_name || company_domain.split('.')[0] || '',
            company_domain: company_domain || '',
            linkedin_url: input.linkedin_url,
            location: input.location,
            status: status || 'new',
            notes: notes || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,company_domain,full_name' }
        )
        .select()
        .maybeSingle();

      if (insertError) {
        console.error('[leads] auto-save on status update failed:', insertError.message);
        return fail('Failed to save lead to pipeline', 500);
      }
      return json({ ok: true, lead: inserted, auto_saved: true });
    }

    const { data, error } = await admin
      .from('user_leads')
      .update(updateData)
      .eq('id', matched[0].id)
      .eq('user_id', userId)
      .select()
      .maybeSingle();

    if (error) return fail('Failed to update lead status', 500);
    return json({ ok: true, lead: data });
  }

  // =========================================================================
  // ACTION 8: DELETE SAVED LEAD(S)
  // =========================================================================
  if (action === 'delete-saved') {
    const { lead_id, lead_ids } = body;
    const company_domain = cleanDomain(typeof body.company_domain === 'string' ? body.company_domain : '');
    const full_name = clampText(body.full_name);
    const idsToDelete: string[] = [];
    if (isUuid(lead_id)) idsToDelete.push(lead_id);
    if (Array.isArray(lead_ids)) {
      // Bounded so one request cannot send an unbounded IN list.
      lead_ids.slice(0, 2000).forEach((id: unknown) => {
        if (typeof id === 'string' && isUuid(id)) idsToDelete.push(id);
      });
    }

    if (idsToDelete.length > 0) {
      // .select() returns the rows that were actually removed. Reporting the
      // requested ids made deleting an already-gone row look successful.
      const { data: deleted, error } = await admin
        .from('user_leads')
        .delete()
        .in('id', idsToDelete)
        .eq('user_id', userId)
        .select('id');

      if (error) return fail('Failed to delete lead(s)', 500);
      return json({ ok: true, deleted_count: deleted?.length ?? 0 });
    }

    // Both halves are required. Either one alone was a wildcard: a name-only
    // delete removed every "John Smith" across companies, and a domain-only
    // (or empty-domain) delete removed a whole company's contacts or every
    // LinkedIn-only lead. Those rows must be deleted by id.
    if (company_domain && full_name) {
      const { data: deleted, error } = await admin
        .from('user_leads')
        .delete()
        .eq('user_id', userId)
        .eq('company_domain', company_domain)
        .ilike('full_name', escapeLike(full_name))
        .select('id');
      if (error) return fail('Failed to delete lead', 500);
      return json({ ok: true, deleted_count: deleted?.length ?? 0 });
    }

    return fail('lead_id, lead_ids, or both company_domain and full_name are required for deletion', 400);
  }

  return fail(`Unknown action: ${String(action).slice(0, 50)}`);
  }
}
