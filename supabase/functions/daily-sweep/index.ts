// ============================================================================
// Supabase Edge Function: daily-sweep
// ----------------------------------------------------------------------------
// Scheduled fan-out sweep across every user with active keywords.
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
// Secrets: supabase secrets set SOCIALFETCH_API_KEY=sfk_...
//          supabase secrets set SWEEP_CRON_SECRET=<long random string>
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SWEEP_CRON_SECRET = Deno.env.get('SWEEP_CRON_SECRET') || '';

/**
 * Edge secret wins; otherwise the key is read from public.service_secrets over
 * the service role. That table has RLS on and no policies, so the browser can
 * never read it — the same trust boundary as an edge secret.
 */
let SOCIALFETCH_API_KEY = Deno.env.get('SOCIALFETCH_API_KEY') || '';

/** Hard cap so one busy day can never run away. */
const MAX_PAGES_PER_KEYWORD = 2;
const MAX_USERS_PER_RUN = 500;
const MAX_KEYWORDS_PER_USER = 25;

type Platform = 'twitter' | 'linkedin' | 'reddit' | 'google';

type SweepSettings = {
  enabled_channels: Platform[] | null;
  lookback_hours: number | null;
  min_intent_threshold: number | null;
};

// ---------------------------------------------------------------------------
// Intent scoring (mirrors the social-search function)
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

function timeframeFor(lookbackHours: number): string {
  if (lookbackHours <= 24) return 'day';
  if (lookbackHours <= 72) return 'week';
  if (lookbackHours <= 168) return 'month';
  return 'year';
}

// ---------------------------------------------------------------------------
// Lookback window -> per-endpoint parameters
// ---------------------------------------------------------------------------
// Mirrors social-search. Each route spells its date filter differently and
// silently ignores unknown params, so a wrong name is indistinguishable from
// "no filter" and let a 2021 tweet into the feed.
//
//   twitter  : no date filter at all -> section=latest + a client-side cutoff
//   reddit   : timeframe  = all | day | week | month | year
//   web      : datePosted = last-hour | last-day | last-week | last-month | last-year
//   linkedin : datePosted = same tokens as web

