// ============================================================================
// Supabase Edge Function: social-search
// ----------------------------------------------------------------------------
// Proxies SocialFetch so SOCIALFETCH_API_KEY never reaches the browser.
//
// The caller's enabled channels, lookback window, intent threshold and
// keywords are all read from the database with the service role key. Nothing
// quota-relevant is trusted from the request body.
//
// NOTE: this file is intentionally SELF-CONTAINED. Do not split shared helpers
// into an underscore-prefixed folder — Supabase's bundler skips `_`-prefixed
// directories and the relative import fails to resolve on deploy.
//
// Deploy:  supabase functions deploy social-search
// Secret:  supabase secrets set SOCIALFETCH_API_KEY=sfk_...
//          (falls back to public.service_secrets, which only the service role
//           can read, so the key is never exposed to the browser either way)
//
// Request body: { keyword?: string }   (optional — sweeps all active keywords)
// Response:     { ok, posts, scanned, channels, lookback_hours, credits }
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

const SOCIALFETCH_BASE = 'https://api.socialfetch.dev';
const MAX_PAGES = 2;
const MAX_KEYWORDS_PER_SWEEP = 25;

/** Every SocialFetch call costs one credit, so this sweep is metered in the UI. */
let creditsSpent = 0;

type Platform = 'twitter' | 'reddit' | 'google' | 'linkedin';

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
  /** Null when the source genuinely has no date (web search returns none). */
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
// Lookback window -> per-endpoint parameters
// ---------------------------------------------------------------------------
// Each SocialFetch endpoint spells its date filter differently, and passing an
// unknown query param is silently ignored rather than rejected — which is how
// an all-time `section=top` Twitter search ended up serving a 2021 tweet.
//
//   twitter  : no date filter at all -> section=latest + a client-side cutoff
//   reddit   : timeframe  = all | day | week | month | year
//   web      : datePosted = last-hour | last-day | last-week | last-month | last-year
//   linkedin : datePosted = same tokens as web
//
// Reddit's tokens start at `day`; web/LinkedIn's are relative labels. Neither
// can express "last 36 hours", so every endpoint is also filtered against an
// exact cutoff below.

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

