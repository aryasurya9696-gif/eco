import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { LeadCard } from './LeadCard';
import { ConfirmRevealModal } from './ConfirmRevealModal';
import { CountrySelect } from './CountrySelect';
import { countryByCode } from './countries';
import { CitySelect } from './CitySelect';
import { EmailCell, PhoneCell, StageSelect, LinkedinIcon } from './LeadCells';
import {
  EMAIL_REVEAL_CREDITS,
  initialsOf,
  linkedinHref,
  needsEmailReveal,
  previewEmail,
  revealedEmail,
  revealedPhone,
  emailState,
} from './lead-utils';
import { downloadCsv, safeFilenamePart } from '../../lib/csv';
import {
  Search,
  Building2,
  Briefcase,
  Tag,
  Download,
  Table as TableIcon,
  LayoutGrid,
  Bookmark,
  BookmarkCheck,
  RotateCcw,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Mail,
  Loader2,
  AlertCircle,
  X,
  Info,
  RefreshCw,
} from 'lucide-react';

// ============================================================================
// Types shared with LeadsTab
// ============================================================================

export interface ProspectorSearchParams {
  companyDomain: string;
  title: string;
  q: string;
  country?: string;
  location?: string;
  limit: number;
  autoEnrich: boolean;
}

/** What the last completed search asked for and what it actually returned. */
export interface LastSearch {
  params: ProspectorSearchParams;
  requested: number;
  count: number;
  enrichRequested: boolean;
  enrichedCount: number;
  creditsCharged: number;
  enrichmentPending: number;
  enrichmentLimitedBy: 'cap' | 'balance' | null;
  skippedDomains: number;
  failedBatches: number;
  completedAt: number;
}

export type SearchStatus =
  | { kind: 'idle' }
  | { kind: 'searching'; params: ProspectorSearchParams; enriching: boolean }
  | { kind: 'done' }
  | { kind: 'error'; message: string; params: ProspectorSearchParams };

interface ProspectorViewProps {
  onSearch: (params: ProspectorSearchParams) => Promise<void>;
  onRevealEmail?: (lead: B2BLead) => Promise<unknown>;
  onRevealPhone?: (lead: B2BLead) => Promise<unknown>;
  onBulkRevealEmails?: (leads: B2BLead[]) => Promise<unknown>;
  onBulkSave: (leads: B2BLead[]) => Promise<any>;
  onSaveLead: (lead: B2BLead) => Promise<any>;
  onStatusChange: (lead: B2BLead, status: B2BPipelineStatus) => Promise<boolean | void>;
  leads: B2BLead[];
  searchStatus: SearchStatus;
  lastSearch: LastSearch | null;
  isBulkRevealing?: boolean;
  revealingEmailIds: ReadonlySet<string>;
  revealingPhoneIds: ReadonlySet<string>;
  /** null when the wallet could not be loaded. */
  availableCredits: number | null;
  onNavigateBilling?: () => void;
}

// ============================================================================
// Constants
// ============================================================================

const PRESET_QUERIES = [
  { label: 'SaaS founders', q: 'SaaS', title: 'Founder', domain: '', country: 'US', loc: '' },
  { label: 'Fintech CEOs', q: 'Fintech', title: 'CEO', domain: '', country: 'US', loc: '' },
  { label: 'AI startup founders', q: 'Artificial Intelligence', title: 'Founder', domain: '', country: 'US', loc: 'San Francisco' },
  { label: 'Directors at Stripe', q: '', title: 'Director', domain: 'stripe.com', country: '', loc: '' },
  { label: 'Engineering at Notion', q: '', title: 'Engineering', domain: 'notion.so', country: '', loc: '' },
];

const PAGE_SIZE = 25;

/**
 * Search quantity bounds. MAX_LIMIT mirrors the clamp in the leads edge
 * function — the server is the authority on what it will actually run, and a
 * client that accepts a larger number only ever lies about the result size.
 */
const MIN_LIMIT = 5;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 50;
const QUANTITY_OPTIONS = [25, 50, 100, 200, 500, 1000];

/**
 * Per-search cap on automatic enrichment (MAX_AUTO_ENRICH on the server). The
 * estimate has to quote the same number the wallet can actually be charged.
 */
const MAX_AUTO_ENRICH = 60;

/** The one rule for the quantity field, shared by every path that reads it. */
function sanitizeLimit(value: string | number, fallback = DEFAULT_LIMIT): number {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(n)));
}

/** Two searches are "the same" when every filter that reaches the API matches. */
function sameCriteria(a: ProspectorSearchParams, b: ProspectorSearchParams): boolean {
  return (
    a.companyDomain === b.companyDomain &&
    a.title === b.title &&
    a.q === b.q &&
    (a.country || '') === (b.country || '') &&
    (a.location || '') === (b.location || '') &&
    a.limit === b.limit
  );
}

function criteriaChips(p: ProspectorSearchParams): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  if (p.title) chips.push({ label: 'Role', value: p.title });
  if (p.q) chips.push({ label: 'Keywords', value: p.q });
  if (p.companyDomain) chips.push({ label: 'Company', value: p.companyDomain });
  const country = countryByCode(p.country);
  if (country) chips.push({ label: 'Country', value: `${country.flag} ${country.name}` });
  if (p.location) chips.push({ label: 'Location', value: p.location });
  return chips;
}

// ============================================================================
// Small presentational pieces
// ============================================================================

