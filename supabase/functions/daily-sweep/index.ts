// ============================================================================
// Supabase Edge Function: daily-sweep
// ----------------------------------------------------------------------------
// Scheduled fan-out sweep across every user with active keywords.
//
// Uses the same treg-first / SocialFetch-fallback chains as `social-search`,
// inlined rather than imported — see the note below.
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
//          supabase secrets set SOCIALFETCH_API_KEY=sfk_...
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SWEEP_CRON_SECRET = Deno.env.get('SWEEP_CRON_SECRET') || '';

const TREG_BASE = 'https://treg.to';
const SOCIALFETCH_BASE = 'https://api.socialfetch.dev';

/** Hard caps so one busy day can never run away. */
const MAX_PAGES_PER_KEYWORD = 2;
const MAX_USERS_PER_RUN = 500;
const MAX_KEYWORDS_PER_USER = 25;

type Platform = 'twitter' | 'reddit' | 'google' | 'linkedin' | 'news';

type SweepSettings = {
  enabled_channels: Platform[] | null;
  lookback_hours: number | null;
  min_intent_threshold: number | null;
};

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
// Credentials — edge secrets first, then public.service_secrets (service-role
// only; that table has RLS on and zero policies so the browser cannot read it)
// ---------------------------------------------------------------------------

let tregToken = Deno.env.get('TREG_TOKEN') || '';
let socialFetchKey = Deno.env.get('SOCIALFETCH_API_KEY') || '';

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
 * analytics software". The endpoint returns no date field, so this is the only
 * signal available.
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

function datePosted(lookbackHours: number): string {
  if (lookbackHours <= 1) return 'last-hour';
  if (lookbackHours <= 24) return 'last-day';
  if (lookbackHours <= 168) return 'last-week';
  if (lookbackHours <= 720) return 'last-month';
  return 'last-year';
}

function sinceDate(lookbackHours: number): string {
  return new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let usdSpent = 0;
let sfCreditsSpent = 0;

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
    usdSpent += opts.costUsd;

    if (!res.ok) {
      console.warn(`[treg] ${endpointId} -> ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[treg] ${endpointId} threw:`, (err as Error)?.name);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function socialFetchGet(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<any | null> {
  if (!socialFetchKey) return null;

  const url = new URL(SOCIALFETCH_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { 'x-api-key': socialFetchKey, Accept: 'application/json' },
    });
    sfCreditsSpent += 1;
    if (!res.ok) {
      console.warn(`[socialfetch] ${path} -> ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[socialfetch] ${path} threw:`, (err as Error)?.name);
    return null;
  }
}

async function socialFetchPaged(
  path: string,
  params: Record<string, string | number | undefined>,
  paginate: 'cursor' | 'page',
): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  let pageNo = 1;

  for (let i = 0; i < MAX_PAGES_PER_KEYWORD; i++) {
    const query: Record<string, string | number | undefined> = { ...params };
    if (paginate === 'page') query.page = pageNo;
    else if (cursor) query.cursor = cursor;

    const body = await socialFetchGet(path, query);
    if (!body) break;

    const data = body.data ?? {};
    const items = data.tweets ?? data.posts ?? data.results ?? [];
    if (!Array.isArray(items) || items.length === 0) break;

    results.push(...items);

    const pg = data.page ?? {};
    if (!pg.hasMore) break;
    if (paginate === 'page') {
      const next = typeof pg.nextPage === 'number' ? pg.nextPage : pageNo + 1;
      if (next <= pageNo) break;
      pageNo = next;
    } else {
      if (!pg.nextCursor || pg.nextCursor === cursor) break;
      cursor = pg.nextCursor;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function row(input: Omit<PostRow, 'status'>): PostRow {
  return { ...input, status: 'new' };
}

function mapTregTwitter(t: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = t?.url ?? (t?.id ? `https://x.com/i/status/${t.id}` : null);
  if (!postUrl) return null;
  const handle = t?.authorUsername ? `@${String(t.authorUsername).replace(/^@/, '')}` : null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'twitter',
    channel_source: 'X / Twitter', post_url: postUrl,
    author_name: t?.authorName ?? null, author_handle: handle,
    author_avatar_url: t?.authorImage ?? null, body: t?.text ?? null,
    posted_at: parseWhen(t?.createdUtc ?? t?.createdAt),
    intent_score: calculateIntentScore(t?.text || ''),
    engagement: {
      likes: t?.likeCount ?? null, retweets: t?.retweetCount ?? null,
      replies: t?.replyCount ?? null, quotes: t?.quoteCount ?? null,
      views: t?.viewCount ?? null, author_followers: t?.authorFollowers ?? null,
    },
  });
}

function mapTregRedditSc(p: any, userId: string, kwId: string, kw: string): PostRow | null {
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

function mapTregRedditTikhub(p: any, userId: string, kwId: string, kw: string): PostRow | null {
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

function mapTregWeb(r: any, userId: string, kwId: string, kw: string): PostRow | null {
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

function mapTregNews(r: any, userId: string, kwId: string, kw: string): PostRow | null {
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

function mapSfTwitter(t: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = t?.url ?? (t?.id ? `https://x.com/i/status/${t.id}` : null);
  if (!postUrl) return null;
  const body = t?.text ?? null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'twitter',
    channel_source: 'X / Twitter', post_url: postUrl,
    author_name: t?.author?.displayName ?? null,
    author_handle: t?.author?.handle ? `@${t.author.handle}` : null,
    author_avatar_url: t?.author?.avatarUrl ?? null, body,
    posted_at: parseWhen(t?.createdAt),
    intent_score: calculateIntentScore(body || ''),
    engagement: {
      likes: t?.metrics?.likes ?? null, retweets: t?.metrics?.retweets ?? null,
      replies: t?.metrics?.replies ?? null, views: t?.metrics?.views ?? null,
    },
  });
}

function mapSfReddit(p: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = p?.permalink ?? p?.url ?? null;
  if (!postUrl) return null;
  const body = `${p?.title || ''} ${p?.bodyText || ''}`.trim() || null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'reddit',
    channel_source: p?.subredditPrefixedName ?? (p?.subreddit ? `r/${p.subreddit}` : 'r/reddit'),
    post_url: postUrl,
    author_name: p?.author ? `u/${p.author}` : 'u/anonymous',
    author_handle: p?.author ? `@${p.author}` : null, author_avatar_url: null, body,
    posted_at: parseWhen(p?.createdAt),
    intent_score: calculateIntentScore(body || ''),
    engagement: { likes: p?.score ?? null, comments: p?.commentCount ?? null },
  });
}

function mapSfWeb(r: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = r?.url;
  if (!postUrl) return null;
  let domain = 'Web';
  try {
    domain = new URL(postUrl).hostname.replace(/^www\./, '');
  } catch { /* keep default */ }
  const body = `${r?.title ?? ''} — ${r?.content ?? ''}`.trim() || null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'google',
    channel_source: domain, post_url: postUrl,
    author_name: r?.title ?? domain, author_handle: `@${domain}`,
    author_avatar_url: null, body,
    posted_at: parseWhen(r?.publishedAt ?? r?.date),
    intent_score: calculateIntentScore(body || ''),
    engagement: { likes: null, comments: null },
  });
}

