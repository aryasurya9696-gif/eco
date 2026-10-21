// ============================================================================
// Supabase Edge Function: daily-sweep
// ----------------------------------------------------------------------------
// Scheduled fan-out sweep across every user with active keywords.
//
// Uses the same treg provider chains as `social-search`, inlined rather than
// imported — see the note below.
//
// SECURITY: runs with the service role key and spends real money on API
// credits, so it is NOT publicly invokable. Callers must present the
// SWEEP_CRON_SECRET in the x-sweep-secret header (pg_net / dashboard schedule /
// your own cron). A ?secret= query parameter is no longer accepted: URLs end up
// in access logs, proxies and pg_net's request table.
//
// NOTE: helpers are copied from social-search rather than imported across
// functions. Pure rules (schedule, run claims, time budget, billing, Reddit
// fallback) live in ./sweep-rules.ts inside this function's own folder, so they
// bundle with it and are unit tested by sweep-rules_test.ts.
//
// Runs are chunked (M3). The hourly cron tick is chunk 0 of that hour's "slot".
// Each chunk atomically claims a sweep_runs row keyed by (slot, chunk), sweeps
// due users in id order until its time budget is spent, then hands the rest to
// chunk n+1 by calling itself with { slot, chunk, after }. A duplicate tick or
// hop finds the row already claimed and does nothing, and per-user reservation
// keys are per slot, so a workspace is charged at most once per due hour.
//
// Deploy:  supabase functions deploy daily-sweep --no-verify-jwt
// Secrets: supabase secrets set SWEEP_CRON_SECRET=<long random string>
//          supabase secrets set TREG_TOKEN=treg_...
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  CALL_TIMEOUT_MS,
  canStartBatch,
  claimIdFor,
  creditsFor,
  filterDue,
  FREE_OPERATIONS,
  groupKeywords,
  isOperationAvailable,
  KEYWORD_CONCURRENCY,
  MAX_CHUNKS_PER_SLOT,
  parseChunkRequest,
  roundCredits,
  shouldTryRedditFallback,
  slotHour,
  USER_CONCURRENCY,
} from './sweep-rules.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * Gate value for the cron caller. The edge secret wins; otherwise it is read
 * from public.service_secrets alongside the provider token, so a pg_cron job
 * can be wired up without first provisioning a Supabase edge secret.
 */
let SWEEP_CRON_SECRET = Deno.env.get('SWEEP_CRON_SECRET') || '';

/** Anything shorter is guessable enough that we would rather not run at all. */
const MIN_CRON_SECRET_LENGTH = 32;

const encoder = new TextEncoder();

/**
 * Constant-time string comparison (same approach as billing-webhook). A plain
 * !== returns at the first differing byte, which leaks how much of a guess was
 * right through response timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;

  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Resolves the cron secret once per isolate: the edge secret, else the single
 * sweep_cron_secret row. Only that row is read; the old query pulled every
 * service secret into memory just to find one.
 */
async function resolveCronSecret(admin: ReturnType<typeof createClient>): Promise<string> {
  if (SWEEP_CRON_SECRET) return SWEEP_CRON_SECRET;
  const { data, error } = await admin
    .from('service_secrets')
    .select('value')
    .eq('name', 'sweep_cron_secret')
    .maybeSingle();
  if (error) {
    console.error('[sweep] cron secret lookup failed:', error.message);
    return '';
  }
  SWEEP_CRON_SECRET = typeof data?.value === 'string' ? data.value : '';
  return SWEEP_CRON_SECRET;
}

/** Provider token, read only after the caller has authenticated. */
async function resolveTregToken(admin: ReturnType<typeof createClient>): Promise<string> {
  if (tregToken) return tregToken;
  const { data, error } = await admin
    .from('service_secrets')
    .select('value')
    .eq('name', 'treg_token')
    .maybeSingle();
  if (error) {
    console.error('[sweep] treg token lookup failed:', error.message);
    return '';
  }
  tregToken = typeof data?.value === 'string' ? data.value : '';
  return tregToken;
}

const TREG_BASE = 'https://treg.to';
/** Per-call cost ceiling sent as X-Treg-Route-Max-Cost; matches social-search. */
const ROUTE_MAX_COST_USD = '0.01';

/**
 * Due users one chunk considers. The time budget normally stops a chunk well
 * before this; anything left goes to the next chunk, not to the next day.
 */
const MAX_USERS_PER_CHUNK = 500;
/** Page size for the profile and keyword reads. */
const PAGE_SIZE = 1000;
/** User ids per keyword lookup (keeps the `in.(...)` filter short). */
const KEYWORD_LOOKUP_BATCH = 100;

type Platform = 'twitter' | 'reddit' | 'google' | 'news';

/**
 * The product's channel limit. It mirrors public.keyword_limit() and
 * public.channel_limit().
 */
const MAX_CHANNELS = 3;

// cadenceHoursOf / sweepHourOf / isSweepDue / DEFAULT_SWEEP_HOUR_UTC live in
// ./sweep-rules.ts.

type PostRow = {
  user_id: string;
  keyword_id: string;
  matched_keyword: string;
  platform: Platform;
  channel_source: string;
  post_url: string;
  author_name: string | null;
  author_handle: string | null;
  author_avatar_url: string | null;
  body: string | null;
  posted_at: string | null;
  intent_score: number;
  status: 'new';
  engagement: Record<string, number | null> | null;
};

// ---------------------------------------------------------------------------
// Credentials — edge secret first, then public.service_secrets (service-role
// only; that table has RLS on and zero policies so the browser cannot read it)
// ---------------------------------------------------------------------------

let tregToken = Deno.env.get('TREG_TOKEN') || '';

// ---------------------------------------------------------------------------
// Intent scoring (mirrors social-search)
// ---------------------------------------------------------------------------

const HIGH_INTENT_PHRASES = [
  'looking for', 'recommend', 'recommendation', 'alternative to', 'switching from',
  'anyone using', 'best tool for', 'best software for', 'pricing', 'how much does',
  'budget', 'quote', 'need software', 'any suggestions', 'help choosing', 'rfp',
  'demo', 'trial', 'contract', 'enterprise plan', 'migration',
];

const MEDIUM_INTENT_PHRASES = [
  'tool', 'software', 'automation', 'platform', 'integration', 'workflow',
  'alternative', 'vs', 'versus',
];

const NEGATIVE_PHRASES = [
  'hiring', 'job opening', 'we are looking for candidates', 'free template',
  'looking to buy followers', 'crypto giveaway',
];