const inputCls =
  'w-full h-10 pl-9 pr-8 bg-white border border-line hover:border-line-strong focus:border-ink focus:ring-2 focus:ring-ink/10 text-sm text-ink placeholder:text-muted outline-none transition-colors disabled:opacity-50';

const labelCls = 'block text-[13px] font-medium text-ink-2 mb-1.5';

const TextField: React.FC<{
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  icon: React.ReactNode;
  hint?: string;
  disabled?: boolean;
}> = ({ id, label, value, onChange, placeholder, icon, hint, disabled }) => (
  <div>
    <label htmlFor={id} className={labelCls}>
      {label}
    </label>
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden>
        {icon}
      </span>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={id === 'lead-company' ? 1000 : 200}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={inputCls}
      />
      {value && !disabled && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink hover:bg-fill cursor-pointer"
          aria-label={`Clear ${label.toLowerCase()}`}
        >
          <X className="w-3.5 h-3.5" aria-hidden />
        </button>
      )}
    </div>
    {hint && (
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
        {hint}
      </p>
    )}
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <fieldset className="min-w-0">
    <legend className="text-xs font-semibold uppercase tracking-wide text-muted mb-3">{title}</legend>
    {children}
  </fieldset>
);

// ============================================================================
// View
// ============================================================================

