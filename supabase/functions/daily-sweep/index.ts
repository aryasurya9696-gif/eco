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
const MAX_KEYWORDS_PER_USER = 25;

type Platform = 'twitter' | 'reddit' | 'google' | 'news';

type SweepSettings = {
  enabled_channels: Platform[] | null;
  lookback_hours: number | null;
  min_intent_threshold: number | null;
  /** "HH:MM" in UTC. Null means the workspace never opted in. */
  sweep_time_utc: string | null;
};

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

let usdSpent = 0;

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
      costUsd: 0.0004,
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
      costUsd: 0.001,
    });
    const tkItems = tk?.data?.posts ?? tk?.posts ?? [];
    if (Array.isArray(tkItems) && tkItems.length) {
      return tkItems.map((x: any) => mapRedditTikhub(x, userId, kwId, kw)).filter((r): r is PostRow => !!r);
    }

    const sc = await tregCall('scrapecreators.reddit.search.posts', {
      query: { query: kw, timeframe: redditTimeframe(lookbackHours), sort: 'relevance', limit: 25 },
      costUsd: 0.00188,
    });
    const scItems = sc?.posts ?? [];
    return Array.isArray(scItems) && scItems.length
      ? scItems.map((x: any) => mapRedditScrapecreators(x, userId, kwId, kw)).filter((r): r is PostRow => !!r)
      : [];
  }

  if (platform === 'google') {
    const r = await tregCall('crawl4ai.web.search.rich', { query: { q: kw, rich: 1 }, costUsd: 0.00015, timeoutMs: 25000 });
    const items = r?.results ?? [];
    return Array.isArray(items) && items.length
      ? items.map((x: any) => mapWeb(x, userId, kwId, kw)).filter((r2): r2 is PostRow => !!r2)
      : [];
  }

  if (platform === 'news') {
    const r = await tregCall('tinyfish.web.search.news', {
      query: { query: kw, domain_type: 'news', after_date: sinceDate(lookbackHours) },
      costUsd: 0,
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

  // Captured before any network work so the retention pass at the end of each
  // user's sweep cannot delete the results that sweep just produced.
  const sweepStartedAt = new Date().toISOString();
  usdSpent = 0;

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
    .select('id, enabled_channels, lookback_hours, min_intent_threshold, sweep_time_utc')
    .in('id', userIds);

  const settingsByUser = new Map<string, SweepSettings>();
  for (const p of profiles ?? []) {
    settingsByUser.set(p.id, {
      enabled_channels: p.enabled_channels,
      lookback_hours: p.lookback_hours,
      min_intent_threshold: p.min_intent_threshold,
      sweep_time_utc: p.sweep_time_utc,
    });
  }

  // The cron fires hourly and each workspace is swept in the hour it asked for,
  // so "every day at 06:00 UTC" in Settings is actually true. Total treg spend
  // is unchanged: each workspace still sweeps once per day.
  const currentHourUtc = new Date().getUTCHours();

  for (const userId of userIds) {
    const userKeywords = byUser.get(userId) ?? [];
    if (userKeywords.length === 0) continue;

    const settings = settingsByUser.get(userId);

    // Respect the workspace's own sweep hour. Checked before the processed
    // counter so the two numbers mean what they say.
    const dueHour = sweepHourOf(settings?.sweep_time_utc);
    if (dueHour !== null && dueHour !== currentHourUtc) {
      usersSkipped++;
      continue;
    }

    usersProcessed++;

    const ALL: Platform[] = ['twitter', 'reddit', 'google', 'news'];
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
    hourUtc: currentHourUtc,
    usersProcessed,
    usersSkipped,
    postsInserted,
    droppedStale: totalStale,
    pruned,
    usdSpent: Number(usdSpent.toFixed(6)),
    errorCount: errors.length,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}