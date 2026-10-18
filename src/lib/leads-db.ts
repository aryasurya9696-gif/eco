/**
 * Echo Leads — the lead database, search and enrichment, from the browser
 * ----------------------------------------------------------------------------
 * Thin wrappers over the leads function. Nothing here decides a price, an
 * ownership or a status: the function re-checks every id against the caller and
 * recomputes every estimate, so these only shape requests and type answers.
 */
import { invokeFunction } from './api';
import type { LeadEmailStatus } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeadStatus = 'new' | 'qualified' | 'contacted' | 'nurture' | 'disqualified';
export const LEAD_STATUSES: Array<{ value: LeadStatus; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'nurture', label: 'Nurture' },
  { value: 'disqualified', label: 'Disqualified' },
];

export interface ScoreReason {
  factor: string;
  points: number;
  max: number;
  note: string;
}

export interface Contact {
  id: string;
  person_name: string | null;
  title: string | null;
  linkedin_url: string | null;
  location: string | null;
  company_name: string | null;
  domain: string | null;
  company_id: string | null;
  email: string | null;
  email_status: LeadEmailStatus;
  email_checked_at: string | null;
  email_verifier: string | null;
  email_provider: string | null;
  phone: string | null;
  phone_provider: string | null;
  tags: string[];
  status: LeadStatus;
  score: number | null;
  score_label: string | null;
  score_reasons?: ScoreReason[];
  source: 'run' | 'search' | 'import';
  last_run_id: string | null;
  last_enriched_at: string | null;
  notes?: string | null;
  custom?: Record<string, string>;
  attributes: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface Company {
  id: string;
  domain: string;
  name: string | null;
  logo_url: string | null;
  data: Record<string, any>;
  enriched_at: string | null;
  tags: string[];
  notes?: string | null;
  contacts: number;
  verified_emails: number;
  missing_emails: number;
  strong_fits: number;
  best_score: number | null;
  updated_at: string;
}

export interface LeadList {
  id: string;
  name: string;
  kind: 'people' | 'companies';
  description: string | null;
  members: number;
  updated_at: string;
}

export interface ContactFilters {
  q?: string;
  email_status?: LeadEmailStatus[];
  has_email?: boolean;
  has_phone?: boolean;
  status?: LeadStatus[];
  tags?: string[];
  list_id?: string;
  company_id?: string;
  domain?: string;
  score_min?: number | null;
  score_max?: number | null;
  source?: 'run' | 'search' | 'import';
  stale_days?: number;
}

export interface Sort {
  field: string;
  dir: 'asc' | 'desc';
}

export interface PeopleSearchFilters {
  jobTitles?: string[];
  excludeJobTitles?: string[];
  seniorities?: string[];
  departments?: string[];
  personLocations?: string[];
  companyDomains?: string[];
  companyNames?: string[];
  industries?: string[];
  companyLocations?: string[];
  employeesMin?: number | null;
  employeesMax?: number | null;
  fundingRounds?: string[];
  revenueRanges?: string[];
  technologies?: string[];
  companyKeywords?: string[];
  maxPerCompany?: number | null;
}

export interface SearchPerson {
  leadsforge_id: string;
  first_name: string;
  last_name: string;
  person_name: string;
  title: string | null;
  person_location: string | null;
  company_name: string | null;
  domain: string | null;
  company: {
    employee_count: number | null;
    industry: string | null;
    location: string | null;
    revenue_min: number | null;
    revenue_max: number | null;
    years_in_business: number | null;
  };
  /** Set when this person is already in the database. */
  contact_id: string | null;
}

export interface SavedSearch {
  id: string;
  name: string;
  kind: 'people_search' | 'people_view' | 'companies_view';
  filters: Record<string, any>;
  last_total: number | null;
  updated_at: string;
}

export interface RunEstimate {
  ok: boolean;
  error?: string;
  min_credits: number;
  expected_credits: number;
  max_credits: number;
  breakdown?: Array<{ label: string; credits: number; note?: string }>;
}

export interface EnrichEstimate {
  ok: boolean;
  error?: string;
  eligible: number;
  selected: number;
  skipped?: Record<string, number>;
  estimate: RunEstimate | null;
  available?: number;
}

export interface StartResult {
  ok: boolean;
  error?: string;
  message?: string;
  shortfall?: number;
  run?: { id: string; status: string };
  replayed?: boolean;
}

export type EnrichAction = 'verify' | 'find_email' | 'phone' | 'company';

type Ok<T> = { ok: true } & T;
type Fail = { ok: false; error: string };

const call = <T>(action: string, body: Record<string, unknown> = {}) =>
  invokeFunction<T>('leads', { ...body, action });

/** A fresh id for a paid request, so a double click is one request, not two. */
export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const searchPeople = (filters: PeopleSearchFilters, cursor?: string | null, limit = 25) =>
  call<Ok<{ people: SearchPerson[]; cursor: string | null; provider: string }> | (Fail & { status?: number })>(
    'search_people', { filters, cursor: cursor ?? undefined, limit },
  );

export const countPeople = (filters: PeopleSearchFilters) =>
  call<Ok<{ total: number | null }> | Fail>('search_count', { filters });

export type VocabKind = 'seniorities' | 'departments' | 'funding' | 'revenue' | 'industries' | 'company_types';
const vocabCache = new Map<VocabKind, Promise<Array<{ value: string; label: string }>>>();
export function filterValues(kind: VocabKind) {
  if (!vocabCache.has(kind)) {
    vocabCache.set(
      kind,
      call<{ ok: boolean; values?: Array<{ value: string; label: string }> }>('filter_values', { kind })
        .then((r) => (r.ok ? r.values ?? [] : []))
        .catch(() => {
          vocabCache.delete(kind);
          return [];
        }),
    );
  }
  return vocabCache.get(kind)!;
}

export const saveSearchResults = (people: SearchPerson[], listId?: string | null) =>
  call<Ok<{ saved: number; skipped: number; contact_ids: string[] }> | Fail>('search_save', { people, list_id: listId ?? undefined });

export const searchHistory = () =>
  call<Ok<{ history: Array<{ id: string; filters: PeopleSearchFilters; created_at: string }> }>>('search_history');

// ---------------------------------------------------------------------------
// People and companies
// ---------------------------------------------------------------------------

export const queryContacts = (filters: ContactFilters, sort: Sort, page: number, pageSize: number) =>
  call<Ok<{ contacts: Contact[]; total: number; page: number; page_size: number }>>('contacts_query', {
    filters, sort, page, page_size: pageSize,
  });

export const getContact = (id: string) =>
  call<Ok<{ contact: Contact; company: Company | null; lists: Array<{ id: string; name: string }>; last_row: any }> | Fail>(
    'contact_get', { id },
  );

export const updateContacts = (
  ids: string[],
  patch: { status?: LeadStatus; add_tags?: string[]; remove_tags?: string[]; notes?: string; custom?: Record<string, string> },
) => call<Ok<{ updated: number }> | Fail>('contacts_update', { ids, patch });

export const deleteContacts = (ids: string[]) => call<Ok<{ deleted: number }> | Fail>('contacts_delete', { ids });

export const findDuplicates = () =>
  call<Ok<{ groups: Array<Array<Partial<Contact> & { id: string }>>; total_groups: number }>>('duplicates');

export const mergeContacts = (keep: string, drop: string[]) =>
  call<Ok<{ merged: number }> | Fail>('contacts_merge', { keep, drop });

export const queryCompanies = (
  filters: { q?: string; enriched?: boolean; missing_contacts?: boolean; missing_emails?: boolean; list_id?: string; tags?: string[] },
  sort: Sort, page: number, pageSize: number,
) => call<Ok<{ companies: Company[]; total: number }>>('companies_query', { filters, sort, page, page_size: pageSize });

export const getCompany = (id: string) =>
  call<Ok<{ company: Company; people: Contact[]; lists: Array<{ id: string; name: string }> }> | Fail>('company_get', { id });

export const updateCompanies = (ids: string[], patch: { notes?: string; add_tags?: string[]; remove_tags?: string[] }) =>
  call<Ok<{ updated: number }> | Fail>('companies_update', { ids, patch });

// ---------------------------------------------------------------------------
// Lists and saved searches
// ---------------------------------------------------------------------------

export const getLists = () => call<Ok<{ lists: LeadList[] }>>('lists');
export const createList = (name: string, kind: 'people' | 'companies', description?: string) =>
  call<Ok<{ list: { id: string; name: string; kind: string } }> | Fail>('list_create', { name, kind, description });
export const updateList = (id: string, patch: { name?: string; description?: string }) =>
  call<{ ok: boolean; error?: string }>('list_update', { id, ...patch });
export const deleteList = (id: string) => call<{ ok: boolean; error?: string }>('list_delete', { id });
export const addToList = (listId: string, ids: string[], filters?: ContactFilters) =>
  call<Ok<{ added: number; already: number }> | Fail>('list_add', { list_id: listId, ids, filters });
export const removeFromList = (listId: string, ids: string[]) =>
  call<Ok<{ removed: number }> | Fail>('list_remove', { list_id: listId, ids });

export const getSavedSearches = (kind?: SavedSearch['kind']) =>
  call<Ok<{ searches: SavedSearch[] }>>('saved_searches', { kind });
export const saveSavedSearch = (s: { id?: string; name: string; kind: SavedSearch['kind']; filters: unknown; last_total?: number | null }) =>
  call<Ok<{ id: string }> | Fail>('saved_search_save', s);
export const deleteSavedSearch = (id: string) => call<{ ok: boolean }>('saved_search_delete', { id });

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoringRules {
  titles: { include: string[]; weight: number };
  seniority: { levels: string[]; weight: number };
  industries: { include: string[]; weight: number };
  employees: { min: number | null; max: number | null; weight: number };
  locations: { include: string[]; weight: number };
  email: { weight: number };
  phone: { weight: number };
  thresholds: { strong: number; possible: number };
}

export const getScoring = () => call<Ok<{ rules: ScoringRules; saved: boolean }>>('scoring_get');
export const putScoring = (rules: ScoringRules) => call<Ok<{ rules: ScoringRules; rescored: number }>>('scoring_put', { rules });

// ---------------------------------------------------------------------------
// Paid work on saved leads
// ---------------------------------------------------------------------------

// The work is sent as `enrich`: `action` names the route, and spreading an
// `action` field into the body would replace it.
export const enrichEstimate = ({ action, ...rest }: {
  action: EnrichAction; contact_ids?: string[]; company_ids?: string[]; filters?: ContactFilters; refresh_stale?: boolean;
}) => call<EnrichEstimate>('enrich_estimate', { ...rest, enrich: action });

export const enrichStart = ({ action, ...rest }: {
  action: EnrichAction; contact_ids?: string[]; company_ids?: string[]; filters?: ContactFilters; refresh_stale?: boolean; request_id: string;
}) => call<StartResult>('enrich_start', { ...rest, enrich: action });

/** Re-verify or find phones for rows of a run: a new, priced run. */
export const bulkRowsEstimate = (runId: string, rowIds: string[], bulk: 'reverify' | 'find_phone') =>
  call<EnrichEstimate>('bulk', { run_id: runId, row_ids: rowIds, bulk, estimate_only: true, request_id: newRequestId() });

export const bulkRowsStart = (runId: string, rowIds: string[], bulk: 'reverify' | 'find_phone', requestId: string) =>
  call<StartResult>('bulk', { run_id: runId, row_ids: rowIds, bulk, request_id: requestId });

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const usageSummary = (days = 30) =>
  call<Ok<{
    days: number;
    total_credits: number;
    by_type: Array<{ type: string; runs: number; credits: number }>;
    runs: Array<{ id: string; name: string | null; kind: string; mode: string | null; status: string; target: number;
      est_credits: number | null; max_credits: number | null; charged_credits: number; created_at: string }>;
  }>>('usage', { days });

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export type AutomationKind = 'saved_search_refresh' | 'auto_enrich' | 'auto_tag';
export type AutomationRunStatus = 'running' | 'succeeded' | 'skipped' | 'refused' | 'failed';

export interface AutomationConfig {
  saved_search_id?: string;
  /** saved_search_refresh */
  list_id?: string | null;
  max_people?: number;
  /** saved_search_refresh: 'none' | 'find_email'. auto_enrich: the enrichment. */
  enrich?: 'none' | 'find_email' | 'verify' | 'phone';
  /** auto_enrich */
  max_rows?: number;
  skip_recent_days?: number;
  /** auto_tag */
  add_tags?: string[];
  remove_tags?: string[];
}

export interface AutomationSchedule {
  frequency: 'daily' | 'weekly';
  /** UTC */
  hour: number;
  /** 0 = Sunday, weekly only */
  weekday: number | null;
}

export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  config: AutomationConfig;
  status: 'active' | 'paused';
  pause_reason: string | null;
  frequency: 'daily' | 'weekly';
  hour: number;
  weekday: number | null;
  max_credits_per_run: number;
  max_credits_per_month: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: AutomationRunStatus | null;
  failure_count: number;
  saved_search: { name: string; kind: string } | null;
  /** Charged this month, counting a run still working at its maximum. */
  month_committed: number;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  status: AutomationRunStatus;
  started_at: string;
  finished_at: string | null;
  people_found: number;
  people_added: number;
  people_skipped: number;
  contacts_matched: number;
  contacts_tagged: number;
  credits_estimated_max: number | null;
  credits_charged: number;
  run_id: string | null;
  run_status: string | null;
  error: string | null;
  detail: Record<string, any>;
}

