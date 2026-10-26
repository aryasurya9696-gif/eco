import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { LeadCard } from './LeadCard';
import { CompanyName } from './CompanyPanel';
import { BulkEnrichPeopleButton, EnrichPersonButton } from './EnrichPersonButton';
import { ConfirmRevealModal } from './ConfirmRevealModal';
import { EmailCell, PhoneCell, StageSelect, LinkedinIcon, ContactStatusBadge } from './LeadCells';
import { useLeadPricing, type EnrichmentRun } from './leads-store';
import { criteriaChips, type LastSearch, type SearchStatus } from './prospector-types';
import {
  initialsOf,
  linkedinHref,
  needsEmailReveal,
  previewEmail,
  foundEmail,
  revealedPhone,
  emailState,
  hasVerifiedContact,
} from './lead-utils';
import { downloadCsv, safeFilenamePart } from '../../lib/csv';
import { creditsLabel, formatCredits } from '../../lib/billing';
import {
  Search,
  Download,
  Table as TableIcon,
  LayoutGrid,
  Bookmark,
  BookmarkCheck,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Mail,
  Loader2,
} from 'lucide-react';

// ============================================================================
// Results panel: summary, live enrichment status, bulk actions, table/cards
// and pagination for the current search. Sits directly under the search bar.
// ============================================================================

const PAGE_SIZE = 25;

interface ResultsPanelProps {
  leads: B2BLead[];
  searchStatus: SearchStatus;
  lastSearch: LastSearch | null;
  enrichment: EnrichmentRun | null;
  onRevealEmail?: (lead: B2BLead) => Promise<unknown>;
  onRevealPhone?: (lead: B2BLead) => Promise<unknown>;
  /** Queues email and/or phone lookups; returns how many leads were added. */
  onEnrichContacts: (leads: B2BLead[], opts: { email: boolean; phone: boolean }) => number;
  onStopEnrichment: () => void;
  onBulkSave: (leads: B2BLead[]) => Promise<any>;
  onSaveLead: (lead: B2BLead) => Promise<any>;
  onStatusChange: (lead: B2BLead, status: B2BPipelineStatus) => Promise<boolean | void>;
  /** Whether a lookup run is going; informational (the dialog stays usable). */
  isBulkRevealing?: boolean;
  revealingEmailIds: ReadonlySet<string>;
  revealingPhoneIds: ReadonlySet<string>;
  /** null when the wallet could not be loaded. */
  availableCredits: number | null;
  onNavigateBilling?: () => void;
}

