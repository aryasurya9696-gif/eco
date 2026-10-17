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
const MAX_KEYWORDS_PER_USER = 8;

type Platform = 'twitter' | 'reddit' | 'google' | 'news';

type SweepSettings = {
  enabled_channels: Platform[] | null;
  lookback_hours: number | null;
  min_intent_threshold: number | null;
  /** "HH:MM" in UTC. Null means the workspace never opted in. */
  sweep_time_utc: string | null;
  /** '6h' | '12h' | '24h'. Anything else is treated as '24h'. */
  sweep_frequency: string | null;
};

/**
 * Echo is free, so these are the product's limits rather than anything a
 * workspace can buy past. They mirror public.keyword_limit() and
 * public.channel_limit().
 */
const MAX_CHANNELS = 3;

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
  callsMade++;

  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        'X-Treg-Token': tregToken,
        Accept: 'application/json',
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
    usdSpent += costMicro / 1e6;

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
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.balance_usd === 'number' ? body.balance_usd : null;
  } catch {
    return null; // unknown balance is not a reason to stop working
  }
}

let usdSpent = 0;
/** Provider calls actually issued, for the spend ledger. */
let callsMade = 0;

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
// Credit accounting
// ---------------------------------------------------------------------------
// The sweep is charged per operation, not per provider call, so what decides a
// charge is whether that channel produced any billable call at all. A channel
// where every call came back free — no results, or an error treg never charges
// for — costs the customer nothing, which is the promise the old system broke
// by billing for the retry.
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
}

function newTally(operation: string): OperationTally {
  return {
    operation, calls: 0, costMicro: 0, billed: false,
    uncertain: false, upstreamFailed: false, callIds: [], errorCodes: [],
  };
}