export interface AutomationDraft {
  id?: string;
  name: string;
  kind: AutomationKind;
  config: AutomationConfig;
  schedule: AutomationSchedule;
  max_credits_per_run: number;
  max_credits_per_month: number;
}

export interface AutomationEstimate {
  ok: boolean;
  error?: string;
  paid?: boolean;
  rows?: number;
  estimate?: RunEstimate | null;
  fits_run_cap?: boolean;
  runs_per_month_cap?: number | null;
}

/** Whether an automation can start paid work: the same rule as the function's isPaid. */
export const automationIsPaid = (kind: AutomationKind, config: AutomationConfig) =>
  kind === 'auto_enrich' || (kind === 'saved_search_refresh' && config.enrich === 'find_email');

export const getAutomations = () => call<Ok<{ automations: Automation[] }>>('automations');
export const saveAutomation = (a: AutomationDraft) =>
  call<Ok<{ automation: Automation }> | Fail>('automation_save', { ...a });
export const pauseAutomation = (id: string) => call<{ ok: boolean; error?: string }>('automation_pause', { id });
export const resumeAutomation = (id: string) => call<{ ok: boolean; error?: string }>('automation_resume', { id });
export const deleteAutomation = (id: string) => call<{ ok: boolean; error?: string }>('automation_delete', { id });
export const runAutomationNow = (id: string) => call<{ ok: boolean; error?: string }>('automation_run_now', { id });
export const automationEstimate = (a: Pick<AutomationDraft, 'kind' | 'config' | 'max_credits_per_run' | 'max_credits_per_month'>) =>
  call<AutomationEstimate>('automation_estimate', { ...a });
