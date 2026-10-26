// ============================================================================
// Pure helpers for the leads function.
//
// Kept apart from index.ts (which calls Deno.serve at module load) so they can
// be unit tested with `deno test` without starting a server.
// ============================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * True for a string that is actually an email address.
 *
 * The provider fills the email field with placeholders such as "N/A". Those
 * were treated as revealed addresses: the row showed "N/A" with a copy button,
 * lost its Reveal button, and was skipped by auto-enrich and bulk reveal.
 */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('*') && EMAIL_RE.test(value.trim());
}

/** Verifier statuses that are shown to the user as a found (if unconfirmed) address. */
const USABLE_EMAIL_STATUSES = new Set(['valid', 'accept_all', 'risky']);

/**
 * True when a saved row holds a VERIFIED work email, i.e. one that was bought.
 *
 * This is the "already revealed, do not look it up again" test. It used to
 * accept any non-preview status, so a free `unknown`/`risky` address saved on
 * a row blocked the user from ever buying the verified one (audit M2).
 */
export function hasRevealedEmail(row: any): boolean {
  return isEmailAddress(row?.work_email) && String(row?.email_status || '').toLowerCase() === 'valid';
}

/**
 * True when a saved row holds an address that may be SHOWN: verified, or a
 * catch-all / risky address the verifier found. An `unknown`, `pending`,
 * `invalid`, `preview` or missing status is not usable (audit H3): it is not
 * shown as revealed and not treated as one.
 */
export function hasUsableEmail(row: any): boolean {
  return isEmailAddress(row?.work_email) && USABLE_EMAIL_STATUSES.has(String(row?.email_status || '').toLowerCase());
}

/**
 * What an email lookup's verifier said, and whether it may be charged.
 *
 * Treg puts the verifier's answer at _treg.verification.verdict: valid,
 * invalid, catch_all, risky or unknown (or `checked: false` / `pending: true`
 * when no verdict exists yet). Only a `valid` address is charged. A catch-all
 * or risky address is shown, labelled unconfirmed, for free. An `invalid`,
 * `unknown`, `pending` or missing verdict is NOT usable: it is not shown, not
 * saved, and not handed out free (audit H3).
 */
export interface EmailVerdict {
  status: string;
  charge: boolean;
  usable: boolean;
}
export function classifyEmail(resJson: any): EmailVerdict {
  const v = resJson?._treg?.verification;
  const verdict = typeof v?.verdict === 'string' ? v.verdict.toLowerCase() : '';
  if (verdict === 'valid') return { status: 'valid', charge: true, usable: true };
  if (verdict === 'invalid') return { status: 'invalid', charge: false, usable: false };
  if (verdict === 'catch_all' || verdict === 'accept_all') return { status: 'accept_all', charge: false, usable: true };
  if (verdict === 'risky') return { status: 'risky', charge: false, usable: true };
  return { status: v?.pending ? 'pending' : 'unknown', charge: false, usable: false };
}

export function cleanDomain(d?: string | null): string {
  if (!d || typeof d !== 'string') return '';
  return d
    .slice(0, 1000)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .trim()
    .toLowerCase()
    .slice(0, 253);
}