function calculateIntentScore(text: string): number {
  if (!text) return 30;
  const lower = text.toLowerCase();

  let score = 30;
  for (const p of HIGH_INTENT_PHRASES) if (lower.includes(p)) score += 9;
  for (const p of MEDIUM_INTENT_PHRASES) if (lower.includes(p)) score += 3;
  for (const p of NEGATIVE_PHRASES) if (lower.includes(p)) score -= 40;

  return Math.max(0, Math.min(97, Math.round(score)));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseWhen(value: unknown): string | null {
  if (value == null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof value !== 'string' || !value.trim()) return null;
  const s = value.trim();

  const rel = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(s);
  if (rel) {
    const ms: Record<string, number> = {
      minute: 60e3, hour: 36e5, day: 864e5,
      week: 6048e5, month: 2629746e3, year: 31556952e3,
    };
    return new Date(Date.now() - Number(rel[1]) * ms[rel[2].toLowerCase()]).toISOString();
  }
  if (/^today$/i.test(s)) return new Date().toISOString();
  if (/^yesterday$/i.test(s)) return new Date(Date.now() - 864e5).toISOString();

  const named = /^([a-z]{3,9})\.?\s+(\d{1,2})?,?\s*(\d{4})$/i.exec(s);
  if (named) {
    const mo = MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (mo !== undefined) {
      return new Date(Date.UTC(Number(named[3]), mo, named[2] ? Number(named[2]) : 1)).toISOString();
    }
  }

  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Google snippets open with a date and an em dash — "Aug 11, 2026 — Top SaaS
 * analytics software". That endpoint returns no date field, so this is the
 * only signal available.
 */
function dateFromSnippet(snippet: string | null | undefined): string | null {
  if (!snippet) return null;
  const m = /^\s*((?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})|(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})|(?:[A-Za-z]{3,9}\.?\s+\d{4}))\s*[—–\-|·]/.exec(snippet);
  return m ? parseWhen(m[1]) : null;
}

function redditTimeframe(lookbackHours: number): string {
  if (lookbackHours <= 24) return 'day';
  if (lookbackHours <= 72) return 'week';
  if (lookbackHours <= 168) return 'month';
  return 'year';
}

function sinceDate(lookbackHours: number): string {
  return new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Platform -> pricing operation
//
// One logical operation per channel, and the charge hangs off that rather than
// off the provider call. Reddit is why: its primary and its fallback are both
// billed calls, so pricing per call would make the same keyword cost two
// credits on one sweep and four the next depending on which provider happened to
// be up. The customer pays for the search, not for the retry.
// ---------------------------------------------------------------------------
const OPERATION_OF: Record<Platform, string> = {
  twitter: 'treg.twitter.search',
  reddit: 'treg.reddit.search',
  google: 'treg.web.search',
  news: 'treg.news.search',
};

// ---------------------------------------------------------------------------
// treg transport — measured cost
// ---------------------------------------------------------------------------
//
// treg reports what it actually charged on every call:
//
//   x-treg-cost-micro        integer micro-USD. 1000 means $0.001.
//   x-treg-call-id           join key for GET /calls/{id}
//   x-treg-upstream-failed   present when the upstream provider failed
//   x-treg-idempotent-replay a replayed call, already stored, charged 0
//   x-treg-cache             "hit" means the repeat rate, 10% from the 2nd call
//
// That header is why this replaces a hardcoded rate card. The old table guessed
// what a call cost; if treg's price moved, or a fallback fired, or the endpoint
// was metered per_result instead of per_call, the reported spend was fiction.
// Reading the charge means the profit figures are measured.
//
// The classification below is built on that rather than on a table of status
// codes. A response that reports a non-zero charge was billed whatever its
// status; one that reports zero was not. That is the provider telling us the
// answer directly, instead of us inferring it from the shape of the error.

/** Whether treg charged for this call, as reported by the provider itself. */
type Billable = 'billed' | 'free' | 'uncertain';

interface TregResult {
  /** True when treg reported a non-zero charge. */
  billable: Billable;
  data: any | null;
  costMicro: number;
  callId: string | null;
  status: number | null;
  /** True when the upstream failed but treg still billed us for the attempt. */
  upstreamFailed: boolean;
  /** A replayed call: the answer came from treg's store and cost nothing. */
  replay: boolean;
  /** Seconds treg spent queueing before dispatch, when it reports it. */
  queueWaitMs: number | null;
  errorCode: string | null;
}

function emptyResult(over: Partial<TregResult> = {}): TregResult {
  return {
    billable: 'free', data: null, costMicro: 0, callId: null, status: null,
    upstreamFailed: false, replay: false, queueWaitMs: null, errorCode: null,
    ...over,
  };
}

/**
 * Calls one catalogued endpoint and reports what it cost.
 *
 * Never throws. A provider that fails hands back a result carrying an outcome
 * rather than an exception, because the difference between "free" and "we might
 * still be charged" is what decides whether the customer is billed, and losing
 * that distinction in a thrown error is how a refund gets issued for money that
 * was already spent.
 *
 * idempotencyKey makes the call safe to retry: treg returns the stored answer
 * and charges 0 for a replay, so a network blip does not become a double charge.
 */
async function tregCall(
  endpointId: string,
  opts: {
    method?: 'GET' | 'POST';
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
    /** Tagged onto the call in treg's own ledger for per-customer attribution. */
    customerId?: string;
    /** This request's counters; never shared with a concurrent run. */
    stats: RunStats;
  },
): Promise<TregResult> {
  if (!tregToken) return emptyResult();

  const url = new URL(`${TREG_BASE}/call/${endpointId}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const method = opts.method ?? 'GET';
  const controller = new AbortController();
  // treg queues before dispatch and reported a ~2s wait in practice, so the
  // default sits comfortably above that. Cutting it close turns a slow provider
  // into an uncertain charge, which is the expensive kind of wrong.
  // Shorter than social-search's 45 s so a chunk's worst case fits the edge
  // function's wall clock (see CALL_TIMEOUT_MS / canStartBatch).
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CALL_TIMEOUT_MS);
  opts.stats.callsMade++;

  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        'X-Treg-Token': tregToken,
        Accept: 'application/json',
        // Hard per-call ceiling (README: every call carries one). Over it, treg
        // answers 402 and charges nothing.
        'X-Treg-Route-Max-Cost': ROUTE_MAX_COST_USD,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
        ...(opts.customerId ? { 'X-Treg-Meta': `customer=${opts.customerId}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    const callId = res.headers.get('x-treg-call-id');
    const costMicro = Number(res.headers.get('x-treg-cost-micro') ?? '0') || 0;
    const upstreamFailed = res.headers.has('x-treg-upstream-failed');
    const replay = res.headers.get('x-treg-idempotent-replay') === 'true';
    const smoothed = res.headers.get('x-treg-smoothed');
    const queueWaitMs = smoothed
      ? Number((/wait=(\d+)/.exec(smoothed)?.[1] ?? '0')) || null
      : null;

    // The charge is whatever treg says it is. Zero means free, whatever the
    // status was.
    const billable: Billable = costMicro > 0 ? 'billed' : 'free';
    opts.stats.usdSpent += costMicro / 1e6;

    if (!res.ok) {
      // 409 and 410 mean treg still holds the call: 409 is it running, 410 is
      // charged with the answer lost. Both are the one case where we cannot say
      // what happened, and guessing wrong in the customer's favour means giving
      // away a call we paid for.
      const uncertain = res.status === 409 || res.status === 410;
      console.warn(`[treg] ${endpointId} -> ${res.status}${uncertain ? ' (uncertain)' : ''}`);
      return emptyResult({
        billable: uncertain ? 'uncertain' : billable,
        costMicro,
        callId,
        status: res.status,
        upstreamFailed,
        replay,
        queueWaitMs,
        errorCode: `http_${res.status}`,
      });
    }

    return {
      billable,
      data: await res.json(),
      costMicro,
      callId,
      status: res.status,
      upstreamFailed,
      replay,
      queueWaitMs,
      errorCode: null,
    };
  } catch (err) {
    // An abort means we stopped waiting, not that treg stopped working. It may
    // well have completed and charged. Treated as uncertain, never as free.
    const aborted = (err as Error)?.name === 'AbortError';
    console.warn(`[treg] ${endpointId} threw:`, (err as Error)?.name);
    return emptyResult({
      billable: 'uncertain',
      errorCode: aborted ? 'timeout' : 'network_error',
    });
  } finally {
    clearTimeout(timer);
  }
}



/**
 * Refuse to start once the wallet cannot cover a plausible run. A dry account
 * otherwise spends an hour of scheduled sweeps collecting 503s, and the failure
 * looks like a provider outage rather than an empty balance.
 */
const MIN_TREG_BALANCE_USD = 0.50;

async function tregBalanceUsd(): Promise<number | null> {
  if (!tregToken) return null;
  try {
    const res = await fetch(`${TREG_BASE}/billing`, {
      headers: { 'X-Treg-Token': tregToken, Accept: 'application/json' },
      // A pre-flight check must not be what hangs the run; on timeout the
      // balance is simply unknown (see catch).
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.balance_usd === 'number' ? body.balance_usd : null;
  } catch {
    return null; // unknown balance is not a reason to stop working
  }
}

/**
 * Per-request counters. These used to be module-level `let`s, so two runs in
 * the same isolate reset and added to each other's figures.
 */
interface RunStats {
  usdSpent: number;
  /** Provider calls actually issued, for the spend ledger. */
  callsMade: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * A URL that came from an external provider is only kept if it is http or https
 * (copied from social-search). Without it a provider returning `javascript:...`
 * becomes a clickable link, or an <img src>, in the feed. Returns null for
 * anything rejected so the mapper drops the row (or the avatar).
 */
function safePostUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Credentials in a URL are a phishing lure at best.
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function row(input: Omit<PostRow, 'status'>): PostRow {
  return { ...input, status: 'new' };
}

function mapTwitter(t: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = safePostUrl(t?.url) ?? (t?.id ? safePostUrl(`https://x.com/i/status/${t.id}`) : null);
  if (!postUrl) return null;
  const handle = t?.authorUsername ? `@${String(t.authorUsername).replace(/^@/, '')}` : null;
  const body = t?.text ?? null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'twitter',
    channel_source: 'X / Twitter', post_url: postUrl,
    author_name: t?.authorName ?? null, author_handle: handle,
    author_avatar_url: safePostUrl(t?.authorImage), body,
    posted_at: parseWhen(t?.createdUtc ?? t?.createdAt),
    intent_score: calculateIntentScore(body || ''),
    engagement: {
      likes: t?.likeCount ?? null, retweets: t?.retweetCount ?? null,
      replies: t?.replyCount ?? null, quotes: t?.quoteCount ?? null,
      views: t?.viewCount ?? null, author_followers: t?.authorFollowers ?? null,
    },
  });
}

function mapRedditScrapecreators(p: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = safePostUrl(p?.url) ?? (p?.permalink ? safePostUrl(`https://www.reddit.com${p.permalink}`) : null);
  if (!postUrl) return null;
  const body = `${p?.title || ''} ${p?.selftext || ''}`.trim() || null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'reddit',
    channel_source: p?.subreddit ? `r/${p.subreddit}` : 'r/reddit', post_url: postUrl,
    author_name: p?.author ? `u/${p.author}` : 'u/anonymous',
    author_handle: p?.author ? `@${p.author}` : null, author_avatar_url: null, body,
    posted_at: parseWhen(p?.created_at_iso ?? p?.created_utc ?? p?.created),
    intent_score: calculateIntentScore(body || ''),
    engagement: {
      likes: p?.score ?? p?.ups ?? null, comments: p?.num_comments ?? null,
      upvotes: p?.ups ?? null, upvote_ratio: p?.upvote_ratio ?? null,
      subreddit_members: p?.subreddit_subscribers ?? null,
    },
  });
}

