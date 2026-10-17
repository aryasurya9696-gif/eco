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
// Response:     { ok, posts, scanned, channels, lookback_hours, usd_spent, ... }
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
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

const TREG_BASE = 'https://treg.to';
const MAX_KEYWORDS_PER_SWEEP = 25;

/**
 * treg does not put a cost on the response, so this tracks approximate USD
 * spend per sweep and reports it back for the UI.
 */
// ---------------------------------------------------------------------------
// Rate card — USD per successful provider call.
//
// These are treg's own published prices, not estimates:
//   GET https://treg.to/catalog/endpoints/<id>  ->  endpoint.cost.usd
//
// They set the running total reported at the end of a search, which is the only
// honest read on what the search layer costs to run. Guessing low makes that
// figure a fiction, which is how the twitter rate came to be recorded at less
// than half its real cost.
// ---------------------------------------------------------------------------
const TREG_COST_USD = {
  twitter: 0.00075,        // anyapi.x.search.posts                  observed 2026-09-11
  reddit: 0.001,           // tikhub.x.reddit-app-fetch-dynamic-search rate card 2026-07-28
  redditFallback: 0.00188, // scrapecreators.reddit.search.posts      rate card 2026-07-28
  google: 0.00015,         // crawl4ai.web.search.rich               observed 2026-10-09
  news: 0,                 // tinyfish.web.search.news               rate card 2026-09-23
} as const;



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
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.balance_usd === 'number' ? body.balance_usd : null;
  } catch {
    return null; // unknown balance is not a reason to stop working
  }
}

let usdSpent = 0;
/** Provider calls issued, for the run telemetry. */
let callsMade = 0;

type Platform = 'twitter' | 'reddit' | 'google' | 'news';

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
// treg transport
// ---------------------------------------------------------------------------

/**
 * Calls one catalogued endpoint. treg injects the provider credential server
 * side and relays the upstream body verbatim, so each endpoint keeps its own
 * response shape.
 *
 * Returns null on any failure so the caller falls through to the next provider
 * in the chain instead of failing the whole sweep.
 */
