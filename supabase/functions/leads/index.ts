// ============================================================================
// Supabase Edge Function: leads
// ----------------------------------------------------------------------------
// B2B Leads Discovery, Email Reveal, Phone Extraction & Contact Intelligence
// Supports bulk prospecting (25, 50, 100, 200 leads) & batch email reveals.
// Powered by Treg.to catalog routing (26+ upstream providers).
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

function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra }, status);
}

/** Verifies the caller's JWT server-side. */
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

const TREG_BASE = 'https://treg.to';
let tregToken = Deno.env.get('TREG_TOKEN') || '';

/**
 * Search quantity bounds.
 *
 * These mirror MIN_LIMIT / MAX_LIMIT in the Prospector view. They drifted apart
 * before — the client accepted 5 while the server floored at 10, so a request for
 * 5 came back as 10 with no indication — which is why they are named here rather
 * than left as bare literals inside the clamp.
 */
const MIN_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 1000;

/** One rule for the quantity, matching the client's sanitiser. */
function sanitizeSearchLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(MIN_SEARCH_LIMIT, Math.round(n)));
}

/**
 * How many provider calls may be made to satisfy a large request.
 *
 * The provider returns at most 100 people per call, so a 1000-lead request
 * needs ten. They are issued in parallel rather than one after another, which
 * is what keeps a large request inside the request timeout: sequentially, ten
 * calls would take ten times as long.
 */
const MAX_PROVIDER_CALLS = 12;
const MAX_SEARCH_DOMAINS = 10;

/**
 * Upper bounds on a single provider call.
 *
 * None of the provider fetches had a timeout, so one hung upstream call held
 * the whole request open until the gateway killed it — the browser then saw a
 * generic failure and any credit hold taken for the run sat unsettled.
 */
const SEARCH_TIMEOUT_MS = 25_000;
const ENRICH_TIMEOUT_MS = 20_000;

/** Longest free-text filter forwarded to the provider. */
const MAX_FILTER_LENGTH = 200;

function cleanFilter(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_FILTER_LENGTH) : '';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * True for a string that is actually an email address.
 *
 * The provider fills the email field with placeholders such as "N/A". Those
 * were treated as revealed addresses: the row showed "N/A" with a copy button,
 * lost its Reveal button, and was skipped by auto-enrich and bulk reveal.
 */
function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('*') && EMAIL_RE.test(value.trim());
}

/**
 * True when a saved row holds a resolved work email.
 *
 * A "preview" address is the provider's unverified homepage/company address,
 * not a reveal. Counting it as one made the reveal endpoints return it as
 * "already revealed" for free, so the verified address could never be bought.
 */
function hasRevealedEmail(row: any): boolean {
  return isEmailAddress(row?.work_email) && row?.email_status !== 'preview';
}

/**
 * What an email lookup's verifier said, and whether it may be charged.
 *
 * Treg puts the verifier's answer at _treg.verification.verdict: valid,
 * invalid, catch_all, risky or unknown (or `checked: false` / `pending: true`
 * when no verdict exists yet). Only a `valid` address is charged. Every other
 * found address is still shown — labelled unconfirmed — but costs nothing;
 * an `invalid` one is treated as not found at all. The old code charged every
 * hit and defaulted a missing verdict to "valid".
 */
interface EmailVerdict {
  status: string;
  charge: boolean;
  usable: boolean;
}
function classifyEmail(resJson: any): EmailVerdict {
  const v = resJson?._treg?.verification;
  const verdict = typeof v?.verdict === 'string' ? v.verdict.toLowerCase() : '';
  if (verdict === 'valid') return { status: 'valid', charge: true, usable: true };
  if (verdict === 'invalid') return { status: 'invalid', charge: false, usable: false };
  if (verdict === 'catch_all') return { status: 'accept_all', charge: false, usable: true };
  if (verdict === 'risky') return { status: 'risky', charge: false, usable: true };
  return { status: v?.pending ? 'pending' : 'unknown', charge: false, usable: true };
}

/**
 * One provider search call.
 *
 * A failure is reported as `null` rather than an empty list so the caller can
 * tell "the provider has nobody for these filters" apart from "the provider
 * call failed". Treating the two the same is how a provider outage on a
 * multi-company search came back as a successful search with zero results.
 */
async function tregPeopleSearch(
  token: string,
  userId: string,
  payload: Record<string, any>,
  feature: string,
  tagDomain?: string,
  usage?: UsageLog,
): Promise<any[] | null> {
  try {
    const res = await fetch(`${TREG_BASE}/call/treg.people.search`, {
      method: 'POST',
      headers: {
        'X-Treg-Token': token,
        'X-Treg-Meta': `customer=${userId}, feature=${feature}`,
        'X-Treg-Route-Max-Cost': MAX_COST.search,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    usage?.track('treg.people.search', res, { feature, batch: true });
    if (!res.ok) {
      console.warn('[leads] treg.people.search batch failed:', res.status);
      return null;
    }
    const data = await res.json();
    const people = data?.output?.people || data?.raw?.data || [];
    if (!Array.isArray(people)) return [];
    return tagDomain ? people.map((p: any) => ({ ...p, _searched_domain: tagDomain })) : people;
  } catch (err: any) {
    usage?.track('treg.people.search', null, { feature, batch: true, error: err?.name || 'error' });
    console.warn('[leads] treg.people.search batch error:', err?.name || err?.message);
    return null;
  }
}

/**
 * Extra query shapes used to satisfy a request larger than the provider's
 * per-call ceiling.
 *
 * The provider returns at most 100 people per call, and the only extra call
 * the search used to make was the same query with the title and keyword
 * swapped. That returned largely the same people, so the result set never
 * grew past roughly 200 no matter what was asked for — asking for 400
 * quietly produced 200.
 *
 * These variations each move the query along a different axis so the extra
 * batches are genuinely different people rather than a re-ranking of the first
 * hundred.
 *
 * A variation may only narrow or re-rank inside the filters the user asked
 * for — never drop or replace one. The previous version dropped the role
 * filter and then rotated through other roles, so a 200-lead "Founder" search
 * came back half full of Directors and Managers while the summary bar still
 * said "Role: Founder". Roles rotate only when the user gave no role at all.
 */
function buildSearchVariations(base: Record<string, any>, count: number): Record<string, any>[] {
  if (count <= 0) return [];
  const variants: Record<string, any>[] = [];
  const title = String(base.title || '').trim();
  const q = String(base.q || '').trim();

  // Rotate the role — a different title surfaces a different person. Only
  // when the user left the role open, so it cannot contradict their filter.
  const rolePool = [
    'Director',
    'Manager',
    'Founder',
    'CEO',
    'VP',
    'Head of Department',
    'President',
    'Partner',
    'Officer',
    'Lead',
  ];
  let i = 0;
  while (!title && variants.length < count && i < rolePool.length) {
    variants.push({ ...base, title: rolePool[i++] });
  }

  // Add a keyword on top of the user's own, once the roles are exhausted (or
  // when the role was fixed by the user). The user's keyword is kept in full.
  const keywordPool = [
    'founder',
    'ceo',
    'leadership',
    'executive',
    'director',
    'head',
    'growth',
    'operations',
  ];
  // One pass over the pool: repeating it would only resend identical queries
  // and pay the provider for duplicates the dedupe step throws away.
  for (const keyword of keywordPool) {
    if (variants.length >= count) break;
    if (title && title.toLowerCase().includes(keyword)) continue;
    variants.push({ ...base, q: q ? `${q} ${keyword}` : keyword });
  }

  return variants.slice(0, count);
}

async function resolveToken(admin: ReturnType<typeof createClient>): Promise<string> {
  if (tregToken) return tregToken;
  const { data, error } = await admin
    .from('service_secrets')
    .select('value')
    .eq('name', 'treg_token')
    .maybeSingle();
  if (error || !data?.value) {
    console.warn('[leads] secret lookup failed:', error?.message);
    return '';
  }
  tregToken = data.value;
  return tregToken;
}


// ---------------------------------------------------------------------------
// Pricing, cost caps and usage logging
// ---------------------------------------------------------------------------

/**
 * Most Treg may spend on one routed call. Treg's default is $1, and the
 * search route used to send no cap at all — a single 100-person call could
 * cost $0.30 while the user paid nothing. Each cap leaves at least ~20%
 * margin on the credit price (1 credit = $0.05): email 1 cr vs $0.04, phone
 * 2 cr vs $0.08, and a 100-lead search call vs the 2 credits it can earn.
 */
const MAX_COST = { search: '0.05', email: '0.04', phone: '0.08' } as const;

/** Leads per search that cost nothing; every further block is charged. */
const SEARCH_FREE_LEADS = 25;
const SEARCH_LEADS_PER_BLOCK = 50;
/** Abuse guard: free searches still cost us provider money. */
const SEARCH_RATE_LIMIT_PER_HOUR = 30;

interface Prices {
  email: number;
  phone: number;
  searchBlock: number;
}

// Searching itself is not charged: users pay only for verified contacts found.
// A search does require a balance, so it can deliver those contacts.
const FALLBACK_PRICES: Prices = { email: 1, phone: 2, searchBlock: 0 };
let priceCache: { at: number; prices: Prices } | null = null;

/**
 * Credit prices come from pricing_config, so changing a price is a data change
 * rather than a deploy. The constants above are only the fallback when the
 * table cannot be read; they match the seeded rows.
 */
async function loadPrices(admin: any): Promise<Prices> {
  if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache.prices;
  const prices = { ...FALLBACK_PRICES };
  try {
    const { data, error } = await admin
      .from('pricing_config')
      .select('operation, credits, enabled')
      .in('operation', ['treg.people.email.find', 'treg.people.phone.find', 'leads.search.extra_50']);
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const credits = Number(row.credits);
        if (!row.enabled || !Number.isFinite(credits) || credits < 0) continue;
        if (row.operation === 'treg.people.email.find') prices.email = credits;
        if (row.operation === 'treg.people.phone.find') prices.phone = credits;
        if (row.operation === 'leads.search.extra_50') prices.searchBlock = credits;
      }
    }
  } catch (err: any) {
    console.warn('[leads] pricing lookup failed, using defaults:', err?.message);
  }
  priceCache = { at: Date.now(), prices };
  return prices;
}

/** Credits a search returning `leads` people costs: the first 25 are free. */
function searchCreditsFor(leads: number, prices: Prices): number {
  return Math.ceil(Math.max(0, leads - SEARCH_FREE_LEADS) / SEARCH_LEADS_PER_BLOCK) * prices.searchBlock;
}

interface UsageRow {
  user_id: string;
  idempotency_key: string;
  operation: string;
  provider: string;
  provider_call_id: string | null;
  provider_cost_usd: number;
  credits_charged: number;
  revenue_usd: number;
  outcome: 'success' | 'free' | 'upstream_failed' | 'not_billed' | 'uncertain';
  http_status: number | null;
  metadata: Record<string, unknown>;
}

/**
 * One api_usage row per Treg call, carrying what Treg actually charged
 * (x-treg-cost-micro). None of the leads calls were recorded before, so the
 * margin reports could not see a cent of leads spend. Revenue stays in the
 * wallet ledger (wallet_settle); these rows carry the credits for context.
 */
class UsageLog {
  rows: UsageRow[] = [];
  constructor(private userId: string) {}

  track(operation: string, res: Response | null, meta: Record<string, unknown> = {}): UsageRow {
    const costMicro = res ? Number(res.headers.get('x-treg-cost-micro') || 0) : 0;
    const cost = Number.isFinite(costMicro) && costMicro > 0 ? costMicro / 1e6 : 0;
    const row: UsageRow = {
      user_id: this.userId,
      idempotency_key: `leads:${operation}:${crypto.randomUUID()}`,
      operation,
      provider: 'treg',
      provider_call_id: res?.headers.get('x-treg-call-id') ?? null,
      provider_cost_usd: Number(cost.toFixed(8)),
      credits_charged: 0,
      revenue_usd: 0,
      outcome: !res ? 'uncertain' : res.ok ? (cost > 0 ? 'success' : 'free') : cost > 0 ? 'upstream_failed' : 'not_billed',
      http_status: res?.status ?? null,
      metadata: meta,
    };
    this.rows.push(row);
    return row;
  }

  async flush(admin: any) {
    if (this.rows.length === 0) return;
    const rows = this.rows;
    this.rows = [];
    const { error } = await admin.from('api_usage').upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true });
    if (error) console.error('[leads] usage record failed:', error.message);
  }
}