function mapRedditTikhub(p: any, userId: string, kwId: string, kw: string): PostRow | null {
  const d = p?.data ?? p;
  const raw = d?.url ?? d?.permalink ?? d?.post_url ?? null;
  if (!raw) return null;
  const postUrl = safePostUrl(String(raw).startsWith('http') ? String(raw) : `https://www.reddit.com${raw}`);
  if (!postUrl) return null;
  const body = `${d?.title || ''} ${d?.selftext || ''}`.trim() || null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'reddit',
    channel_source: d?.subreddit_name ?? d?.subreddit ?? 'r/reddit',
    post_url: postUrl,
    author_name: d?.author ?? null,
    author_handle: d?.author ? `@${d.author}` : null, author_avatar_url: null, body,
    posted_at: parseWhen(d?.created_at ?? d?.created_utc ?? d?.post_time),
    intent_score: calculateIntentScore(body || ''),
    engagement: { likes: d?.upvote ?? d?.score ?? null, comments: d?.comment_count ?? null },
  });
}

function mapWeb(r: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = safePostUrl(r?.url);
  if (!postUrl) return null;
  let domain = 'Web';
  try {
    domain = new URL(postUrl).hostname.replace(/^www\./, '');
  } catch { /* keep default */ }
  const body = r?.snippet ? String(r.snippet).slice(0, 1200) : null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'google',
    channel_source: domain, post_url: postUrl,
    author_name: r?.title ?? domain, author_handle: `@${domain}`,
    author_avatar_url: null, body,
    posted_at: dateFromSnippet(r?.snippet),
    intent_score: calculateIntentScore(body || ''),
    engagement: { likes: null, comments: null },
  });
}

function mapNews(r: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = safePostUrl(r?.url);
  if (!postUrl) return null;
  let domain = r?.site_name ?? 'News';
  try {
    domain = new URL(postUrl).hostname.replace(/^www\./, '') || domain;
  } catch { /* keep default */ }
  const body = r?.title ? `${r.title}${r.snippet ? ` — ${r.snippet}` : ''}`.slice(0, 1200) : null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'news',
    channel_source: r?.publisher ?? domain, post_url: postUrl,
    author_name: r?.publisher ?? domain, author_handle: `@${domain}`,
    author_avatar_url: null, body,
    posted_at: parseWhen(r?.date),
    intent_score: calculateIntentScore(body || ''),
    engagement: { likes: null, comments: null },
  });
}

