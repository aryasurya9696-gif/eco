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
//
// Request body: { keyword?: string }   (optional — sweeps all active keywords)
// Response:     { ok, posts, scanned, channels }
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
const SOCIALFETCH_API_KEY = Deno.env.get('SOCIALFETCH_API_KEY') || '';
const MAX_PAGES = 2;
const MAX_KEYWORDS_PER_SWEEP = 25;

type Platform = 'twitter' | 'reddit' | 'google' | 'linkedin' | 'facebook';

interface KeywordRow {
  id: string;
  keyword: string;
}

interface RawPost {
  id: string;
  keyword_id: string;
  matched_keyword: string;
  platform: Platform;
  channel_source: string;
  post_url: string;
  author_name: string | null;
  author_handle: string | null;
  author_avatar_url: string | null;
  body: string | null;
  posted_at: string;
  intent_score: number;
  intent_level: 'high' | 'medium' | 'low';
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

function intentLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 85) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

/** Maps a lookback window in hours onto the SocialFetch timeframe token. */
function timeframeFor(lookbackHours: number): string {
  if (lookbackHours <= 24) return 'day';
  if (lookbackHours <= 72) return 'week';
  if (lookbackHours <= 168) return 'month';
  return 'year';
}

// ---------------------------------------------------------------------------
// SocialFetch transport
// ---------------------------------------------------------------------------

async function socialFetchGet(
  path: string,
  params: Record<string, string | undefined>,
): Promise<any> {
  const url = new URL(SOCIALFETCH_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': SOCIALFETCH_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SocialFetch ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Walks up to MAX_PAGES of a cursor-paginated SocialFetch endpoint. */
async function fetchPaged(
  path: string,
  params: Record<string, string | undefined>,
): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await socialFetchGet(path, { ...params, cursor });
    const items = body?.data?.tweets ?? body?.data?.posts ?? body?.data?.results ?? [];
    if (!Array.isArray(items) || items.length === 0) break;

    results.push(...items);

    cursor = body?.data?.page?.nextCursor;
    if (!body?.data?.page?.hasMore || !cursor) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Platform mappers
// ---------------------------------------------------------------------------

function basePost(p: Omit<RawPost, 'intent_score' | 'intent_level'>): RawPost {
  const intent = calculateIntentScore(p.body || '');
  return { ...p, intent_score: intent, intent_level: intentLevel(intent) };
}

function mapTwitter(tweet: any, kw: KeywordRow): RawPost | null {
  const postUrl =
    tweet?.url ?? tweet?.permalink ?? (tweet?.id ? `https://x.com/i/status/${tweet.id}` : null);
  if (!postUrl) return null;

  return basePost({
    id: `tw_${tweet.id}`,
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'twitter',
    channel_source: 'X / Twitter',
    post_url: postUrl,
    author_name: tweet?.author?.displayName ?? tweet?.author?.name ?? null,
    author_handle: tweet?.author?.handle ? `@${tweet.author.handle}` : null,
    author_avatar_url: tweet?.author?.avatarUrl ?? null,
    body: tweet?.text ?? null,
    posted_at: tweet?.createdAt ?? new Date().toISOString(),
    engagement: {
      likes: tweet?.metrics?.likes ?? null,
      retweets: tweet?.metrics?.retweets ?? null,
      replies: tweet?.metrics?.replies ?? null,
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
    // Deterministic id — identical across repeated sweeps, so the
    // (user_id, post_url) unique constraint can dedupe properly.
    id: `rd_${String(post?.id ?? postUrl).replace(/[^a-zA-Z0-9]/g, '').slice(0, 48)}`,
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'reddit',
    channel_source: post?.subreddit ? `r/${post.subreddit}` : 'r/reddit',
    post_url: postUrl,
    author_name: post?.author ? `u/${post.author}` : 'u/anonymous',
    author_handle: post?.author ? `@${post.author}` : null,
    author_avatar_url: null,
    body: body || null,
    posted_at: post?.createdAt ?? new Date().toISOString(),
    engagement: { likes: post?.score ?? null, comments: post?.commentCount ?? null },
  });
}

function mapWeb(result: any, kw: KeywordRow, idx: number): RawPost | null {
  const postUrl = result?.url;
  if (!postUrl) return null;

  let domain = 'Web';
  try {
    domain = new URL(postUrl).hostname.replace(/^www\./, '');
  } catch {
    /* keep default */
  }

  return basePost({
    id: `web_${encodeURIComponent(postUrl).replace(/[^a-zA-Z0-9]/g, '').slice(0, 60)}_${idx}`,
    keyword_id: kw.id,
    matched_keyword: kw.keyword,
    platform: 'google',
    channel_source: domain,
    post_url: postUrl,
    author_name: result?.title ?? 'Discussion Participant',
    author_handle: `@${domain}`,
    author_avatar_url: null,
    body: `${result?.title ?? ''} — ${result?.content ?? ''}`.trim() || null,
    posted_at: result?.publishedAt ?? result?.date ?? new Date().toISOString(),
    engagement: { likes: null, comments: null },
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

  if (!SOCIALFETCH_API_KEY) {
    return fail('Social search is not configured on this deployment.', 503);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Captured BEFORE any search runs. prune_feed() uses this so the batch this
  // sweep is about to write is never deleted by the retention pass.
  const sweepStartedAt = new Date().toISOString();

  // --- Load authoritative user settings (service role bypasses RLS) --------
  // min_intent_threshold arrives with the 20261017 migration. Fall back to a
  // narrower select if the deployment has not applied it yet, so the function
  // degrades instead of hard-failing.
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
    ? profile.enabled_channels
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
    return json({ ok: true, posts: [], scanned: 0, channels: enabledChannels });
  }

  const timeframe = timeframeFor(lookbackHours);
  const collected: RawPost[] = [];
  const seenUrls = new Set<string>();
  const errors: string[] = [];

  for (const kw of keywords) {
    const tasks: Array<Promise<RawPost[]>> = [];

    if (enabledChannels.includes('twitter')) {
      tasks.push(
        fetchPaged('/v1/twitter/search', { query: kw.keyword, timeframe })
          .then((items) => items.map((t) => mapTwitter(t, kw)).filter((p): p is RawPost => !!p))
          .catch((e) => {
            errors.push(`twitter/${kw.keyword}: ${e.message}`);
            return [];
          }),
      );
    }

    if (enabledChannels.includes('reddit')) {
      tasks.push(
        fetchPaged('/v1/reddit/search', { query: kw.keyword, timeframe, sortBy: 'new' })
          .then((items) => items.map((p) => mapReddit(p, kw)).filter((p): p is RawPost => !!p))
          .catch((e) => {
            errors.push(`reddit/${kw.keyword}: ${e.message}`);
            return [];
          }),
      );
    }

    if (enabledChannels.includes('google')) {
      tasks.push(
        fetchPaged('/v1/web/search', { query: kw.keyword, timeframe })
          .then((items) =>
            items.map((r, i) => mapWeb(r, kw, i)).filter((p): p is RawPost => !!p),
          )
          .catch((e) => {
            errors.push(`web/${kw.keyword}: ${e.message}`);
            return [];
          }),
      );
    }

    const settled = await Promise.all(tasks);

    for (const post of settled.flat()) {
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
    pruned,
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