function record(tally: OperationTally, r: TregResult): void {
  tally.calls += 1;
  tally.costMicro += r.costMicro;
  if (r.billable === 'billed') tally.billed = true;
  if (r.billable === 'uncertain') tally.uncertain = true;
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
  tally: OperationTally, runNonce: string,
): Promise<PostRow[]> {
  const kwId = kwRow.id;
  const kw = kwRow.keyword;

  // Stable within a run so an internal retry is free, and different between runs
  // so a scheduled sweep is charged normally rather than looking like a replay.
  const idem = `ds:${runNonce}:${kwId}:${platform}`;
  const common = { customerId: userId, idempotencyKey: idem };

  if (platform === 'twitter') {
    const t = await tregCall('anyapi.x.search.posts', {
      ...common,
      method: 'POST',
      // Latest, not the default: the default returns all-time top posts, which
      // is what once put a 2021 tweet into the feed.
      body: { query: kw, queryType: 'Latest', limit: 20 },
    });
    record(tally, t);
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
    record(tally, tk);
    const tkItems = tk.data?.data?.posts ?? tk.data?.posts ?? [];
    if (Array.isArray(tkItems) && tkItems.length) {
      return tkItems.map((x: any) => mapRedditTikhub(x, userId, kwId, kw)).filter((r: any): r is PostRow => !!r);
    }

    // Distinct key: a different provider answering the same search. Reusing the
    // primary's key would make treg reject it as a mismatched replay.
    const sc = await tregCall('scrapecreators.reddit.search.posts', {
      ...common,
      idempotencyKey: `${idem}:fb`,
      query: { query: kw, timeframe: redditTimeframe(lookbackHours), sort: 'relevance', limit: 25 },
    });
    record(tally, sc);
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
    record(tally, r);
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
    record(tally, r);
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
  callsMade = 0;

  const { data: runRow } = await supabase.from('sweep_runs').insert({}).select().single();
  const runId = runRow?.id;

  const errors: Array<Record<string, string>> = [];

  // Close out holds whose sweep died between reserving and settling. Without
  // this, an isolate eviction or a wall-clock kill in that window locked those
  // credits out of the workspace's balance permanently — invisible until
  // someone read an ops view by hand.
  let reaped: { settled: number; released: number } | null = null;
  try {
    const { data, error } = await supabase.rpc('reap_stale_reservations', {
      p_older_than: '1 hour',
    });
    if (error) {
      errors.push({ user: '*', kw: '*', platform: '*', message: `reaper: ${error.message}` });
    } else if (data && (data.settled > 0 || data.released > 0)) {
      reaped = { settled: data.settled, released: data.released };
      console.warn(`[sweep] reaped ${data.settled} settled, ${data.released} released stale holds`);
    }
  } catch (reaperErr) {
    errors.push({ user: '*', kw: '*', platform: '*', message: `reaper: ${String(reaperErr)}` });
  }
  let usersProcessed = 0;
  let usersSkipped = 0;
  let postsInserted = 0;
  let pruned = 0;
  let totalStale = 0;
  // Credit accounting for the whole run. Out-of-credit workspaces are collected
  // rather than logged and forgotten, because "why did nothing arrive" is a
  // question the answer to which belongs in the run result.
  const skippedNoCredits: Array<{ user: string; required: number; available: number; shortfall: number }> = [];
  let totalCreditsCharged = 0;
  let totalProviderCostUsd = 0;
  // Provider failures across the run. tregCall never throws — deliberately, so a
  // dead provider falls through the chain instead of killing the request — which
  // means a run where every call failed used to report ok: true and
  // errorCount: 0. The errors array only ever held database failures.
  const providerFailures: Array<{ user: string; operation: string; code: string }> = [];
  const pricing = await loadPricing(supabase);

  // What one credit is realised at, for the usage ledger. Taken from the live
  // packages rather than assumed, so a price change moves the reported revenue
  // with it instead of leaving a stale figure in the profit report.
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
    const cadenceHours = cadenceHoursOf(settings?.sweep_frequency);

    // Respect the workspace's own sweep hour. Checked before the processed
    // counter so the two numbers mean what they say.
    const dueHour = sweepHourOf(settings?.sweep_time_utc);
    if (dueHour !== null && !isSweepDue(currentHourUtc, dueHour, cadenceHours)) {
      usersSkipped++;
      continue;
    }

    usersProcessed++;

    const ALL: Platform[] = ['twitter', 'reddit', 'google', 'news'];
    const requested: Platform[] = Array.isArray(settings?.enabled_channels) && settings.enabled_channels.length > 0
      ? settings.enabled_channels.filter((c): c is Platform => ALL.includes(c as Platform))
      : ['twitter', 'reddit', 'google'];
    // A flat cap on how many channels may be scanned. The Settings UI stops the
    // over-limit selection from being made; this is the backstop.
    const channels: Platform[] = requested.slice(0, MAX_CHANNELS);
    const lookbackHours = Number(settings?.lookback_hours) || 24;
    const minIntent = Number(settings?.min_intent_threshold) || 0;
    const cutoffMs = Date.now() - lookbackHours * 60 * 60 * 1000;

    let droppedStale = 0;

    const rowsToUpsert: PostRow[] = [];
    const seenUrls = new Set<string>();

    // ---- Price the workspace's sweep, then hold it before any call ---------
    //
    // All or nothing. A sweep that ran for six of eight keywords would charge for
    // a truncated search and quietly under-report the results, so a workspace
    // that cannot cover the whole thing gets nothing and is recorded as skipped.
    const runKey = `ds:${runId ?? 'run'}:${userId}`;
    const runNonce = `${runId ?? Date.now().toString(36)}:${userId}`;

    const wantedOps = [...new Set(channels.map((c) => OPERATION_OF[c]))]
      .filter((op) => pricing.has(op));
    const billableChannels = channels.filter((c) => pricing.has(OPERATION_OF[c]));

    const unpriced = channels.filter((c) => !pricing.has(OPERATION_OF[c]));
    if (unpriced.length > 0) {
      console.warn(`[sweep] no configured price for ${userId}: ${unpriced.join(', ')}`);
    }

    const creditsPerKeyword = wantedOps.reduce((s, op) => s + (pricing.get(op) ?? 0), 0);
    const creditsRequired = creditsPerKeyword * userKeywords.length;

    const hold = await reserveSweep(supabase, userId, creditsRequired, runKey, {
      scope: 'daily-sweep',
      run_id: runId,
      keywords: userKeywords.length,
      channels: wantedOps,
      credits_per_keyword: creditsPerKeyword,
    });

    if ('shortfall' in hold) {
      // Nothing has been called. Recorded rather than silently dropped so the
      // user can be told they are short instead of wondering why nothing
      // arrived this morning.
      skippedNoCredits.push({
        user: userId,
        required: hold.required,
        available: hold.available,
        shortfall: hold.shortfall,
      });
      console.warn(
        `[sweep] ${userId} skipped: needs ${hold.required} credits, has ${hold.available}`,
      );
      usersSkipped++;
      continue;
    }

    const tallies = new Map<string, OperationTally>();
    for (const op of wantedOps) tallies.set(op, newTally(op));

    for (const kw of userKeywords) {
      const perChannel = await Promise.all(
        billableChannels.map((ch) => {
          const tally = tallies.get(OPERATION_OF[ch])!;
          return searchChannel(ch, kw, userId, lookbackHours, tally, runNonce);
        }),
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

    // ---- Settle for what actually billed ----------------------------------
    let creditsCharged = 0;
    let providerCostUsd = 0;
    const perOperation: Record<string, number> = {};
    const charges = new Map<string, { credits: number; revenueUsd: number }>();

    for (const [op, t] of tallies) {
      providerCostUsd += t.costMicro / 1e6;
      // Charged if any of its calls billed, or if any outcome is unknown. Not
      // charged when the whole channel came back free.
      const charged = (t.billed || t.uncertain) ? (pricing.get(op) ?? 0) * userKeywords.length : 0;
      creditsCharged += charged;
      perOperation[op] = charged;
      // What the usage ledger records, so it carries the same figures the wallet
      // was debited rather than a hardcoded zero. Revenue is reconstructed at the
      // rate these credits were bought for, which is what wallet_settle works
      // out — the two records then agree instead of diverging.
      charges.set(op, {
        credits: charged,
        revenueUsd: charged * pricePerCredit,
      });
    }

    let charged = false;
    if (creditsCharged > 0) {
      // The result is checked. settleSweep returns null when the RPC fails;
      // ignoring that reported a charge that never happened and left the hold in
      // place forever, shrinking this workspace's balance on every later sweep.
      const balanceAfter = await settleSweep(
        supabase, hold.id, creditsCharged, providerCostUsd, `${runKey}:settle`,
        `${userKeywords.length} keywords across ${billableChannels.length} channels`,
      );
      charged = balanceAfter !== null;
      if (charged) {
        totalCreditsCharged += creditsCharged;
      } else {
        errors.push({
          user: userId, kw: '*', platform: '*',
          message: 'credit settlement failed; reservation left held for the reaper',
        });
      }
    } else {
      await releaseSweep(supabase, hold.id, 'no billable provider calls');
    }

    totalProviderCostUsd += providerCostUsd;
    for (const [op, t] of tallies) {
      for (const code of t.errorCodes) {
        providerFailures.push({ user: userId, operation: op, code });
      }
    }
    await recordUsage(supabase, userId, runKey, tallies, hold.id, charges);

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
    // False only when every provider call this run failed. A run that swept some
    // workspaces and found nothing is a success; one where nothing was reachable
    // is not, and saying otherwise hides an outage behind a healthy-looking count.
    ok: providerFailures.length === 0 || providerFailures.length < callsMade,
    hourUtc: currentHourUtc,
    usersProcessed,
    usersSkipped,
    postsInserted,
    droppedStale: totalStale,
    pruned,
    // Measured from treg's own cost headers, not from a rate card.
    usdSpent: Number(usdSpent.toFixed(6)),
    callsMade,
    balanceUsd,
    errorCount: errors.length,
    provider_failure_count: providerFailures.length,
    provider_failures: providerFailures.slice(0, 12),
    reaped_reservations: reaped,
    billing: {
      creditsCharged: Number(totalCreditsCharged.toFixed(6)),
      providerCostUsd: Number(totalProviderCostUsd.toFixed(8)),
      // Workspaces that wanted a sweep and could not pay for one. Each of these
      // cost zero, because the hold is taken before any provider call.
      skippedInsufficientCredits: skippedNoCredits,
    },
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