// ---------------------------------------------------------------------------
// Credit accounting
// ---------------------------------------------------------------------------
// The sweep is charged per (keyword, operation), not per provider call: a
// keyword is charged for a channel when any call it made there was billed or
// uncertain. A keyword where every call came back free — no results, or an
// error treg never charges for — costs the customer nothing, even if another
// keyword on the same channel was billed (the old code charged price x all
// keywords as soon as any one billed). Retries are not charged again.
//
// Prices come from pricing_config, never from the request, and are read with
// the service role: pricing_config is not client-readable.

interface OperationTally {
  operation: string;
  calls: number;
  costMicro: number;
  /** Any call in this operation that treg reported a charge for. */
  billed: boolean;
  /** Any call whose outcome could not be determined. */
  uncertain: boolean;
  /** A call treg charged for even though the upstream provider failed. */
  upstreamFailed: boolean;
  callIds: string[];
  errorCodes: string[];
  /**
   * Keywords that produced at least one billed or uncertain call on this
   * operation. The charge is price x this count: one keyword that billed must
   * not make every other keyword in the workspace chargeable too.
   */
  chargeableKeywords: Set<string>;
}

function newTally(operation: string): OperationTally {
  return {
    operation, calls: 0, costMicro: 0, billed: false,
    uncertain: false, upstreamFailed: false, callIds: [], errorCodes: [],
    chargeableKeywords: new Set(),
  };
}

function record(tally: OperationTally, r: TregResult, keywordId: string): void {
  tally.calls += 1;
  tally.costMicro += r.costMicro;
  if (r.billable === 'billed') tally.billed = true;
  if (r.billable === 'uncertain') tally.uncertain = true;
  if (r.billable !== 'free') tally.chargeableKeywords.add(keywordId);
  if (r.upstreamFailed) tally.upstreamFailed = true;
  if (r.callId) tally.callIds.push(r.callId);
  if (r.errorCode) tally.errorCodes.push(r.errorCode);
}

/**
 * Reads the price of each operation from the database. A missing or disabled
 * operation is absent from the map rather than priced at zero, so it cannot turn
 * into a free search by accident.
 */
async function loadPricing(
  admin: ReturnType<typeof createClient>,
): Promise<Map<string, number>> {
  const { data, error } = await admin
    .from('pricing_config')
    .select('operation, credits, enabled')
    .eq('enabled', true);
  if (error) {
    console.error('[billing] pricing lookup failed:', error.message);
    return new Map();
  }
  return new Map((data ?? []).map((r: any) => [r.operation, Number(r.credits)]));
}

interface Reservation {
  /** Null when nothing needed holding (a 0-credit sweep, e.g. News only). */
  id: string | null;
  reserved: number;
  /**
   * The key already had a hold, held or finalised. It belongs to another (or an
   * earlier) run, so this run must neither use it nor settle it: running the
   * sweep against it delivered the work free while the run reported a charge.
   */
  duplicate: boolean;
}

/**
 * Holds the credits for a whole sweep before any provider call. Refusing here
 * is the point: the customer is told they are short, and treg is never called,
 * so an empty wallet costs nothing rather than everything.
 */
async function reserveSweep(
  admin: ReturnType<typeof createClient>,
  userId: string,
  credits: number,
  key: string,
  context: Record<string, unknown>,
): Promise<Reservation | { shortfall: number; required: number; available: number }> {
  const { data, error } = await admin.rpc('wallet_reserve', {
    p_user_id: userId,
    p_credits: credits,
    p_idempotency_key: key,
    p_context: context,
  });
  if (error) {
    console.error('[billing] reserve failed:', error.message);
    // Fail closed. Serving without a hold would mean the balance is never
    // checked, which is the unbounded-free-usage defect all over again.
    return { shortfall: credits, required: credits, available: 0 };
  }
  const r = data as any;
  if (r?.ok) {
    return { id: typeof r.reservation_id === 'string' ? r.reservation_id : null, reserved: Number(r.reserved ?? credits), duplicate: r.duplicate === true };
  }
  return {
    shortfall: Number(r?.shortfall ?? credits),
    required: Number(r?.required ?? credits),
    available: Number(r?.available ?? 0),
  };
}

/** Settles a hold for what was actually billable, and returns the new balance. */
async function settleSweep(
  admin: ReturnType<typeof createClient>,
  reservationId: string,
  creditsCharged: number,
  providerCostUsd: number,
  key: string,
  note: string,
): Promise<number | null> {
  const { data, error } = await admin.rpc('wallet_settle', {
    p_reservation_id: reservationId,
    p_credits_charged: creditsCharged,
    p_provider_cost: providerCostUsd,
    p_idempotency_key: key,
    p_note: note,
  });
  if (error) {
    console.error('[billing] settle failed:', error.message);
    return null;
  }
  // wallet_settle reports an already-finalised or missing hold as ok:false,
  // not as an RPC error. Reading balance_after off that counted a charge that
  // never happened.
  if ((data as any)?.ok === false) {
    console.error('[billing] settle refused:', (data as any)?.error);
    return null;
  }
  return Number((data as any)?.balance_after ?? 0);
}

/** Returns a hold untouched. For every outcome treg does not bill. */
async function releaseSweep(
  admin: ReturnType<typeof createClient>,
  reservationId: string,
  reason: string,
): Promise<void> {
  const { error } = await admin.rpc('wallet_release', {
    p_reservation_id: reservationId,
    p_reason: reason,
  });
  if (error) console.error('[billing] release failed:', error.message);
}

/**
 * One usage row per operation per sweep. Metadata only — the post bodies go to
 * monitored_posts, which is where they belong, and keeping a second copy here
 * would mean holding public content twice.
 */
async function recordUsage(
  admin: ReturnType<typeof createClient>,
  userId: string,
  runKey: string,
  tallies: Map<string, OperationTally>,
  reservationId: string | null,
  charges: Map<string, { credits: number; revenueUsd: number }>,
): Promise<void> {
  const rows = [...tallies.values()]
    .filter((t) => t.calls > 0)
    .map((t) => ({
      user_id: userId,
      // Distinct per operation, so the unique key is what makes a retried
      // sweep write once instead of twice.
      idempotency_key: `${runKey}:${t.operation}`,
      operation: t.operation,
      provider: 'treg',
      provider_call_id: t.callIds[0] ?? null,
      provider_cost_usd: Number((t.costMicro / 1e6).toFixed(8)),
      credits_charged: charges.get(t.operation)?.credits ?? 0,
      revenue_usd: Number((charges.get(t.operation)?.revenueUsd ?? 0).toFixed(6)),
      outcome: t.uncertain ? 'uncertain'
        : t.upstreamFailed ? 'upstream_failed'
        : t.billed ? 'success'
        : 'free',
      reservation_id: reservationId,
      metadata: {
        calls: t.calls,
        billed: t.billed,
        upstream_failed: t.upstreamFailed,
        chargeable_keywords: t.chargeableKeywords.size,
        call_ids: t.callIds,
        errors: t.errorCodes,
      },
    }));
  if (rows.length === 0) return;

  const { error } = await admin
    .from('api_usage')
    .upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true });
  if (error) console.error('[billing] usage record failed:', error.message);
}

