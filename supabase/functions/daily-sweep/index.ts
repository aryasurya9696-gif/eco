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
// SWEEP_CRON_SECRET header (pg_net / dashboard schedule / your own cron).
//
// NOTE: this file is intentionally SELF-CONTAINED. Do not split shared helpers
// into an underscore-prefixed folder — Supabase's bundler skips `_`-prefixed
// directories and the relative import fails to resolve on deploy.
//
// Deploy:  supabase functions deploy daily-sweep --no-verify-jwt
// Secrets: supabase secrets set SWEEP_CRON_SECRET=<long random string>
//          supabase secrets set TREG_TOKEN=treg_...
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * Gate value for the cron caller. The edge secret wins; otherwise it is read
 * from public.service_secrets alongside the provider token, so a pg_cron job
 * can be wired up without first provisioning a Supabase edge secret.
 */
let SWEEP_CRON_SECRET = Deno.env.get('SWEEP_CRON_SECRET') || '';

const TREG_BASE = 'https://treg.to';

/** Hard caps so one busy day can never run away. */
const MAX_USERS_PER_RUN = 500;
// Must equal public.plan_max_keywords(). A workspace cannot be given more
// keywords than this, so anything higher would be dead headroom.
const MAX_KEYWORDS_PER_USER = 40;

type Platform = 'twitter' | 'reddit' | 'google' | 'news';

type SweepSettings = {
  enabled_channels: Platform[] | null;
  lookback_hours: number | null;
  min_intent_threshold: number | null;
  /** "HH:MM" in UTC. Null means the workspace never opted in. */
  sweep_time_utc: string | null;
  /** '6h' | '12h' | '24h'. Anything else is treated as '24h'. */
  sweep_frequency: string | null;
  subscription_plan: string | null;
};

/**
 * Plan limits. MUST stay in sync with SUBSCRIPTION_PLANS in
 * src/lib/billing.ts -- the client already hides the options a plan cannot
 * buy, but this is the authority that actually enforces them.
 */
const PLAN_MIN_SWEEP_HOURS: Record<string, number> = {
  starter: 24,
  pro: 12,
  scale: 6,
};

const PLAN_MAX_CHANNELS: Record<string, number> = {
  starter: 3,
  pro: 4,
  scale: 4,
};

/** Interval length in hours for a stored cadence string. */
function cadenceHoursOf(frequency: string | null | undefined): number {
  if (frequency === '6h') return 6;
  if (frequency === '12h') return 12;
  return 24;
}

/**
 * Parses the workspace's "HH:MM" sweep time into an hour of day.
 * Returns null when unset or malformed, which the caller treats as "any hour".
 */
function sweepHourOf(sweepTime: string | null | undefined): number | null {
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
 *
 * `cadenceHours` must already be clamped to the plan's fastest allowed
 * interval, otherwise a downgraded workspace keeps its old aggressive cadence.
 */
function isSweepDue(currentHourUtc: number, sweepHour: number, cadenceHours: number): boolean {
  if (cadenceHours >= 24) return currentHourUtc === sweepHour;
  return currentHourUtc % cadenceHours === sweepHour % cadenceHours;
}

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
// Rate card — USD per successful provider call.
//
// These are treg's own published prices, not estimates:
//   GET https://treg.to/catalog/endpoints/<id>  ->  endpoint.cost.usd
//
// They matter twice over: they set the running total reported at the end of a
// sweep, and they are what the plan limits in public.plan_keyword_limit() are
// sized against. Guessing low here makes every margin figure a fiction, which
// is how the twitter rate came to be recorded at less than half its real cost.
//
// Keep in step with supabase/migrations/20261024_billing_economics.sql.
// ---------------------------------------------------------------------------
const TREG_COST_USD = {
  twitter: 0.00075,        // anyapi.x.search.posts                  observed 2026-09-11
  reddit: 0.001,           // tikhub.x.reddit-app-fetch-dynamic-search rate card 2026-07-28
  redditFallback: 0.00188, // scrapecreators.reddit.search.posts      rate card 2026-07-28
  google: 0.00015,         // crawl4ai.web.search.rich               observed 2026-10-09
  news: 0,                 // tinyfish.web.search.news               rate card 2026-09-23
} as const;

// Credits charged per successful call. These are the customer-facing prices and
// live in public.billing_config under 'operation_pricing' so an admin can
// retune them without a deploy; the values here are only the fallback used when
// the config row is missing.
//
// The ratio between credits and cost is what sets the margin on each call. At
// 20 credits per dollar one credit is $0.05, so a Reddit call at 2 credits
// ($0.10) against a $0.00288 cost is a 97% margin.
const DEFAULT_CREDITS_PER_OPERATION: Record<string, number> = {
  sweep_call_twitter: 1,
  sweep_call_reddit: 2,
  sweep_call_google: 1,
  sweep_call_news: 0,
};

let operationCredits: Record<string, number> = { ...DEFAULT_CREDITS_PER_OPERATION };

/** Accumulators, reset per run. */
let creditsCharged = 0;
const perOperation = new Map<string, { calls: number; credits: number; costUsd: number }>();

function tally(operation: string, costUsd: number) {
  creditsCharged += operationCredits[operation] ?? 0;
  const row = perOperation.get(operation) ?? { calls: 0, credits: 0, costUsd: 0 };
  row.calls += 1;
  row.credits += operationCredits[operation] ?? 0;
  row.costUsd += costUsd;
  perOperation.set(operation, row);
}

function resetCreditCounters() {
  creditsCharged = 0;
  perOperation.clear();
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
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.balance_usd === 'number' ? body.balance_usd : null;
  } catch {
    return null; // unknown balance is not a reason to stop working
  }
}

