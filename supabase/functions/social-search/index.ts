// ============================================================================
// Supabase Edge Function: social-search
// ----------------------------------------------------------------------------
// Fetches mentions for a workspace's keywords across its enabled channels.
//
// One upstream: treg.to, a catalog of 3,900+ provider endpoints behind a single
// token at the provider's own rate with no markup. The credential is injected
// server-side, so nothing sensitive reaches the browser or this file's callers.
//
// Each channel has a provider chain and the first endpoint that returns rows
// wins. The chain is load-bearing rather than decorative: treg answers
// 503 provider_capacity_unavailable when the vendor it would otherwise use is
// busy, and names a usable alternative in the same error body.
//
// The caller's channels, lookback window, intent threshold and keywords are all
// read from the database with the service role key. Nothing quota-relevant is
// trusted from the request body.
//
// NOTE: this file is intentionally SELF-CONTAINED. Do not split shared helpers
// into an underscore-prefixed folder — Supabase's bundler skips `_`-prefixed
// directories and the relative import fails to resolve on deploy.
//
// Deploy:  supabase functions deploy social-search
// Secret:  supabase secrets set TREG_TOKEN=treg_...
//          (falls back to public.service_secrets, which only the service role
//           can read, so the token is never exposed to the browser)
//
// Request body: { keyword?: string }   (optional — sweeps all active keywords)
// Response:     { ok, posts, scanned, channels, lookback_hours, served_by, billing, ... }
//               (provider spend is not returned to the browser; it lives in
//                api_usage and wallet settlement only)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function fail(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

/** Verifies the caller's JWT server-side. Identity is never taken from the body. */
async function requireUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) return null;

  try {
    const res = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: anonKey },
      // A hung auth call would otherwise hold the request open indefinitely.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

/**
 * Durable rate limit backed by take_rate_limit(). The old in-memory buckets
 * were per-isolate and reset on every cold start, so they bounded nothing under
 * real load. Fails CLOSED: a limiter we cannot reach is treated as "no".
 */
async function takeRateLimit(
  admin: ReturnType<typeof createClient>,
  userId: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc('take_rate_limit', {
      p_user_id: userId,
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      console.warn('[social-search] take_rate_limit failed:', error.message);
      return false;
    }
    return data === true;
  } catch (err) {
    console.warn('[social-search] take_rate_limit threw:', err);
    return false;
  }
}

const TREG_BASE = 'https://treg.to';
const MAX_KEYWORDS_PER_SWEEP = 25;
/** Used when sweep_shape() cannot be read; match keyword_limit()/channel_limit(). */
const FALLBACK_MAX_KEYWORDS = 8;
const FALLBACK_MAX_CHANNELS = 3;

/**
 * Hard ceiling treg enforces per call (README: every call carries one). A
 * search that would cost more is refused with a 402 and nothing is charged,
 * so a provider repricing cannot silently run up the bill on a sweep.
 */
const ROUTE_MAX_COST_USD = '0.01';

/**
 * Per-request counters. These used to be module-level `let`s, so two sweeps
 * running concurrently in the same isolate reset and added to each other's
 * figures.
 */
interface RunStats {
  usdSpent: number;
  callsMade: number;
}

// ---------------------------------------------------------------------------
// Platform -> pricing operation
//
// One logical operation per channel, and the charge hangs off that rather than
// off the provider call. Reddit is why: its primary and its fallback are both
// billed calls, so pricing per call would make the same keyword cost two
// credits on one sweep and four the next depending on which provider happened to
// be up. The customer pays for the search, not for the retry.
// ---------------------------------------------------------------------------
type Platform = 'twitter' | 'reddit' | 'google' | 'news';

const OPERATION_OF: Record<Platform, string> = {
  twitter: 'treg.twitter.search',
  reddit: 'treg.reddit.search',
  google: 'treg.web.search',
  news: 'treg.news.search',
};

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
      // A pre-flight check must not be the thing that hangs the sweep; on
      // timeout the balance is simply unknown (see catch).
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.balance_usd === 'number' ? body.balance_usd : null;
  } catch {
    return null; // unknown balance is not a reason to stop working
  }
}