/** Normalises the several timestamp spellings SocialFetch uses. */
function parseWhen(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// SocialFetch transport
// ---------------------------------------------------------------------------

/**
 * Resolved per request: the edge secret wins, otherwise the key is read from
 * public.service_secrets over the service role. Neither path is reachable
 * from the browser.
 */
let apiKey = Deno.env.get('SOCIALFETCH_API_KEY') || '';

async function resolveApiKey(admin: ReturnType<typeof createClient>): Promise<string> {
  if (apiKey) return apiKey;
  const { data, error } = await admin
    .from('service_secrets')
    .select('value')
    .eq('name', 'socialfetch_api_key')
    .maybeSingle();
  if (!error && typeof data?.value === 'string' && data.value) {
    apiKey = data.value;
  }
  return apiKey;
}

async function socialFetchGet(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<any> {
  const url = new URL(SOCIALFETCH_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  creditsSpent += 1;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Walks up to MAX_PAGES of a SocialFetch endpoint.
 *
 * Pagination is not uniform: twitter/reddit/linkedin return an opaque
 * `page.nextCursor`, web returns `page.page` + `page.nextPage` (1-based
 * integers). Driving web with a cursor left nextCursor undefined forever and
 * silently refetched page 1.
 */
async function fetchPaged(
  path: string,
  params: Record<string, string | number | undefined>,
  paginate: 'cursor' | 'page',
): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  let pageNo = 1;

  for (let i = 0; i < MAX_PAGES; i++) {
    const query: Record<string, string | number | undefined> = { ...params };
    if (paginate === 'page') query.page = pageNo;
    else if (cursor) query.cursor = cursor;

    const body = await socialFetchGet(path, query);
    const data = body?.data ?? {};
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
      // Stop on a repeated cursor too — some routes echo the same value back.
      if (!pg.nextCursor || pg.nextCursor === cursor) break;
      cursor = pg.nextCursor;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Platform mappers
// ---------------------------------------------------------------------------

function basePost(p: Omit<RawPost, 'intent_score'>): RawPost {
  return { ...p, intent_score: calculateIntentScore(p.body || '') };
}

function mapTwitter(tweet: any, kw: KeywordRow): RawPost | null {
  const postUrl =
    tweet?.url ?? (tweet?.id ? `https://x.com/i/status/${tweet.id}` : null);
  if (!postUrl) return null;

  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'twitter',
    channel_source: 'X / Twitter',
    post_url: postUrl,
    author_name: tweet?.author?.displayName ?? tweet?.author?.name ?? null,
    author_handle: tweet?.author?.handle ? `@${tweet.author.handle}` : null,
    author_avatar_url: tweet?.author?.avatarUrl ?? null,
    body: tweet?.text ?? null,
    posted_at: parseWhen(tweet?.createdAt),
    engagement: {
      likes: tweet?.metrics?.likes ?? null,
      retweets: tweet?.metrics?.retweets ?? null,
      replies: tweet?.metrics?.replies ?? null,
      views: tweet?.metrics?.views ?? null,
      quotes: tweet?.metrics?.quotes ?? null,
    },
  });
}

function mapReddit(post: any, kw: KeywordRow): RawPost | null {
  const postUrl =
    post?.permalink ??
    post?.url ??
    (post?.subreddit ? `https://reddit.com/r/${post.subreddit}` : null);
  if (!postUrl) return null;

  const body = `${post?.title || ''} ${post?.bodyText || ''}`.trim();

  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'reddit',
    channel_source: post?.subredditPrefixedName
      ?? (post?.subreddit ? `r/${post.subreddit}` : 'r/reddit'),
    post_url: postUrl,
    author_name: post?.author ? `u/${post.author}` : 'u/anonymous',
    author_handle: post?.author ? `@${post.author}` : null,
    author_avatar_url: null,
    body: body || null,
    posted_at: parseWhen(post?.createdAt),
    engagement: {
      likes: post?.score ?? null,
      comments: post?.commentCount ?? null,
      // Reddit-only signals worth keeping for later ranking.
      upvotes: post?.upvotes ?? null,
      upvote_ratio: post?.upvoteRatio ?? null,
      subreddit_members: post?.subredditSubscriberCount ?? null,
    },
  });
}

function mapWeb(result: any, kw: KeywordRow): RawPost | null {
  const postUrl = result?.url;
  if (!postUrl) return null;

  let domain = 'Web';
  try {
    domain = new URL(postUrl).hostname.replace(/^www\./, '');
  } catch {
    /* keep default */
  }

  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'google',
    channel_source: domain,
    post_url: postUrl,
    author_name: result?.title ?? domain,
    author_handle: `@${domain}`,
    author_avatar_url: null,
    body: `${result?.title ?? ''} — ${result?.content ?? ''}`.trim() || null,
    // /v1/web/search returns only title/url/content — there is no date. Stamping
    // `now()` here made every web result look like it was discovered today, so
    // the field is left null and the feed renders it as "date unknown".
    posted_at: parseWhen(result?.publishedAt ?? result?.date),
    engagement: { likes: null, comments: null },
  });
}