export const automationHistory = (automationId?: string, limit = 50) =>
  call<Ok<{ runs: AutomationRun[] }>>('automation_history', { automation_id: automationId, limit });

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Human copy for the reasons a selection was not all worked. */
export function skippedCopy(skipped?: Record<string, number>): string[] {
  if (!skipped) return [];
  const out: string[] = [];
  if (skipped.fresh) out.push(`${skipped.fresh} checked recently (tick "refresh" to include them)`);
  if (skipped.already_has) out.push(`${skipped.already_has} already have it`);
  if (skipped.no_input) out.push(`${skipped.no_input} have nothing to look it up with`);
  return out;
}

export function errorCopy(error: string | undefined): string {
  switch (error) {
    case 'insufficient_credits':
      return 'Not enough credits to cover the most this could cost. Top up and try again.';
    case 'nothing_to_do':
      return 'Nothing in the selection needs this.';
    case 'nothing_selected':
      return 'Nothing is selected.';
    case 'provider_not_configured':
      return 'The data provider is not configured yet, so this cannot run.';
    case 'no_filters':
      return 'Add at least one filter to search.';
    case 'leads_not_priced':
      return 'Leads prices are not configured, so nothing can be estimated.';
    case 'name_taken':
      return 'That name is already used.';
    case 'search_failed':
      return 'The search provider did not answer. Nothing was charged. Try again in a moment.';
    case 'saved_search_required':
    case 'saved_search_not_found':
      return 'Pick a saved search. Save one from Search or People first.';
    case 'cap_required':
      return 'An automation that spends credits needs a cap per run and a cap per month.';
    case 'run_cap_over_month_cap':
      return 'The cap per run cannot be more than the cap per month.';
    case 'bad_cap':
      return 'Caps must be zero or more credits.';
    case 'tags_required':
      return 'Add at least one tag to add or remove.';
    case 'list_not_found':
      return 'That list no longer exists.';
    case 'not_active':
      return 'Resume the automation first.';
    case 'over_run_cap':
      return 'The run could cost more than the cap per run.';
    case 'over_month_cap':
      return "The run could cost more than what is left of this month's cap.";
    case 'no_cap':
      return 'No spending cap was set, so no paid run was started.';
    default:
      return error ? `That did not work (${error}).` : 'That did not work.';
  }
}