let usdSpent = 0;
/** usdSpent sampled before the current workspace starts, so its cost can be attributed. */
let usdSpentBefore = 0;
/** Provider calls actually issued, for the spend ledger. */
let callsMade = 0;

async function tregCall(
  endpointId: string,
  opts: { method?: 'GET' | 'POST'; query?: Record<string, string | number | undefined>; body?: unknown; costUsd: number; operation: string; timeoutMs?: number },
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
      // Counting it would overstate cost, which is the safer direction but
      // still wrong to report.
      console.warn(`[treg] ${endpointId} -> ${res.status}`);
      return null;
    }

    usdSpent += opts.costUsd;
    tally(opts.operation, opts.costUsd);
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

function row(input: Omit<PostRow, 'status'>): PostRow {
  return { ...input, status: 'new' };
}

function mapTwitter(t: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = t?.url ?? (t?.id ? `https://x.com/i/status/${t.id}` : null);
  if (!postUrl) return null;
  const handle = t?.authorUsername ? `@${String(t.authorUsername).replace(/^@/, '')}` : null;
  const body = t?.text ?? null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'twitter',
    channel_source: 'X / Twitter', post_url: postUrl,
    author_name: t?.authorName ?? null, author_handle: handle,
    author_avatar_url: t?.authorImage ?? null, body,
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
  const postUrl = p?.url ?? (p?.permalink ? `https://www.reddit.com${p.permalink}` : null);
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
  const body = `${d?.title || ''} ${d?.selftext || ''}`.trim() || null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'reddit',
    channel_source: d?.subreddit_name ?? d?.subreddit ?? 'r/reddit',
    post_url: String(raw).startsWith('http') ? String(raw) : `https://www.reddit.com${raw}`,
    author_name: d?.author ?? null,
    author_handle: d?.author ? `@${d.author}` : null, author_avatar_url: null, body,
    posted_at: parseWhen(d?.created_at ?? d?.created_utc ?? d?.post_time),
    intent_score: calculateIntentScore(body || ''),
    engagement: { likes: d?.upvote ?? d?.score ?? null, comments: d?.comment_count ?? null },
  });
}