export const ProspectorView: React.FC<ProspectorViewProps> = ({
  onSearch,
  onRevealEmail,
  onRevealPhone,
  onBulkRevealEmails,
  onBulkSave,
  onSaveLead,
  onStatusChange,
  leads,
  searchStatus,
  lastSearch,
  isBulkRevealing,
  revealingEmailIds,
  revealingPhoneIds,
  availableCredits,
  onNavigateBilling,
}) => {
  // ---- Search form -------------------------------------------------------
  const [query, setQuery] = useState('');
  const [companyDomain, setCompanyDomain] = useState('');
  const [title, setTitle] = useState('');
  const [country, setCountry] = useState('');
  const [location, setLocation] = useState('');
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  // The text in the custom box, kept apart from `limit` so it can be empty or
  // half-typed. Everything else is derived from `limit`.
  const [limitText, setLimitText] = useState<string>(String(DEFAULT_LIMIT));
  const [autoEnrich, setAutoEnrich] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<SearchStatus | null>(null);

  // ---- Results -----------------------------------------------------------
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isRevealModalOpen, setIsRevealModalOpen] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  const isSearching = searchStatus.kind === 'searching';

  // A new result set starts on page 1 with nothing selected. Keyed on the
  // completion time, not the array, so reveals that patch rows keep both.
  // Adjusted during render (React's "reset state on prop change" pattern)
  // rather than in an effect, so the old page never flashes first.
  const [seenSearchAt, setSeenSearchAt] = useState(lastSearch?.completedAt);
  if (seenSearchAt !== lastSearch?.completedAt) {
    setSeenSearchAt(lastSearch?.completedAt);
    setCurrentPage(1);
    setSelectedIds(new Set());
  }

  // ---- Derived form values -----------------------------------------------
  const effectiveLimit = sanitizeLimit(limitText.trim() === '' ? limit : limitText);

  const currentParams: ProspectorSearchParams = {
    companyDomain: companyDomain.trim(),
    title: title.trim(),
    q: query.trim(),
    country: country.trim(),
    location: location.trim(),
    limit: effectiveLimit,
    autoEnrich,
  };
  const hasCriteria = Boolean(
    currentParams.companyDomain || currentParams.title || currentParams.q || currentParams.country || currentParams.location,
  );
  const hasFormInput = Boolean(query || companyDomain || title || country || location);
  const formDiffersFromResults = Boolean(lastSearch && hasCriteria && !sameCriteria(currentParams, lastSearch.params));

  // Cost of auto-enrich: the ceiling the server may charge, then whether the
  // wallet covers it. Never min(limit, balance) — that collapses to 0 on an
  // empty wallet and advertises an unaffordable search as free.
  const enrichCeiling = Math.min(effectiveLimit, MAX_AUTO_ENRICH) * EMAIL_REVEAL_CREDITS;
  const balanceKnown = availableCredits !== null;
  const walletEmpty = balanceKnown && (availableCredits ?? 0) <= 0;
  const balanceShort = balanceKnown && !walletEmpty && (availableCredits ?? 0) < enrichCeiling;

  // ---- Form handlers -----------------------------------------------------
  const handleCountryChange = (code: string) => {
    // Dependent filter: a city picked for the old country would silently
    // AND against the new one and match nobody.
    if (code !== country) setLocation('');
    setCountry(code);
  };

  const handleSelectQuantity = (val: number) => {
    // Choosing a size never starts a search; only the Find button does.
    setLimit(val);
    setLimitText(String(val));
  };

  const handleLimitInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    if (digits === '') {
      setLimitText('');
      return;
    }
    // The upper bound applies live, so the box never shows a quantity the
    // search will not run with.
    const capped = Math.min(MAX_LIMIT, parseInt(digits, 10));
    setLimit(capped);
    setLimitText(String(capped));
  };

  const handleLimitInputBlur = () => {
    const num = limitText.trim() === '' ? DEFAULT_LIMIT : sanitizeLimit(limitText);
    setLimit(num);
    setLimitText(String(num));
  };

  const runSearch = (params: ProspectorSearchParams) => {
    setFormError(null);
    setDismissedError(null);
    void onSearch(params);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSearching) return;
    if (!hasCriteria) {
      setFormError('Add at least one filter — a role, keyword, company, country or location.');
      return;
    }
    setLimit(effectiveLimit);
    setLimitText(String(effectiveLimit));
    runSearch(currentParams);
  };

  const handleResetFilters = () => {
    setQuery('');
    setCompanyDomain('');
    setTitle('');
    setCountry('');
    setLocation('');
    setFormError(null);
  };

  const handleApplyPreset = (preset: (typeof PRESET_QUERIES)[number]) => {
    // Fills the form only. Searching stays an explicit click, so trying a
    // preset never spends anything.
    setQuery(preset.q);
    setTitle(preset.title);
    setCompanyDomain(preset.domain);
    setCountry(preset.country);
    setLocation(preset.loc);
    setFormError(null);
  };

  // ---- Pagination & selection --------------------------------------------
  const totalPages = Math.max(1, Math.ceil(leads.length / PAGE_SIZE));
  const page = Math.min(currentPage, totalPages);
  const pageStart = (page - 1) * PAGE_SIZE;
  const paginatedLeads = useMemo(() => leads.slice(pageStart, pageStart + PAGE_SIZE), [leads, pageStart]);

  // Selection only ever refers to rows that exist in the current results.
  const leadIds = useMemo(() => new Set(leads.map((l) => l.id)), [leads]);
  const selectedLeads = useMemo(() => leads.filter((l) => selectedIds.has(l.id)), [leads, selectedIds]);
  const selectedCount = selectedLeads.length;
  const selectedNeedingEmail = useMemo(() => selectedLeads.filter(needsEmailReveal), [selectedLeads]);

  const pageSelectedCount = paginatedLeads.filter((l) => selectedIds.has(l.id)).length;
  const allPageSelected = paginatedLeads.length > 0 && pageSelectedCount === paginatedLeads.length;
  const somePageSelected = pageSelectedCount > 0 && !allPageSelected;

  useEffect(() => {
    if (headerCheckboxRef.current) headerCheckboxRef.current.indeterminate = somePageSelected;
  }, [somePageSelected]);

  const toggleSelectPage = () => {
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => leadIds.has(id)));
      if (allPageSelected) paginatedLeads.forEach((l) => next.delete(l.id));
      else paginatedLeads.forEach((l) => next.add(l.id));
      return next;
    });
  };

  const selectAllResults = () => setSelectedIds(new Set(leads.map((l) => l.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const goToPage = (p: number) => {
    setCurrentPage(Math.min(totalPages, Math.max(1, p)));
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ---- Bulk actions ------------------------------------------------------
  const handleConfirmBulkReveal = async (max?: number) => {
    if (!onBulkRevealEmails || selectedNeedingEmail.length === 0) return;
    const batch = typeof max === 'number' ? selectedNeedingEmail.slice(0, Math.max(0, max)) : selectedNeedingEmail;
    if (batch.length === 0) return;
    await onBulkRevealEmails(batch);
    setIsRevealModalOpen(false);
  };

  const handleBulkSave = async () => {
    if (isBulkSaving || selectedLeads.length === 0) return;
    setIsBulkSaving(true);
    try {
      await onBulkSave(selectedLeads);
    } finally {
      setIsBulkSaving(false);
    }
  };

  /**
   * Exports exactly the rows passed in. The verified-email column only ever
   * holds a resolved address; the provider's unverified company address goes
   * in its own column so a CRM import cannot mistake one for the other.
   */
  const exportLeads = (targetLeads: B2BLead[], scope: 'selected' | 'all') => {
    if (targetLeads.length === 0) return;
    const basis = lastSearch ? criteriaChips(lastSearch.params).map((c) => c.value).join('_') : 'leads';
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(`leads_${safeFilenamePart(basis) || 'search'}_${scope}_${targetLeads.length}_${date}.csv`, [
      [
        'Full Name',
        'First Name',
        'Last Name',
        'Title',
        'Company',
        'Company Domain',
        'Industry',
        'Company Size',
        'Location',
        'Work Email',
        'Email Status',
        'Company Email (unverified)',
        'Phone',
        'LinkedIn',
        'Pipeline Stage',
      ],
      ...targetLeads.map((l) => {
        const state = emailState(l);
        return [
          l.full_name || '',
          l.first_name || '',
          l.last_name || '',
          l.title || '',
          l.company_name || '',
          l.company_domain || '',
          l.industry || '',
          l.company_size || '',
          l.location || '',
          revealedEmail(l) || '',
          state.kind === 'verified' || state.kind === 'unconfirmed'
            ? state.label
            : state.kind === 'not_found'
              ? 'Not found'
              : 'Not revealed',
          previewEmail(l) || '',
          revealedPhone(l) || '',
          l.linkedin_url || '',
          l.status || (l.is_saved ? 'new' : ''),
        ];
      }),
    ]);
  };

  // ---- Status banners ----------------------------------------------------
  const errorVisible = searchStatus.kind === 'error' && dismissedError !== searchStatus;
  const shownParams = isSearching ? searchStatus.params : lastSearch?.params;
  const hasResults = leads.length > 0;
  const showResultsPanel = hasResults || Boolean(lastSearch);

  const submitLabel = isSearching
    ? 'Searching…'
    : `Find ${effectiveLimit} leads`;

  return (
    <div className="space-y-5">
      {/* ================================================================
          1. Search workspace
          ================================================================ */}
      <section className="bg-white border border-line" aria-labelledby="lead-search-title">
        <form onSubmit={handleSubmit} noValidate>
          <header className="px-4 sm:px-6 pt-5 pb-4 border-b border-line-soft flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="lead-search-title" className="text-lg font-semibold text-ink">
                Find leads
              </h2>
              <p className="mt-0.5 text-sm text-ink-2">
                Searching is free. Emails cost {EMAIL_REVEAL_CREDITS} credit each, charged only when one is found.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick start presets">
              <span className="text-xs text-muted mr-1">Quick start:</span>
              {PRESET_QUERIES.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => handleApplyPreset(p)}
                  disabled={isSearching}
                  className="h-7 px-2.5 text-xs text-ink-2 bg-surface-2 border border-line hover:border-line-strong hover:text-ink transition-colors cursor-pointer disabled:opacity-50"
                  title="Fills the filters — nothing runs until you click Find"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </header>

          <div className="px-4 sm:px-6 py-5 grid grid-cols-1 lg:grid-cols-12 gap-x-8 gap-y-6">
            <div className="lg:col-span-12">
              <Section title="Who">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <TextField
                    id="lead-title"
                    label="Job title or role"
                    value={title}
                    onChange={setTitle}
                    placeholder="e.g. Founder, VP Sales"
                    icon={<Briefcase className="w-4 h-4" />}
                    disabled={isSearching}
                  />
                  <TextField
                    id="lead-keywords"
                    label="Keywords or industry"
                    value={query}
                    onChange={setQuery}
                    placeholder="e.g. SaaS, fintech"
                    icon={<Tag className="w-4 h-4" />}
                    disabled={isSearching}
                  />
                  <TextField
                    id="lead-company"
                    label="Company or domain"
                    value={companyDomain}
                    onChange={setCompanyDomain}
                    placeholder="e.g. stripe.com, Notion"
                    icon={<Building2 className="w-4 h-4" />}
                    hint="Separate several with commas (up to 10 domains)."
                    disabled={isSearching}
                  />
                </div>
              </Section>
            </div>

            <div className="lg:col-span-5 2xl:col-span-6">
              <Section title="Where">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <span id="lead-country-label" className={labelCls}>
                      Country
                    </span>
                    <CountrySelect
                      id="lead-country"
                      aria-labelledby="lead-country-label"
                      value={country}
                      onChange={handleCountryChange}
                      disabled={isSearching}
                    />
                  </div>
                  <div>
                    <span id="lead-city-label" className={labelCls}>
                      City, state or region
                    </span>
                    <CitySelect
                      id="lead-city"
                      aria-labelledby="lead-city-label"
                      value={location}
                      onChange={setLocation}
                      selectedCountry={country}
                      disabled={isSearching}
                    />
                  </div>
                </div>
              </Section>
            </div>

            <div className="lg:col-span-7 2xl:col-span-6">
              <Section title="Options">
                <div className="flex flex-col 2xl:flex-row 2xl:items-start gap-x-8 gap-y-4">
                  <div>
                    <span id="lead-qty-label" className={labelCls}>
                      Number of leads
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="inline-flex flex-wrap border border-line" role="group" aria-labelledby="lead-qty-label">
                        {QUANTITY_OPTIONS.map((num) => {
                          const isSelected = effectiveLimit === num;
                          return (
                            <button
                              key={num}
                              type="button"
                              onClick={() => handleSelectQuantity(num)}
                              aria-pressed={isSelected}
                              disabled={isSearching}
                              className={`h-9 min-w-12 px-3 text-sm tabular-nums transition-colors cursor-pointer border-r border-line last:border-r-0 disabled:opacity-60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink ${
                                isSelected ? 'bg-ink text-white font-semibold' : 'bg-white text-ink-2 hover:bg-fill'
                              }`}
                            >
                              {num}
                            </button>
                          );
                        })}
                      </div>
                      <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
                        <span>Custom</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={limitText}
                          onChange={handleLimitInputChange}
                          onBlur={handleLimitInputBlur}
                          disabled={isSearching}
                          aria-describedby="lead-qty-hint"
                          className="w-20 h-9 px-2 bg-white border border-line focus:border-ink focus:ring-2 focus:ring-ink/10 text-sm text-ink text-center tabular-nums outline-none disabled:opacity-50"
                        />
                      </label>
                    </div>
                    <p id="lead-qty-hint" className="mt-1 text-xs text-muted">
                      {MIN_LIMIT}–{MAX_LIMIT}. Fewer may come back if fewer match.
                      {effectiveLimit > 100 && ' Large requests are fetched in batches of 100 and take longer.'}
                    </p>
                  </div>

                  <div className="2xl:max-w-md">
                    <span className={labelCls}>Contact enrichment</span>
                    <label className="flex items-start gap-2.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={autoEnrich}
                        onChange={(e) => setAutoEnrich(e.target.checked)}
                        disabled={isSearching}
                        className="mt-0.5 w-4 h-4 accent-ink shrink-0 cursor-pointer"
                        aria-describedby="lead-enrich-hint"
                      />
                      <span className="text-sm text-ink">Find verified work emails automatically</span>
                    </label>
                    <p id="lead-enrich-hint" className="mt-1 ml-6.5 text-xs text-muted">
                      {autoEnrich ? (
                        <>
                          Runs on the first {Math.min(effectiveLimit, MAX_AUTO_ENRICH)} leads · up to {enrichCeiling}{' '}
                          credit{enrichCeiling === 1 ? '' : 's'}, only for emails found.
                          {walletEmpty && (
                            <span className="block text-warn">
                              Your balance is 0, so this search will skip enrichment.
                            </span>
                          )}
                          {balanceShort && (
                            <span className="block text-warn">
                              Your balance ({availableCredits}) covers {availableCredits} of these; the rest come back
                              unenriched.
                            </span>
                          )}
                        </>
                      ) : (
                        'Off — leads come back without emails. You can reveal them individually or in bulk.'
                      )}
                    </p>
                  </div>
                </div>
              </Section>
            </div>
          </div>

          <footer className="px-4 sm:px-6 py-4 border-t border-line-soft bg-surface-2 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-h-5 text-[13px]" aria-live="polite">
              {formError ? (
                <span className="flex items-center gap-1.5 text-danger">
                  <AlertCircle className="w-4 h-4 shrink-0" aria-hidden />
                  {formError}
                </span>
              ) : !hasCriteria ? (
                <span className="text-muted">Add at least one filter to search.</span>
              ) : formDiffersFromResults && !isSearching ? (
                <span className="flex items-center gap-1.5 text-ink-2">
                  <Info className="w-4 h-4 shrink-0 text-info" aria-hidden />
                  Filters changed — the results below are from your previous search.
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2 sm:shrink-0">
              {hasFormInput && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  disabled={isSearching}
                  className="h-10 px-3 text-sm text-ink-2 hover:text-ink border border-line bg-white hover:bg-fill flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <RotateCcw className="w-4 h-4" aria-hidden />
                  Clear filters
                </button>
              )}
              <button
                type="submit"
                disabled={isSearching || !hasCriteria}
                aria-disabled={isSearching || !hasCriteria}
                className="flex-1 sm:flex-none h-10 px-5 bg-ink hover:bg-black text-white text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink whitespace-nowrap"
              >
                {isSearching ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Search className="w-4 h-4" aria-hidden />}
                {submitLabel}
              </button>
            </div>
          </footer>
        </form>
      </section>

      {/* ================================================================
          2. Search error (previous results, if any, stay below)
          ================================================================ */}
      {errorVisible && searchStatus.kind === 'error' && (
        <div role="alert" className="bg-danger-bg border border-danger-line px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2 text-sm text-danger-ink min-w-0">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium">Search failed</p>
              <p className="text-[13px] break-words">
                {searchStatus.message}
                {hasResults && ' Your previous results are still shown below.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => runSearch(searchStatus.params)}
              className="h-9 px-3 bg-danger-strong hover:bg-danger text-white text-sm font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" aria-hidden />
              Retry
            </button>
            <button
              type="button"
              onClick={() => setDismissedError(searchStatus)}
              className="h-9 px-3 text-sm text-danger-ink hover:bg-white/60 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* ================================================================
          3. Results
          ================================================================ */}
      {showResultsPanel || isSearching ? (
        <section
          ref={resultsRef}
          className="bg-white border border-line scroll-mt-4"
          aria-labelledby="lead-results-title"
          aria-busy={isSearching}
        >
          {/* Summary: what was searched, what came back */}
          <div className="px-4 sm:px-6 py-4 border-b border-line-soft space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="lead-results-title" className="text-base font-semibold text-ink" aria-live="polite">
                  {isSearching ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                      Searching for up to {searchStatus.params.limit} leads
                      {searchStatus.enriching ? ' and enriching emails' : ''}…
                    </span>
                  ) : lastSearch ? (
                    <>
                      {lastSearch.count} lead{lastSearch.count === 1 ? '' : 's'} found
                      <span className="font-normal text-ink-2"> · {lastSearch.requested} requested</span>
                    </>
                  ) : (
                    'Results'
                  )}
                </h2>
                {!isSearching && lastSearch && (
                  <ResultNotes lastSearch={lastSearch} />
                )}
              </div>

              {hasResults && !isSearching && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => exportLeads(leads, 'all')}
                    className="h-9 px-3 text-sm text-ink border border-line hover:bg-fill flex items-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-4 h-4" aria-hidden />
                    Export all ({leads.length})
                  </button>
                  <div className="hidden lg:flex border border-line" role="group" aria-label="Result layout">
                    <button
                      type="button"
                      onClick={() => setViewMode('table')}
                      aria-pressed={viewMode === 'table'}
                      className={`h-9 w-9 flex items-center justify-center cursor-pointer ${
                        viewMode === 'table' ? 'bg-ink text-white' : 'text-muted hover:bg-fill'
                      }`}
                      aria-label="Table view"
                      title="Table view"
                    >
                      <TableIcon className="w-4 h-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('cards')}
                      aria-pressed={viewMode === 'cards'}
                      className={`h-9 w-9 flex items-center justify-center cursor-pointer border-l border-line ${
                        viewMode === 'cards' ? 'bg-ink text-white' : 'text-muted hover:bg-fill'
                      }`}
                      aria-label="Card view"
                      title="Card view"
                    >
                      <LayoutGrid className="w-4 h-4" aria-hidden />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {shownParams && (
              <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                <span className="text-muted mr-0.5">{isSearching ? 'Searching:' : 'Results for:'}</span>
                {criteriaChips(shownParams).map((chip) => (
                  <span key={chip.label} className="inline-flex items-center gap-1 h-7 px-2 bg-surface-2 border border-line text-ink max-w-full">
                    <span className="text-muted">{chip.label}:</span>
                    <span className="truncate max-w-[220px]" title={chip.value}>{chip.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Bulk action bar — sticks to the top of the scroll area while rows are selected */}
          {selectedCount > 0 && (
            <div
              className="sticky top-0 z-20 px-4 sm:px-6 py-2.5 bg-ink text-white flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
              role="region"
              aria-label="Bulk actions"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-semibold tabular-nums" aria-live="polite">{selectedCount} selected</span>
                {selectedCount < leads.length && (
                  <button type="button" onClick={selectAllResults} className="underline underline-offset-2 text-white/80 hover:text-white cursor-pointer">
                    Select all {leads.length}
                  </button>
                )}
                <button type="button" onClick={clearSelection} className="underline underline-offset-2 text-white/80 hover:text-white cursor-pointer">
                  Clear
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {onBulkRevealEmails && (
                  <button
                    type="button"
                    onClick={() => setIsRevealModalOpen(true)}
                    disabled={selectedNeedingEmail.length === 0 || isBulkRevealing}
                    className="h-9 px-3 bg-white text-ink hover:bg-surface text-sm font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    title={
                      selectedNeedingEmail.length === 0
                        ? 'Every selected lead already has an email'
                        : `Up to ${selectedNeedingEmail.length * EMAIL_REVEAL_CREDITS} credits — charged only for emails found`
                    }
                  >
                    {isBulkRevealing ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Mail className="w-4 h-4" aria-hidden />}
                    {isBulkRevealing
                      ? 'Revealing…'
                      : `Reveal emails (${selectedNeedingEmail.length} · up to ${selectedNeedingEmail.length * EMAIL_REVEAL_CREDITS} cr)`}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleBulkSave}
                  disabled={isBulkSaving}
                  className="h-9 px-3 border border-white/30 hover:bg-white/10 text-sm font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {isBulkSaving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Bookmark className="w-4 h-4" aria-hidden />}
                  Save to pipeline
                </button>
                <button
                  type="button"
                  onClick={() => exportLeads(selectedLeads, 'selected')}
                  className="h-9 px-3 border border-white/30 hover:bg-white/10 text-sm font-medium flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-4 h-4" aria-hidden />
                  Export selected
                </button>
              </div>
            </div>
          )}

          {/* Body */}
          {hasResults ? (
            <div className={isSearching ? 'opacity-50 pointer-events-none transition-opacity' : 'transition-opacity'}>
              {/* Table (lg and up, when chosen) */}
              <div className={viewMode === 'table' ? 'hidden lg:block' : 'hidden'}>
                {/* `relative` keeps the absolutely positioned sr-only caption inside
                    this scroll box; without it the caption escaped to the page and
                    gave the whole document a horizontal scrollbar. */}
                <div className="relative overflow-x-auto">
                  <table className="w-full min-w-[1040px] text-left text-sm border-collapse">
                    <caption className="sr-only">
                      Lead results, page {page} of {totalPages}
                    </caption>
                    <thead>
                      <tr className="bg-surface-2 border-b border-line text-xs font-medium text-ink-2">
                        <th scope="col" className="w-11 pl-4 sm:pl-5 pr-1 py-3">
                          <input
                            ref={headerCheckboxRef}
                            type="checkbox"
                            checked={allPageSelected}
                            onChange={toggleSelectPage}
                            aria-label={allPageSelected ? 'Deselect all leads on this page' : 'Select all leads on this page'}
                            className="w-4 h-4 accent-ink cursor-pointer align-middle"
                          />
                        </th>
                        <th scope="col" className="px-2.5 py-3">Contact</th>
                        <th scope="col" className="px-2.5 py-3">Company</th>
                        <th scope="col" className="px-2.5 py-3">Location</th>
                        <th scope="col" className="px-2.5 py-3">Work email</th>
                        <th scope="col" className="px-2.5 py-3">Phone</th>
                        <th scope="col" className="pl-2.5 pr-4 sm:pr-5 py-3">Pipeline</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {paginatedLeads.map((lead) => {
                        const isSelected = selectedIds.has(lead.id);
                        return (
                          <tr
                            key={lead.id}
                            className={`align-top transition-colors ${isSelected ? 'bg-fill/70' : 'hover:bg-surface-2'}`}
                          >
                            <td className="pl-4 sm:pl-5 pr-1 py-3.5">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelect(lead.id)}
                                aria-label={`Select ${lead.full_name || 'lead'}`}
                                className="mt-2 w-4 h-4 accent-ink cursor-pointer"
                              />
                            </td>

                            <td className="px-2.5 py-3.5">
                              <div className="flex items-start gap-2.5 w-[190px] 2xl:w-[230px]">
                                <div
                                  className="w-9 h-9 rounded-full bg-ink text-white flex items-center justify-center text-xs font-semibold shrink-0"
                                  aria-hidden
                                >
                                  {initialsOf(lead.full_name)}
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-semibold text-ink truncate" title={lead.full_name}>
                                      {lead.full_name || 'Unnamed lead'}
                                    </span>
                                    {lead.linkedin_url && (
                                      <a
                                        href={linkedinHref(lead.linkedin_url)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-muted hover:text-[#0a66c2] transition-colors shrink-0"
                                        aria-label={`${lead.full_name} on LinkedIn (opens in a new tab)`}
                                      >
                                        <LinkedinIcon className="w-3.5 h-3.5" />
                                      </a>
                                    )}
                                  </div>
                                  <p className="text-[13px] text-ink-2 line-clamp-2 break-words" title={lead.title}>
                                    {lead.title || '—'}
                                  </p>
                                </div>
                              </div>
                            </td>

                            <td className="px-2.5 py-3.5">
                              <div className="w-[160px] 2xl:w-[200px]">
                              <p className="font-medium text-ink line-clamp-2 break-words" title={lead.company_name}>
                                {lead.company_name || '—'}
                              </p>
                              {lead.company_domain ? (
                                <a
                                  href={`https://${lead.company_domain}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[13px] text-muted hover:text-ink hover:underline inline-flex items-center gap-1 max-w-full"
                                  title={lead.company_domain}
                                >
                                  <span className="truncate">{lead.company_domain}</span>
                                  <ExternalLink className="w-3 h-3 shrink-0" aria-hidden />
                                </a>
                              ) : (
                                <p className="text-[13px] text-muted">No website</p>
                              )}
                              {(lead.industry || lead.company_size) && (
                                <p className="text-xs text-muted truncate">
                                  {[lead.industry, lead.company_size].filter(Boolean).join(' · ')}
                                </p>
                              )}
                              </div>
                            </td>

                            <td className="px-2.5 py-3.5 text-[13px] text-ink-2">
                              {lead.location ? (
                                <span className="block w-[120px] 2xl:w-[160px] line-clamp-2 break-words pt-0.5" title={lead.location}>
                                  {lead.location}
                                </span>
                              ) : (
                                <span className="text-muted">Unknown</span>
                              )}
                            </td>

                            <td className="px-2.5 py-3.5">
                              <div className="w-[200px] 2xl:w-[250px]">
                              <EmailCell
                                lead={lead}
                                onReveal={onRevealEmail}
                                isRevealing={revealingEmailIds.has(lead.id)}
                              />
                              </div>
                            </td>

                            <td className="px-2.5 py-3.5">
                              <PhoneCell
                                lead={lead}
                                onReveal={onRevealPhone}
                                isRevealing={revealingPhoneIds.has(lead.id)}
                              />
                            </td>

                            <td className="pl-2.5 pr-4 sm:pr-5 py-3.5">
                              <div className="flex items-center gap-1.5">
                              <StageSelect lead={lead} onChange={onStatusChange} />
                              <button
                                type="button"
                                onClick={() => onSaveLead(lead)}
                                aria-pressed={Boolean(lead.is_saved)}
                                aria-label={lead.is_saved ? `Remove ${lead.full_name} from pipeline` : `Save ${lead.full_name} to pipeline`}
                                title={lead.is_saved ? 'Saved — click to remove from pipeline' : 'Save to pipeline'}
                                className={`p-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-ink ${
                                  lead.is_saved ? 'text-ok bg-ok-bg' : 'text-muted hover:text-ink hover:bg-fill'
                                }`}
                              >
                                {lead.is_saved ? <BookmarkCheck className="w-4 h-4" aria-hidden /> : <Bookmark className="w-4 h-4" aria-hidden />}
                              </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Cards (always below lg; on lg+ when chosen) */}
              <div className={viewMode === 'cards' ? 'block' : 'lg:hidden'}>
                <div className="lg:hidden px-4 py-2.5 border-b border-line-soft flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleSelectPage}
                    id="lead-select-page-mobile"
                    className="w-4 h-4 accent-ink"
                  />
                  <label htmlFor="lead-select-page-mobile" className="text-ink-2">
                    Select all on this page
                  </label>
                </div>
                <div className="p-4 sm:p-6 grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
                  {paginatedLeads.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      onRevealEmail={onRevealEmail}
                      onRevealPhone={onRevealPhone}
                      onSaveLead={onSaveLead}
                      onStatusChange={onStatusChange}
                      isRevealingEmail={revealingEmailIds.has(lead.id)}
                      isRevealingPhone={revealingPhoneIds.has(lead.id)}
                      isSelected={selectedIds.has(lead.id)}
                      onToggleSelect={(l) => toggleSelect(l.id)}
                    />
                  ))}
                </div>
              </div>

              {/* Pagination (client-side over the result set the server returned) */}
              {leads.length > PAGE_SIZE && (
                <nav
                  className="px-4 sm:px-6 py-3 border-t border-line-soft flex flex-wrap items-center justify-between gap-3 text-sm"
                  aria-label="Results pages"
                >
                  <p className="text-ink-2">
                    Showing <span className="font-medium text-ink tabular-nums">{pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, leads.length)}</span> of{' '}
                    <span className="font-medium text-ink tabular-nums">{leads.length}</span>
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => goToPage(page - 1)}
                      disabled={page === 1}
                      className="h-9 px-2.5 border border-line hover:bg-fill flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="w-4 h-4" aria-hidden />
                      <span className="hidden sm:inline">Previous</span>
                    </button>
                    {pageNumbers(page, totalPages).map((n, i) =>
                      n === null ? (
                        <span key={`gap-${i}`} className="px-1.5 text-muted" aria-hidden>…</span>
                      ) : (
                        <button
                          key={n}
                          type="button"
                          onClick={() => goToPage(n)}
                          aria-current={n === page ? 'page' : undefined}
                          aria-label={`Page ${n}`}
                          className={`h-9 min-w-9 px-2 border tabular-nums cursor-pointer ${
                            n === page ? 'bg-ink text-white border-ink font-semibold' : 'border-line text-ink-2 hover:bg-fill'
                          }`}
                        >
                          {n}
                        </button>
                      ),
                    )}
                    <button
                      type="button"
                      onClick={() => goToPage(page + 1)}
                      disabled={page === totalPages}
                      className="h-9 px-2.5 border border-line hover:bg-fill flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label="Next page"
                    >
                      <span className="hidden sm:inline">Next</span>
                      <ChevronRight className="w-4 h-4" aria-hidden />
                    </button>
                  </div>
                </nav>
              )}
            </div>
          ) : isSearching ? (
            <SkeletonRows />
          ) : (
            <div className="px-6 py-14 text-center">
              <div className="w-12 h-12 mx-auto bg-surface-2 border border-line flex items-center justify-center text-muted">
                <Search className="w-5 h-5" aria-hidden />
              </div>
              <h3 className="mt-3 font-semibold text-ink">No leads matched</h3>
              <p className="mt-1 text-sm text-ink-2 max-w-md mx-auto">
                Try a broader role (for example “Founder” instead of “Co-Founder &amp; CTO”), fewer keywords, or remove the
                city filter.
              </p>
            </div>
          )}
        </section>
      ) : (
        !errorVisible && (
          <section className="bg-white border border-dashed border-line-strong px-6 py-14 text-center">
            <div className="w-12 h-12 mx-auto bg-surface-2 border border-line flex items-center justify-center text-muted">
              <Search className="w-5 h-5" aria-hidden />
            </div>
            <h3 className="mt-3 font-semibold text-ink">No search yet</h3>
            <p className="mt-1 text-sm text-ink-2 max-w-md mx-auto">
              Set a role, keyword, company or location above and click <strong className="text-ink">Find leads</strong>, or
              start from a quick-start preset.
            </p>
          </section>
        )
      )}

      <ConfirmRevealModal
        isOpen={isRevealModalOpen}
        onClose={() => setIsRevealModalOpen(false)}
        onConfirm={handleConfirmBulkReveal}
        selectedLeads={selectedLeads}
        availableCredits={availableCredits}
        isProcessing={Boolean(isBulkRevealing)}
        onNavigateBilling={onNavigateBilling}
      />
    </div>
  );
};

// ============================================================================
// Helpers rendered by the view
// ============================================================================

/** Page buttons: first, last, and the current page's neighbours. */
function pageNumbers(current: number, total: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let n = 1; n <= total; n++) {
    if (n === 1 || n === total || Math.abs(n - current) <= 1) out.push(n);
    else if (out[out.length - 1] !== null) out.push(null);
  }
  return out;
}

/**
 * The honest small print under the result count: why fewer came back than
 * were asked for, what enrichment did and cost, and anything that was skipped.
 */
const ResultNotes: React.FC<{ lastSearch: LastSearch }> = ({ lastSearch: s }) => {
  const notes: { tone: 'muted' | 'warn'; text: string }[] = [];

  if (s.count < s.requested && s.count > 0) {
    notes.push({
      tone: s.failedBatches > 0 ? 'warn' : 'muted',
      text:
        s.failedBatches > 0
          ? `Some provider requests failed, so this may not be everything that matches. Search again to retry.`
          : `That is everything the provider returned for these filters.`,
    });
  } else if (s.failedBatches > 0) {
    notes.push({ tone: 'warn', text: 'Some provider requests failed; results may be incomplete.' });
  }

  if (s.enrichRequested) {
    notes.push({
      tone: 'muted',
      text: `${s.enrichedCount} verified email${s.enrichedCount === 1 ? '' : 's'} found automatically · ${s.creditsCharged} credit${s.creditsCharged === 1 ? '' : 's'} charged.`,
    });
    if (s.enrichmentPending > 0) {
      notes.push({
        tone: 'warn',
        text:
          s.enrichmentLimitedBy === 'balance'
            ? `${s.enrichmentPending} leads were not enriched because your balance ran out. Top up, then select them and use Reveal emails.`
            : `${s.enrichmentPending} leads were past the ${MAX_AUTO_ENRICH}-lead auto-enrich limit. Select them and use Reveal emails.`,
      });
    }
  }

  if (s.skippedDomains > 0) {
    notes.push({
      tone: 'warn',
      text: `${s.skippedDomains} company domain(s) were not searched — one search covers up to 10.`,
    });
  }

  if (notes.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[13px]">
      {notes.map((n) => (
        <li key={n.text} className={n.tone === 'warn' ? 'text-warn' : 'text-ink-2'}>
          {n.text}
        </li>
      ))}
    </ul>
  );
};

/** Placeholder rows while the first search runs. Layout only — no fake data. */
const SkeletonRows: React.FC = () => (
  <div className="divide-y divide-line-soft" aria-hidden>
    {Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="px-4 sm:px-6 py-4 flex items-center gap-4 animate-pulse">
        <div className="w-4 h-4 bg-fill" />
        <div className="w-9 h-9 rounded-full bg-fill" />
        <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="h-3.5 bg-fill w-3/4" />
          <div className="h-3.5 bg-fill w-2/3" />
          <div className="hidden md:block h-3.5 bg-fill w-1/2" />
          <div className="hidden md:block h-3.5 bg-fill w-2/3" />
        </div>
      </div>
    ))}
  </div>
);