async function tregCall(
  endpointId: string,
  opts: { method?: 'GET' | 'POST'; query?: Record<string, string | number | undefined>; body?: unknown; costUsd: number; timeoutMs?: number },
): Promise<any | null> {
  if (!tregToken) return null;

  const url = new URL(`${TREG_BASE}/call/${endpointId}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const method = opts.method ?? 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  callsMade++;

  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        'X-Treg-Token': tregToken,
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      // treg meters per_success, so a call it declined to serve is free.
      console.warn(`[treg] ${endpointId} -> ${res.status}`);
      return null;
    }

    usdSpent += opts.costUsd;
    return await res.json();
  } catch (err) {
    console.warn(`[treg] ${endpointId} threw:`, (err as Error)?.name);
    return null;
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
  const postUrl = t?.url ?? (t?.id ? `https://x.com/i/status/${t.id}` : null);
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
    author_avatar_url: t?.authorImage ?? null,
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
  const postUrl = p?.url ?? (p?.permalink ? `https://www.reddit.com${p.permalink}` : null);
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
  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'reddit',
    channel_source: d?.subreddit_name ?? d?.subreddit ?? 'r/reddit',
    post_url: String(raw).startsWith('http') ? String(raw) : `https://www.reddit.com${raw}`,
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
  const postUrl = r?.url;
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
  const postUrl = r?.url;
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
): Promise<RawPost[]> {
  // ── Twitter ────────────────────────────────────────────────────────────
  if (platform === 'twitter') {
    const t = await tregCall('anyapi.x.search.posts', {
      method: 'POST',
      // queryType Latest is the whole point: the default returns all-time top
      // posts, which is what put a 2021 tweet into the feed.
      body: { query: kw.keyword, queryType: 'Latest', limit: 20 },
      costUsd: TREG_COST_USD.twitter,
    });
    const items = t?.output?.data?.items ?? [];
    if (items.length) {
      served.twitter = 'anyapi.x.search.posts';
      return items.map((x: any) => mapTwitter(x, kw)).filter((p): p is RawPost => !!p);
    }
    return [];
  }

  // ── Reddit ─────────────────────────────────────────────────────────────
  if (platform === 'reddit') {
    // tikhub is cheapest and fastest but its shared capacity runs out often;
    // scrapecreators is the reliable second and answers in about a second.
    const tk = await tregCall('tikhub.x.reddit-app-fetch-dynamic-search', {
      query: {
        query: kw.keyword,
        search_type: 'post',
        // RELEVANCE, not NEW: sorted by newest, a site-wide search returns
        // whatever matched the tokens rather than posts about the keyword.
        sort: 'RELEVANCE',
        time_range: redditTimeframe(lookbackHours),
        need_format: 'true',
      },
      costUsd: TREG_COST_USD.reddit,
    });
    const tkItems = tk?.data?.posts ?? tk?.posts ?? [];
    if (Array.isArray(tkItems) && tkItems.length) {
      served.reddit = 'tikhub.x.reddit-app-fetch-dynamic-search';
      return tkItems.map((x: any) => mapRedditTikhub(x, kw)).filter((p): p is RawPost => !!p);
    }

    const sc = await tregCall('scrapecreators.reddit.search.posts', {
      query: {
        query: kw.keyword,
        timeframe: redditTimeframe(lookbackHours),
        sort: 'relevance',
        limit: 25,
      },
      costUsd: TREG_COST_USD.redditFallback,
    });
    const scItems = sc?.posts ?? [];
    if (Array.isArray(scItems) && scItems.length) {
      served.reddit = 'scrapecreators.reddit.search.posts';
      return scItems.map((x: any) => mapRedditScrapecreators(x, kw)).filter((p): p is RawPost => !!p);
    }
    return [];
  }

  // ── Google / web ───────────────────────────────────────────────────────
  if (platform === 'google') {
    const r = await tregCall('crawl4ai.web.search.rich', {
      query: { q: kw.keyword, rich: 1 },
      costUsd: TREG_COST_USD.google,
      timeoutMs: 25000,
    });
    const items = r?.results ?? [];
    if (Array.isArray(items) && items.length) {
      served.google = 'crawl4ai.web.search.rich';
      return items.map((x: any) => mapWeb(x, kw)).filter((p): p is RawPost => !!p);
    }
    return [];
  }

  // ── News ───────────────────────────────────────────────────────────────
  if (platform === 'news') {
    const r = await tregCall('tinyfish.web.search.news', {
      query: {
        query: kw.keyword,
        domain_type: 'news',
        after_date: sinceDate(lookbackHours),
      },
      costUsd: TREG_COST_USD.news,
    });
    const items = r?.results ?? [];
    if (Array.isArray(items) && items.length) {
      served.news = 'tinyfish.web.search.news';
      return items.map((x: any) => mapNews(x, kw)).filter((p): p is RawPost => !!p);
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

  if (!rateLimit('search:' + userId, 30, 60 * 60 * 1000)) {
    return fail('Search rate limit reached. Please try again in a few minutes.', 429);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

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
  usdSpent = 0;
  callsMade = 0;

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

  const ALL: Platform[] = ['twitter', 'reddit', 'google', 'news'];
  const enabledChannels: Platform[] = Array.isArray(profile?.enabled_channels)
    ? profile.enabled_channels.filter((c: string): c is Platform => ALL.includes(c as Platform))
    : ['twitter', 'reddit', 'google'];
  const lookbackHours = Number(profile?.lookback_hours) || 24;
  const minIntent = Number(profile?.min_intent_threshold) || 0;

  // --- Load the caller's own active keywords ------------------------------
  let keywordQuery = admin
    .from('keywords')
    .select('id, keyword')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(MAX_KEYWORDS_PER_SWEEP);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* optional body */
  }
  if (typeof body?.keyword === 'string' && body.keyword.trim()) {
    keywordQuery = keywordQuery.eq('keyword', body.keyword.trim().toLowerCase());
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
      lookback_hours: lookbackHours, usd_spent: 0, served_by: {},
    });
  }

  const collected: RawPost[] = [];
  const seenUrls = new Set<string>();
  const served: Record<string, string> = {};
  let droppedStale = 0;

  // Exact cutoff. The endpoints only accept coarse windows, so anything that
  // slips in outside the real lookback is dropped here.
  const cutoffMs = Date.now() - lookbackHours * 60 * 60 * 1000;
  const withinLookback = (postedAt: string | null): boolean => {
    if (!postedAt) return true; // source has no date — cannot judge, keep it
    return Date.parse(postedAt) >= cutoffMs;
  };

  for (const kw of keywords) {
    // Channels run in parallel; providers inside a channel run in sequence so a
    // fallback only costs money once the cheaper one has actually failed.
    const perChannel = await Promise.all(
      enabledChannels.map((ch) => searchChannel(ch, kw, lookbackHours, served)),
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

  // --- Retention pass ------------------------------------------------------
  const pruned = await pruneOldMentions(admin, userId, sweepStartedAt);

  return json({
    ok: true,
    posts: collected,
    scanned: keywords.length,
    channels: enabledChannels,
    lookback_hours: lookbackHours,
    dropped_stale: droppedStale,
    pruned,
    served_by: served,
  });
});

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