export const ResultsPanel: React.FC<ResultsPanelProps> = ({
  leads: allLeads,
  searchStatus,
  lastSearch,
  enrichment,
  onRevealEmail,
  onRevealPhone,
  onEnrichContacts,
  onStopEnrichment,
  onBulkSave,
  onSaveLead,
  onStatusChange,
  revealingEmailIds,
  revealingPhoneIds,
  availableCredits,
  onNavigateBilling,
}) => {
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

  const wantPhone = Boolean(lastSearch?.params.autoPhone);

  // Default view: only leads with a verified email or a phone — what the
  // user is paying for. "All" shows every lead the search returned.
  const [view, setView] = useState<'verified' | 'all'>('verified');
  const verifiedLeads = useMemo(() => allLeads.filter(hasVerifiedContact), [allLeads]);
  const leads = view === 'verified' ? verifiedLeads : allLeads;
  const enriching = enrichment?.state === 'running' || enrichment?.state === 'stopping';
  // An empty wallet locks every unrevealed contact behind one Top up action
  // instead of offering a find button that can only fail.
  const locked = availableCredits !== null && availableCredits <= 0;

  // ---- Pagination & selection --------------------------------------------
  const totalPages = Math.max(1, Math.ceil(leads.length / PAGE_SIZE));
  const page = Math.min(currentPage, totalPages);
  const pageStart = (page - 1) * PAGE_SIZE;
  const paginatedLeads = useMemo(() => leads.slice(pageStart, pageStart + PAGE_SIZE), [leads, pageStart]);

  // Selection only ever refers to rows that exist in the current results.
  const leadIds = useMemo(() => new Set(leads.map((l) => l.id)), [leads]);
  const selectedLeads = useMemo(() => leads.filter((l) => selectedIds.has(l.id)), [leads, selectedIds]);
  const selectedCount = selectedLeads.length;
  const selectedNeedingContacts = selectedLeads.filter((l) => needsEmailReveal(l) || !revealedPhone(l)).length;
  const selectedUnsaved = selectedLeads.filter((l) => !l.is_saved).length;

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
  // Leads the enrich dialog is about: the selection, or every result when it
  // was opened from the "contacts not looked up" banner.
  const [enrichTargets, setEnrichTargets] = useState<B2BLead[]>([]);
  const openEnrichDialog = (targets: B2BLead[]) => {
    setEnrichTargets(targets);
    setIsRevealModalOpen(true);
  };
  const handleConfirmEnrich = (opts: { email: boolean; phone: boolean }) => {
    onEnrichContacts(enrichTargets, opts);
    setIsRevealModalOpen(false);
  };

  /**
   * Re-queues what the last run did not finish: rows never attempted, skipped
   * for credits, or failed. Rows the provider answered "not found" for are
   * left alone — asking again would only repeat the same answer.
   */
  const resumeEnrichment = () => {
    const email = lastSearch?.params.autoEnrich ?? true;
    const phone = Boolean(lastSearch?.params.autoPhone);
    if (email) {
      onEnrichContacts(
        allLeads.filter((l) => needsEmailReveal(l) && emailState(l).kind !== 'not_found'),
        { email: true, phone: false },
      );
    }
    if (phone) {
      onEnrichContacts(allLeads.filter((l) => !revealedPhone(l) && l.phone_lookup !== 'not_found'), { email: false, phone: true });
    }
  };
  // Resume / Find contacts stay offered while either kind of lookup is still
  // outstanding — including when only phone lookups remain.
  const needsContacts = allLeads.some(
    (l) =>
      ((lastSearch?.params.autoEnrich ?? true) && needsEmailReveal(l) && emailState(l).kind !== 'not_found') ||
      (wantPhone && !revealedPhone(l) && l.phone_lookup !== 'not_found'),
  );

  const handleBulkSave = async () => {
    const unsaved = selectedLeads.filter((l) => !l.is_saved);
    if (isBulkSaving || unsaved.length === 0) return;
    setIsBulkSaving(true);
    try {
      await onBulkSave(unsaved);
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
          foundEmail(l) || '',
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

  const shownParams = isSearching ? searchStatus.params : lastSearch?.params;
  const hasResults = leads.length > 0;

  return (
    <>
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
                      {verifiedLeads.length} verified contact{verifiedLeads.length === 1 ? '' : 's'}
                      <span className="font-normal text-ink-2">
                        {' '}
                        · from {lastSearch.count} lead{lastSearch.count === 1 ? '' : 's'} found ({lastSearch.requested} requested)
                      </span>
                    </>
                  ) : (
                    'Results'
                  )}
                </h2>
                {!isSearching && lastSearch && <ResultNotes lastSearch={lastSearch} />}
              </div>

              {allLeads.length > 0 && !isSearching && (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex border border-line" role="group" aria-label="Which leads to show">
                    {(
                      [
                        ['verified', 'Verified contacts', verifiedLeads.length],
                        ['all', 'All leads', allLeads.length],
                      ] as const
                    ).map(([id, label, count]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={view === id}
                        onClick={() => setView(id)}
                        className={`h-9 px-3 text-sm flex items-center gap-1.5 border-r border-line last:border-r-0 cursor-pointer ${
                          view === id ? 'bg-ink text-white font-medium' : 'bg-white text-ink-2 hover:bg-fill'
                        }`}
                      >
                        {label}
                        <span className={`text-xs tabular-nums ${view === id ? 'text-white/70' : 'text-muted'}`}>{count}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => exportLeads(leads, 'all')}
                    disabled={leads.length === 0}
                    className="h-9 px-3 text-sm text-ink border border-line hover:bg-fill flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Download className="w-4 h-4" aria-hidden />
                    Export ({leads.length})
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

            {!isSearching && hasResults && (
              <EnrichmentPanel
                run={enrichment}
                needsContacts={needsContacts}
                availableCredits={availableCredits}
                onStop={onStopEnrichment}
                onResume={resumeEnrichment}
                onFindAll={() => openEnrichDialog(allLeads)}
                onNavigateBilling={onNavigateBilling}
              />
            )}

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
                <button
                  type="button"
                  onClick={() => openEnrichDialog(selectedLeads)}
                  disabled={selectedNeedingContacts === 0}
                  className="h-9 px-3 bg-white text-ink hover:bg-surface text-sm font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  title={selectedNeedingContacts === 0 ? 'Every selected lead already has an email and phone' : 'Choose emails and/or phones, then confirm the cost'}
                >
                  <Mail className="w-4 h-4" aria-hidden />
                  Find contacts
                </button>
                <button
                  type="button"
                  onClick={handleBulkSave}
                  disabled={isBulkSaving || selectedUnsaved === 0}
                  className="h-9 px-3 border border-white/30 hover:bg-white/10 text-sm font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  title={selectedUnsaved === 0 ? 'All selected leads are already in your pipeline' : undefined}
                >
                  {isBulkSaving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Bookmark className="w-4 h-4" aria-hidden />}
                  {selectedUnsaved === 0 ? 'All in pipeline' : `Save ${selectedUnsaved} to pipeline`}
                </button>
                <BulkEnrichPeopleButton leads={selectedLeads} />
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
                                  <ContactStatusBadge lead={lead} wantPhone={wantPhone} />
                                  <EnrichPersonButton lead={lead} />
                                </div>
                              </div>
                            </td>

                            <td className="px-2.5 py-3.5">
                              <div className="w-[160px] 2xl:w-[200px]">
                              <p className="font-medium text-ink line-clamp-2 break-words" title={lead.company_name}>
                                <CompanyName name={lead.company_name} domain={lead.company_domain} />
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
                                locked={locked}
                                onTopUp={onNavigateBilling}
                                onReveal={onRevealEmail}
                                isRevealing={revealingEmailIds.has(lead.id)}
                              />
                              </div>
                            </td>

                            <td className="px-2.5 py-3.5">
                              <PhoneCell
                                lead={lead}
                                locked={locked}
                                onTopUp={onNavigateBilling}
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
                      locked={locked}
                      onTopUp={onNavigateBilling}
                      lead={lead}
                      onRevealEmail={onRevealEmail}
                      onRevealPhone={onRevealPhone}
                      onSaveLead={onSaveLead}
                      onStatusChange={onStatusChange}
                      isRevealingEmail={revealingEmailIds.has(lead.id)}
                      isRevealingPhone={revealingPhoneIds.has(lead.id)}
                      isSelected={selectedIds.has(lead.id)}
                      onToggleSelect={(l) => toggleSelect(l.id)}
                      wantPhone={wantPhone}
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
          ) : allLeads.length > 0 && !isSearching ? (
            <div className="px-6 py-12 text-center" aria-live="polite">
              {enriching ? (
                <>
                  <Loader2 className="w-6 h-6 mx-auto animate-spin text-muted" aria-hidden />
                  <h3 className="mt-3 font-semibold text-ink">Finding verified contacts…</h3>
                  <p className="mt-1 text-sm text-ink-2">
                    Checking {allLeads.length} leads. Each one appears here as soon as a verified email or phone is found.
                  </p>
                </>
              ) : (
                <>
                  <div className="w-12 h-12 mx-auto bg-surface-2 border border-line flex items-center justify-center text-muted">
                    <Search className="w-5 h-5" aria-hidden />
                  </div>
                  <h3 className="mt-3 font-semibold text-ink">No verified contacts yet</h3>
                  <p className="mt-1 text-sm text-ink-2 max-w-md mx-auto">
                    None of the {allLeads.length} leads has a verified email or phone so far, so nothing was charged for them.
                  </p>
                </>
              )}
              <button
                type="button"
                onClick={() => setView('all')}
                className="mt-4 h-9 px-3 text-sm border border-line hover:bg-fill text-ink cursor-pointer"
              >
                Show all {allLeads.length} leads
              </button>
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

      <ConfirmRevealModal
        isOpen={isRevealModalOpen}
        onClose={() => setIsRevealModalOpen(false)}
        onConfirm={handleConfirmEnrich}
        leads={enrichTargets}
        defaultEmail={lastSearch?.params.autoEnrich ?? true}
        defaultPhone={Boolean(lastSearch?.params.autoPhone)}
        availableCredits={availableCredits}
        // Confirming during a run adds to that run (enrichLeads appends), so
        // a running job neither disables the dialog nor keeps it open.
        isProcessing={false}
        onNavigateBilling={onNavigateBilling}
      />
    </>
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
  const pricing = useLeadPricing();
  const notes: { tone: 'muted' | 'warn'; text: string }[] = [];

  // What the search itself cost, as charged by the server (a flat
  // pricing.searchCredits per search, plus any per-lead block fee).
  if (typeof s.creditsCharged === 'number' && s.creditsCharged > 0) {
    notes.push({
      tone: 'muted',
      text: `The search itself used ${creditsLabel(s.creditsCharged)}${
        pricing.searchCredits > 0 && s.creditsCharged % pricing.searchCredits === 0
          ? ` (${s.creditsCharged / pricing.searchCredits} billed provider call${s.creditsCharged / pricing.searchCredits === 1 ? '' : 's'} × ${formatCredits(pricing.searchCredits)})`
          : ''
      }.`,
    });
  }

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

/**
 * Live status of the contact lookups for the current results. Every number
 * here is counted from server responses — nothing is estimated or animated.
 */
const EnrichmentPanel: React.FC<{
  run: EnrichmentRun | null;
  needsContacts: boolean;
  availableCredits: number | null;
  onStop: () => void;
  onResume: () => void;
  onFindAll: () => void;
  onNavigateBilling?: () => void;
}> = ({ run, needsContacts, availableCredits, onStop, onResume, onFindAll, onNavigateBilling }) => {
  const pricing = useLeadPricing();
  const btn = 'h-8 px-3 text-[13px] font-medium border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
  const topUp = onNavigateBilling && (
    <button type="button" onClick={onNavigateBilling} className={`${btn} bg-ink text-white border-ink hover:bg-black`}>
      Buy credits
    </button>
  );

  if (!run) {
    if (!needsContacts) return null;
    const empty = availableCredits !== null && availableCredits <= 0;
    return (
      <div
        className={`flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 border text-[13px] ${
          empty ? 'bg-warn-bg border-warn-line' : 'bg-surface-2 border-line'
        }`}
        role={empty ? 'alert' : undefined}
      >
        <span className={empty ? 'text-ink' : 'text-ink-2'}>
          {empty ? (
            <>
              <span className="font-semibold">You have 0 credits, so emails and phones are hidden.</span> Top up and they are
              found automatically — {pricing.email} credit{pricing.email === 1 ? '' : 's'} per verified email, {pricing.phone} per
              phone, nothing for misses or unconfirmed ones.
            </>
          ) : (
            'Contact details have not been looked up for these leads yet.'
          )}
        </span>
        <div className="flex items-center gap-2">
          {empty ? topUp : (
            <button type="button" onClick={onFindAll} className={`${btn} bg-ink text-white border-ink hover:bg-black`}>
              Find contacts
            </button>
          )}
        </div>
      </div>
    );
  }

  const verified = run.emailsVerified ?? run.emailsFound;
  const found = [
    `${run.emailsFound} email${run.emailsFound === 1 ? '' : 's'}${run.emailsFound > verified ? ` (${verified} verified)` : ''}`,
    run.phonesFound > 0 ? `${run.phonesFound} phone${run.phonesFound === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  const used = `${creditsLabel(run.creditsCharged)} used`;
  const pct = run.total > 0 ? Math.min(100, Math.round((run.processed / run.total) * 100)) : 0;

  if (run.state === 'running' || run.state === 'stopping') {
    return (
      <div className="px-3 py-2.5 bg-info-bg border border-info/30 text-[13px] space-y-2" role="status" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 text-ink">
            <Loader2 className="w-4 h-4 animate-spin text-info" aria-hidden />
            <span>
              {run.state === 'stopping' ? 'Stopping after the current batch…' : 'Finding contact details'} ·{' '}
              <span className="tabular-nums">{run.processed} of {run.total}</span> leads · {found} found · {used}
            </span>
          </span>
          <button type="button" onClick={onStop} disabled={run.state === 'stopping'} className={`${btn} bg-white border-line hover:bg-fill text-ink`}>
            Stop
          </button>
        </div>
        <div className="h-1.5 bg-white border border-info/20" aria-hidden>
          <div className="h-full bg-info transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  const tone =
    run.state === 'done'
      ? 'bg-ok-bg border-ok-line'
      : run.state === 'error'
        ? 'bg-danger-bg border-danger-line'
        : 'bg-warn-bg border-warn-line';
  const headline =
    run.state === 'done'
      ? `Contact lookup finished: ${found} found · ${used}.`
      : run.state === 'no_credits'
        ? `${run.message || 'Paused — out of credits.'} ${found} found · ${used}.`
        : run.state === 'error'
          ? run.message || 'Contact lookup stopped after repeated errors.'
          : run.state === 'interrupted'
            ? `Contact lookup was interrupted (page reloaded). ${found} found so far.`
            : `${run.message || 'Contact lookup stopped.'} ${found} found · ${used}.`;

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 border text-[13px] ${tone}`} role="status" aria-live="polite">
      <span className="text-ink">{headline}</span>
      <div className="flex items-center gap-2">
        {run.state === 'no_credits' && topUp}
        {run.state !== 'done' && needsContacts && (
          <button type="button" onClick={onResume} className={`${btn} bg-white border-line-strong hover:bg-fill text-ink`}>
            Resume
          </button>
        )}
      </div>
    </div>
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
