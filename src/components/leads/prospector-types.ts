import { countryByCode } from './countries';

// Types and pure helpers shared by the Prospector search bar, the results
// panel, the store and recent searches. Kept out of the components so none of
// them has to import another component file just for a type.

export interface ProspectorSearchParams {
  companyDomain: string;
  title: string;
  /** Free-text query sent as `q` (the chosen keywords, space-joined). */
  q: string;
  /** Keyword chips, also sent as Treg's `keywords` list filter. */
  keywords?: string[];
  country?: string;
  location?: string;
  limit: number;
  /** Look up work emails automatically once results arrive. */
  autoEnrich: boolean;
  /** Also look up direct phone numbers (charged only when found). */
  autoPhone: boolean;
}

/** What the last completed search asked for and what it actually returned. */
export interface LastSearch {
  params: ProspectorSearchParams;
  requested: number;
  count: number;
  /** Whether contacts were queued for lookup when the results arrived. */
  enrichRequested: boolean;
  /** Credits the search itself cost (leads past the free allowance). */
  creditsCharged?: number;
  skippedDomains: number;
  failedBatches: number;
  completedAt: number;
}

export type SearchStatus =
  | { kind: 'idle' }
  | { kind: 'searching'; params: ProspectorSearchParams; enriching: boolean }
  | { kind: 'done' }
  | { kind: 'error'; message: string; params: ProspectorSearchParams; affordableLimit?: number };

/** Prices the UI quotes; loaded from the leads function's `pricing` action. */
export interface LeadPricing {
  email: number;
  phone: number;
  freeLeads: number;
  blockLeads: number;
  blockCredits: number;
  /** Credits per billed provider call a people search makes. */
  searchCredits: number;
  /** Most provider calls a single-target search may make (server: 11). */
  searchMaxCallsSingle: number;
  /** Most provider calls a multi-company search may make (server: 12). */
  searchMaxCallsMulti: number;
  /** Leads holds draw on purchased credits only (welcome credits excluded). */
  paidCreditsOnly: boolean;
}

// Owner pricing (October 2026): 1 credit per verified email, 2 per phone,
// and 1 credit per billed provider call a search makes. Only the fallback —
// the server's pricing action wins.
export const DEFAULT_PRICING: LeadPricing = {
  email: 1,
  phone: 2,
  freeLeads: 0,
  blockLeads: 100,
  blockCredits: 0,
  searchCredits: 1,
  searchMaxCallsSingle: 11,
  searchMaxCallsMulti: 12,
  paidCreditsOnly: true,
};

/** The provider returns at most this many people per call. */
const PEOPLE_PER_CALL = 100;
const MAX_PROVIDER_CALLS = 12;
const MAX_SEARCH_DOMAINS = 10;

/** Company domains in the filter (comma-separated; names without a dot are not domains). */
export function domainCountOf(companyDomain: string | undefined): number {
  return (companyDomain || '').split(',').map((d) => d.trim()).filter((d) => d.includes('.')).length;
}

/**
 * Most billed provider calls a search can make — mirrors the leads function's
 * maxSearchProviderCalls (lib.ts), capped by the limits its pricing action
 * reports.
 */
export function maxSearchCalls(leads: number, pricing: LeadPricing, domains = 1): number {
  let calls: number;
  if (domains > 1) {
    const d = Math.min(domains, MAX_SEARCH_DOMAINS);
    const perDomain = Math.max(10, Math.ceil(leads / d));
    const rounds = Math.max(1, Math.min(Math.ceil(perDomain / PEOPLE_PER_CALL), Math.floor(MAX_PROVIDER_CALLS / d)));
    calls = Math.min(d * rounds, Math.max(1, pricing.searchMaxCallsMulti));
  } else {
    calls = leads <= PEOPLE_PER_CALL ? 1 : 1 + Math.min(MAX_PROVIDER_CALLS, Math.ceil(leads / PEOPLE_PER_CALL));
    calls = Math.min(calls, Math.max(1, pricing.searchMaxCallsSingle));
  }
  return calls;
}

/**
 * The most a search for `leads` people can cost (what is held up front): every
 * possible provider call billed, plus any per-lead block fee past `freeLeads`.
 */