function mapWeb(r: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = r?.url;
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
  const postUrl = r?.url;
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
): Promise<PostRow[]> {
  const kwId = kwRow.id;
  const kw = kwRow.keyword;

  if (platform === 'twitter') {
    const t = await tregCall('anyapi.x.search.posts', {
      method: 'POST',
      // Latest, not the default: the default returns all-time top posts, which
      // is what once put a 2021 tweet into the feed.
      body: { query: kw, queryType: 'Latest', limit: 20 },
      costUsd: TREG_COST_USD.twitter,
      operation: 'sweep_call_twitter',
    });
    const items = t?.output?.data?.items ?? [];
    return items.length
      ? items.map((x: any) => mapTwitter(x, userId, kwId, kw)).filter((r): r is PostRow => !!r)
      : [];
  }

  if (platform === 'reddit') {
    const tk = await tregCall('tikhub.x.reddit-app-fetch-dynamic-search', {
      query: {
        query: kw, search_type: 'post',
        // RELEVANCE, not NEW: sorted by newest, a site-wide search returns
        // whatever matched the tokens rather than posts about the keyword.
        sort: 'RELEVANCE', time_range: redditTimeframe(lookbackHours), need_format: 'true',
      },
      costUsd: TREG_COST_USD.reddit,
      operation: 'sweep_call_reddit',
    });
    const tkItems = tk?.data?.posts ?? tk?.posts ?? [];
    if (Array.isArray(tkItems) && tkItems.length) {
      return tkItems.map((x: any) => mapRedditTikhub(x, userId, kwId, kw)).filter((r): r is PostRow => !!r);
    }

    const sc = await tregCall('scrapecreators.reddit.search.posts', {
      query: { query: kw, timeframe: redditTimeframe(lookbackHours), sort: 'relevance', limit: 25 },
      costUsd: TREG_COST_USD.redditFallback,
      operation: 'sweep_call_reddit',
    });
    const scItems = sc?.posts ?? [];
    return Array.isArray(scItems) && scItems.length
      ? scItems.map((x: any) => mapRedditScrapecreators(x, userId, kwId, kw)).filter((r): r is PostRow => !!r)
      : [];
  }

  if (platform === 'google') {
    const r = await tregCall('crawl4ai.web.search.rich', { query: { q: kw, rich: 1 }, costUsd: TREG_COST_USD.google,
      operation: 'sweep_call_google', timeoutMs: 25000 });
    const items = r?.results ?? [];
    return Array.isArray(items) && items.length
      ? items.map((x: any) => mapWeb(x, userId, kwId, kw)).filter((r2): r2 is PostRow => !!r2)
      : [];
  }

  if (platform === 'news') {
    const r = await tregCall('tinyfish.web.search.news', {
      query: { query: kw, domain_type: 'news', after_date: sinceDate(lookbackHours) },
      costUsd: TREG_COST_USD.news,
      operation: 'sweep_call_news',
    });
    const items = r?.results ?? [];
    return Array.isArray(items) && items.length
      ? items.map((x: any) => mapNews(x, userId, kwId, kw)).filter((r2): r2 is PostRow => !!r2)
      : [];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const provided =
    req.headers.get('x-sweep-secret') ??
    new URL(req.url).searchParams.get('secret') ??
    '';

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Edge secrets win; fall back to the service-role-only secrets table. This is
  // resolved before the gate check below so a deployment that only has the
  // table configured still authenticates its own cron caller.
  if (!SWEEP_CRON_SECRET || !tregToken) {
    const { data: secrets } = await supabase
      .from('service_secrets')
      .select('name, value');
    for (const s of secrets ?? []) {
      if (s.name === 'sweep_cron_secret' && !SWEEP_CRON_SECRET) SWEEP_CRON_SECRET = s.value;
      if (s.name === 'treg_token' && !tregToken) tregToken = s.value;
    }
  }

  if (!SWEEP_CRON_SECRET) {
    console.error('SWEEP_CRON_SECRET is not configured — refusing to run.');
    return json({ ok: false, error: 'sweep not configured' }, 503);
  }

  if (provided !== SWEEP_CRON_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  if (!tregToken) {
    return json({ ok: false, error: 'search provider not configured' }, 503);
  }

  // An empty treg wallet turns every scheduled sweep into a burst of 503s that
  // reads like a provider outage. One clear refusal is cheaper to diagnose.
  const balanceUsd = await tregBalanceUsd();
  if (balanceUsd !== null && balanceUsd < MIN_TREG_BALANCE_USD) {
    console.error(
      `[sweep] treg balance $${balanceUsd.toFixed(4)} is below the $${MIN_TREG_BALANCE_USD} floor — skipping this run.`,
    );
    return json(
      {
        ok: false,
        error: 'insufficient_provider_credit',
        balanceUsd,
        requiredUsd: MIN_TREG_BALANCE_USD,
      },
      503,
    );
  }

  // Captured before any network work so the retention pass at the end of each
  // user's sweep cannot delete the results that sweep just produced.
  const sweepStartedAt = new Date().toISOString();
  usdSpent = 0;
  usdSpentBefore = 0;
  callsMade = 0;
  resetCreditCounters();

  // Credit prices are admin-tunable, so read them rather than trusting the
  // compiled-in defaults. A failure here is not fatal: the defaults are the
  // published list prices.
  try {
    const { data: cfg } = await supabase
      .from('billing_config')
      .select('value')
      .eq('key', 'operation_pricing')
      .maybeSingle();
    const configured: Record<string, number> = {};
    for (const [key, entry] of Object.entries(cfg?.value ?? {})) {
      const credits = Number((entry as any)?.credits);
      if (Number.isFinite(credits)) configured[key] = credits;
    }
    if (Object.keys(configured).length > 0) {
      operationCredits = { ...DEFAULT_CREDITS_PER_OPERATION, ...configured };
    }
  } catch {
    // Keep the defaults.
  }

  const { data: runRow } = await supabase.from('sweep_runs').insert({}).select().single();
  const runId = runRow?.id;

  const errors: Array<Record<string, string>> = [];
  let usersProcessed = 0;
  let usersSkipped = 0;
  let postsInserted = 0;
  let pruned = 0;
  let totalStale = 0;

  const { data: keywords, error: keywordsError } = await supabase
    .from('keywords')
    .select('id, user_id, keyword')
    .eq('is_active', true);

  if (keywordsError) {
    if (runId) {
      await supabase
        .from('sweep_runs')
        .update({
          finished_at: new Date().toISOString(),
          errors: [{ stage: 'keywords', message: keywordsError.message }],
        })
        .eq('id', runId);
    }
    return json({ ok: false, error: keywordsError.message }, 500);
  }

  const byUser = new Map<string, Array<{ id: string; keyword: string }>>();
  for (const kw of keywords ?? []) {
    const list = byUser.get(kw.user_id) ?? [];
    if (list.length < MAX_KEYWORDS_PER_USER) list.push(kw);
    byUser.set(kw.user_id, list);
  }

  const userIds = [...byUser.keys()].slice(0, MAX_USERS_PER_RUN);
  if (userIds.length < byUser.size) {
    errors.push({
      stage: 'cap',
      message: `Run capped at ${MAX_USERS_PER_RUN} users; ${byUser.size - MAX_USERS_PER_RUN} deferred.`,
    });
  }

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, enabled_channels, lookback_hours, min_intent_threshold, sweep_time_utc, sweep_frequency, subscription_plan')
    .in('id', userIds);

  const settingsByUser = new Map<string, SweepSettings>();
  for (const p of profiles ?? []) {
    settingsByUser.set(p.id, {
      enabled_channels: p.enabled_channels,
      lookback_hours: p.lookback_hours,
      min_intent_threshold: p.min_intent_threshold,
      sweep_time_utc: p.sweep_time_utc,
      sweep_frequency: p.sweep_frequency,
      subscription_plan: p.subscription_plan,
    });
  }

  // The cron fires every hour and each workspace is swept only in the hours its
  // own hour + cadence make due, so "every day at 06:00 UTC" in Settings is
  // actually true.
  const currentHourUtc = new Date().getUTCHours();

  for (const userId of userIds) {
    const userKeywords = byUser.get(userId) ?? [];
    if (userKeywords.length === 0) continue;

    const settings = settingsByUser.get(userId);
    const plan = settings?.subscription_plan ?? 'starter';

    // A plan caps how often a workspace may sweep. Clamp upwards so a
    // downgraded workspace slows back down instead of keeping the faster
    // cadence it bought on the old plan.
    const planMinHours = PLAN_MIN_SWEEP_HOURS[plan] ?? 24;
    const cadenceHours = Math.max(cadenceHoursOf(settings?.sweep_frequency), planMinHours);

    // Respect the workspace's own sweep hour. Checked before the processed
    // counter so the two numbers mean what they say.
    const dueHour = sweepHourOf(settings?.sweep_time_utc);
    if (dueHour !== null && !isSweepDue(currentHourUtc, dueHour, cadenceHours)) {
      usersSkipped++;
      continue;
    }

    usersProcessed++;

    // Everything this workspace spends from here on is attributed to it, which
    // is what makes the per-workspace margin figure real.
    usdSpentBefore = usdSpent;
    const callsBefore = callsMade;
    resetCreditCounters();

    const ALL: Platform[] = ['twitter', 'reddit', 'google', 'news'];
    const requested: Platform[] = Array.isArray(settings?.enabled_channels) && settings.enabled_channels.length > 0
      ? settings.enabled_channels.filter((c): c is Platform => ALL.includes(c as Platform))
      : ['twitter', 'reddit', 'google'];
    // A plan also caps how many channels may be scanned. The Settings UI stops
    // the over-limit selection from being made; this is the backstop.
    const channels: Platform[] = requested.slice(0, PLAN_MAX_CHANNELS[plan] ?? 2);
    const lookbackHours = Number(settings?.lookback_hours) || 24;
    const minIntent = Number(settings?.min_intent_threshold) || 0;
    const cutoffMs = Date.now() - lookbackHours * 60 * 60 * 1000;
    let droppedStale = 0;

    const rowsToUpsert: PostRow[] = [];
    const seenUrls = new Set<string>();

    for (const kw of userKeywords) {
      const perChannel = await Promise.all(
        channels.map((ch) => searchChannel(ch, kw, userId, lookbackHours)),
      );

      for (const r of perChannel.flat()) {
        // Exact cutoff: the endpoints only accept coarse windows, so drop
        // anything outside the real lookback. Rows with no date cannot be
        // judged and are kept.
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

    if (rowsToUpsert.length > 0) {
      const { error: upsertError } = await supabase
        .from('monitored_posts')
        .upsert(rowsToUpsert, { onConflict: 'user_id,post_url', ignoreDuplicates: true });

      if (upsertError) {
        errors.push({ user: userId, kw: '*', platform: '*', message: upsertError.message });
      } else {
        postsInserted += rowsToUpsert.length;
      }
    }

    // Retention pass for this user. sweepStartedAt keeps this sweep's results.
    try {
      const { data: prune, error: pruneError } = await supabase.rpc('prune_feed', {
        p_user_id: userId,
        p_keep_after: sweepStartedAt,
      });
      if (pruneError) {
        errors.push({ user: userId, kw: '*', platform: 'prune', message: pruneError.message });
      } else if (typeof prune?.deleted === 'number' && prune.deleted > 0) {
        pruned += prune.deleted;
      }
    } catch (pruneErr) {
      errors.push({ user: userId, kw: '*', platform: 'prune', message: String(pruneErr) });
    }

    // ---- settle the credit meter for this workspace -----------------------
    // One call, carrying the per-channel breakdown in metadata, rather than one
    // per provider call. Overdraft is allowed so a workspace keeps working while
    // a top-up settles; the shortfall shows up as a negative balance and is
    // visible on the billing page instead of silently producing an empty feed.
    const userUsd = Number((usdSpent - usdSpentBefore).toFixed(6));
    const userCalls = callsMade - callsBefore;
    const breakdown = Object.fromEntries(perOperation);

    if (userCalls > 0) {
      try {
        const { data: settled } = await supabase.rpc('spend_credits', {
          p_user_id: userId,
          p_credits: creditsCharged,
          p_operation: 'sweep',
          p_service_cost_usd: userUsd,
          p_calls: userCalls,
          p_provider: 'treg',
          p_provider_ref: runId ?? null,
          p_allow_overdraft: true,
          p_idempotency_key: runId ? `sweep:${runId}:${userId}` : null,
          p_metadata: { byOperation: breakdown, runId },
        });

        if (settled?.shortfall > 0) {
          errors.push({
            user: userId,
            kw: '*',
            platform: 'credits',
            message: `Credit balance short by ${settled.shortfall} after this sweep.`,
          });
        }
      } catch (spendErr) {
        errors.push({ user: userId, kw: '*', platform: 'credits', message: String(spendErr) });
      }
    }

    totalStale += droppedStale;
  }

  if (runId) {
    await supabase
      .from('sweep_runs')
      .update({
        finished_at: new Date().toISOString(),
        users_processed: usersProcessed,
        posts_inserted: postsInserted,
        usd_spent: Number(usdSpent.toFixed(6)),
        errors,
      })
      .eq('id', runId);
  }

  return json({
    ok: true,
    hourUtc: currentHourUtc,
    usersProcessed,
    usersSkipped,
    postsInserted,
    droppedStale: totalStale,
    pruned,
    usdSpent: Number(usdSpent.toFixed(6)),
    callsMade,
    balanceUsd,
    errorCount: errors.length,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}