// ---------------------------------------------------------------------------
// Per-channel provider chains
// ---------------------------------------------------------------------------

/**
 * Providers are tried in order and the first one that returns rows wins, so a
 * fallback only costs money once the cheaper option has actually failed. This
 * is not hypothetical: treg answers 503 provider_capacity_unavailable when the
 * vendor it would otherwise use is busy.
 */
async function searchChannel(
  platform: Platform, kwRow: { id: string; keyword: string },
  userId: string, lookbackHours: number,
  tally: OperationTally, runNonce: string, stats: RunStats,
): Promise<PostRow[]> {
  const kwId = kwRow.id;
  const kw = kwRow.keyword;

  // Stable within a run so an internal retry is free, and different between runs
  // so a scheduled sweep is charged normally rather than looking like a replay.
  const idem = `ds:${runNonce}:${kwId}:${platform}`;
  const common = { customerId: userId, idempotencyKey: idem, stats };

  if (platform === 'twitter') {
    const t = await tregCall('anyapi.x.search.posts', {
      ...common,
      method: 'POST',
      // Latest, not the default: the default returns all-time top posts, which
      // is what once put a 2021 tweet into the feed.
      body: { query: kw, queryType: 'Latest', limit: 20 },
    });
    record(tally, t, kwId);
    const items = t.data?.output?.data?.items ?? [];
    return items.length
      ? items.map((x: any) => mapTwitter(x, userId, kwId, kw)).filter((r: any): r is PostRow => !!r)
      : [];
  }

  if (platform === 'reddit') {
    const tk = await tregCall('tikhub.x.reddit-app-fetch-dynamic-search', {
      ...common,
      query: {
        query: kw, search_type: 'post',
        // RELEVANCE, not NEW: sorted by newest, a site-wide search returns
        // whatever matched the tokens rather than posts about the keyword.
        sort: 'RELEVANCE', time_range: redditTimeframe(lookbackHours), need_format: 'true',
      },
    });
    record(tally, tk, kwId);
    const tkRaw = tk.data?.data?.posts ?? tk.data?.posts ?? [];
    const tkItems = Array.isArray(tkRaw) ? tkRaw : [];
    if (tkItems.length) {
      return tkItems.map((x: any) => mapRedditTikhub(x, userId, kwId, kw)).filter((r: any): r is PostRow => !!r);
    }

    // Only an unbilled miss falls back. When tikhub billed (or may have) for an
    // empty answer the search is already paid for; a second provider would pay
    // twice for one keyword (N9).
    if (!shouldTryRedditFallback(tk, tkItems.length)) return [];

    // Distinct key: a different provider answering the same search. Reusing the
    // primary's key would make treg reject it as a mismatched replay.
    const sc = await tregCall('scrapecreators.reddit.search.posts', {
      ...common,
      idempotencyKey: `${idem}:fb`,
      query: { query: kw, timeframe: redditTimeframe(lookbackHours), sort: 'relevance', limit: 25 },
    });
    record(tally, sc, kwId);
    const scItems = sc.data?.posts ?? [];
    return Array.isArray(scItems) && scItems.length
      ? scItems.map((x: any) => mapRedditScrapecreators(x, userId, kwId, kw)).filter((r: any): r is PostRow => !!r)
      : [];
  }

  if (platform === 'google') {
    const r = await tregCall('crawl4ai.web.search.rich', {
      ...common,
      query: { q: kw, rich: 1 },
    });
    record(tally, r, kwId);
    const items = r.data?.results ?? [];
    return Array.isArray(items) && items.length
      ? items.map((x: any) => mapWeb(x, userId, kwId, kw)).filter((r2): r2 is PostRow => !!r2)
      : [];
  }

  if (platform === 'news') {
    const r = await tregCall('tinyfish.web.search.news', {
      ...common,
      query: { query: kw, domain_type: 'news', after_date: sinceDate(lookbackHours) },
    });
    record(tally, r, kwId);
    const items = r.data?.results ?? [];
    return Array.isArray(items) && items.length
      ? items.map((x: any) => mapNews(x, userId, kwId, kw)).filter((r2): r2 is PostRow => !!r2)
      : [];
  }

  return [];
}


// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

type ProfileRow = {
  id: string;
  enabled_channels: Platform[] | null;
  lookback_hours: number | null;
  min_intent_threshold: number | null;
  sweep_time_utc: string | null;
  sweep_frequency: string | null;
};

/** Everything one chunk accumulates. Per request, never module-level. */
interface RunAcc {
  stats: RunStats;
  errors: Array<Record<string, string>>;
  usersProcessed: number;
  usersSkipped: number;
  postsInserted: number;
  pruned: number;
  totalStale: number;
  // Out-of-credit workspaces are collected rather than logged and forgotten,
  // because "why did nothing arrive" belongs in the run result.
  skippedNoCredits: Array<{ user: string; required: number; available: number; shortfall: number }>;
  totalCreditsCharged: number;
  totalProviderCostUsd: number;
  // tregCall never throws, so a run where every call failed used to report
  // ok: true. Provider failures are collected here (codes only, no bodies).
  providerFailures: Array<{ user: string; operation: string; code: string }>;
}

interface ChunkCtx {
  supabase: ReturnType<typeof createClient>;
  slot: string;
  runId: string;
  pricing: Map<string, number>;
  pricePerCredit: number;
  /** Retention never deletes what this chunk wrote. */
  sweepStartedAt: string;
  acc: RunAcc;
}