export function searchCost(leads: number, pricing: LeadPricing, domains = 1): number {
  return (
    pricing.searchCredits * maxSearchCalls(leads, pricing, domains) +
    Math.ceil(Math.max(0, leads - pricing.freeLeads) / Math.max(1, pricing.blockLeads)) * pricing.blockCredits
  );
}

/** "1 credit per provider call (up to 12 per search)". */
export function searchFeeText(pricing: LeadPricing): string {
  const per = `${pricing.searchCredits} credit${pricing.searchCredits === 1 ? '' : 's'} per provider call`;
  const maxCalls = Math.max(pricing.searchMaxCallsSingle, pricing.searchMaxCallsMulti);
  const max = Math.round(pricing.searchCredits * maxCalls * 100) / 100;
  return maxCalls > 1 ? `${per} (up to ${max} per search)` : per;
}

/**
 * Search quantity bounds. MAX_LIMIT mirrors the clamp in the leads edge
 * function — the server is the authority on what it will actually run.
 */
export const MIN_LIMIT = 5;
export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 25;
export const QUANTITY_OPTIONS = [25, 50, 100, 200, 500, 1000];

export function sanitizeLimit(value: string | number, fallback = DEFAULT_LIMIT): number {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(n)));
}

/** Two searches are "the same" when every filter that reaches the API matches. */
export function sameCriteria(a: ProspectorSearchParams, b: ProspectorSearchParams): boolean {
  return (
    a.companyDomain === b.companyDomain &&
    a.title === b.title &&
    a.q === b.q &&
    (a.keywords ?? []).join('|') === (b.keywords ?? []).join('|') &&
    (a.country || '') === (b.country || '') &&
    (a.location || '') === (b.location || '') &&
    a.limit === b.limit
  );
}

export function criteriaChips(p: ProspectorSearchParams): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  if (p.title) chips.push({ label: 'Role', value: p.title });
  const keywords = p.keywords?.length ? p.keywords : p.q ? [p.q] : [];
  if (keywords.length) chips.push({ label: 'Keywords', value: keywords.join(', ') });
  if (p.companyDomain) chips.push({ label: 'Company', value: p.companyDomain });
  if (p.location) chips.push({ label: 'Location', value: p.location });
  const country = countryByCode(p.country);
  if (country) chips.push({ label: 'Country', value: `${country.flag} ${country.name}` });
  return chips;
}

// ---- Search bar form ---------------------------------------------------

export interface SearchForm {
  title: string;
  keywords: string[];
  companyDomain: string;
  country: string;
  location: string;
  limit: number;
  autoEnrich: boolean;
  autoPhone: boolean;
}

export function formToParams(f: SearchForm): ProspectorSearchParams {
  const keywords = f.keywords.map((k) => k.trim()).filter(Boolean);
  return {
    title: f.title.trim(),
    q: keywords.join(' '),
    keywords,
    companyDomain: f.companyDomain.trim(),
    country: f.country.trim(),
    location: f.location.trim(),
    limit: sanitizeLimit(f.limit),
    autoEnrich: f.autoEnrich,
    autoPhone: f.autoPhone,
  };
}

export function paramsToForm(p?: ProspectorSearchParams | null): SearchForm {
  return {
    title: p?.title ?? '',
    keywords: p?.keywords?.length ? p.keywords : p?.q ? [p.q] : [],
    companyDomain: p?.companyDomain ?? '',
    country: p?.country ?? '',
    location: p?.location ?? '',
    limit: p?.limit ?? 25,
    autoEnrich: p?.autoEnrich ?? true,
    // Both on by default: a search delivers verified emails and phones.
    autoPhone: p?.autoPhone ?? true,
  };
}

export function hasCriteria(f: SearchForm): boolean {
  return Boolean(f.title.trim() || f.keywords.length || f.companyDomain.trim() || f.country || f.location.trim());
}

/** Most a search can cost: every lead verified for each detail switched on. */
export function maxContactCost(f: Pick<SearchForm, 'limit' | 'autoEnrich' | 'autoPhone'>, pricing: LeadPricing): number {
  return (f.autoEnrich ? f.limit * pricing.email : 0) + (f.autoPhone ? f.limit * pricing.phone : 0);
}