function mapSfLinkedIn(p: any, userId: string, kwId: string, kw: string): PostRow | null {
  const postUrl = p?.url ?? p?.permalink;
  if (!postUrl) return null;
  const handle = p?.author?.profileUrl ? p.author.profileUrl.split('/in/')[1] : null;
  const body = `${p?.title ?? ''} ${p?.text ?? ''}`.trim() || null;
  return row({
    user_id: userId, keyword_id: kwId, matched_keyword: kw, platform: 'linkedin',
    channel_source: 'LinkedIn', post_url: postUrl,
    author_name: p?.author?.name ?? null,
    author_handle: handle ? `@${handle}` : null,
    author_avatar_url: p?.author?.avatarUrl ?? null, body,
    posted_at: parseWhen(p?.publishedAt),
    intent_score: calculateIntentScore(body || ''),
    engagement: {
      likes: p?.metrics?.reactions ?? null, comments: p?.metrics?.comments ?? null,
      author_followers: p?.author?.followers ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Per-channel provider chains
// ---------------------------------------------------------------------------

/**
 * Providers are tried in order and the first one that returns rows wins, so a
 * fallback only costs money once the cheaper option has actually failed. This
 * is not hypothetical: treg answers 503 provider_capacity_unavailable when the
 * vendor it prefers is busy.
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
      costUsd: 0.0004,
    });
    const items = t?.output?.data?.items ?? [];
    if (items.length) {
      return items.map((x: any) => mapTregTwitter(x, userId, kwId, kw)).filter((r): r is PostRow => !!r);
    }
    const sf = await socialFetchPaged('/v1/twitter/search', { query: kw, section: 'latest' }, 'cursor');
    return sf.length
      ? sf.map((x: any) => mapSfTwitter(x, userId, kwId, kw)).filter((r): r is PostRow => !!r)
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
      costUsd: 0.001,
    });
    const tkItems = tk?.data?.posts ?? tk?.posts ?? [];
    if (Array.isArray(tkItems) && tkItems.length) {
      return tkItems.map((x: any) => mapTregRedditTikhub(x, userId, kwId, kw)).filter((r): r is PostRow => !!r);
    }

    const sc = await tregCall('scrapecreators.reddit.search.posts', {
      query: { query: kw, timeframe: redditTimeframe(lookbackHours), sort: 'relevance', limit: 25 },
      costUsd: 0.00188,
    });
    const scItems = sc?.posts ?? [];
    if (Array.isArray(scItems) && scItems.length) {
      return scItems.map((x: any) => mapTregRedditSc(x, userId, kwId, kw)).filter((r): r is PostRow => !!r);
    }

    const sf = await socialFetchPaged(
      '/v1/reddit/search',
      { query: kw, timeframe: redditTimeframe(lookbackHours), sortBy: 'relevance' },
      'cursor',
    );
    return sf.length
      ? sf.map((x: any) => mapSfReddit(x, userId, kwId, kw)).filter((r): r is PostRow => !!r)
      : [];
  }

  if (platform === 'google') {
    const r = await tregCall('crawl4ai.web.search.rich', { query: { q: kw, rich: 1 }, costUsd: 0.00015, timeoutMs: 25000 });
    const items = r?.results ?? [];
    if (Array.isArray(items) && items.length) {
      return items.map((x: any) => mapTregWeb(x, userId, kwId, kw)).filter((r2): r2 is PostRow => !!r2);
    }
    const sf = await socialFetchPaged('/v1/web/search', { query: kw, datePosted: datePosted(lookbackHours) }, 'page');
    return sf.length
      ? sf.map((x: any) => mapSfWeb(x, userId, kwId, kw)).filter((r2): r2 is PostRow => !!r2)
      : [];
  }

  if (platform === 'linkedin') {
    // treg has no keyword search for LinkedIn posts — only per-profile fetches.
    const sf = await socialFetchPaged('/v1/linkedin/posts/search', { query: kw, datePosted: datePosted(lookbackHours) }, 'cursor');
    return sf.length
      ? sf.map((x: any) => mapSfLinkedIn(x, userId, kwId, kw)).filter((r2): r2 is PostRow => !!r2)
      : [];
  }

  if (platform === 'news') {
    const r = await tregCall('tinyfish.web.search.news', {
      query: { query: kw, domain_type: 'news', after_date: sinceDate(lookbackHours) },
      costUsd: 0,
    });
    const items = r?.results ?? [];
    return Array.isArray(items) && items.length
      ? items.map((x: any) => mapTregNews(x, userId, kwId, kw)).filter((r2): r2 is PostRow => !!r2)
      : [];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  // --- Gate: shared secret required ---------------------------------------
  if (!SWEEP_CRON_SECRET) {
    console.error('SWEEP_CRON_SECRET is not set — refusing to run.');
    return json({ ok: false, error: 'sweep not configured' }, 503);
  }

  const provided =
    req.headers.get('x-sweep-secret') ??
    new URL(req.url).searchParams.get('secret') ??
    '';
  if (provided !== SWEEP_CRON_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Edge secrets win; fall back to the service-role-only secrets table.
  if (!tregToken || !socialFetchKey) {
    const { data: secrets } = await supabase.from('service_secrets').select('name, value');
    for (const s of secrets ?? []) {
      if (s.name === 'treg_token' && !tregToken) tregToken = s.value;
      if (s.name === 'socialfetch_api_key' && !socialFetchKey) socialFetchKey = s.value;
    }
  }

  if (!tregToken && !socialFetchKey) {
    return json({ ok: false, error: 'no search provider configured' }, 503);
  }

  // Captured before any network work so the retention pass at the end of each
  // user's sweep cannot delete the results that sweep just produced.
  const sweepStartedAt = new Date().toISOString();
  usdSpent = 0;
  sfCreditsSpent = 0;

  const { data: runRow } = await supabase.from('sweep_runs').insert({}).select().single();
  const runId = runRow?.id;

  const errors: Array<Record<string, string>> = [];
  let usersProcessed = 0;
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
    .select('id, enabled_channels, lookback_hours, min_intent_threshold')
    .in('id', userIds);

  const settingsByUser = new Map<string, SweepSettings>();
  for (const p of profiles ?? []) {
    settingsByUser.set(p.id, {
      enabled_channels: p.enabled_channels,
      lookback_hours: p.lookback_hours,
      min_intent_threshold: p.min_intent_threshold,
    });
  }

  for (const userId of userIds) {
    const userKeywords = byUser.get(userId) ?? [];
    if (userKeywords.length === 0) continue;

    usersProcessed++;

    const settings = settingsByUser.get(userId);
    const ALL: Platform[] = ['twitter', 'reddit', 'google', 'linkedin', 'news'];
    const channels: Platform[] = Array.isArray(settings?.enabled_channels) && settings.enabled_channels.length > 0
      ? settings.enabled_channels.filter((c): c is Platform => ALL.includes(c as Platform))
      : ['twitter', 'reddit', 'google'];
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
        // Exact cutoff: the upstreams only accept coarse windows, so drop
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

    totalStale += droppedStale;
  }

  if (runId) {
    await supabase
      .from('sweep_runs')
      .update({
        finished_at: new Date().toISOString(),
        users_processed: usersProcessed,
        posts_inserted: postsInserted,
        errors,
      })
      .eq('id', runId);
  }

  return json({
    ok: true,
    usersProcessed,
    postsInserted,
    droppedStale: totalStale,
    pruned,
    usdSpent: Number(usdSpent.toFixed(6)),
    sfCreditsSpent,
    errorCount: errors.length,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}