interface KeywordRow {
  id: string;
  keyword: string;
}

interface RawPost {
  keyword_id: string;
  matched_keyword: string;
  platform: Platform;
  channel_source: string;
  post_url: string;
  author_name: string | null;
  author_handle: string | null;
  author_avatar_url: string | null;
  body: string | null;
  /** Null when the source genuinely has no date. */
  posted_at: string | null;
  intent_score: number;
  engagement: Record<string, number | null> | null;
}

// ---------------------------------------------------------------------------
// Intent scoring
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

/**
 * A URL that came from an external provider is only kept if it is http or https.
 *
 * Without this, a provider returning `javascript:...` — or any row written
 * straight into monitored_posts — becomes a clickable javascript: link in the
 * feed. React does not strip the scheme, and `rel="noopener"` has nothing to do
 * with it. Browsers currently block javascript: in a new browsing context, so
 * this is defence in depth rather than a live hole, but it is the difference
 * between an untrusted upstream choosing where a link goes and not.
 *
 * Returns null for anything rejected, so the caller drops the row rather than
 * storing a link that leads nowhere.
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

/**
 * Score 0-100. Base 30, +9 per strong intent phrase, +3 per supporting phrase,
 * heavy penalty for recruiting/promo noise. Capped 0..97.
 */
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

/** Normalises the several timestamp spellings the upstreams use. */
function parseWhen(value: unknown): string | null {
  if (value == null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // X sends seconds, others milliseconds. The magnitude decides which.
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof value !== 'string' || !value.trim()) return null;
  const s = value.trim();

  // "3 days ago" / "2 weeks ago"
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

  // "Feb 4, 2026" / "February 4 2026" / "Feb 2026"
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
 * analytics software". That endpoint returns no date field at all, so this is
 * the only date signal available and it is worth reading.
 */
function dateFromSnippet(snippet: string | null | undefined): string | null {
  if (!snippet) return null;
  const m = /^\s*((?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})|(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})|(?:[A-Za-z]{3,9}\.?\s+\d{4}))\s*[—–\-|·]/.exec(snippet);
  return m ? parseWhen(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Lookback window -> per-endpoint parameters
// ---------------------------------------------------------------------------
// No two endpoints agree on how a time window is spelled, and an unrecognised
// query param is dropped rather than rejected — which is how an unfiltered
// search once served a 2021 post into the feed.

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
// Credentials
// ---------------------------------------------------------------------------
// The edge secret wins; otherwise the value is read from
// public.service_secrets over the service role. That table has RLS on and no
// policies, so the browser has no path to the token.

let tregToken = Deno.env.get('TREG_TOKEN') || '';

async function resolveToken(admin: ReturnType<typeof createClient>): Promise<string> {
  if (tregToken) return tregToken;
  const { data, error } = await admin
    .from('service_secrets')
    .select('value')
    .eq('name', 'treg_token')
    .maybeSingle();
  if (error) {
    console.warn('[social-search] secret lookup failed:', error.message);
    return '';
  }
  tregToken = typeof data?.value === 'string' ? data.value : '';
  return tregToken;
}

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
    /** This request's counters; never shared with a concurrent sweep. */
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
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
  opts.stats.callsMade++;

  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        'X-Treg-Token': tregToken,
        Accept: 'application/json',
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

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function basePost(p: Omit<RawPost, 'intent_score'>): RawPost {
  return { ...p, intent_score: calculateIntentScore(p.body || '') };
}

/** anyapi.x.search.posts — createdUtc is unix seconds. */
function mapTwitter(t: any, kw: KeywordRow): RawPost | null {
  const postUrl = safePostUrl(t?.url) ?? (t?.id ? safePostUrl(`https://x.com/i/status/${t.id}`) : null);
  if (!postUrl) return null;
  const handle = t?.authorUsername ? `@${String(t.authorUsername).replace(/^@/, '')}` : null;
  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'twitter',
    channel_source: 'X / Twitter',
    post_url: postUrl,
    author_name: t?.authorName ?? null,
    author_handle: handle,
    // Rendered as an <img src>, so it gets the same scheme check as the link.
    author_avatar_url: safePostUrl(t?.authorImage),
    body: t?.text ?? null,
    posted_at: parseWhen(t?.createdUtc ?? t?.createdAt),
    engagement: {
      likes: t?.likeCount ?? null,
      retweets: t?.retweetCount ?? null,
      replies: t?.replyCount ?? null,
      quotes: t?.quoteCount ?? null,
      views: t?.viewCount ?? null,
      author_followers: t?.authorFollowers ?? null,
    },
  });
}