Deno.serve(async (req) => {
  const startedMs = Date.now();
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  // Header only (see the file header for why the query parameter was dropped).
  const provided = req.headers.get('x-sweep-secret') ?? '';

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Edge secret wins; fall back to the service-role-only secrets table, so a
  // deployment that only has the table configured still authenticates its own
  // cron caller.
  const expected = await resolveCronSecret(supabase);

  if (!expected) {
    console.error('SWEEP_CRON_SECRET is not configured — refusing to run.');
    return json({ ok: false, error: 'sweep not configured' }, 503);
  }
  if (expected.length < MIN_CRON_SECRET_LENGTH) {
    // A short secret is a misconfiguration, not a credential. Refuse loudly
    // rather than gate a money-spending endpoint behind something brute-forceable.
    console.error(`SWEEP_CRON_SECRET is shorter than ${MIN_CRON_SECRET_LENGTH} characters — refusing to run.`);
    return json({ ok: false, error: 'sweep not configured' }, 503);
  }

  if (!timingSafeEqual(provided, expected)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  // The cron sends {}; a chain hop sends { slot, chunk, after }.
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* empty body: the cron tick */
  }
  const parsed = parseChunkRequest(body, new Date());
  if ('error' in parsed) {
    console.warn('[sweep] refused request:', parsed.error);
    return json({ ok: false, error: 'bad request' }, 400);
  }
  const { slot, chunk, after } = parsed;

  if (!await resolveTregToken(supabase)) {
    return json({ ok: false, error: 'search provider not configured' }, 503);
  }

  // An empty treg wallet turns every scheduled sweep into a burst of 503s that
  // reads like a provider outage. One clear refusal is cheaper to diagnose.
  const balanceUsd = await tregBalanceUsd();
  if (balanceUsd !== null && balanceUsd < MIN_TREG_BALANCE_USD) {
    console.error(
      `[sweep] treg balance $${balanceUsd.toFixed(4)} is below the $${MIN_TREG_BALANCE_USD} floor — skipping this run.`,
    );
    return json({ ok: false, error: 'insufficient_provider_credit' }, 503);
  }

  // ---- Claim (slot, chunk) atomically: the run lock -------------------------
  //
  // The primary key is derived from (slot, chunk), so of two invocations for the
  // same chunk exactly one insert succeeds. The loser stops here, before any
  // hold or provider call; overlapping runs used to double-charge.
  const runId = await claimIdFor(slot, chunk);
  const { error: claimError } = await supabase.from('sweep_runs').insert({ id: runId });
  if (claimError) {
    if ((claimError as { code?: string }).code === '23505') {
      console.warn(`[sweep] ${slot} chunk ${chunk} is already claimed; not running it twice`);
      return json({ ok: true, skipped: 'already_claimed', slot, chunk });
    }
    // Without a claim there is no lock, so fail closed rather than risk overlap.
    console.error('[sweep] run claim failed:', claimError.message);
    return json({ ok: false, error: 'sweep unavailable' }, 503);
  }

  const work = runChunk(supabase, { slot, chunk, after, runId, startedMs, balanceUsd });

  // A chain hop answers at once and works in the background, so the previous
  // chunk is not held open waiting for it. The cron tick (chunk 0) stays
  // synchronous so pg_net records the result.
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (chunk > 0 && typeof edgeRuntime?.waitUntil === 'function') {
    edgeRuntime.waitUntil(work.catch((err) => {
      console.error(`[sweep] ${slot} chunk ${chunk} failed:`, (err as Error)?.name ?? 'Error');
    }));
    return json({ ok: true, accepted: true, slot, chunk }, 202);
  }

  try {
    const result = await work;
    return json(result.body, result.status);
  } catch (err) {
    console.error(`[sweep] ${slot} chunk ${chunk} failed:`, (err as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'sweep failed' }, 500);
  }
});

async function runChunk(
  supabase: ReturnType<typeof createClient>,
  req: { slot: string; chunk: number; after: string | null; runId: string; startedMs: number; balanceUsd: number | null },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { slot, chunk, after, runId, startedMs } = req;
  const hourUtc = slotHour(slot);

  const acc: RunAcc = {
    stats: { usdSpent: 0, callsMade: 0 },
    errors: [],
    usersProcessed: 0,
    usersSkipped: 0,
    postsInserted: 0,
    pruned: 0,
    totalStale: 0,
    skippedNoCredits: [],
    totalCreditsCharged: 0,
    totalProviderCostUsd: 0,
    providerFailures: [],
  };

  const finishRun = async () => {
    const { error } = await supabase
      .from('sweep_runs')
      .update({
        finished_at: new Date().toISOString(),
        users_processed: acc.usersProcessed,
        posts_inserted: acc.postsInserted,
        errors: acc.errors,
      })
      .eq('id', runId);
    if (error) console.error('[sweep] run row update failed:', error.message);
  };

  // Close out holds whose sweep died between reserving and settling. Once per
  // slot (chunk 0) is enough.
  let reaped: { settled: number; released: number } | null = null;
  if (chunk === 0) {
    try {
      const { data, error } = await supabase.rpc('reap_stale_reservations', {
        p_older_than: '1 hour',
      });
      if (error) {
        acc.errors.push({ user: '*', kw: '*', platform: '*', message: `reaper: ${error.message}` });
      } else if (data && ((data as any).settled > 0 || (data as any).released > 0)) {
        reaped = { settled: (data as any).settled, released: (data as any).released };
        console.warn(`[sweep] reaped ${reaped.settled} settled, ${reaped.released} released stale holds`);
      }
    } catch (reaperErr) {
      acc.errors.push({ user: '*', kw: '*', platform: '*', message: `reaper: ${String(reaperErr)}` });
    }
  }

  const pricing = await loadPricing(supabase);

  // What one credit is realised at, for the usage ledger. Taken from the live
  // packages rather than assumed.
  const { data: pkgsForPrice } = await supabase
    .from('topup_packages')
    .select('gross_usd, credits')
    .eq('active', true)
    .order('gross_usd')
    .limit(1);
  const pricePerCredit =
    (pkgsForPrice ?? []).reduce(
      (sum: number, p: { gross_usd: number; credits: number }) => sum + (Number(p.credits) > 0 ? Number(p.gross_usd) / Number(p.credits) : 0),
      0,
    );

  const ctx: ChunkCtx = {
    supabase, slot, runId, pricing, pricePerCredit,
    sweepStartedAt: new Date().toISOString(),
    acc,
  };

  // ---- Due users, filtered BEFORE the cap -----------------------------------
  // Without settings every workspace would look due every hour and be charged
  // 24x a day, so a failed read stops the run before anything is held.
  const due = await loadDueProfiles(supabase, hourUtc, after, MAX_USERS_PER_CHUNK + 1);
  if ('error' in due) {
    acc.errors.push({ stage: 'profiles', message: due.error });
    await finishRun();
    return { status: 500, body: { ok: false, error: 'could not load workspace settings' } };
  }
  const candidates = due.profiles.slice(0, MAX_USERS_PER_CHUNK);
  let more = due.profiles.length > MAX_USERS_PER_CHUNK;

  // ---- Sweep in id order until the time budget is spent ---------------------
  let cursor: string | null = after;
  let stoppedForTime = false;

  groups:
  for (let g = 0; g < candidates.length; g += KEYWORD_LOOKUP_BATCH) {
    const group = candidates.slice(g, g + KEYWORD_LOOKUP_BATCH);
    const keywordsByUser = await loadKeywords(supabase, group.map((p) => p.id));
    if ('error' in keywordsByUser) {
      acc.errors.push({ stage: 'keywords', message: String(keywordsByUser.error) });
      await finishRun();
      return { status: 500, body: { ok: false, error: 'could not load keywords' } };
    }

    let i = 0;
    while (i < group.length) {
      const batch: Array<{ profile: ProfileRow; keywords: Array<{ id: string; keyword: string }> }> = [];
      let lastIdx = i - 1;
      while (i < group.length && batch.length < USER_CONCURRENCY) {
        const list = keywordsByUser.get(group[i].id) ?? [];
        if (list.length > 0) batch.push({ profile: group[i], keywords: list });
        lastIdx = i;
        i++;
      }
      if (batch.length === 0) {
        // Due but no active keywords: nothing to do, and handled.
        cursor = group[lastIdx].id;
        continue;
      }
      const maxKeywords = Math.max(...batch.map((b) => b.keywords.length));
      if (!canStartBatch(Date.now() - startedMs, maxKeywords)) {
        stoppedForTime = true;
        break groups;
      }
      await Promise.all(batch.map((b) => sweepUser(ctx, b.profile, b.keywords)));
      cursor = group[lastIdx].id;
    }
  }
  more = more || stoppedForTime;

  // ---- Hand the rest of the slot to the next chunk --------------------------
  let next: { chunk: number; after: string | null; dispatched: boolean } | null = null;
  if (more) {
    if (cursor === after) {
      acc.errors.push({ stage: 'chain', message: 'no progress in this chunk; remaining due users deferred' });
    } else if (chunk + 1 >= MAX_CHUNKS_PER_SLOT) {
      acc.errors.push({ stage: 'chain', message: `chunk limit ${MAX_CHUNKS_PER_SLOT} reached; remaining due users deferred` });
    } else {
      const dispatched = await dispatchNextChunk(slot, chunk + 1, cursor);
      next = { chunk: chunk + 1, after: cursor, dispatched };
      if (!dispatched) {
        acc.errors.push({ stage: 'chain', message: `could not confirm dispatch of chunk ${chunk + 1}` });
      }
    }
  }

  await finishRun();

  return {
    status: 200,
    body: {
      // False only when every provider call this chunk failed.
      ok: acc.providerFailures.length === 0 || acc.providerFailures.length < acc.stats.callsMade,
      slot,
      chunk,
      hourUtc,
      dueUsersConsidered: candidates.length,
      next,
      usersProcessed: acc.usersProcessed,
      usersSkipped: acc.usersSkipped,
      postsInserted: acc.postsInserted,
      droppedStale: acc.totalStale,
      pruned: acc.pruned,
      // Measured from treg's own cost headers, not from a rate card.
      usdSpent: Number(acc.stats.usdSpent.toFixed(6)),
      callsMade: acc.stats.callsMade,
      balanceUsd: req.balanceUsd,
      errorCount: acc.errors.length,
      provider_failure_count: acc.providerFailures.length,
      provider_failures: acc.providerFailures.slice(0, 12),
      reaped_reservations: reaped,
      billing: {
        creditsCharged: roundCredits(acc.totalCreditsCharged),
        providerCostUsd: Number(acc.totalProviderCostUsd.toFixed(8)),
        // News is free to the customer by policy: always 0 credits.
        freeOperations: [...FREE_OPERATIONS],
        // Each of these cost zero: the hold is taken before any provider call.
        skippedInsufficientCredits: acc.skippedNoCredits,
      },
    },
  };
}