/** Credits this user can spend right now (balance minus held credits). */
async function walletAvailable(admin: any, userId: string): Promise<number> {
  const { data, error } = await admin.from('wallet').select('balance, reserved').eq('user_id', userId).maybeSingle();
  if (error || !data) return 0;
  return Math.max(0, Number(data.balance ?? 0) - Number(data.reserved ?? 0));
}

/** Searches this user ran in the last hour (one api_usage row per search). */
async function recentSearchCount(admin: any, userId: string): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await admin
    .from('api_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('operation', 'leads.search')
    .gte('created_at', since);
  if (error) {
    console.warn('[leads] rate-limit count failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Credit Accounting via wallet_reserve & wallet_settle
// ---------------------------------------------------------------------------

interface Reservation {
  id: string;
  reserved: number;
}

async function reserveCredits(
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
    console.error('[billing] wallet_reserve failed:', error.message);
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

async function settleCredits(
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
    console.error('[billing] wallet_settle failed:', error.message);
    return null;
  }
  return Number((data as any)?.balance_after ?? 0);
}

// ---------------------------------------------------------------------------
// Helpers: URL, Domain & Lead Normalization
// ---------------------------------------------------------------------------
function cleanDomain(d?: string | null): string {
  if (!d || typeof d !== 'string') return '';
  return d
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .trim()
    .toLowerCase();
}

function normalizeLinkedin(url?: string | null): string | null {
  if (!url || typeof url !== 'string' || url === 'N/A' || url === 'null') return null;
  let clean = url.trim();
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = 'https://' + clean.replace(/^\/+/, '');
  }
  return clean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for a real UUID. Anything else must never reach a uuid column. */
function isUuid(value?: string | null): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Escapes the wildcards in a value used with ilike.
 *
 * `_` matches any single character, so "Ann_Smith" would otherwise also match
 * "Ann Smith" and the lookup could settle on somebody else's row.
 */
function escapeLike(value?: string | null): string {
  if (!value || typeof value !== 'string') return '';
  return value.replace(/([\\%_])/g, '\\$1');
}

/** Slug of a LinkedIn profile URL, lowercased, or null. */
function linkedinSlug(url?: string | null): string | null {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function slugOfRow(row: any): string | null {
  return linkedinSlug(row?.linkedin_url);
}

/**
 * Finds an already-saved lead.
 *
 * Two things this is careful about:
 *  - company_domain is optional in a LinkedIn-only lookup. Passing undefined to
 *    .eq() serialises as the literal string "undefined" and matches nothing, so
 *    the filter is only attached when there is a value.
 *  - maybeSingle() throws when more than one row comes back, turning a routine
 *    "you already have this contact" into a 500. limit(1) takes the newest row
 *    and never errors.
 */
interface FindExistingOpts {
  companyDomain?: string | null;
  fullName?: string | null;
  linkedinUrl?: string | null;
  workEmail?: string | null;
}

/**
 * Finds an already-saved lead without guessing the wrong person.
 *
 * The old version matched on full_name alone when no domain was supplied, so a
 * LinkedIn lookup for "John Smith" could return another John Smith's paid email
 * from a different company. Now the strongest available identity signal wins:
 *   1. exact work_email
 *   2. exact LinkedIn slug
 *   3. company_domain + full_name
 * and a name-only query is post-filtered on the LinkedIn slug when one was
 * supplied, so a name match that does not also agree on LinkedIn is rejected.
 */
async function findExistingLead(
  admin: any,
  userId: string,
  optsOrDomain?: string | null | FindExistingOpts,
  fullName?: string | null,
  linkedinUrl?: string | null,
  workEmail?: string | null,
): Promise<any | null> {
  // Backwards-compatible call shapes.
  let opts: FindExistingOpts;
  if (optsOrDomain && typeof optsOrDomain === 'object') {
    opts = optsOrDomain as FindExistingOpts;
  } else {
    opts = {
      companyDomain: optsOrDomain as string | null,
      fullName,
      linkedinUrl,
      workEmail,
    };
  }

  const name = (opts.fullName || '').trim();
  const domain = (opts.companyDomain || '').trim().toLowerCase();
  const email = (opts.workEmail || '').trim().toLowerCase();
  const slug = linkedinSlug(opts.linkedinUrl);

  if (!name && !domain && !email && !slug) return null;

  // Try the identity signals in order of confidence and keep looking when one
  // of them misses. The old version stopped at the first signal it had, so a
  // stale or preview email that matched no row made the whole lookup return
  // null even though the same person was already in the pipeline under the
  // exact domain + name. Callers then upserted on
  // (user_id, company_domain, full_name) and overwrote that row's stage and
  // address.
  async function firstMatch(
    builder: () => any,
    accept: (row: any) => boolean,
  ): Promise<any | null> {
    const { data, error } = await builder()
      .order('updated_at', { ascending: false })
      .limit(25);
    if (error) {
      console.warn('[leads] existing-lead lookup failed:', error.message);
      return null;
    }
    for (const row of data || []) {
      if (accept(row)) return row;
    }
    return null;
  }

  if (email) {
    const hit = await firstMatch(
      () =>
        admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .eq('work_email', email),
      () => true,
    );
    if (hit) return hit;
  }

  if (slug) {
    const hit = await firstMatch(
      () =>
        admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .ilike('linkedin_url', `%${escapeLike(slug)}%`),
      (row) => {
        const rowSlug = slugOfRow(row);
        return !rowSlug || rowSlug === slug;
      },
    );
    if (hit) return hit;
  }

  if (name && domain) {
    const hit = await firstMatch(
      () =>
        admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .eq('company_domain', domain)
          .ilike('full_name', escapeLike(name)),
      (row) => (row.company_domain || '').toLowerCase() === domain,
    );
    if (hit) return hit;
  }

  // Name-only is the last resort. A domain with no name is deliberately not
  // attempted: it cannot identify a person and would hand back a colleague's
  // cached contact.
  if (name) {
    const hit = await firstMatch(
      () =>
        admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .ilike('full_name', escapeLike(name)),
      () => true,
    );
    if (hit) return hit;
  }

  return null;
}

/**
 * A human-readable name for a LinkedIn-only lookup.
 *
 * The UI used to send the literal string "LinkedIn Prospect" with an empty
 * domain, so every LinkedIn reveal saved a junk row into the pipeline — rows
 * that could never be matched against a later search and had to be deleted by
 * hand. Deriving the name from the profile slug keeps the two halves matching.
 */
function nameFromLinkedinSlug(url?: string | null): { full_name: string; first_name: string; last_name: string } | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  const slug = match?.[1];
  if (!slug) return null;
  const spaced = slug
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const parts = spaced.split(/\s+/).filter(Boolean).map(cap);
  const first_name = parts[0] || '';
  const last_name = parts.slice(1).join(' ');
  return { full_name: `${first_name}${last_name ? ' ' + last_name : ''}`, first_name, last_name };
}

function normalizeLead(p: any, idx: number, fallbackDomain = ''): any {
  // 1. Full Name, First Name, Last Name (Handles both camelCase and snake_case)
  const rawFullName = (p.fullName || p.full_name || p.name || '').trim();
  let firstName = (p.first_name || p.firstName || '').trim();
  let lastName = (p.last_name || p.lastName || '').trim();

  if (!firstName && rawFullName) {
    const parts = rawFullName.split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  const fullName =
    rawFullName ||
    (firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || 'Decision Maker');

  // 2. Title & Role (Handles Aviato currentExperienceSummary and Quickenrich title)
  const title = (
    p.title ||
    p.currentExperienceSummary?.title ||
    p.headline ||
    p.role ||
    'Executive / Leader'
  ).trim();

  // 3. Domain & Company Name
  const domain = cleanDomain(
    p._searched_domain ||
    p.company_url ||
    p.email_domain ||
    p.currentExperienceSummary?.company?.URLs?.website ||
    p.company?.website ||
    p.company_domain ||
    p.domain ||
    fallbackDomain
  );

  const fallbackCompanyName = domain
    ? domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1)
    : 'Enterprise';

  const companyName = (
    p.company_name ||
    p.currentExperienceSummary?.company?.name ||
    p.company?.name ||
    p.company ||
    fallbackCompanyName
  ).trim();

  // 4. Location & Country
  const location =
    p.locality ||
    p.location ||
    (p.city && p.country_code ? `${p.city}, ${p.country_code}` : p.city || p.country || p.country_code || null);

  const countryCode = p.country_code || (p.city && p.country_code ? p.country_code : null);

  // 5. Headcount / Size / Industry
  const companySize =
    p.employee_count ||
    (p.currentExperienceSummary?.company?.headcount
      ? `${p.currentExperienceSummary.company.headcount} employees`
      : null) ||
    p.headcount ||
    p.company_size ||
    null;

  const industry = p.industry || p.currentExperienceSummary?.company?.industry || null;
  const revenue = p.revenue || p.company_revenue || null;

  // 6. Contact Signals
  const linkedinUrl = normalizeLinkedin(
    p.employee_linkedin ||
    p.URLs?.linkedin ||
    p.linkedin_url ||
    p.linkedin ||
    p.profile_url
  );

  // The address that comes back with a search result is the provider's
  // unverified homepage/company address (or a placeholder like "N/A"), not the
  // person's verified work email. It travels as `preview_email` so it can be
  // shown for what it is without blocking a real reveal.
  const homePageEmail = isEmailAddress(p.home_page_email)
    ? p.home_page_email.trim()
    : isEmailAddress(p.email)
      ? p.email.trim()
      : null;

  const hasEmail = Boolean(p.has_email || homePageEmail);
  const hasPhone = Boolean(p.has_phone || p.phone || p.company_phone || p.mobile_phone);
  const hasLinkedin = Boolean(linkedinUrl);

  const id = p.emp_id
    ? String(p.emp_id)
    : p.id
    ? String(p.id)
    : `lead_${idx}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  return {
    id,
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    title,
    company_name: companyName,
    company_domain: domain,
    company_size: companySize,
    company_revenue: revenue,
    industry,
    company_phone: p.company_phone || null,
    linkedin_url: linkedinUrl,
    location,
    country_code: countryCode,
    has_email: hasEmail,
    has_phone: hasPhone,
    has_linkedin: hasLinkedin,
    preview_email: homePageEmail,
    revealed_email: null,
    revealed_phone: null,
    email_status: null,
    is_saved: false,
  };
}

// ---------------------------------------------------------------------------
// Main Request Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  const userId = await requireUserId(req);
  if (!userId) {
    return fail('Unauthorized', 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const token = await resolveToken(admin);
  if (!token) {
    return fail('Leads service is not configured (missing token).', 503);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return fail('Invalid JSON body');
  }

  const action = body.action || 'search';
  const usage = new UsageLog(userId);
  try {
    return await handleAction();
  } finally {
    await usage.flush(admin);
  }

  async function handleAction(): Promise<Response> {
  // =========================================================================
  // ACTION 0: PRICING — what the UI quotes, from the same source the charges use
  // =========================================================================
  if (action === 'pricing') {
    const prices = await loadPrices(admin);
    return json({
      ok: true,
      email_credits: prices.email,
      phone_credits: prices.phone,
      search_free_leads: SEARCH_FREE_LEADS,
      search_block_leads: SEARCH_LEADS_PER_BLOCK,
      search_block_credits: prices.searchBlock,
    });
  }

  // =========================================================================
  // ACTION 1: SEARCH (Directory Prospecting with Batch & Bulk Limits)
  // =========================================================================
  if (action === 'search') {
    const rawTarget = typeof body.company_domain === 'string' ? body.company_domain.trim().slice(0, 1000) : '';
    const title = cleanFilter(body.title);
    const query = cleanFilter(body.q);
    const location = cleanFilter(body.location);
    const country = cleanFilter(body.country).toUpperCase();
    const industry = cleanFilter(body.industry);
    const requestedLimit = sanitizeSearchLimit(body.limit);
    // Treg's documented `keywords` list filter. Bounded so a client cannot
    // send an unbounded payload upstream.
    const keywords: string[] = Array.isArray(body.keywords)
      ? [...new Set(body.keywords.map((k: unknown) => cleanFilter(k).slice(0, 60)).filter(Boolean))].slice(0, 10) as string[]
      : [];

    // The provider expects an ISO 3166-1 alpha-2 code. A free-text value such
    // as "United States" was forwarded as-is and silently matched nobody.
    if (country && !/^[A-Z]{2}$/.test(country)) {
      return fail('Country must be a two-letter ISO code (for example "US").');
    }

    // Support comma-separated target domains
    const targetParts = rawTarget
      ? rawTarget.split(',').map((d: string) => cleanDomain(d)).filter(Boolean)
      : [];

    // Separate actual domains (contain a dot) from company names
    const domainList = targetParts.filter((d: string) => d.includes('.'));
    const companyNames = targetParts.filter((d: string) => !d.includes('.'));

    if (domainList.length === 0 && companyNames.length === 0 && !title && !query && !location && !country && !industry && keywords.length === 0) {
      return fail('Please provide search criteria (persona, title, company, or country).');
    }

    // A search only makes sense with credits to reveal what it finds: every
    // result is checked for a verified email/phone and charged per hit. With
    // an empty wallet the provider search would be paid for and shown nothing.
    const prices = await loadPrices(admin);
    const minimumCredits = Math.max(1, Math.min(prices.email, prices.phone));
    if ((await walletAvailable(admin, userId)) < minimumCredits) {
      return fail('Add credits to search. You pay only for verified emails and phone numbers that are found.', 402, {
        insufficient_credits: true,
        needs_credits_to_search: true,
      });
    }

    // Searches cost provider money even when nothing is found, so they are
    // rate-limited.
    if ((await recentSearchCount(admin, userId)) >= SEARCH_RATE_LIMIT_PER_HOUR) {
      return fail(
        `You have run ${SEARCH_RATE_LIMIT_PER_HOUR} searches in the last hour. Please wait a few minutes and try again.`,
        429,
        { rate_limited: true },
      );
    }

    // The first SEARCH_FREE_LEADS leads are free; each further block of 50 is
    // held up front at the most the search can cost, then settled on what was
    // actually returned — a search that comes back short is refunded.
    const maxSearchCredits = searchCreditsFor(requestedLimit, prices);
    const searchKey = `search_${userId}_${crypto.randomUUID()}`;
    let searchHold: Reservation | null = null;
    let billableLeads = 0;
    if (maxSearchCredits > 0) {
      const hold = await reserveCredits(admin, userId, maxSearchCredits, searchKey, {
        feature: 'leads_search',
        requested_limit: requestedLimit,
      });
      if ('shortfall' in hold) {
        const blocks = prices.searchBlock > 0 ? Math.floor(Math.max(0, hold.available) / prices.searchBlock) : 0;
        return fail(
          `This search needs up to ${maxSearchCredits} credits; you have ${hold.available}.`,
          402,
          {
            insufficient_credits: true,
            required: maxSearchCredits,
            available: hold.available,
            affordable_limit: Math.min(requestedLimit, SEARCH_FREE_LEADS + blocks * SEARCH_LEADS_PER_BLOCK),
          },
        );
      }
      searchHold = hold;
    }
    const searchRow = usage.track('leads.search', null, { requested_limit: requestedLimit });
    searchRow.outcome = 'free';

    try {
      let allRawPeople: any[] = [];
      // Provider calls that failed outright. Reported back so a short result
      // caused by an outage is not presented as "all available leads".
      let failedBatches = 0;
      const fetchLimit = Math.min(requestedLimit, 100);

      let skippedDomains = 0;
      if (domainList.length > 1) {
        // Multi-domain search in parallel. Each domain may need more than one
        // provider call to fill its share of a large request, so the variation
        // rounds are budgeted across the target list. The old version allowed
        // up to 12 calls per domain and silently ignored every company past
        // the sixth.
        const domainsToSearch = domainList.slice(0, MAX_SEARCH_DOMAINS);
        skippedDomains = Math.max(0, domainList.length - domainsToSearch.length);
        const perDomainLimit = Math.max(10, Math.ceil(requestedLimit / domainsToSearch.length));
        const rounds = Math.max(
          1,
          Math.min(
            Math.ceil(perDomainLimit / 100),
            Math.floor(MAX_PROVIDER_CALLS / domainsToSearch.length),
          ),
        );
        const domainPromises = domainsToSearch.flatMap((domain: string) => {
          const payload: Record<string, any> = {
            company_domain: domain,
            limit: Math.min(100, perDomainLimit),
          };
          if (title) payload.title = title;
          if (query) payload.q = query;
          if (country) payload.country = country;
          if (location) payload.location = location;
          if (industry) payload.industry = industry;
          if (keywords.length) payload.keywords = keywords;
          const variants =
            rounds > 1 ? buildSearchVariations(payload, rounds - 1) : [];
          return [
            tregPeopleSearch(token, userId, payload, 'leads-multi-domain', domain, usage),
            ...variants.map((v) =>
              tregPeopleSearch(token, userId, v, 'leads-multi-domain', domain, usage),
            ),
          ];
        });

        const results = await Promise.all(domainPromises);
        failedBatches = results.filter((r) => r === null).length;
        if (failedBatches === results.length) {
          return fail('The lead search provider is not responding. Please try again in a moment.', 502);
        }
        allRawPeople = results.flatMap((r) => r ?? []);
      } else {
        // Single target or Persona / Topic Search
        let combinedQuery = query;
        if (companyNames.length > 0) {
          combinedQuery = combinedQuery ? `${combinedQuery} ${companyNames.join(' ')}` : companyNames.join(' ');
        }
        if (industry) {
          combinedQuery = combinedQuery ? `${combinedQuery} ${industry}` : industry;
        }

        const payload: Record<string, any> = { limit: fetchLimit };
        if (domainList[0]) payload.company_domain = domainList[0];
        if (title) payload.title = title;
        if (combinedQuery) payload.q = combinedQuery;
        if (country) payload.country = country;
        if (location) payload.location = location;
        if (keywords.length) payload.keywords = keywords;

        let tregRes: Response;
        try {
          tregRes = await fetch(`${TREG_BASE}/call/treg.people.search`, {
            method: 'POST',
            headers: {
              'X-Treg-Token': token,
              'X-Treg-Meta': `customer=${userId}, feature=leads-search`,
              'X-Treg-Route-Max-Cost': MAX_COST.search,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          });
          usage.track('treg.people.search', tregRes, { feature: 'leads-search' });
        } catch (err: any) {
          usage.track('treg.people.search', null, { feature: 'leads-search', error: err?.name || 'error' });
          console.error('[leads] treg.people.search unreachable:', err?.name || err?.message);
          return fail('The lead search provider did not respond in time. Please try again.', 504);
        }

        if (tregRes.ok) {
          const resJson = await tregRes.json();
          const firstBatch = resJson?.output?.people || resJson?.raw?.data || [];
          allRawPeople = Array.isArray(firstBatch) ? firstBatch : [];

          // More than one provider call is needed for a request above 100.
          // The extra calls run in parallel — the old sequential second call
          // was the same query with the title and keyword swapped, so it
          // returned the same people and the result set stopped at ~200.
          //
          // Below 100 the first call already asked for everything the user
          // wanted, so a short result means the provider has no more people
          // for these filters. Another call would only add provider cost.
          if (requestedLimit > 100 && allRawPeople.length < requestedLimit) {
            const remaining = requestedLimit - allRawPeople.length;
            const extraCalls = Math.min(
              MAX_PROVIDER_CALLS,
              Math.max(1, Math.ceil(remaining / 100)),
            );
            const variations = buildSearchVariations(payload, extraCalls);
            const extraResults = await Promise.all(
              variations.map((v) => tregPeopleSearch(token, userId, v, 'leads-search-p2', undefined, usage)),
            );
            for (const batch of extraResults) {
              if (batch === null) failedBatches++;
              else allRawPeople = allRawPeople.concat(batch);
            }
          }
        } else {
          const errText = await tregRes.text();
          console.error('[leads] treg.people.search failed:', tregRes.status, errText);
          return fail('Lead search provider error. Please try adjusting your filters.', 502);
        }
      }

      // Deduplicate and normalize
      const seen = new Set<string>();
      // Ids are the client's row keys and selection keys. Two raw records with
      // the same provider id but a slightly different domain both survived the
      // name dedupe, rendered under one React key and toggled together.
      const seenIds = new Set<string>();
      const normalized: any[] = [];
      for (let i = 0; i < allRawPeople.length; i++) {
        const item = normalizeLead(allRawPeople[i], i, domainList[0] || '');
        // Filter out empty records
        if (!item.full_name || item.full_name === 'Decision Maker' && !item.company_domain) continue;

        const key = `${(item.company_domain || '').toLowerCase().trim()}::${(item.full_name || '').toLowerCase().trim()}`;
        if (!seen.has(key) && !seenIds.has(item.id)) {
          seen.add(key);
          seenIds.add(item.id);
          normalized.push(item);
        }
        if (normalized.length >= requestedLimit) break;
      }

      // Cross-check against user's already revealed/saved leads in database.
      // Fetch only the rows whose domain matches this result set: a full-table
      // select is capped by PostgREST at 1000 rows, so a power user's oldest
      // leads silently dropped out of the cross-check and re-revealing them
      // charged a second credit.
      const resultDomains = [...new Set(normalized.map((l: any) => (l.company_domain || '').trim().toLowerCase()).filter(Boolean))];
      let existingLeads: any[] = [];
      if (resultDomains.length > 0) {
        const { data } = await admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .in('company_domain', resultDomains);
        if (data) existingLeads = existingLeads.concat(data);
      }
      // LinkedIn-only leads carry an empty domain; fetch those separately so
      // they can still be matched instead of being skipped.
      if (normalized.some((l: any) => !(l.company_domain || '').trim())) {
        const { data: nullRows } = await admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .is('company_domain', null);
        if (nullRows) existingLeads = existingLeads.concat(nullRows);
        const { data: emptyRows } = await admin
          .from('user_leads')
          .select('*')
          .eq('user_id', userId)
          .eq('company_domain', '');
        if (emptyRows) existingLeads = existingLeads.concat(emptyRows);
      }

      if (existingLeads && existingLeads.length > 0) {
        const existingMap = new Map<string, any>();
        for (const ex of existingLeads) {
          const key = `${(ex.company_domain || '').toLowerCase().trim()}::${(ex.full_name || '').toLowerCase().trim()}`;
          existingMap.set(key, ex);
        }

        for (const item of normalized) {
          const key = `${(item.company_domain || '').toLowerCase().trim()}::${(item.full_name || '').toLowerCase().trim()}`;
          const match = existingMap.get(key);
          if (match) {
            item.is_saved = true;
            item.status = match.status;
            // The saved row's own id, so downstream writes (status, phone)
            // address a row that exists. Without it every later update on this
            // lead 500s, because a provider id is not a uuid.
            item.db_id = match.id;
            if (hasRevealedEmail(match)) {
              item.revealed_email = match.work_email;
              item.email_status = match.email_status;
            }
            if (match.phone_number) {
              item.revealed_phone = match.phone_number;
              item.phone_type = match.phone_type;
            }
          }
        }
      }

      // =======================================================================
      // Automated Contact Enrichment: Automatically resolve & verify work emails
      // =======================================================================
      let creditsCharged = 0;
      let enrichedCount = 0;
      // Of those, the ones the verifier confirmed — the only ones charged.
      let verifiedCount = 0;
      let enrichmentPending = 0;
      // Why some contacts were left unenriched: the per-search cap, or the
      // wallet. The client words its notice differently for each.
      let enrichmentLimitedBy: 'cap' | 'balance' | null = null;
      const MAX_AUTO_ENRICH = 60;

      // Enrichment spends credits, so it has to be an explicit opt-in. A
      // caller that omitted the flag (an older client, a script) used to be
      // charged for up to 60 reveals it never asked for.
      if (body.auto_enrich === true && normalized.length > 0) {
        // Cap what one search may resolve. A 200-lead search ran 200 upstream
        // lookups in sequential batches of five, which is minutes of work — the
        // gateway cut the request off and the credits taken for it were never
        // settled. The cap keeps a search inside its own time budget; anything
        // over it still comes back, just with a per-row reveal button.
        const leadsToEnrich = normalized
          .filter((l) => !l.revealed_email && l.company_domain)
          .slice(0, MAX_AUTO_ENRICH);

        if (leadsToEnrich.length > 0) {
          let runKey = `auto_enrich_${userId}_${Date.now()}`;
          let hold = await reserveCredits(admin, userId, leadsToEnrich.length, runKey, {
            feature: 'auto_enrich_leads',
            requested_count: leadsToEnrich.length,
          });

          // Short on credits: hold what the wallet can cover instead. The old
          // code fell through to `available` lookups with no hold at all, so
          // those emails were resolved without ever being charged, while the
          // response still reported them as credits charged.
          if ('shortfall' in hold) {
            const affordable = Math.floor(Math.max(0, Number(hold.available) || 0));
            if (affordable > 0) {
              runKey = `${runKey}_partial`;
              hold = await reserveCredits(admin, userId, affordable, runKey, {
                feature: 'auto_enrich_leads',
                requested_count: leadsToEnrich.length,
                partial: true,
              });
            }
          }

          const maxAllowed = 'id' in hold ? Math.floor(hold.reserved) : 0;
          if (maxAllowed < leadsToEnrich.length) enrichmentLimitedBy = 'balance';

          const targetBatch = leadsToEnrich.slice(0, maxAllowed);
          enrichmentPending = normalized.filter(
            (l) => !l.revealed_email && l.company_domain && !targetBatch.includes(l)
          ).length;
          if (enrichmentPending > 0 && !enrichmentLimitedBy) enrichmentLimitedBy = 'cap';

          try {
            // Parallel enrichment batches of 5
            const BATCH_SIZE = 5;
            for (let i = 0; i < targetBatch.length; i += BATCH_SIZE) {
              const chunk = targetBatch.slice(i, i + BATCH_SIZE);
              await Promise.all(
                chunk.map(async (lead) => {
                  try {
                    const emailPayload: Record<string, string> = { domain: lead.company_domain };
                    if (lead.full_name) emailPayload.full_name = lead.full_name;
                    if (lead.linkedin_url) emailPayload.linkedin_url = lead.linkedin_url;

                    const res = await fetch(`${TREG_BASE}/call/treg.people.email.find`, {
                      method: 'POST',
                      headers: {
                        'X-Treg-Token': token,
                        'X-Treg-Meta': `customer=${userId}, feature=auto-enrich`,
                        'X-Treg-Route-Verify': 'true',
                        'X-Treg-Route-Max-Cost': MAX_COST.email,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                      },
                      body: JSON.stringify(emailPayload),
                      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
                    });
                    const autoRow = usage.track('treg.people.email.find', res, { feature: 'auto-enrich' });

                    if (!res.ok) {
                      // Not a miss: the lookup itself failed, so the row keeps
                      // its Reveal button and the user can retry it.
                      return;
                    }
                    {
                      const data = await res.json();
                      const rawEmail = data?.output?.email || data?.raw?.data?.email || null;
                      const verdict = classifyEmail(data);
                      const email = isEmailAddress(rawEmail) && verdict.usable ? rawEmail.trim() : null;
                      if (email) {
                        enrichedCount++;
                        if (verdict.charge) {
                          verifiedCount++;
                          autoRow.credits_charged = prices.email;
                        }
                        lead.revealed_email = email;
                        lead.work_email = email;
                        lead.email_status = verdict.status;
                        lead.is_saved = true;

                        // Upsert into user_leads
                        const { data: upserted } = await admin
                          .from('user_leads')
                          .upsert(
                            {
                              user_id: userId,
                              company_domain: lead.company_domain,
                              company_name: lead.company_name,
                              full_name: lead.full_name,
                              first_name: lead.first_name,
                              last_name: lead.last_name,
                              title: lead.title,
                              location: lead.location,
                              linkedin_url: lead.linkedin_url,
                              work_email: email,
                              email_status: lead.email_status,
                              status: lead.status || 'new',
                              updated_at: new Date().toISOString(),
                            },
                            { onConflict: 'user_id,company_domain,full_name' }
                          )
                          .select('id')
                          .maybeSingle();
                        if (upserted?.id) lead.db_id = upserted.id;
                      } else {
                        lead.email_status = 'not_found';
                      }
                    }
                  } catch (err: any) {
                    // A timeout or network error is not a "not found" — leave
                    // the status empty so the row can still be revealed.
                    console.warn('[leads] auto-enrich lookup failed:', err?.name || err?.message);
                  }
                })
              );
            }
          } finally {
            // Settling from `finally` rather than after the loop: an exception
            // thrown mid-run used to skip the settle entirely, and a held
            // reservation is money the user can see as available and cannot
            // spend. Whatever happened, the hold is closed here.
            creditsCharged = verifiedCount * prices.email;
            if ('id' in hold) {
              await settleCredits(
                admin,
                hold.id,
                creditsCharged,
                creditsCharged * 0.005,
                runKey,
                `Auto-enriched ${creditsCharged} verified emails for search (${normalized.length} leads)`
              );
            }
          }
        }
      }

      billableLeads = normalized.length;
      const searchCredits = searchCreditsFor(billableLeads, prices);
      searchRow.credits_charged = searchCredits;
      searchRow.metadata = { ...searchRow.metadata, returned: billableLeads };
      return json({
        ok: true,
        people: normalized,
        count: normalized.length,
        requested_limit: requestedLimit,
        free_leads: Math.min(SEARCH_FREE_LEADS, normalized.length),
        search_credits_charged: searchCredits,
        enriched_count: enrichedCount,
        credits_charged: creditsCharged + searchCredits,
        enrichment_pending: enrichmentPending,
        enrichment_limited_by: enrichmentLimitedBy,
        skipped_domains: skippedDomains,
        failed_batches: failedBatches,
      });
    } catch (err: any) {
      console.error('[leads] search execution error:', err.message);
      return fail('Internal lead search error', 500);
    } finally {
      // Every exit — success, provider error, exception — closes the hold, and
      // only leads actually returned past the free allowance are charged.
      if (searchHold) {
        const charge = searchCreditsFor(billableLeads, prices);
        await settleCredits(
          admin,
          searchHold.id,
          charge,
          0,
          searchKey,
          `Lead search: ${billableLeads} leads (${Math.min(SEARCH_FREE_LEADS, billableLeads)} free)`,
        );
      }
    }
  }

  // =========================================================================
  // ACTION 2: REVEAL EMAIL (Single, 1 Credit)
  // =========================================================================
  if (action === 'reveal-email') {
    const { full_name, first_name, last_name, company_domain, linkedin_url, title, company_name, company_size, company_revenue, location } = body;

    if (!company_domain && !linkedin_url) {
      return fail('Company domain or LinkedIn URL is required to find email.');
    }
    if (!full_name && !first_name && !linkedin_url) {
      return fail('Lead name or LinkedIn URL is required.');
    }

    // A LinkedIn-only lookup arrives with no name at all. Deriving one from the
    // profile slug keeps the saved row identifiable; sending a placeholder like
    // "LinkedIn Prospect" saved a different junk row on every single lookup.
    const derived = !full_name && linkedin_url ? nameFromLinkedinSlug(linkedin_url) : null;
    const resolvedName = (full_name || derived?.full_name || '').trim();
    const resolvedFirst = (first_name || derived?.first_name || resolvedName.split(' ')[0] || '').trim();
    const resolvedLast = (
      last_name ||
      derived?.last_name ||
      (resolvedName ? resolvedName.split(' ').slice(1).join(' ') : '')
    ).trim();
    let resolvedDomain = cleanDomain(company_domain);

    // 1. Check if already revealed in local database (idempotent / free)
    const existing = await findExistingLead(admin, userId, { companyDomain: resolvedDomain, fullName: resolvedName, linkedinUrl: linkedin_url });

    if (hasRevealedEmail(existing)) {
      return json({
        ok: true,
        already_revealed: true,
        lead: existing,
        credits_charged: 0,
      });
    }

    // 2. Reserve 1 credit in user's wallet
    const CREDITS_REQUIRED = (await loadPrices(admin)).email;
    const runKey = `reveal_email_${userId}_${resolvedDomain}_${Date.now()}`;
    const hold = await reserveCredits(admin, userId, CREDITS_REQUIRED, runKey, {
      feature: 'lead_email_reveal',
      target: resolvedName || linkedin_url,
    });

    if ('shortfall' in hold) {
      return fail(`Insufficient credits. Required: ${hold.required}, Available: ${hold.available}`, 402, {
        insufficient_credits: true,
        required: hold.required,
        available: hold.available,
      });
    }

    // 3. Call Treg Email Finder with auto verification
    let emailFound: string | null = null;
    // Credits this reveal costs: the full price only for a verified address.
    let emailCharge = 0;
    let emailStatus: string = 'unknown';
    let emailConfidence = 0.9;
    let providerCostUsd = 0.0048;

    try {
      const emailPayload: Record<string, string> = {};
      if (resolvedDomain) emailPayload.domain = resolvedDomain;
      if (resolvedName) emailPayload.full_name = resolvedName;
      else if (resolvedFirst && resolvedLast) {
        emailPayload.first_name = resolvedFirst;
        emailPayload.last_name = resolvedLast;
      }
      if (linkedin_url) emailPayload.linkedin_url = linkedin_url;

      const tregRes = await fetch(`${TREG_BASE}/call/treg.people.email.find`, {
        method: 'POST',
        headers: {
          'X-Treg-Token': token,
          'X-Treg-Meta': `customer=${userId}, feature=lead-email`,
          'X-Treg-Route-Verify': 'true',
          'X-Treg-Route-Max-Cost': MAX_COST.email,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(emailPayload),
        signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      });

      const costMicro = Number(tregRes.headers.get('x-treg-cost-micro') || 0);
      if (costMicro > 0) providerCostUsd = costMicro / 1e6;
      const emailRow = usage.track('treg.people.email.find', tregRes, { feature: 'lead-email' });

      if (tregRes.ok) {
        const resJson = await tregRes.json();
        const rawEmail = resJson?.output?.email || resJson?.raw?.data?.email || null;
        const verdict = classifyEmail(resJson);
        emailFound = isEmailAddress(rawEmail) && verdict.usable ? rawEmail.trim() : null;
        emailCharge = emailFound && verdict.charge ? CREDITS_REQUIRED : 0;
        emailRow.credits_charged = emailCharge;
        emailStatus = verdict.status;
        emailConfidence = resJson?.output?.confidence || 0.95;

        // Auto-extract domain & company info from Treg if empty
        const outputDomain = cleanDomain(
          resJson?.output?.domain ||
          resJson?.raw?.data?.domain ||
          resJson?.raw?.data?.company_domain ||
          (emailFound ? emailFound.split('@')[1] : '')
        );
        if (!resolvedDomain && outputDomain) {
          resolvedDomain = outputDomain;
        }
      }
    } catch (err: any) {
      console.warn('[leads] email find upstream warning:', err.message);
    }

    // 4. Settle credit hold
    if (emailFound) {
      await settleCredits(
        admin,
        hold.id,
        emailCharge,
        providerCostUsd,
        runKey,
        emailCharge > 0 ? `Revealed verified email for ${resolvedName}` : `Unconfirmed email for ${resolvedName} - not charged`,
      );
    } else {
      await settleCredits(admin, hold.id, 0, 0, runKey, `No email found - refund`);
      return fail('No verified email found for this lead. Zero credits charged.', 404, { no_hit: true });
    }

    const finalCompanyName =
      company_name && company_name !== 'Target Company'
        ? company_name
        : (resolvedDomain ? resolvedDomain.split('.')[0].toUpperCase() : 'Company');

    const finalTitle =
      title && title !== 'Target Decision Maker'
        ? title
        : title || 'Executive';

    // 5. Upsert into user_leads table
    const leadRecord = {
      user_id: userId,
      first_name: resolvedFirst,
      last_name: resolvedLast,
      full_name: resolvedName || `${resolvedFirst} ${resolvedLast}`.trim(),
      title: finalTitle,
      company_name: finalCompanyName,
      company_domain: resolvedDomain,
      company_size: company_size || null,
      company_revenue: company_revenue || null,
      linkedin_url: linkedin_url || null,
      location: location || null,
      work_email: emailFound,
      email_status: emailStatus,
      email_confidence: emailConfidence,
      status: existing?.status || 'new',
      updated_at: new Date().toISOString(),
    };

    if (!leadRecord.full_name) {
      // full_name is NOT NULL, so an unidentifiable target cannot be persisted.
      // The credits are still settled above — the work was done, and the user
      // got an address back on screen.
      return json({
        ok: true,
        lead: { ...leadRecord, full_name: 'Unknown contact', is_saved: false },
        credits_charged: emailCharge,
        persisted: false,
      });
    }

    const { data: savedLead, error: saveErr } = await admin
      .from('user_leads')
      .upsert(leadRecord, { onConflict: 'user_id,company_domain,full_name' })
      .select()
      .single();

    if (saveErr) {
      console.error('[leads] lead upsert error:', saveErr.message);
    }

    return json({
      ok: true,
      lead: savedLead || leadRecord,
      credits_charged: emailCharge,
      verified: emailCharge > 0,
      persisted: !saveErr,
    });
  }

  // =========================================================================
  // ACTION 3: BULK REVEAL EMAILS (Batch processing for 10, 50, 100 leads)
  // =========================================================================
  if (action === 'bulk-reveal-email') {
    const MAX_BULK = 100;
    // A lead without a name cannot be looked up or saved (full_name is NOT
    // NULL), and one bad row used to fail the batch upsert, leaving every
    // email in it charged but never persisted.
    const leadsToReveal: any[] = (Array.isArray(body.leads) ? body.leads : [])
      .slice(0, 2000)
      .filter(
        (l: any) =>
          typeof l?.full_name === 'string' &&
          l.full_name.trim() &&
          (cleanDomain(l.company_domain) || l.linkedin_url),
      );
    if (leadsToReveal.length === 0) {
      return fail('No leads provided for bulk reveal');
    }

    // Filter out already revealed. Fetch only the rows whose domain is among
    // the requested leads: a full-table select is capped at 1000 rows by
    // PostgREST, which silently dropped the oldest leads and re-charged them.
    const revealDomains = [...new Set(leadsToReveal.map((l: any) => (l.company_domain || '').trim().toLowerCase()).filter(Boolean))];
    let existingLeads: any[] = [];
    if (revealDomains.length > 0) {
      const { data } = await admin
        .from('user_leads')
        .select('*')
        .eq('user_id', userId)
        .in('company_domain', revealDomains);
      if (data) existingLeads = data;
    }
    // LinkedIn-only leads (empty domain) are handled separately so they can
    // still be matched instead of being missed.
    if (leadsToReveal.some((l: any) => !(l.company_domain || '').trim())) {
      const { data: nullRows } = await admin
        .from('user_leads')
        .select('*')
        .eq('user_id', userId)
        .is('company_domain', null);
      if (nullRows) existingLeads = existingLeads.concat(nullRows);
      const { data: emptyRows } = await admin
        .from('user_leads')
        .select('*')
        .eq('user_id', userId)
        .eq('company_domain', '');
      if (emptyRows) existingLeads = existingLeads.concat(emptyRows);
    }

    const existingMap = new Map<string, any>();
    (existingLeads || []).forEach((e: any) => {
      const k = `${(e.company_domain || '').toLowerCase().trim()}::${(e.full_name || '').toLowerCase().trim()}`;
      if (hasRevealedEmail(e)) existingMap.set(k, e);
    });

    const neededLeads = leadsToReveal.filter((l: any) => {
      const k = `${(l.company_domain || '').toLowerCase().trim()}::${(l.full_name || '').toLowerCase().trim()}`;
      return !existingMap.has(k);
    });

    if (neededLeads.length === 0) {
      // Same key as the success branch. This one returned `updated_leads`, which
      // the client never reads, so a re-run of the batch looked like it had
      // revealed nothing at all.
      return json({
        ok: true,
        message: 'All selected leads were already revealed.',
        requested_count: 0,
        revealed_count: 0,
        credits_charged: 0,
        updated_records: (existingLeads || []).filter((e: any) =>
          existingMap.has(`${(e.company_domain || '').toLowerCase().trim()}::${(e.full_name || '').toLowerCase().trim()}`)
        ),
      });
    }

    // Reserve credits for the batch
    const emailPrice = (await loadPrices(admin)).email;
    const creditsToHold = Math.min(neededLeads.length, MAX_BULK) * emailPrice;
    const runKey = `bulk_reveal_${userId}_${Date.now()}`;
    const hold = await reserveCredits(admin, userId, creditsToHold, runKey, {
      feature: 'bulk_lead_email_reveal',
      count: creditsToHold,
    });

    if ('shortfall' in hold) {
      return fail(`Insufficient credits. Needed: ${hold.required}, Available: ${hold.available}`, 402, {
        insufficient_credits: true,
        required: hold.required,
        available: hold.available,
      });
    }

    // Execute email finds concurrently (batches of 5)
    const batch = neededLeads.slice(0, Math.min(neededLeads.length, MAX_BULK));
    let successfulReveals = 0;
    // Only verified addresses are charged; unconfirmed ones are returned free.
    let verifiedReveals = 0;
    let totalProviderCostUsd = 0;
    const updatedRecords: any[] = [];
    // Leads the provider answered for but had no address. A failed or timed-out
    // lookup is deliberately not listed: the client marks these rows "Not
    // found", and that must not happen to a row that was never really tried.
    const notFoundKeys: string[] = [];
    // Lookups that errored or timed out. Reported separately so the client
    // can offer a retry instead of claiming the person has no email.
    const failedKeys: string[] = [];

    const batchSize = 5;
    for (let i = 0; i < batch.length; i += batchSize) {
      const chunk = batch.slice(i, i + batchSize);
      await Promise.all(
        chunk.map(async (lead: any) => {
          try {
            const emailPayload: Record<string, string> = {};
            if (lead.company_domain) emailPayload.domain = lead.company_domain;
            if (lead.full_name) emailPayload.full_name = lead.full_name;
            if (lead.linkedin_url) emailPayload.linkedin_url = lead.linkedin_url;

            const tregRes = await fetch(`${TREG_BASE}/call/treg.people.email.find`, {
              method: 'POST',
              headers: {
                'X-Treg-Token': token,
                'X-Treg-Meta': `customer=${userId}, feature=bulk-email`,
                'X-Treg-Route-Verify': 'true',
                'X-Treg-Route-Max-Cost': MAX_COST.email,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(emailPayload),
              signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
            });

            const bulkRow = usage.track('treg.people.email.find', tregRes, { feature: 'bulk-email' });
            if (tregRes.ok) {
              const resJson = await tregRes.json();
              const rawEmail = resJson?.output?.email || resJson?.raw?.data?.email;
              const verdict = classifyEmail(resJson);
              const email = isEmailAddress(rawEmail) && verdict.usable ? rawEmail.trim() : null;
              if (email && verdict.charge) {
                verifiedReveals++;
                bulkRow.credits_charged = emailPrice;
              }
              const costMicro = Number(tregRes.headers.get('x-treg-cost-micro') || 0);
              totalProviderCostUsd += costMicro > 0 ? costMicro / 1e6 : 0.0048;

              const key = `${(lead.company_domain || '').toLowerCase().trim()}::${(lead.full_name || '').toLowerCase().trim()}`;
              if (!email) notFoundKeys.push(key);
              if (email) {
                successfulReveals++;
                updatedRecords.push({
                  user_id: userId,
                  first_name: lead.first_name || lead.full_name?.split(' ')[0] || '',
                  last_name: lead.last_name || lead.full_name?.split(' ').slice(1).join(' ') || '',
                  full_name: lead.full_name,
                  title: lead.title || 'Executive',
                  company_name: lead.company_name || lead.company_domain?.split('.')[0] || '',
                  company_domain: cleanDomain(lead.company_domain),
                  company_size: lead.company_size || null,
                  company_revenue: lead.company_revenue || null,
                  linkedin_url: lead.linkedin_url || null,
                  location: lead.location || null,
                  work_email: email,
                  email_status: verdict.status,
                  email_confidence: verdict.charge ? 0.95 : 0.5,
                  // Carry the existing stage forward. Hardcoding 'new' moved a
                  // prospect the user had already marked "Replied" back to the
                  // top of the pipeline every time its email was re-resolved.
                  status: existingMap.get(key)?.status || lead.status || 'new',
                  updated_at: new Date().toISOString(),
                });
              }
            } else {
              failedKeys.push(`${(lead.company_domain || '').toLowerCase().trim()}::${(lead.full_name || '').toLowerCase().trim()}`);
            }
          } catch (err: any) {
            failedKeys.push(`${(lead.company_domain || '').toLowerCase().trim()}::${(lead.full_name || '').toLowerCase().trim()}`);
            console.warn('[leads] bulk email item failed:', err?.name || err?.message);
          }
        })
      );
    }

    // Settle credits: ONLY charge for successful reveals!
    const creditsCharged = verifiedReveals * emailPrice;
    await settleCredits(
      admin,
      hold.id,
      creditsCharged,
      totalProviderCostUsd,
      runKey,
      `Bulk revealed ${successfulReveals} emails, ${verifiedReveals} verified and charged (${batch.length - verifiedReveals} not charged)`
    );

    // Save all successful records to user_leads
    if (updatedRecords.length > 0) {
      const { data: savedRows, error: saveErr } = await admin
        .from('user_leads')
        .upsert(updatedRecords, { onConflict: 'user_id,company_domain,full_name' })
        .select('id, company_domain, full_name');
      if (saveErr) console.error('[leads] bulk reveal upsert failed:', saveErr.message);
      // Hand the row ids back so the client can address those leads directly.
      const idByKey = new Map<string, string>();
      (savedRows || []).forEach((r: any) => {
        idByKey.set(`${(r.company_domain || '').toLowerCase().trim()}::${(r.full_name || '').toLowerCase().trim()}`, r.id);
      });
      updatedRecords.forEach((r: any) => {
        r.id = idByKey.get(`${(r.company_domain || '').toLowerCase().trim()}::${(r.full_name || '').toLowerCase().trim()}`) || r.id;
      });
    }

    return json({
      ok: true,
      // The client needs all three numbers to describe what happened without
      // inventing a refund: leads it sent, leads that cost nothing because the
      // address was already known, and leads this run could not reach because
      // of the per-batch cap.
      requested_count: leadsToReveal.length,
      already_revealed_count: leadsToReveal.length - neededLeads.length,
      processed_count: batch.length,
      capped_count: Math.max(0, neededLeads.length - batch.length),
      revealed_count: successfulReveals,
      verified_count: verifiedReveals,
      credits_charged: creditsCharged,
      skipped_count: neededLeads.length - batch.length,
      updated_records: updatedRecords,
      // Leads in this request whose address was already on file. Returned so
      // the client can show them without a second round trip.
      existing_records: leadsToReveal
        .map((l: any) => existingMap.get(`${(l.company_domain || '').toLowerCase().trim()}::${(l.full_name || '').toLowerCase().trim()}`))
        .filter(Boolean),
      not_found_keys: notFoundKeys,
      failed_keys: failedKeys,
    });
  }

  // =========================================================================
  // ACTION 3b: BULK REVEAL PHONES (2 credits per number found)
  // -------------------------------------------------------------------------
  // Same contract as bulk-reveal-email: credits are held for the batch up
  // front, only numbers actually found are charged, and the response says per
  // lead whether it was found, not found, or failed. The provider has no batch
  // endpoint, so the batch is small and the lookups run five at a time.
  // =========================================================================
  if (action === 'bulk-reveal-phone') {
    const MAX_BULK_PHONE = 25;
    const PHONE_CREDITS = (await loadPrices(admin)).phone;
    const keyOf = (l: any) =>
      `${(l.company_domain || '').toLowerCase().trim()}::${(l.full_name || '').toLowerCase().trim()}`;

    const requested: any[] = (Array.isArray(body.leads) ? body.leads : [])
      .slice(0, 2000)
      .filter(
        (l: any) =>
          typeof l?.full_name === 'string' &&
          l.full_name.trim() &&
          (cleanDomain(l.company_domain) || l.linkedin_url || isEmailAddress(l.work_email)),
      );
    if (requested.length === 0) return fail('No leads provided for phone lookup');

    const domains = [...new Set(requested.map((l: any) => cleanDomain(l.company_domain)).filter(Boolean))];
    let existingRows: any[] = [];
    if (domains.length > 0) {
      const { data } = await admin
        .from('user_leads')
        .select('*')
        .eq('user_id', userId)
        .in('company_domain', domains);
      if (data) existingRows = data;
    }
    const existingByKey = new Map<string, any>();
    existingRows.forEach((r: any) => existingByKey.set(keyOf(r), r));

    // A number already on file is never bought twice.
    const known = requested.filter((l: any) => existingByKey.get(keyOf(l))?.phone_number);
    const needed = requested.filter((l: any) => !existingByKey.get(keyOf(l))?.phone_number);
    const batch = needed.slice(0, MAX_BULK_PHONE);
    const existingRecords = known.map((l: any) => existingByKey.get(keyOf(l)));

    if (batch.length === 0) {
      return json({
        ok: true,
        revealed_count: 0,
        credits_charged: 0,
        processed_count: 0,
        capped_count: 0,
        updated_records: [],
        existing_records: existingRecords,
        not_found_keys: [],
        failed_keys: [],
      });
    }

    const runKey = `bulk_phone_${userId}_${Date.now()}`;
    const hold = await reserveCredits(admin, userId, batch.length * PHONE_CREDITS, runKey, {
      feature: 'bulk_lead_phone_reveal',
      count: batch.length,
    });
    if ('shortfall' in hold) {
      return fail(`Insufficient credits. Needed: ${hold.required}, Available: ${hold.available}`, 402, {
        insufficient_credits: true,
        required: hold.required,
        available: hold.available,
      });
    }

    const updatedRecords: any[] = [];
    const notFoundKeys: string[] = [];
    const failedKeys: string[] = [];
    let providerCostUsd = 0;

    try {
      for (let i = 0; i < batch.length; i += 5) {
        await Promise.all(
          batch.slice(i, i + 5).map(async (lead: any) => {
            const key = keyOf(lead);
            try {
              const domain = cleanDomain(lead.company_domain);
              const email = isEmailAddress(lead.work_email) ? lead.work_email.trim() : '';
              const payload: Record<string, string> = { full_name: lead.full_name.trim() };
              if (lead.linkedin_url) payload.linkedin_url = lead.linkedin_url;
              if (email) payload.email = email;
              if (domain) payload.domain = domain;

              const res = await fetch(`${TREG_BASE}/call/treg.people.phone.find`, {
                method: 'POST',
                headers: {
                  'X-Treg-Token': token,
                  'X-Treg-Meta': `customer=${userId}, feature=bulk-phone`,
                  'X-Treg-Route-Max-Cost': MAX_COST.phone,
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
              });
              const costMicro = Number(res.headers.get('x-treg-cost-micro') || 0);
              if (costMicro > 0) providerCostUsd += costMicro / 1e6;
              const phoneRow = usage.track('treg.people.phone.find', res, { feature: 'bulk-phone' });
              if (!res.ok) {
                failedKeys.push(key);
                return;
              }
              const data = await res.json();
              const phone = data?.output?.phone || data?.raw?.data?.employee_phone || null;
              if (typeof phone !== 'string' || !phone.trim()) {
                notFoundKeys.push(key);
                return;
              }
              phoneRow.credits_charged = PHONE_CREDITS;
              updatedRecords.push({
                user_id: userId,
                full_name: lead.full_name.trim(),
                first_name: lead.first_name || lead.full_name.trim().split(' ')[0] || '',
                last_name: lead.last_name || lead.full_name.trim().split(' ').slice(1).join(' ') || '',
                title: lead.title || 'Executive',
                company_name: lead.company_name || (domain ? domain.split('.')[0] : ''),
                company_domain: domain,
                linkedin_url: lead.linkedin_url || null,
                location: lead.location || null,
                // Omitted when unknown: on a conflict an explicit null would
                // erase the address this row already had.
                ...(email ? { work_email: email } : {}),
                phone_number: phone.trim(),
                phone_type: data?.output?.line_type || 'mobile',
                updated_at: new Date().toISOString(),
              });
            } catch (err: any) {
              failedKeys.push(key);
              console.warn('[leads] bulk phone item failed:', err?.name || err?.message);
            }
          }),
        );
      }
    } finally {
      // Settled from `finally` so an exception mid-batch cannot leave the
      // hold open. Only numbers actually found are charged.
      await settleCredits(
        admin,
        hold.id,
        updatedRecords.length * PHONE_CREDITS,
        providerCostUsd,
        runKey,
        `Bulk revealed ${updatedRecords.length} phones (${batch.length - updatedRecords.length} not charged)`,
      );
    }

    if (updatedRecords.length > 0) {
      const { data: savedRows, error: saveErr } = await admin
        .from('user_leads')
        .upsert(updatedRecords, { onConflict: 'user_id,company_domain,full_name' })
        .select('id, company_domain, full_name');
      if (saveErr) console.error('[leads] bulk phone upsert failed:', saveErr.message);
      const idByKey = new Map<string, string>();
      (savedRows || []).forEach((r: any) => idByKey.set(keyOf(r), r.id));
      updatedRecords.forEach((r: any) => {
        r.id = idByKey.get(keyOf(r)) || r.id;
      });
    }

    return json({
      ok: true,
      revealed_count: updatedRecords.length,
      credits_charged: updatedRecords.length * PHONE_CREDITS,
      processed_count: batch.length,
      capped_count: Math.max(0, needed.length - batch.length),
      updated_records: updatedRecords,
      existing_records: existingRecords,
      not_found_keys: notFoundKeys,
      failed_keys: failedKeys,
    });
  }

  // =========================================================================
  // ACTION 4: REVEAL PHONE (2 Credits)
  // =========================================================================
  if (action === 'reveal-phone') {
    const { full_name, first_name, last_name, company_domain, linkedin_url } = body;
    // Only a real address is used to match or persist; a preview placeholder
    // like "N/A" would otherwise be written into the saved row.
    const work_email = isEmailAddress(body.work_email) ? body.work_email.trim() : '';

    if (!linkedin_url && !company_domain && !work_email) {
      return fail('LinkedIn URL, email, or company domain is required.');
    }

    const resolvedDomain = cleanDomain(company_domain);
    let finalDomain = resolvedDomain;
    if (!finalDomain && work_email && work_email.includes('@')) {
      finalDomain = cleanDomain(work_email.split('@')[1]);
    }
    const derived = !full_name && linkedin_url ? nameFromLinkedinSlug(linkedin_url) : null;
    const resolvedName = (full_name || derived?.full_name || '').trim();

    const existing = await findExistingLead(admin, userId, { companyDomain: finalDomain, fullName: resolvedName, linkedinUrl: linkedin_url, workEmail: work_email });

    if (existing?.phone_number) {
      return json({
        ok: true,
        already_revealed: true,
        lead: existing,
        credits_charged: 0,
      });
    }

    const CREDITS_REQUIRED = (await loadPrices(admin)).phone;
    const runKey = `reveal_phone_${userId}_${Date.now()}`;
    const hold = await reserveCredits(admin, userId, CREDITS_REQUIRED, runKey, {
      feature: 'lead_phone_reveal',
      target: resolvedName || linkedin_url,
    });

    if ('shortfall' in hold) {
      return fail(`Insufficient credits. Required: ${hold.required}, Available: ${hold.available}`, 402, {
        insufficient_credits: true,
        required: hold.required,
        available: hold.available,
      });
    }

    let phoneFound: string | null = null;
    let phoneType = 'mobile';
    let providerCostUsd = 0.02;

    try {
      const phonePayload: Record<string, string> = {};
      if (linkedin_url) phonePayload.linkedin_url = linkedin_url;
      if (work_email) phonePayload.email = work_email;
      if (finalDomain) phonePayload.domain = finalDomain;
      if (resolvedName) phonePayload.full_name = resolvedName;

      const tregRes = await fetch(`${TREG_BASE}/call/treg.people.phone.find`, {
        method: 'POST',
        headers: {
          'X-Treg-Token': token,
          'X-Treg-Meta': `customer=${userId}, feature=lead-phone`,
          'X-Treg-Route-Max-Cost': MAX_COST.phone,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(phonePayload),
        signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      });

      const costMicro = Number(tregRes.headers.get('x-treg-cost-micro') || 0);
      if (costMicro > 0) providerCostUsd = costMicro / 1e6;
      const singlePhoneRow = usage.track('treg.people.phone.find', tregRes, { feature: 'lead-phone' });

      if (tregRes.ok) {
        const resJson = await tregRes.json();
        phoneFound = resJson?.output?.phone || resJson?.raw?.data?.employee_phone || null;
        phoneType = resJson?.output?.line_type || 'mobile';
        if (phoneFound) singlePhoneRow.credits_charged = CREDITS_REQUIRED;
      }
    } catch (err: any) {
      console.warn('[leads] phone find error:', err.message);
    }

    if (phoneFound) {
      await settleCredits(admin, hold.id, CREDITS_REQUIRED, providerCostUsd, runKey, `Revealed phone for ${resolvedName}`);
    } else {
      await settleCredits(admin, hold.id, 0, 0, runKey, `No phone found - refund`);
      return fail('No direct mobile number found for this lead. Zero credits charged.', 404, { no_hit: true });
    }

    const updatePayload = {
      phone_number: phoneFound,
      phone_type: phoneType,
      updated_at: new Date().toISOString(),
    };

    let updatedLead = existing;

    if (existing?.id) {
      const { data, error } = await admin
        .from('user_leads')
        .update(updatePayload)
        .eq('id', existing.id)
        .eq('user_id', userId)
        .select()
        .maybeSingle();
      if (error) console.warn('[leads] phone update failed:', error.message);
      updatedLead = data || existing;
    } else if (resolvedName) {
      // The credits are already settled, so the number has to land somewhere
      // durable. Previously a phone revealed for a lead that was not already in
      // the pipeline was returned to the screen and then dropped on the next
      // render — two credits for a contact the user could never find again.
      const { data, error } = await admin
        .from('user_leads')
        .upsert(
          {
            user_id: userId,
            first_name: first_name || derived?.first_name || resolvedName.split(' ')[0] || '',
            last_name: last_name || derived?.last_name || resolvedName.split(' ').slice(1).join(' ') || '',
            full_name: resolvedName,
            title: body.title || 'Executive',
            company_name: body.company_name || (finalDomain ? finalDomain.split('.')[0].toUpperCase() : ''),
            company_domain: finalDomain,
            linkedin_url: linkedin_url || null,
            location: body.location || null,
            // Omitted when unknown: on a conflict an explicit null would erase
            // the address this row already had.
            ...(work_email ? { work_email } : {}),
            ...updatePayload,
          },
          { onConflict: 'user_id,company_domain,full_name' }
        )
        .select()
        .maybeSingle();
      if (error) {
        console.error('[leads] phone persist failed:', error.message);
      } else {
        updatedLead = data;
      }
    }

    return json({
      ok: true,
      lead: updatedLead || { ...body, full_name: resolvedName, ...updatePayload },
      credits_charged: CREDITS_REQUIRED,
    });
  }

  // =========================================================================
  // ACTION 5: BULK SAVE LEADS (Bookmarks)
  // =========================================================================
  if (action === 'bulk-save') {
    const leadsToSave: any[] = Array.isArray(body.leads) ? body.leads : [];
    if (leadsToSave.length === 0) return fail('No leads provided');
  // Fetch existing rows so a re-save cannot wipe a paid-for email, phone, or
  // the pipeline stage the user already set on this prospect.
  //
  // Scoped to the domains in this batch on purpose: a full-table select is
  // capped by PostgREST, so on a pipeline bigger than that cap the map came
  // back incomplete and the upsert below wrote null over the very emails and
  // phones it was supposed to preserve.
  const saveDomains = [
    ...new Set(
      leadsToSave.map((l: any) => cleanDomain(l?.company_domain)).filter(Boolean),
    ),
  ];
  let existingRows: any[] = [];
  const DOMAIN_CHUNK = 100;
  const ROW_PAGE = 500;
  for (let i = 0; i < saveDomains.length; i += DOMAIN_CHUNK) {
    const chunk = saveDomains.slice(i, i + DOMAIN_CHUNK);
    let from = 0;
    while (true) {
      const { data, error } = await admin
        .from('user_leads')
        .select('*')
        .eq('user_id', userId)
        .in('company_domain', chunk)
        .range(from, from + ROW_PAGE - 1);
      if (error || !data || data.length === 0) break;
      existingRows.push(...data);
      if (data.length < ROW_PAGE) break;
      from += ROW_PAGE;
    }
  }
  // LinkedIn-only leads carry an empty domain, and the upsert can collide with
  // those rows too.
  if (leadsToSave.some((l: any) => !cleanDomain(l?.company_domain))) {
    const { data: emptyRows } = await admin
      .from('user_leads')
      .select('*')
      .eq('user_id', userId)
      .eq('company_domain', '');
    if (emptyRows) existingRows = existingRows.concat(emptyRows);
    const { data: nullRows } = await admin
      .from('user_leads')
      .select('*')
      .eq('user_id', userId)
      .is('company_domain', null);
    if (nullRows) existingRows = existingRows.concat(nullRows);
  }
  const existingMap = new Map();
  (existingRows || []).forEach((r) => {
    existingMap.set((r.company_domain || '').toLowerCase().trim() + '::' + (r.full_name || '').toLowerCase().trim(), r);
  });


    const existingFor = (l: any) =>
      existingMap.get(cleanDomain(l.company_domain) + '::' + (l.full_name || '').toLowerCase().trim());
    // Only a resolved address may be written as work_email. A search result's
    // unverified preview address (or a placeholder such as "N/A") saved here
    // later came back from the reveal endpoints as "already revealed", so the
    // verified address could never be bought for that lead.
    const clientEmail = (l: any): string | null => {
      if (l?.email_status === 'preview') return null;
      const candidate = l?.revealed_email || l?.work_email;
      return isEmailAddress(candidate) ? candidate.trim() : null;
    };

    const records = leadsToSave
      // full_name is NOT NULL and is half the conflict target, so a record
      // without one cannot be saved at all.
      .filter((l: any) => typeof l?.full_name === 'string' && l.full_name.trim())
      .map((l: any) => ({
        user_id: userId,
        first_name: l.first_name || l.full_name?.split(' ')[0] || '',
        last_name: l.last_name || l.full_name?.split(' ').slice(1).join(' ') || '',
        full_name: l.full_name,
        title: l.title || 'Executive',
        company_name: l.company_name || l.company_domain?.split('.')[0] || '',
        company_domain: cleanDomain(l.company_domain),
        company_size: l.company_size || null,
        company_revenue: l.company_revenue || null,
        company_phone: l.company_phone || null,
        linkedin_url: l.linkedin_url || null,
        location: l.location || null,
        work_email: clientEmail(l) || existingFor(l)?.work_email || null,
        phone_number: l.revealed_phone || l.phone_number || existingFor(l)?.phone_number || null,
        email_status: (clientEmail(l) ? l.email_status : null) || existingFor(l)?.email_status || null,
        status: l.status || existingFor(l)?.status || 'new',
        updated_at: new Date().toISOString(),
      }));

    if (records.length === 0) return fail('No savable leads provided');

    // Postgres rejects an upsert whose payload touches the same conflict key
    // twice ("ON CONFLICT DO UPDATE command cannot affect row a second time").
    // Keep the last copy of each person.
    const dedupedRecords = new Map<string, any>();
    for (const record of records) {
      dedupedRecords.set(
        `${record.company_domain}::${(record.full_name || '').toLowerCase().trim()}`,
        record,
      );
    }
    const uniqueRecords = [...dedupedRecords.values()];

    const { data, error } = await admin
      .from('user_leads')
      .upsert(uniqueRecords, { onConflict: 'user_id,company_domain,full_name' })
      .select();

    if (error) {
      console.error('[leads] bulk save failed:', error.message);
      return fail('Failed to save leads', 500);
    }
    // How many were already in the pipeline, so the client can say "3 added,
    // 2 already saved" instead of claiming every row was newly saved.
    const alreadySaved = uniqueRecords.filter((r) =>
      existingMap.has(`${r.company_domain}::${(r.full_name || '').toLowerCase().trim()}`),
    ).length;
    return json({
      ok: true,
      saved_count: data?.length || 0,
      new_count: Math.max(0, (data?.length || 0) - alreadySaved),
      already_saved_count: alreadySaved,
      skipped_count: leadsToSave.length - records.length,
      leads: data,
    });
  }

  // =========================================================================
  // ACTION 6: LIST SAVED LEADS
  // =========================================================================
  if (action === 'list-saved') {
    const status = body.status;
    const query = String(body.query || '').trim();

    let q = admin
      .from('user_leads')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      q = q.eq('status', status);
    }
    if (query) {
      // PostgREST .or() takes a filter string, so its own metacharacters have
      // to go: a comma or parenthesis in the search box would otherwise close
      // the pattern and start a new condition. The letters and digits are all
      // a name search actually needs.
      const safe = query.replace(/[^a-z0-9 ._@'-]/gi, '').slice(0, 80);
      if (safe) {
        q = q.or(
          `full_name.ilike.%${safe}%,company_name.ilike.%${safe}%,company_domain.ilike.%${safe}%,work_email.ilike.%${safe}%`
        );
      }
    }

    // A single PostgREST response is capped, so one .limit() call quietly kept
    // only the newest slice of the pipeline. With searches now reaching 1000
    // leads that slice is half the pipeline. Page through the result set
    // instead, with a ceiling high enough to hold a full large search.
    const PAGE_SIZE = 500;
    const MAX_SAVED_LEADS = 2000;
    const savedLeads: any[] = [];

    for (let from = 0; from < MAX_SAVED_LEADS; from += PAGE_SIZE) {
      const to = Math.min(from + PAGE_SIZE, MAX_SAVED_LEADS) - 1;
      const { data, error } = await q.range(from, to);
      if (error) {
        return fail('Failed to fetch saved leads', 500);
      }
      if (data && data.length > 0) savedLeads.push(...data);
      if (!data || data.length < PAGE_SIZE) break;
    }

    // Rows saved before preview addresses were kept apart can still carry one
    // (or a placeholder such as "N/A") in work_email. Hand those back as the
    // unverified preview they are, so no view presents them as revealed.
    const cleaned = savedLeads.map((row) =>
      row.work_email && !hasRevealedEmail(row)
        ? {
            ...row,
            preview_email: isEmailAddress(row.work_email) ? row.work_email : null,
            work_email: null,
            email_status: null,
          }
        : row,
    );

    return json({ ok: true, leads: cleaned, limit_reached: cleaned.length >= MAX_SAVED_LEADS });
  }

  // =========================================================================
  // ACTION 7: UPDATE STATUS / NOTES
  // =========================================================================
  if (action === 'update-status') {
    const { lead_id, company_domain, full_name, status, notes } = body;

    const ALLOWED_STATUS = ['new', 'contacted', 'replied', 'dismissed'];
    if (!lead_id && !(company_domain && full_name)) {
      return fail('lead_id or company_domain + full_name is required', 400);
    }
    if (status && !ALLOWED_STATUS.includes(status)) {
      return fail(`Invalid status. Expected one of: ${ALLOWED_STATUS.join(', ')}`, 400);
    }

    const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
    if (status) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;

    let query = admin.from('user_leads').select('*').eq('user_id', userId);
    if (isUuid(lead_id)) {
      query = query.eq('id', lead_id);
    } else {
      query = query.eq('company_domain', cleanDomain(company_domain)).ilike('full_name', escapeLike(full_name));
    }

    const { data: matched, error: lookupError } = await query.limit(1);
    if (lookupError) return fail('Failed to look up lead', 500);

    // If lead is not yet saved in user_leads, auto-save it with the requested status!
    if (!matched || matched.length === 0) {
      const resolvedName = (full_name || '').trim();
      if (!resolvedName) {
        return fail('Lead not found in your pipeline. Save it first.', 404);
      }
      const first = body.first_name || resolvedName.split(' ')[0] || '';
      const last = body.last_name || resolvedName.split(' ').slice(1).join(' ') || '';
      const { data: inserted, error: insertError } = await admin
        .from('user_leads')
        .upsert(
          {
            user_id: userId,
            first_name: first,
            last_name: last,
            full_name: resolvedName,
            title: body.title || 'Executive',
            company_name: body.company_name || (company_domain || '').split('.')[0] || '',
            company_domain: cleanDomain(company_domain),
            linkedin_url: body.linkedin_url || null,
            // Omitted when unknown: on a conflict an explicit null would erase
            // the paid-for contact details the row already carried.
            ...(isEmailAddress(body.work_email) ? { work_email: body.work_email.trim() } : {}),
            ...(body.phone_number ? { phone_number: body.phone_number } : {}),
            location: body.location || null,
            status: status || 'new',
            notes: notes || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,company_domain,full_name' }
        )
        .select()
        .maybeSingle();

      if (insertError) {
        console.error('[leads] auto-save on status update failed:', insertError.message);
        return fail('Failed to save lead to pipeline', 500);
      }
      return json({ ok: true, lead: inserted, auto_saved: true });
    }

    const { data, error } = await admin
      .from('user_leads')
      .update(updateData)
      .eq('id', matched[0].id)
      .eq('user_id', userId)
      .select()
      .maybeSingle();

    if (error) return fail('Failed to update lead status', 500);
    return json({ ok: true, lead: data });
  }

  // =========================================================================
  // ACTION 8: DELETE SAVED LEAD(S)
  // =========================================================================
  if (action === 'delete-saved') {
    const { lead_id, lead_ids, company_domain, full_name } = body;
    const idsToDelete: string[] = [];
    if (isUuid(lead_id)) idsToDelete.push(lead_id);
    if (Array.isArray(lead_ids)) {
      lead_ids.forEach((id: string) => {
        if (isUuid(id)) idsToDelete.push(id);
      });
    }

    if (idsToDelete.length > 0) {
      // .select() returns the rows that were actually removed. Reporting the
      // requested ids made deleting an already-gone row look successful.
      const { data: deleted, error } = await admin
        .from('user_leads')
        .delete()
        .in('id', idsToDelete)
        .eq('user_id', userId)
        .select('id');

      if (error) return fail('Failed to delete lead(s)', 500);
      return json({ ok: true, deleted_count: deleted?.length ?? 0 });
    }

    if (company_domain || full_name) {
      let delQuery = admin.from('user_leads').delete().eq('user_id', userId);
      if (company_domain) delQuery = delQuery.eq('company_domain', cleanDomain(company_domain));
      if (full_name) delQuery = delQuery.ilike('full_name', escapeLike(full_name));

      const { data: deleted, error } = await delQuery.select('id');
      if (error) return fail('Failed to delete lead', 500);
      return json({ ok: true, deleted_count: deleted?.length ?? 0 });
    }

    return fail('lead_id, lead_ids, or company_domain + full_name required for deletion', 400);
  }

  return fail(`Unknown action: ${action}`);
  }
});