/** scrapecreators.reddit.search.posts — permalink here is relative, url is not. */
function mapRedditScrapecreators(p: any, kw: KeywordRow): RawPost | null {
  const postUrl = safePostUrl(p?.url) ?? (p?.permalink ? safePostUrl(`https://www.reddit.com${p.permalink}`) : null);
  if (!postUrl) return null;
  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'reddit',
    channel_source: p?.subreddit ? `r/${p.subreddit}` : 'r/reddit',
    post_url: postUrl,
    author_name: p?.author ? `u/${p.author}` : 'u/anonymous',
    author_handle: p?.author ? `@${p.author}` : null,
    author_avatar_url: null,
    body: `${p?.title || ''} ${p?.selftext || ''}`.trim() || null,
    posted_at: parseWhen(p?.created_at_iso ?? p?.created_utc ?? p?.created),
    engagement: {
      likes: p?.score ?? p?.ups ?? null,
      comments: p?.num_comments ?? null,
      upvotes: p?.ups ?? null,
      upvote_ratio: p?.upvote_ratio ?? null,
      subreddit_members: p?.subreddit_subscribers ?? null,
    },
  });
}

/** tikhub.x.reddit-app-fetch-dynamic-search — shape is not pinned down. */
function mapRedditTikhub(p: any, kw: KeywordRow): RawPost | null {
  const d = p?.data ?? p;
  const raw = d?.url ?? d?.permalink ?? d?.post_url ?? null;
  if (!raw) return null;
  // Checked, not cast: the old `as string` let a rejected URL through as null.
  const postUrl = safePostUrl(String(raw).startsWith('http') ? raw : `https://www.reddit.com${raw}`);
  if (!postUrl) return null;
  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'reddit',
    channel_source: d?.subreddit_name ?? d?.subreddit ?? 'r/reddit',
    post_url: postUrl,
    author_name: d?.author ?? null,
    author_handle: d?.author ? `@${d.author}` : null,
    author_avatar_url: null,
    body: `${d?.title || ''} ${d?.selftext || ''}`.trim() || null,
    posted_at: parseWhen(d?.created_at ?? d?.created_utc ?? d?.post_time),
    engagement: { likes: d?.upvote ?? d?.score ?? null, comments: d?.comment_count ?? null },
  });
}

/** crawl4ai.web.search.rich — no date field; the snippet often carries one. */
function mapWeb(r: any, kw: KeywordRow): RawPost | null {
  const postUrl = safePostUrl(r?.url);
  if (!postUrl) return null;
  let domain = 'Web';
  try {
    domain = new URL(postUrl).hostname.replace(/^www\./, '');
  } catch { /* keep default */ }

  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'google',
    channel_source: domain,
    post_url: postUrl,
    author_name: r?.title ?? domain,
    author_handle: `@${domain}`,
    author_avatar_url: null,
    body: r?.snippet ? String(r.snippet).slice(0, 1200) : null,
    posted_at: dateFromSnippet(r?.snippet),
    engagement: { likes: null, comments: null },
  });
}