/**
 * Due profiles with id > after, in id order. Keyset paging with an explicit
 * order, so a PostgREST max-rows cap below PAGE_SIZE cannot silently end the
 * scan, and the due filter is applied before `limit` is.
 */
async function loadDueProfiles(
  supabase: ReturnType<typeof createClient>,
  hourUtc: number,
  after: string | null,
  limit: number,
): Promise<{ profiles: ProfileRow[] } | { error: string }> {
  const out: ProfileRow[] = [];
  let lastId = after;
  for (;;) {
    let q = supabase
      .from('profiles')
      .select('id, enabled_channels, lookback_hours, min_intent_threshold, sweep_time_utc, sweep_frequency')
      .order('id', { ascending: true });
    if (lastId) q = q.gt('id', lastId);
    const { data, error } = await q.range(0, PAGE_SIZE - 1);
    if (error) return { error: error.message };
    const rows = (data ?? []) as unknown as ProfileRow[];
    if (rows.length === 0) break;
    out.push(...filterDue(rows, hourUtc));
    if (out.length >= limit) break;
    lastId = rows[rows.length - 1].id;
  }
  return { profiles: out.slice(0, limit) };
}

/**
 * Active keywords for a set of users, ordered (user, created_at, id) and paged
 * until an empty page, then capped per user to the oldest MAX_KEYWORDS_PER_USER.
 */