/** Slug of a LinkedIn profile URL, lowercased, or null. */
export function linkedinSlug(url?: string | null): string | null {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** The (company_domain, full_name) identity the table's unique key is built on. */
export function leadKey(l: any): string {
  return `${cleanDomain(l?.company_domain)}::${String(l?.full_name || '').toLowerCase().trim()}`;
}

/**
 * Collapses duplicate leads by (company_domain, full_name) before any lookup
 * (audit H5). Duplicates used to be looked up and charged once each, and then
 * the batch upsert failed with "cannot affect row a second time", so nothing
 * was saved. The first copy wins; every client key of the group is kept so
 * per-lead results still reach each of the client's rows.
 */
export function dedupeLeads<T extends { client_key?: string }>(leads: T[]): (T & { client_keys: string[] })[] {
  const byKey = new Map<string, T & { client_keys: string[] }>();
  for (const l of leads) {
    const k = leadKey(l);
    const ck = l.client_key ?? k;
    const seen = byKey.get(k);
    if (seen) {
      if (!seen.client_keys.includes(ck)) seen.client_keys.push(ck);
      continue;
    }
    byKey.set(k, { ...l, client_keys: [ck] });
  }
  return [...byKey.values()];
}

/**
 * The name-only lookup's post-filter (audit M2). A same-name row is only the
 * same person when the LinkedIn slug was supplied and agrees, and the row's
 * domain does not contradict the requested one. Without a slug a name alone
 * cannot identify anyone, so nothing is accepted.
 */
export function acceptNameOnlyMatch(row: any, slug: string | null, domain: string): boolean {
  if (!slug) return false;
  if (linkedinSlug(row?.linkedin_url) !== slug) return false;
  const rowDomain = cleanDomain(row?.company_domain);
  return !domain || !rowDomain || rowDomain === domain;
}

/** Defaults the function writes when it knows nothing better; never worth overwriting real data with. */
const PLACEHOLDERS: Record<string, string[]> = {
  title: ['Executive', 'Executive / Leader', 'Target Decision Maker'],
  company_name: ['Enterprise', 'Company', 'Target Company'],
  full_name: ['Decision Maker'],
};

function isBlank(key: string, v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && (v.trim() === '' || PLACEHOLDERS[key]?.includes(v.trim()))) return true;
  return false;
}

/**
 * Merges an incoming user_leads record onto the stored row (audit M2).
 *
 * Upserts used to write every column, so a re-save or a phone reveal replaced
 * a stored title, company, size or LinkedIn URL with null or "Executive". Now
 * an incoming blank or placeholder value keeps what was stored. The stored
 * row's exact company_domain / full_name are used so the upsert hits that row
 * (the unique key is case-sensitive). `status` keeps the stored stage when the
 * incoming one is blank, and falls back to 'new' (the column is NOT NULL).
 * Only keys present in `incoming` are returned, so every record built from the
 * same template has the same columns (a bulk upsert fills missing ones with null).
 */
export function mergeLeadRecord(existing: any | null, incoming: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...incoming };
  if (existing) {
    for (const [k, v] of Object.entries(incoming)) {
      if (isBlank(k, v) && !isBlank(k, existing[k])) out[k] = existing[k];
    }
    if (typeof existing.company_domain === 'string') out.company_domain = existing.company_domain;
    if (typeof existing.full_name === 'string' && existing.full_name) out.full_name = existing.full_name;
  }
  if ('status' in incoming && !out.status) out.status = 'new';
  return out;
}

// ---------------------------------------------------------------------------
// Search call budget (audit H4: search is charged per billed provider call)
// ---------------------------------------------------------------------------

export const MAX_PROVIDER_CALLS = 12;
export const MAX_SEARCH_DOMAINS = 10;
export const PROVIDER_PAGE = 100;

/**
 * Most provider calls one search can make, mirroring the search code exactly:
 *  - multi-domain (2+ domains): d = min(domains, 10) domains, each searched in
 *    `rounds` calls, rounds = max(1, min(ceil(perDomain/100), floor(12/d))),
 *    so at most d × rounds ≤ 12 (e.g. 3 domains × 4 rounds for 1000 leads).
 *  - single target / persona: one call, plus for a request above 100 up to
 *    min(12, ceil(remaining/100)) extra calls, remaining ≤ limit, so at most
 *    1 + 10 = 11 for the 1000-lead maximum.
 */