/** /v1/web/search and /v1/linkedin/posts/search relative date tokens. */
function datePostedFor(lookbackHours: number): string {
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
// Transport
// ---------------------------------------------------------------------------

async function socialFetchGet(
  path: string,
  params: Record<string, string | undefined>,
): Promise<any> {
  const url = new URL('https://api.socialfetch.dev' + path);
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

async function fetchPaged(
  path: string,
  params: Record<string, string | number | undefined>,
  paginate: 'cursor' | 'page',
): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  let pageNo = 1;

  for (let page = 0; page < MAX_PAGES_PER_KEYWORD; page++) {
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
      if (!pg.nextCursor || pg.nextCursor === cursor) break;
      cursor = pg.nextCursor;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

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

function mapTwitter(tweet: any, userId: string, kwId: string, kw: string): PostRow | null {
  const url =
    tweet?.url ?? tweet?.permalink ?? (tweet?.id ? `https://x.com/i/status/${tweet.id}` : null);
  if (!url) return null;

  const body = tweet?.text ?? null;
  return {
    user_id: userId,
    keyword_id: kwId,
    matched_keyword: kw,
    platform: 'twitter',
    channel_source: 'X / Twitter',
    post_url: url,
    author_name: tweet?.author?.displayName ?? tweet?.author?.name ?? null,
    author_handle: tweet?.author?.handle ? `@${tweet.author.handle}` : null,
    author_avatar_url: tweet?.author?.avatarUrl ?? null,
    body,
    posted_at: parseWhen(tweet?.createdAt),
    intent_score: calculateIntentScore(body || ''),
    status: 'new',
    engagement: {
      likes: tweet?.metrics?.likes ?? null,
      retweets: tweet?.metrics?.retweets ?? null,
      replies: tweet?.metrics?.replies ?? null,
      views: tweet?.metrics?.views ?? null,
      quotes: tweet?.metrics?.quotes ?? null,
    },
  };
}

function mapLinkedIn(post: any, userId: string, kwId: string, kw: string): PostRow | null {
  const url = post?.url ?? post?.permalink;
  if (!url) return null;

  const body = `${post?.title || ''} ${post?.text || ''}`.trim() || null;
  const authorHandle = post?.author?.profileUrl
    ? post.author.profileUrl.split('/in/')[1]
    : null;

  return {
    user_id: userId,
    keyword_id: kwId,
    matched_keyword: kw,
    platform: 'linkedin',
    channel_source: 'LinkedIn',
    post_url: url,
    author_name: post?.author?.name ?? null,
    author_handle: authorHandle ? `@${authorHandle}` : null,
    author_avatar_url: post?.author?.avatarUrl ?? null,
    body,
    // The field is `publishedAt`. The old mapper looked for postedAt/createdAt,
    // so every LinkedIn row landed with a NULL date.
    posted_at: parseWhen(post?.publishedAt),
    intent_score: calculateIntentScore(body || ''),
    status: 'new',
    engagement: {
      likes: post?.metrics?.reactions ?? null,
      comments: post?.metrics?.comments ?? null,
      author_followers: post?.author?.followers ?? null,
    },
  };
}

function mapReddit(post: any, userId: string, kwId: string, kw: string): PostRow | null {
  const url = post?.permalink ?? post?.url ?? null;
  if (!url) return null;

  const body = `${post?.title || ''} ${post?.bodyText || ''}`.trim() || null;
  return {
    user_id: userId,
    keyword_id: kwId,
    matched_keyword: kw,
    platform: 'reddit',
    channel_source: post?.subreddit ? `r/${post.subreddit}` : 'r/reddit',
    post_url: url,
    author_name: post?.author ? `u/${post.author}` : 'u/anonymous',
    author_handle: post?.author ? `@${post.author}` : null,
    author_avatar_url: null,
    body,
    posted_at: parseWhen(post?.createdAt),
    intent_score: calculateIntentScore(body || ''),
    status: 'new',
    engagement: {
      likes: post?.score ?? null,
      comments: post?.commentCount ?? null,
      upvotes: post?.upvotes ?? null,
      upvote_ratio: post?.upvoteRatio ?? null,
      subreddit_members: post?.subredditSubscriberCount ?? null,
    },
  };
}

function mapWeb(result: any, userId: string, kwId: string, kw: string): PostRow | null {
  const url = result?.url;
  if (!url) return null;

  let domain = 'Web';
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* keep default */
  }

  const body = `${result?.title || ''} — ${result?.content ?? ''}`.trim() || null;
  return {
    user_id: userId,
    keyword_id: kwId,
    matched_keyword: kw,
    platform: 'google',
    channel_source: domain,
    post_url: url,
    author_name: result?.title ?? domain,
    author_handle: `@${domain}`,
    author_avatar_url: null,
    body,
    // /v1/web/search returns only title/url/content — no date field exists, so
    // this stays null rather than being stamped with `now()`.
    posted_at: parseWhen(result?.publishedAt ?? result?.date),
    intent_score: calculateIntentScore(body || ''),
    status: 'new',
    engagement: { likes: null, comments: null },
  };
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

  if (!SOCIALFETCH_API_KEY) {
    const { data: secretRow, error: secretError } = await supabase
      .from('service_secrets')
      .select('value')
      .eq('name', 'socialfetch_api_key')
      .maybeSingle();
    if (secretError) {
      return json({ ok: false, error: `secret lookup failed: ${secretError.message}` }, 503);
    }
    SOCIALFETCH_API_KEY = secretRow?.value ?? '';
  }

  if (!SOCIALFETCH_API_KEY) {
    return json({ ok: false, error: 'SOCIALFETCH_API_KEY not set' }, 503);
  }

  // Captured before any network work so the retention pass at the end of each
  // user's sweep cannot delete the results that sweep just produced.
  const sweepStartedAt = new Date().toISOString();

  const { data: runRow } = await supabase.from('sweep_runs').insert({}).select().single();
  const runId = runRow?.id;

  const errors: Array<Record<string, string>> = [];
  let usersProcessed = 0;
  let postsInserted = 0;
  let pruned = 0;

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

  // Cap the number of users processed in one run.
  const userIds = [...byUser.keys()].slice(0, MAX_USERS_PER_RUN);
  if (userIds.length < byUser.size) {
    errors.push({
      stage: 'cap',
      message: `Run capped at ${MAX_USERS_PER_RUN} users; ${
        byUser.size - MAX_USERS_PER_RUN
      } deferred to the next run.`,
    });
  }

  // Load every sweep user's settings in one round trip.
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

  let totalStale = 0;

  for (const userId of userIds) {
    const userKeywords = byUser.get(userId) ?? [];
    if (userKeywords.length === 0) continue;

    usersProcessed++;

    const settings = settingsByUser.get(userId);
    const channels: Platform[] =
      Array.isArray(settings?.enabled_channels) && settings.enabled_channels.length > 0
        ? settings.enabled_channels
        : ['twitter', 'reddit', 'google'];
    const lookbackHours = Number(settings?.lookback_hours) || 24;
    const minIntent = Number(settings?.min_intent_threshold) || 0;
    const timeframe = timeframeFor(lookbackHours);
    const datePosted = datePostedFor(lookbackHours);
    const cutoffMs = Date.now() - lookbackHours * 60 * 60 * 1000;
    let droppedStale = 0;

    const rowsToUpsert: PostRow[] = [];
    const seenUrls = new Set<string>();

    for (const kw of userKeywords) {
      const tasks: Array<Promise<PostRow[]>> = [];

      if (channels.includes('twitter')) {
        // This route has no date filter; section=latest plus the cutoff below
        // is the only way to keep all-time top results out of the feed.
        tasks.push(
          fetchPaged('/v1/twitter/search', { query: kw.keyword, section: 'latest' }, 'cursor')
            .then((items) =>
              items.map((t) => mapTwitter(t, userId, kw.id, kw.keyword)).filter((r): r is PostRow => !!r),
            )
            .catch((e) => {
              errors.push({ user: userId, kw: kw.keyword, platform: 'twitter', message: String(e) });
              return [];
            }),
        );
      }

      if (channels.includes('linkedin')) {
        tasks.push(
          fetchPaged('/v1/linkedin/posts/search', { query: kw.keyword, datePosted }, 'cursor')
            .then((items) =>
              items.map((p) => mapLinkedIn(p, userId, kw.id, kw.keyword)).filter((r): r is PostRow => !!r),
            )
            .catch((e) => {
              errors.push({ user: userId, kw: kw.keyword, platform: 'linkedin', message: String(e) });
              return [];
            }),
        );
      }

      if (channels.includes('reddit')) {
        tasks.push(
          fetchPaged('/v1/reddit/search', { query: kw.keyword, timeframe, sortBy: 'new' }, 'cursor')
            .then((items) =>
              items.map((p) => mapReddit(p, userId, kw.id, kw.keyword)).filter((r): r is PostRow => !!r),
            )
            .catch((e) => {
              errors.push({ user: userId, kw: kw.keyword, platform: 'reddit', message: String(e) });
              return [];
            }),
        );
      }

      if (channels.includes('google')) {
        // Paginated by page number, not a cursor.
        tasks.push(
          fetchPaged('/v1/web/search', { query: kw.keyword, datePosted }, 'page')
            .then((items) =>
              items.map((r) => mapWeb(r, userId, kw.id, kw.keyword)).filter((r): r is PostRow => !!r),
            )
            .catch((e) => {
              errors.push({ user: userId, kw: kw.keyword, platform: 'google', message: String(e) });
              return [];
            }),
        );
      }

      const settled = await Promise.all(tasks);

      for (const row of settled.flat()) {
        // Exact cutoff: the API windows are coarse, so drop anything outside
        // the real lookback. Rows with no date at all cannot be judged.
        if (row.posted_at && Date.parse(row.posted_at) < cutoffMs) {
          droppedStale++;
          continue;
        }
        if (row.intent_score < minIntent) continue;
        const key = row.post_url.trim().toLowerCase();
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        rowsToUpsert.push(row);
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
    totalStale += droppedStale;
    }
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
    errorCount: errors.length,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}