async function loadKeywords(
  supabase: ReturnType<typeof createClient>,
  userIds: string[],
): Promise<Map<string, Array<{ id: string; keyword: string }>> | { error: string }> {
  if (userIds.length === 0) return new Map();
  const rows: Array<{ id: string; user_id: string; keyword: string }> = [];
  for (let from = 0; ;) {
    const { data, error } = await supabase
      .from('keywords')
      .select('id, user_id, keyword')
      .eq('is_active', true)
      .in('user_id', userIds)
      .order('user_id', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { error: error.message };
    const page = (data ?? []) as unknown as Array<{ id: string; user_id: string; keyword: string }>;
    if (page.length === 0) break;
    rows.push(...page);
    from += page.length;
  }
  return groupKeywords(rows);
}

/**
 * Starts chunk n+1 of this slot. The callee claims its own row, answers 202 and
 * works in the background, so this normally returns in well under a second.
 */
async function dispatchNextChunk(slot: string, chunk: number, after: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/daily-sweep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sweep-secret': SWEEP_CRON_SECRET },
      body: JSON.stringify({ slot, chunk, after }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    return res.status === 202 || res.ok;
  } catch (err) {
    console.error(`[sweep] dispatch of ${slot} chunk ${chunk} failed:`, (err as Error)?.name ?? 'Error');
    return false;
  }
}

/** Sweeps one due workspace: reserve, search, settle, store, prune. */
async function sweepUser(
  ctx: ChunkCtx,
  settings: ProfileRow,
  userKeywords: Array<{ id: string; keyword: string }>,
): Promise<void> {
  const { supabase, pricing, pricePerCredit, acc } = ctx;
  const userId = settings.id;

  const ALL: Platform[] = ['twitter', 'reddit', 'google', 'news'];
  const requested: Platform[] = Array.isArray(settings.enabled_channels) && settings.enabled_channels.length > 0
    ? settings.enabled_channels.filter((c): c is Platform => ALL.includes(c as Platform))
    : ['twitter', 'reddit', 'google'];
  // A flat cap on how many channels may be scanned. The Settings UI stops the
  // over-limit selection from being made; this is the backstop.
  const channels: Platform[] = [...new Set(requested)].slice(0, MAX_CHANNELS);
  const lookbackHours = Number(settings.lookback_hours) || 24;
  const minIntent = Number(settings.min_intent_threshold) || 0;
  const cutoffMs = Date.now() - lookbackHours * 60 * 60 * 1000;

  let droppedStale = 0;
  const rowsToUpsert: PostRow[] = [];
  const seenUrls = new Set<string>();

  // ---- Price the workspace's sweep, then hold it before any call -----------
  //
  // All or nothing. The key is per slot, not per invocation: a second run in the
  // same due hour finds the key taken (duplicate) and skips the workspace, so it
  // is never charged twice for one scheduled sweep.
  const runKey = `ds:${ctx.slot}:${userId}`;
  const runNonce = `${ctx.slot}:${userId}`;

  const wantedOps = [...new Set(channels.map((c) => OPERATION_OF[c]))]
    .filter((op) => isOperationAvailable(op, pricing));
  const billableChannels = channels.filter((c) => isOperationAvailable(OPERATION_OF[c], pricing));

  const unpriced = channels.filter((c) => !isOperationAvailable(OPERATION_OF[c], pricing));
  if (unpriced.length > 0) {
    console.warn(`[sweep] no configured price for ${userId}: ${unpriced.join(', ')}`);
  }

  const creditsPerKeyword = wantedOps.reduce((s, op) => s + creditsFor(op, pricing), 0);
  // Fractional credits (e.g. 0.1 per keyword per channel): never rounded to an
  // integer, only to 2 decimals to drop float noise.
  const creditsRequired = roundCredits(creditsPerKeyword * userKeywords.length);

  // No p_paid_only: scheduled sweeps may spend welcome credits.
  const hold = await reserveSweep(supabase, userId, creditsRequired, runKey, {
    scope: 'daily-sweep',
    run_id: ctx.runId,
    slot: ctx.slot,
    keywords: userKeywords.length,
    channels: wantedOps,
    free_channels: wantedOps.filter((op) => FREE_OPERATIONS.has(op)),
    credits_per_keyword: roundCredits(creditsPerKeyword),
  });

  if ('shortfall' in hold) {
    // Nothing has been called. Recorded rather than silently dropped.
    acc.skippedNoCredits.push({
      user: userId,
      required: hold.required,
      available: hold.available,
      shortfall: hold.shortfall,
    });
    console.warn(`[sweep] ${userId} skipped: needs ${hold.required} credits, has ${hold.available}`);
    acc.usersSkipped++;
    return;
  }

  if (hold.duplicate) {
    // This slot's key is already taken, so another invocation owns that hold.
    // Sweeping anyway would deliver the work without charging for it.
    acc.errors.push({ user: userId, kw: '*', platform: '*', message: 'reservation key already used; user skipped' });
    console.error(`[sweep] ${userId} skipped: reservation ${runKey} already exists`);
    acc.usersSkipped++;
    return;
  }

  acc.usersProcessed++;

  const tallies = new Map<string, OperationTally>();
  for (const op of wantedOps) tallies.set(op, newTally(op));

  let holdClosed = false;

  /**
   * Works out what is owed from the tallies, writes the usage rows, then
   * settles (or releases) the hold. Usage is recorded first so a settle that
   * fails still leaves the measured cost on the ledger for reconciliation.
   */
  const closeHold = async (note: string): Promise<void> => {
    if (holdClosed) return;
    holdClosed = true;

    let creditsCharged = 0;
    let providerCostUsd = 0;
    const charges = new Map<string, { credits: number; revenueUsd: number }>();

    for (const [op, t] of tallies) {
      providerCostUsd += t.costMicro / 1e6;
      // Charged per keyword: price x the keywords that had at least one billed
      // or uncertain call on this operation. Free operations (News) are 0.
      const opCredits = roundCredits(creditsFor(op, pricing) * t.chargeableKeywords.size);
      creditsCharged += opCredits;
      charges.set(op, { credits: opCredits, revenueUsd: opCredits * pricePerCredit });
    }

    // Never settle more than was held (2-decimal rounding per operation must not
    // push the total past the reservation).
    creditsCharged = Math.min(roundCredits(creditsCharged), hold.reserved);

    acc.totalProviderCostUsd += providerCostUsd;
    for (const [op, t] of tallies) {
      for (const code of t.errorCodes) {
        acc.providerFailures.push({ user: userId, operation: op, code });
      }
    }
    await recordUsage(supabase, userId, runKey, tallies, hold.id, charges);

    // A 0-credit sweep has no hold (wallet_reserve returns reservation_id null).
    if (!hold.id) return;

    if (creditsCharged > 0) {
      const balanceAfter = await settleSweep(
        supabase, hold.id, creditsCharged, providerCostUsd, `${runKey}:settle`, note,
      );
      if (balanceAfter !== null) {
        acc.totalCreditsCharged = roundCredits(acc.totalCreditsCharged + creditsCharged);
      } else {
        acc.errors.push({
          user: userId, kw: '*', platform: '*',
          message: 'credit settlement failed; reservation left held for the reaper',
        });
      }
    } else {
      await releaseSweep(supabase, hold.id, 'no billable provider calls');
    }
  };

  try {
    // Keywords run in waves of KEYWORD_CONCURRENCY, channels in parallel within
    // each; providers inside a channel stay sequential so a fallback only costs
    // money once the cheaper one has failed unbilled.
    for (let k = 0; k < userKeywords.length; k += KEYWORD_CONCURRENCY) {
      const wave = userKeywords.slice(k, k + KEYWORD_CONCURRENCY);
      const perKeyword: PostRow[][][] = await Promise.all(
        wave.map((kw) =>
          Promise.all(
            billableChannels.map((ch) => {
              const tally = tallies.get(OPERATION_OF[ch])!;
              return searchChannel(ch, kw, userId, lookbackHours, tally, runNonce, acc.stats);
            }),
          )
        ),
      );

      for (const r of perKeyword.flat(2)) {
        // Exact cutoff: the endpoints only accept coarse windows. Rows with no
        // date cannot be judged and are kept.
        if (r.posted_at && Date.parse(r.posted_at) < cutoffMs) {
          droppedStale++;
          continue;
        }
        if (r.intent_score < minIntent) continue;
        const key = r.post_url.trim().toLowerCase();
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        rowsToUpsert.push(r);
      }
    }

    await closeHold(`${userKeywords.length} keywords across ${billableChannels.length} channels`);
  } catch (sweepErr) {
    // One workspace throwing must not abort the whole chunk, and must not leave
    // its hold reserved until the reaper finds it.
    acc.errors.push({ user: userId, kw: '*', platform: '*', message: `sweep: ${(sweepErr as Error)?.name ?? 'Error'}` });
  } finally {
    if (!holdClosed) {
      try {
        await closeHold('sweep aborted by an error; charged for calls already billed');
      } catch (closeErr) {
        acc.errors.push({ user: userId, kw: '*', platform: '*', message: `close hold: ${(closeErr as Error)?.name ?? 'Error'}` });
      }
    }
  }

  if (rowsToUpsert.length > 0) {
    const { error: upsertError } = await supabase
      .from('monitored_posts')
      .upsert(rowsToUpsert, { onConflict: 'user_id,post_url', ignoreDuplicates: true });

    if (upsertError) {
      acc.errors.push({ user: userId, kw: '*', platform: '*', message: upsertError.message });
    } else {
      acc.postsInserted += rowsToUpsert.length;
    }
  }

  // Retention pass for this user. sweepStartedAt keeps this chunk's results.
  try {
    const { data: prune, error: pruneError } = await supabase.rpc('prune_feed', {
      p_user_id: userId,
      p_keep_after: ctx.sweepStartedAt,
    });
    if (pruneError) {
      acc.errors.push({ user: userId, kw: '*', platform: 'prune', message: pruneError.message });
    } else if (typeof (prune as any)?.deleted === 'number' && (prune as any).deleted > 0) {
      acc.pruned += (prune as any).deleted;
    }
  } catch (pruneErr) {
    acc.errors.push({ user: userId, kw: '*', platform: 'prune', message: (pruneErr as Error)?.name ?? 'Error' });
  }

  acc.totalStale += droppedStale;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