export function maxSearchProviderCalls(domainCount: number, requestedLimit: number): number {
  if (domainCount > 1) {
    const d = Math.min(domainCount, MAX_SEARCH_DOMAINS);
    const perDomainLimit = Math.max(10, Math.ceil(requestedLimit / d));
    const rounds = Math.max(1, Math.min(Math.ceil(perDomainLimit / PROVIDER_PAGE), Math.floor(MAX_PROVIDER_CALLS / d)));
    return d * rounds;
  }
  if (requestedLimit <= PROVIDER_PAGE) return 1;
  return 1 + Math.min(MAX_PROVIDER_CALLS, Math.max(1, Math.ceil(requestedLimit / PROVIDER_PAGE)));
}

/** Largest limit (≤ requested, ≥ min) whose worst-case search cost fits `available`; 0 when none does. */
export function affordableSearchLimit(
  requested: number,
  domainCount: number,
  available: number,
  creditsPerCall: number,
  minLimit = 5,
): number {
  if (creditsPerCall <= 0) return requested;
  for (let limit = requested; limit >= minLimit; limit--) {
    if (maxSearchProviderCalls(domainCount, limit) * creditsPerCall <= available) return limit;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Company enrichment (treg.companies.enrich)
// ---------------------------------------------------------------------------

/** A cached company is re-bought after this long; a cached miss is retried after the shorter one. */
export const COMPANY_HIT_TTL_MS = 90 * 24 * 3600_000;
export const COMPANY_MISS_TTL_MS = 30 * 24 * 3600_000;

/** One `companies` row, as the leads function writes it. */
export interface CompanyRow {
  domain: string;
  name: string;
  description: string | null;
  industry: string | null;
  employees: string | null;
  founded_year: number | null;
  location: string | null;
  linkedin_url: string | null;
  website: string | null;
  logo_url: string | null;
  served_by: string | null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/** An https URL on one of `hosts` (or any host when omitted), else null. Rendered as links, so nothing else gets through. */
function httpsUrl(value: unknown, hosts?: string[]): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  return `https://${host}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * The `companies` row for a treg.companies.enrich answer, or null on a miss.
 *
 * treg normalises every child provider onto one contract under `output`
 * (name, domain, website, description, industry, employees, founded,
 * location, linkedin_url); a miss is `output.name == null`. A logo is not in
 * the contract, so it is taken from the provider's own answer when present.
 */
export function mapCompanyOutput(resJson: any, domain: string): CompanyRow | null {
  const out = resJson?.output ?? {};
  const name = text(out.name, 200);
  if (!name) return null;
  const raw = resJson?.raw ?? {};
  const founded = Number(out.founded);
  const year = new Date().getUTCFullYear();
  return {
    domain,
    name,
    description: text(out.description, 2000),
    industry: text(out.industry, 200),
    employees: text(out.employees, 50),
    founded_year: Number.isInteger(founded) && founded >= 1600 && founded <= year ? founded : null,
    location: text(out.location, 200),
    linkedin_url: httpsUrl(out.linkedin_url, ['linkedin.com']),
    website: httpsUrl(out.website),
    logo_url: httpsUrl(raw.logo_url ?? raw.logo ?? raw.data?.logo_url ?? raw.data?.logo),
    served_by: text(resJson?._treg?.served_by, 100),
  };
}

/** What a cached row is worth: a usable hit, a recent miss, or nothing (absent or stale). */
export function cachedCompanyState(
  row: { enriched_at?: string | null; miss_at?: string | null; name?: string | null } | null | undefined,
  now = Date.now(),
): 'hit' | 'miss' | 'stale' {
  if (!row) return 'stale';
  const at = (v?: string | null) => (v ? Date.parse(v) : NaN);
  const hitAt = at(row.enriched_at);
  const missAt = at(row.miss_at);
  // Whichever lookup is newer decides.
  if (row.name && Number.isFinite(hitAt) && !(missAt > hitAt) && now - hitAt < COMPANY_HIT_TTL_MS) return 'hit';
  if (Number.isFinite(missAt) && !(hitAt > missAt) && now - missAt < COMPANY_MISS_TTL_MS) return 'miss';
  return 'stale';
}

// ---------------------------------------------------------------------------
// Usage log
// ---------------------------------------------------------------------------

export interface UsageRow {
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
  /** The hold this call was made under, so the reaper can settle it (audit H6). */
  reservation_id: string | null;
  metadata: Record<string, unknown>;
}

/**
 * One api_usage row per Treg call, carrying what Treg actually charged
 * (x-treg-cost-micro) and the reservation it was made under. Revenue stays in
 * the wallet ledger (wallet_settle); these rows carry the credits so the
 * reaper can settle a hold whose request died before its own settle.
 */
export class UsageLog {
  rows: UsageRow[] = [];
  /** Rows before this index are already written. Rows are never dropped, so indices stay valid. */
  private flushed = 0;
  /** Rows whose response carried no cost header at all (cannot tell billed from free). */
  private unreported = new WeakSet<UsageRow>();
  constructor(private userId: string) {}

  track(
    operation: string,
    res: Response | null,
    meta: Record<string, unknown> = {},
    reservationId: string | null = null,
  ): UsageRow {
    const header = res ? res.headers.get('x-treg-cost-micro') : null;
    const costMicro = Number(header || 0);
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
      reservation_id: reservationId,
      metadata: meta,
    };
    if (res && header === null) this.unreported.add(row);
    this.rows.push(row);
    return row;
  }

  /** What Treg charged for every call tracked since `start`, hits and misses alike. */
  costSince(start: number, operation?: string, feature?: string): number {
    let total = 0;
    for (const row of this.rows.slice(start)) {
      if (operation && row.operation !== operation) continue;
      if (feature && row.metadata?.feature !== feature) continue;
      total += row.provider_cost_usd;
    }
    return Number(total.toFixed(8));
  }

  /**
   * Successful calls since `start` that the provider billed: a reported cost
   * above zero, or a 2xx with no cost header at all (treated as billed rather
   * than handing the search out free when the header is missing).
   */
  billedCallsSince(start: number, operation: string): UsageRow[] {
    return this.rows.slice(start).filter(
      (row) =>
        row.operation === operation &&
        row.http_status !== null &&
        row.http_status >= 200 &&
        row.http_status < 300 &&
        (row.provider_cost_usd > 0 || this.unreported.has(row)),
    );
  }

  /** Writes the rows not yet written. Called before every settle (audit H6). */
  async flush(admin: any) {
    if (this.flushed >= this.rows.length) return;
    const rows = this.rows.slice(this.flushed);
    this.flushed = this.rows.length;
    const { error } = await admin.from('api_usage').upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true });
    if (error) console.error('[leads] usage record failed:', error.message);
  }
}

/** The message for a paid-only reserve that the wallet cannot cover. */
export const PAID_CREDITS_MESSAGE =
  'Leads need purchased credits — free welcome credits only cover feed sweeps.';

// ---------------------------------------------------------------------------
// CORS allow-list (same rule as social-search / mail)
// ---------------------------------------------------------------------------

export const DEV_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];

const stripSlash = (s: string) => s.trim().replace(/\/+$/, '');

/**
 * ALLOWED_ORIGIN (comma-separated) plus APP_ORIGIN form the allow-list. With
 * neither set only the local dev server is allowed; `*` only when set explicitly.
 */
export function allowedOrigins(allowedOriginEnv: string | undefined, appOriginEnv: string | undefined): string[] {
  const list = [...(allowedOriginEnv ?? '').split(','), appOriginEnv ?? ''].map(stripSlash).filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : [...DEV_ORIGINS];
}

/** The request's Origin when allowed, otherwise the first allowed origin (the browser then refuses the read). */
export function corsOriginFor(requestOrigin: string | null, allowed: string[]): string {
  if (allowed.includes('*')) return '*';
  if (requestOrigin && allowed.includes(stripSlash(requestOrigin))) return stripSlash(requestOrigin);
  return allowed[0];
}