function mapLinkedIn(post: any, kw: KeywordRow): RawPost | null {
  const postUrl = post?.url ?? post?.permalink;
  if (!postUrl) return null;

  const authorHandle = post?.author?.profileUrl
    ? post.author.profileUrl.split('/in/')[1]
    : null;

  return basePost({
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'linkedin',
    channel_source: 'LinkedIn',
    post_url: postUrl,
    author_name: post?.author?.name ?? null,
    author_handle: authorHandle ? `@${authorHandle}` : null,
    author_avatar_url: post?.author?.avatarUrl ?? null,
    body: `${post?.title ?? ''} ${post?.text ?? ''}`.trim() || null,
    // The field is `publishedAt`; the old mapper looked for postedAt/createdAt,
    // so every LinkedIn row landed with a NULL date.
    posted_at: parseWhen(post?.publishedAt),
    engagement: {
      // LinkedIn nests counters under `metrics` as reactions/comments.
      likes: post?.metrics?.reactions ?? null,
      comments: post?.metrics?.comments ?? null,
      author_followers: post?.author?.followers ?? null,
    },
  });
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

  const key = await resolveApiKey(admin);
  if (!key) return fail('Social search is not configured on this deployment.', 503);

  // Captured BEFORE any search runs. prune_feed() uses this so the batch this
  // sweep is about to write is never deleted by the retention pass.
  const sweepStartedAt = new Date().toISOString();
  creditsSpent = 0;

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

  const enabledChannels: Platform[] = Array.isArray(profile?.enabled_channels)
    ? profile.enabled_channels.filter((c: string): c is Platform =>
      c === 'twitter' || c === 'reddit' || c === 'google' || c === 'linkedin'
    )
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
    return json({ ok: true, posts: [], scanned: 0, channels: enabledChannels, credits: 0 });
  }

  const collected: RawPost[] = [];
  const seenUrls = new Set<string>();
  const errors: string[] = [];
  let droppedStale = 0;

  // Exact cutoff. Reddit/web/LinkedIn only accept coarse windows, so anything
  // that slipped in outside the real lookback is dropped here.
  const cutoffMs = Date.now() - lookbackHours * 60 * 60 * 1000;
  const withinLookback = (postedAt: string | null): boolean => {
    if (!postedAt) return true; // source has no date — cannot judge, keep it
    return Date.parse(postedAt) >= cutoffMs;
  };

  for (const kw of keywords) {
    const tasks: Array<Promise<RawPost[]>> = [];

    if (enabledChannels.includes('twitter')) {
      // No date filter exists on this route; `latest` + the cutoff below is the
      // only way to keep all-time top results out of the feed.
      tasks.push(
        fetchPaged('/v1/twitter/search', { query: kw.keyword, section: 'latest' }, 'cursor')
          .then((items) => items.map((t) => mapTwitter(t, kw)).filter((p): p is RawPost => !!p))
          .catch((e) => {
            errors.push(`twitter/${kw.keyword}: ${e.message}`);
            return [];
          }),
      );
    }

    if (enabledChannels.includes('reddit')) {
      tasks.push(
        fetchPaged(
          '/v1/reddit/search',
          { query: kw.keyword, timeframe: redditTimeframe(lookbackHours), sortBy: 'new' },
          'cursor',
        )
          .then((items) => items.map((p) => mapReddit(p, kw)).filter((p): p is RawPost => !!p))
          .catch((e) => {
            errors.push(`reddit/${kw.keyword}: ${e.message}`);
            return [];
          }),
      );
    }

    if (enabledChannels.includes('google')) {
      tasks.push(
        fetchPaged(
          '/v1/web/search',
          { query: kw.keyword, datePosted: datePosted(lookbackHours) },
          'page',
        )
          .then((items) => items.map((r) => mapWeb(r, kw)).filter((p): p is RawPost => !!p))
          .catch((e) => {
            errors.push(`web/${kw.keyword}: ${e.message}`);
            return [];
          }),
      );
    }

    if (enabledChannels.includes('linkedin')) {
      tasks.push(
        fetchPaged(
          '/v1/linkedin/posts/search',
          { query: kw.keyword, datePosted: datePosted(lookbackHours) },
          'cursor',
        )
          .then((items) => items.map((p) => mapLinkedIn(p, kw)).filter((p): p is RawPost => !!p))
          .catch((e) => {
            errors.push(`linkedin/${kw.keyword}: ${e.message}`);
            return [];
          }),
      );
    }

    const settled = await Promise.all(tasks);

    for (const post of settled.flat()) {
      if (!withinLookback(post.posted_at)) {
        droppedStale++;
        continue;
      }
      // Apply the workspace intent filter server-side.
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
  // Runs after the upsert so this sweep's own results are already saved, and
  // is passed sweepStartedAt so they are never treated as stale.
  const pruned = await pruneOldMentions(admin, userId, sweepStartedAt);

  return json({
    ok: true,
    posts: collected,
    scanned: keywords.length,
    channels: enabledChannels,
    lookback_hours: lookbackHours,
    dropped_stale: droppedStale,
    pruned,
    credits: creditsSpent,
    errors: errors.length > 0 ? errors : undefined,
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