/** tinyfish.web.search.news — free, and every result carries a date. */
function mapNews(r: any, kw: KeywordRow): RawPost | null {
  const postUrl = safePostUrl(r?.url);
  if (!postUrl) return null;
  let domain = r?.site_name ?? 'News';
  try {
    domain = new URL(postUrl).hostname.replace(/^www\./, '') || domain;
  } catch { /* keep default */ }

  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'news',
    channel_source: r?.publisher ?? domain,
    post_url: postUrl,
    author_name: r?.publisher ?? domain,
    author_handle: `@${domain}`,
    author_avatar_url: null,
    body: r?.title ? `${r.title}${r.snippet ? ` — ${r.snippet}` : ''}`.slice(0, 1200) : null,
    posted_at: parseWhen(r?.date),
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
// keywords as soon as any one billed). Retries behind a billed call are not
// charged again either.
//
// Prices are read with the service role: pricing_config is not client-readable.
//
// Prices come from pricing_config, never from the request. A client that could
// name its own price would not need the table.

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
   * not make every other keyword on the sweep chargeable too.
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
  id: string;
  reserved: number;
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
    return { id: r.reservation_id, reserved: Number(r.reserved ?? credits) };
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
 * Runs the chain for one keyword on one channel and returns the first provider
 * that produced rows. A provider that errors, times out or returns nothing
 * hands over to the next.
 */
/**
 * Providers are tried in order and the first one that returns rows wins, so a
 * fallback only costs money once the cheaper option has actually failed. This
 * is not hypothetical: treg answers 503 provider_capacity_unavailable when the
 * vendor it would otherwise use is busy.
 */
async function searchChannel(
  platform: Platform,
  kw: KeywordRow,
  lookbackHours: number,
  served: Record<string, string>,
  tally: OperationTally,
  userId: string,
  runNonce: string,
  stats: RunStats,
): Promise<RawPost[]> {
  // Stable within a sweep so an internal retry is free, and different between
  // sweeps so a deliberate second search is charged normally.
  const idem = `ss:${runNonce}:${kw.id}:${platform}`;
  const common = { customerId: userId, idempotencyKey: idem, stats };

  // ── Twitter ────────────────────────────────────────────────────────────
  if (platform === 'twitter') {
    const t = await tregCall('anyapi.x.search.posts', {
      ...common,
      method: 'POST',
      // queryType Latest is the whole point: the default returns all-time top
      // posts, which is what put a 2021 tweet into the feed.
      body: { query: kw.keyword, queryType: 'Latest', limit: 20 },
    });
    record(tally, t, kw.id);
    const items = t.data?.output?.data?.items ?? [];
    if (items.length) {
      served.twitter = 'anyapi.x.search.posts';
      return items.map((x: any) => mapTwitter(x, kw)).filter((p: any): p is RawPost => !!p);
    }
    return [];
  }

  // ── Reddit ─────────────────────────────────────────────────────────────
  if (platform === 'reddit') {
    // tikhub is cheapest and fastest but its shared capacity runs out often;
    // scrapecreators is the reliable second and answers in about a second.
    const tk = await tregCall('tikhub.x.reddit-app-fetch-dynamic-search', {
      ...common,
      query: {
        query: kw.keyword,
        search_type: 'post',
        // RELEVANCE, not NEW: sorted by newest, a site-wide search returns
        // whatever matched the tokens rather than posts about the keyword.
        sort: 'RELEVANCE',
        time_range: redditTimeframe(lookbackHours),
        need_format: 'true',
      },
    });
    record(tally, tk, kw.id);
    const tkItems = tk.data?.data?.posts ?? tk.data?.posts ?? [];
    if (Array.isArray(tkItems) && tkItems.length) {
      served.reddit = 'tikhub.x.reddit-app-fetch-dynamic-search';
      return tkItems.map((x: any) => mapRedditTikhub(x, kw)).filter((p: any): p is RawPost => !!p);
    }

    // Distinct key: this is a different provider answering the same search, and
    // reusing the primary's key would make treg reject it as a mismatched replay.
    const sc = await tregCall('scrapecreators.reddit.search.posts', {
      ...common,
      idempotencyKey: `${idem}:fb`,
      query: {
        query: kw.keyword,
        timeframe: redditTimeframe(lookbackHours),
        sort: 'relevance',
        limit: 25,
      },
    });
    record(tally, sc, kw.id);
    const scItems = sc.data?.posts ?? [];
    if (Array.isArray(scItems) && scItems.length) {
      served.reddit = 'scrapecreators.reddit.search.posts';
      return scItems.map((x: any) => mapRedditScrapecreators(x, kw)).filter((p: any): p is RawPost => !!p);
    }
    return [];
  }

  // ── Google / web ───────────────────────────────────────────────────────
  if (platform === 'google') {
    const r = await tregCall('crawl4ai.web.search.rich', {
      ...common,
      query: { q: kw.keyword, rich: 1 },
    });
    record(tally, r, kw.id);
    const items = r.data?.results ?? [];
    if (Array.isArray(items) && items.length) {
      served.google = 'crawl4ai.web.search.rich';
      return items.map((x: any) => mapWeb(x, kw)).filter((p: any): p is RawPost => !!p);
    }
    return [];
  }

  // ── News ───────────────────────────────────────────────────────────────
  if (platform === 'news') {
    const r = await tregCall('tinyfish.web.search.news', {
      ...common,
      query: {
        query: kw.keyword,
        domain_type: 'news',
        after_date: sinceDate(lookbackHours),
      },
    });
    record(tally, r, kw.id);
    const items = r.data?.results ?? [];
    if (Array.isArray(items) && items.length) {
      served.news = 'tinyfish.web.search.news';
      return items.map((x: any) => mapNews(x, kw)).filter((p: any): p is RawPost => !!p);
    }
    return [];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  const userId = await requireUserId(req);
  if (!userId) return fail('Unauthorized', 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // 20 manual sweeps / hour / user, counted in the database so the limit holds
  // across isolates and cold starts.
  if (!(await takeRateLimit(admin, userId, 'social-search', 20, 3600))) {
    return fail('Search rate limit reached. Please try again in a few minutes.', 429);
  }

  if (!await resolveToken(admin)) {
    return fail('Search is not configured on this deployment.', 503);
  }

  // A manual sweep against a dry wallet would burn the user's time and return
  // nothing but errors, so say what is actually wrong.
  const balanceUsd = await tregBalanceUsd();
  if (balanceUsd !== null && balanceUsd < MIN_TREG_BALANCE_USD) {
    console.warn(
      `[social-search] treg balance $${balanceUsd.toFixed(4)} below the $${MIN_TREG_BALANCE_USD} floor.`,
    );
    return fail('Search is temporarily unavailable. Please try again shortly.', 503);
  }

  // Captured BEFORE any search runs. prune_feed() uses this so the batch this
  // sweep is about to write is never deleted by the retention pass.
  const sweepStartedAt = new Date().toISOString();
  const stats: RunStats = { usdSpent: 0, callsMade: 0 };

  // --- Load authoritative user settings (service role bypasses RLS) --------
  let profile: any = null;
  let profileError: any = null;

  ({ data: profile, error: profileError } = await admin
    .from('profiles')
    .select('enabled_channels, lookback_hours, min_intent_threshold')
    .eq('id', userId)
    .maybeSingle());

  if (profileError) {
    console.warn(
      '[social-search] retrying without min_intent_threshold:',
      profileError.message,
    );
    ({ data: profile, error: profileError } = await admin
      .from('profiles')
      .select('enabled_channels, lookback_hours')
      .eq('id', userId)
      .maybeSingle());
  }

  if (profileError) {
    console.error('[social-search] profile lookup failed:', profileError.message);
    return fail('Could not load workspace settings', 500);
  }
  if (!profile) {
    return fail('Workspace profile not found', 404);
  }

  // The plan's ceilings come from sweep_shape(), the same numbers the billing
  // page prices from. Without this a profile edited past the UI could enable
  // every channel and every keyword and the sweep would reserve and run them all.
  const shape = await loadSweepShape(admin);

  const ALL: Platform[] = ['twitter', 'reddit', 'google', 'news'];
  const enabledChannels: Platform[] = (Array.isArray(profile?.enabled_channels)
    ? [...new Set(profile.enabled_channels.filter((c: string): c is Platform => ALL.includes(c as Platform)))] as Platform[]
    : ['twitter', 'reddit', 'google'] as Platform[]
  ).slice(0, shape.maxChannels);
  const lookbackHours = Number(profile?.lookback_hours) || 24;
  const minIntent = Number(profile?.min_intent_threshold) || 0;

  // --- Load the caller's own active keywords ------------------------------
  let keywordQuery = admin
    .from('keywords')
    .select('id, keyword')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(Math.min(MAX_KEYWORDS_PER_SWEEP, shape.maxKeywords));

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* optional body */
  }
  if (typeof body?.keyword === 'string' && body.keyword.trim()) {
    keywordQuery = keywordQuery.eq('keyword', body.keyword.trim().toLowerCase().slice(0, 200));
  }

  const { data: keywordRows, error: kwError } = await keywordQuery;
  if (kwError) {
    console.error('[social-search] keyword lookup failed:', kwError.message);
    return fail('Could not load keywords', 500);
  }

  const keywords = (keywordRows ?? []) as KeywordRow[];
  if (keywords.length === 0) {
    return json({
      ok: true, posts: [], scanned: 0, channels: enabledChannels,
      lookback_hours: lookbackHours, served_by: {},
    });
  }

  const collected: RawPost[] = [];
  const seenUrls = new Set<string>();
  const served: Record<string, string> = {};
  let droppedStale = 0;

  // ---- Price the sweep, then hold it before a single provider call ----------
  //
  // All or nothing. A sweep that ran for six of eight keywords would charge for
  // a truncated search and quietly under-report the results, so a workspace that
  // cannot cover the whole thing gets nothing and a clear message instead.
  const runKey = `ss:${Date.now().toString(36)}:${userId}`;
  const runNonce = runKey.slice(3);

  // Service-role client: pricing_config is no longer readable by clients.
  const pricing = await loadPricing(admin);

  // Realised price per credit, from the live packages. Used for the usage
  // ledger's revenue column so the two records of a charge agree.
  const { data: pkgsForPrice } = await admin
    .from('topup_packages')
    .select('gross_usd, credits')
    .eq('active', true)
    .order('gross_usd')
    .limit(1);
  const pricePerCredit = (pkgsForPrice ?? []).reduce(
    (sum: number, p: { gross_usd: number; credits: number }) => sum + (Number(p.credits) > 0 ? Number(p.gross_usd) / Number(p.credits) : 0),
    0,
  );
  const wanted = [...new Set(enabledChannels.map((c) => OPERATION_OF[c]))]
    .filter((op) => pricing.has(op));

  // A channel with no configured price is not free — it is unavailable. Running
  // it would serve the customer something we cannot bill for.
  const unpriced = enabledChannels.filter((c) => !pricing.has(OPERATION_OF[c]));
  if (unpriced.length > 0) {
    console.warn(`[social-search] no configured price for: ${unpriced.join(', ')}`);
  }

  const creditsPerKeyword = wanted.reduce((sum, op) => sum + (pricing.get(op) ?? 0), 0);
  const creditsRequired = creditsPerKeyword * keywords.length;

  const hold = await reserveSweep(admin, userId, creditsRequired, runKey, {
    scope: 'social-search',
    keywords: keywords.length,
    channels: wanted,
    credits_per_keyword: creditsPerKeyword,
  });

  if ('shortfall' in hold) {
    // Nothing has been called. This is the whole point of reserving first.
    console.warn(
      `[social-search] skipping search for ${userId}: needs ${hold.required} credits, has ${hold.available}`,
    );
    return json({
      ok: false,
      error: 'insufficient_credits',
      required: hold.required,
      available: hold.available,
      shortfall: hold.shortfall,
    }, 402);
  }

  // Exact cutoff. The endpoints only accept coarse windows, so anything that
  // slips in outside the real lookback is dropped here.
  const cutoffMs = Date.now() - lookbackHours * 60 * 60 * 1000;
  const withinLookback = (postedAt: string | null): boolean => {
    if (!postedAt) return true; // source has no date — cannot judge, keep it
    return Date.parse(postedAt) >= cutoffMs;
  };

  const tallies = new Map<string, OperationTally>();
  for (const op of wanted) tallies.set(op, newTally(op));
  const billableChannels = enabledChannels.filter((c) => pricing.has(OPERATION_OF[c]));

  let creditsCharged = 0;
  let providerCostUsd = 0;
  const perOperation: Record<string, number> = {};
  let balanceAfter: number | null = null;
  let charged = false;
  // Set once the hold has been settled or released, so the finally block below
  // only acts on a sweep that threw before reaching that point.
  let holdClosed = false;

  /**
   * Works out what is owed from the tallies, writes the usage rows, then
   * settles (or releases) the hold. Usage is recorded first so a settle that
   * fails still leaves the measured cost on the ledger for reconciliation.
   */
  const closeHold = async (note: string): Promise<void> => {
    if (holdClosed) return;
    holdClosed = true;

    creditsCharged = 0;
    providerCostUsd = 0;
    const charges = new Map<string, { credits: number; revenueUsd: number }>();
    for (const [op, t] of tallies) {
      providerCostUsd += t.costMicro / 1e6;
      // Charged per keyword, not per sweep: price x the number of keywords that
      // had at least one billed or uncertain call on this operation. Keywords
      // whose calls were all free cost nothing, even when another keyword on
      // the same channel was billed.
      const opCredits = (pricing.get(op) ?? 0) * t.chargeableKeywords.size;
      creditsCharged += opCredits;
      perOperation[op] = opCredits;
      // What the usage ledger records, so it carries the same figures the
      // wallet was debited. Revenue at the rate these credits were bought for,
      // which is what wallet_settle works out.
      charges.set(op, { credits: opCredits, revenueUsd: opCredits * pricePerCredit });
    }

    await recordUsage(admin, userId, runKey, tallies, hold.id, charges);

    if (creditsCharged > 0) {
      // Checked. settleSweep returns null when the RPC fails, and this used to
      // set charged = true regardless — the response then said "charged" with
      // balance_after null while the hold stayed put.
      balanceAfter = await settleSweep(
        admin, hold.id, creditsCharged, providerCostUsd, `${runKey}:settle`, note,
      );
      charged = balanceAfter !== null;
    } else {
      // Nothing billable happened: no results, or every call failed in a way
      // treg does not charge for. The hold goes back in full.
      await releaseSweep(admin, hold.id, 'no billable provider calls');
    }
  };

  try {
    for (const kw of keywords) {
      // Channels run in parallel; providers inside a channel run in sequence so
      // a fallback only costs money once the cheaper one has actually failed.
      const perChannel = await Promise.all(
        billableChannels.map((ch) => {
          const tally = tallies.get(OPERATION_OF[ch])!;
          return searchChannel(ch, kw, lookbackHours, served, tally, userId, runNonce, stats);
        }),
      );

      for (const post of perChannel.flat()) {
        if (!withinLookback(post.posted_at)) {
          droppedStale++;
          continue;
        }
        if (post.intent_score < minIntent) continue;

        const normalizedUrl = post.post_url.trim().toLowerCase();
        if (seenUrls.has(normalizedUrl)) continue;
        seenUrls.add(normalizedUrl);
        collected.push(post);
      }
    }

    // ---- Settle for what actually billed ----------------------------------
    //
    // A keyword/channel pair that produced no billable call costs nothing. The
    // customer pays for searches that were paid for, not for the ones that were
    // free or for the retries behind them.
    await closeHold(`${keywords.length} keywords across ${billableChannels.length} channels`);
  } finally {
    // An exception mid-sweep used to leave the hold reserved forever (and the
    // calls already billed unrecorded). Whatever was billed up to the throw is
    // recorded and settled; if nothing was, the hold is released.
    if (!holdClosed) {
      try {
        await closeHold('sweep aborted by an error; charged for calls already billed');
      } catch (err) {
        console.error('[billing] closing hold after error failed:', err);
      }
    }
  }

  // --- Persist to monitored_posts (service role) ---------------------------
  if (collected.length > 0) {
    const rows = collected.map((p) => ({
      user_id: userId,
      keyword_id: p.keyword_id,
      matched_keyword: p.matched_keyword,
      platform: p.platform,
      channel_source: p.channel_source,
      post_url: p.post_url,
      author_name: p.author_name,
      author_handle: p.author_handle,
      author_avatar_url: p.author_avatar_url,
      body: p.body,
      posted_at: p.posted_at,
      intent_score: p.intent_score,
      status: 'new',
      engagement: p.engagement,
    }));

    const { error: upsertError } = await admin
      .from('monitored_posts')
      .upsert(rows, { onConflict: 'user_id,post_url', ignoreDuplicates: true });

    if (upsertError) {
      console.error('[social-search] upsert failed:', upsertError.message);
      return fail('Search succeeded but saving results failed', 500);
    }
  }

  // Provider failures are reported, not swallowed. tregCall never throws — that
  // is deliberate, so a dead provider falls through the chain instead of killing
  // the request — but it also means a sweep where every channel 500s used to
  // return ok: true with an empty feed and no explanation anywhere.
  const providerErrors = [...tallies.values()]
    .flatMap((t) => t.errorCodes.map((code) => ({ operation: t.operation, code })));
  const allCallsFailed =
    providerErrors.length > 0 && [...tallies.values()].every((t) => t.calls > 0 && !t.billed);

  // Measured spend stays server-side: it is our cost price, not the customer's
  // business, and it is already on the api_usage rows.
  console.log(
    `[social-search] ${userId}: ${stats.callsMade} calls, $${stats.usdSpent.toFixed(6)} provider cost`,
  );

  // --- Retention pass ------------------------------------------------------
  const pruned = await pruneOldMentions(admin, userId, sweepStartedAt);

  return json({
    ok: !allCallsFailed,
    // Explicit rather than inferred from an empty feed: "nothing new today" and
    // "the provider was down" look identical to a customer otherwise, and only
    // one of them is worth retrying.
    ...(allCallsFailed
      ? { error: 'search_provider_unavailable', provider_errors: providerErrors.slice(0, 8) }
      : {}),
    posts: collected,
    scanned: keywords.length,
    channels: enabledChannels,
    lookback_hours: lookbackHours,
    dropped_stale: droppedStale,
    pruned,
    served_by: served,
    calls_made: stats.callsMade,
    billing: {
      charged,
      // Surfaced so a client can tell "charged and it worked" from "charged and
      // every call failed", which are the same shape to a reader otherwise.
      provider_errors: providerErrors.slice(0, 8),
      credits_charged: creditsCharged,
      credits_required: creditsRequired,
      per_operation: perOperation,
      balance_after: balanceAfter,
    },
  });
});

/**
 * Plan ceilings from sweep_shape(). Falls back to the smallest plan's numbers
 * rather than to "unlimited" if the RPC is unavailable.
 */
async function loadSweepShape(
  admin: ReturnType<typeof createClient>,
): Promise<{ maxKeywords: number; maxChannels: number }> {
  const fallback = { maxKeywords: FALLBACK_MAX_KEYWORDS, maxChannels: FALLBACK_MAX_CHANNELS };
  try {
    const { data, error } = await admin.rpc('sweep_shape');
    if (error) {
      console.warn('[social-search] sweep_shape failed:', error.message);
      return fallback;
    }
    const k = Number((data as any)?.max_keywords);
    const c = Number((data as any)?.max_channels);
    return {
      maxKeywords: Number.isFinite(k) && k > 0 ? Math.floor(k) : fallback.maxKeywords,
      maxChannels: Number.isFinite(c) && c > 0 ? Math.floor(c) : fallback.maxChannels,
    };
  } catch (err) {
    console.warn('[social-search] sweep_shape threw:', err);
    return fallback;
  }
}

/**
 * Retention pass. Removes mentions older than the workspace's retention window,
 * but never removes anything written by the sweep currently in flight.
 */
async function pruneOldMentions(
  admin: ReturnType<typeof createClient>,
  userId: string,
  keepAfter: string,
): Promise<number> {
  try {
    const { data, error } = await admin.rpc('prune_feed', {
      p_user_id: userId,
      p_keep_after: keepAfter,
    });
    if (error) {
      console.warn('[social-search] prune failed:', error.message);
      return 0;
    }
    return typeof data?.deleted === 'number' ? data.deleted : 0;
  } catch (err) {
    console.warn('[social-search] prune threw:', err);
    return 0;
  }
}
