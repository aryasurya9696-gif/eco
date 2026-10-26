import React, { useMemo, useRef, useState, useEffect } from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { downloadCsv, downloadTextFile } from '../../lib/csv';
import { EmailCell, PhoneCell, StageSelect, LinkedinIcon } from './LeadCells';
import { emailState, initialsOf, linkedinHref, previewEmail, foundEmail, revealedPhone } from './lead-utils';
import { CompanyName } from './CompanyPanel';
import { EnrichPersonButton } from './EnrichPersonButton';
import {
  Search,
  Bookmark,
  Download,
  RefreshCw,
  Loader2,
  Trash2,
  ExternalLink,
  AlertCircle,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

interface SavedLeadsViewProps {
  leads: B2BLead[];
  isLoading?: boolean;
  /** False until the first load answers, so "empty" is never shown early. */
  hasLoaded?: boolean;
  onStatusChange: (lead: B2BLead, status: B2BPipelineStatus) => Promise<boolean | void>;
  onDeleteLead?: (lead: B2BLead) => Promise<void>;
  onBulkDelete?: (leads: B2BLead[]) => Promise<void>;
  onRefresh?: () => Promise<void>;
  /** The server stopped at its 2,000-row page limit. */
  limitReached?: boolean;
  onGoToProspector?: () => void;
}

const STAGES: { id: 'all' | B2BPipelineStatus; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'replied', label: 'Replied' },
  { id: 'dismissed', label: 'Dismissed' },
];

const PAGE_SIZE = 50;

/** Every field on user_leads is nullable, so nothing here may assume a string. */
const text = (value?: string | null): string => (value ?? '').toLowerCase();

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The single pipeline every saved lead belongs to (user_leads, one row per
 * person per user, with a stage). The data model has no named or multiple
 * pipelines, so there is no pipeline picker: a lead is either in the
 * pipeline, at a stage, or not.
 */
export const SavedLeadsView: React.FC<SavedLeadsViewProps> = ({
  leads,
  isLoading = false,
  hasLoaded = true,
  onStatusChange,
  onDeleteLead,
  onBulkDelete,
  onRefresh,
  limitReached = false,
  onGoToProspector,
}) => {
  const [stage, setStage] = useState<'all' | B2BPipelineStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: leads.length, new: 0, contacted: 0, replied: 0, dismissed: 0 };
    leads.forEach((l) => {
      const s = l.status || 'new';
      c[s] = (c[s] ?? 0) + 1;
    });
    return c;
  }, [leads]);

  const filteredLeads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return leads.filter((lead) => {
      if (stage !== 'all' && (lead.status || 'new') !== stage) return false;
      if (!q) return true;
      return (
        text(lead.full_name).includes(q) ||
        text(lead.company_name).includes(q) ||
        text(lead.company_domain).includes(q) ||
        text(foundEmail(lead)).includes(q) ||
        text(lead.phone_number).includes(q) ||
        text(lead.title).includes(q)
      );
    });
  }, [leads, stage, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageLeads = filteredLeads.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Selection is scoped to what the filters show, so a hidden row can never
  // be exported or deleted by accident.
  const selectedLeads = filteredLeads.filter((l) => selectedIds.has(l.id));
  const pageSelected = pageLeads.filter((l) => selectedIds.has(l.id)).length;
  const allPageSelected = pageLeads.length > 0 && pageSelected === pageLeads.length;

  useEffect(() => {
    if (headerCheckboxRef.current) headerCheckboxRef.current.indeterminate = pageSelected > 0 && !allPageSelected;
  }, [pageSelected, allPageSelected]);

  const resetSelection = () => {
    setSelectedIds(new Set());
    setConfirmBulkDelete(false);
  };

  const toggleSelectPage = () => {
    setConfirmBulkDelete(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageLeads.forEach((l) => next.delete(l.id));
      else pageLeads.forEach((l) => next.add(l.id));
      return next;
    });
  };

  const toggleSelect = (id: string) => {
    setConfirmBulkDelete(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const stamp = () => new Date().toISOString().slice(0, 10);

  const exportCSV = (targetLeads: B2BLead[]) => {
    if (targetLeads.length === 0) return;
    downloadCsv(`pipeline_${targetLeads.length}_${stamp()}.csv`, [
      ['Full Name', 'Title', 'Company', 'Domain', 'Work Email', 'Email Status', 'Company Email (unverified)', 'Phone', 'LinkedIn', 'Stage', 'Location', 'Added'],
      ...targetLeads.map((l) => {
        const state = emailState(l);
        return [
          l.full_name || '',
          l.title || '',
          l.company_name || '',
          l.company_domain || '',
          foundEmail(l) || '',
          state.kind === 'verified' || state.kind === 'unconfirmed' ? state.label : '',
          previewEmail(l) || '',
          revealedPhone(l) || '',
          l.linkedin_url || '',
          l.status || 'new',
          l.location || '',
          l.created_at || '',
        ];
      }),
    ]);
  };

  const exportJSON = (targetLeads: B2BLead[]) => {
    if (targetLeads.length === 0) return;
    // Only the contact fields — not internal ids or client-side state.
    const rows = targetLeads.map((l) => ({
      full_name: l.full_name,
      title: l.title,
      company_name: l.company_name,
      company_domain: l.company_domain,
      work_email: foundEmail(l),
      email_status: foundEmail(l) ? l.email_status : null,
      phone_number: revealedPhone(l),
      linkedin_url: l.linkedin_url,
      location: l.location,
      stage: l.status || 'new',
      added: l.created_at,
    }));
    downloadTextFile(`pipeline_${targetLeads.length}_${stamp()}.json`, JSON.stringify(rows, null, 2), 'application/json');
  };

  const handleDelete = async (lead: B2BLead) => {
    if (!onDeleteLead) return;
    setDeletingId(lead.id);
    try {
      await onDeleteLead(lead);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleBulkDelete = async () => {
    if (!onBulkDelete || selectedLeads.length === 0) return;
    setIsBulkDeleting(true);
    try {
      await onBulkDelete(selectedLeads);
      resetSelection();
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const filtersActive = stage !== 'all' || searchQuery.trim() !== '';
  const btn = 'h-9 px-3 text-sm border border-line bg-white hover:bg-fill text-ink flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';

  const deleteControl = (lead: B2BLead) =>
    onDeleteLead &&
    (deletingId === lead.id ? (
      <Loader2 className="w-4 h-4 animate-spin text-danger" aria-label="Removing" />
    ) : pendingDeleteId === lead.id ? (
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setPendingDeleteId(null);
            void handleDelete(lead);
          }}
          className="h-8 px-2.5 bg-danger-strong hover:bg-danger text-white text-xs font-medium cursor-pointer"
        >
          Remove
        </button>
        <button type="button" onClick={() => setPendingDeleteId(null)} className="text-xs text-ink-2 hover:text-ink underline cursor-pointer">
          Cancel
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={() => setPendingDeleteId(lead.id)}
        className="p-2 text-muted hover:text-danger hover:bg-danger-bg cursor-pointer"
        aria-label={`Remove ${lead.full_name} from pipeline`}
        title="Remove from pipeline"
      >
        <Trash2 className="w-4 h-4" aria-hidden />
      </button>
    ));

  return (
    <div className="space-y-5">
      <section className="bg-white border border-line" aria-labelledby="pipeline-title">
        <header className="px-4 sm:px-6 pt-5 pb-4 border-b border-line-soft flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="pipeline-title" className="text-lg font-semibold text-ink">
              Saved pipeline
              <span className="ml-2 text-sm font-normal text-ink-2 tabular-nums">{leads.length} lead{leads.length === 1 ? '' : 's'}</span>
            </h2>
            <p className="mt-0.5 text-sm text-ink-2">
              Leads you save, and every lead whose email or phone you find, are kept here with their stage.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onRefresh && (
              <button type="button" onClick={onRefresh} disabled={isLoading} className={btn} title="Reload from the server">
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
                Refresh
              </button>
            )}
            <button type="button" onClick={() => exportCSV(filteredLeads)} disabled={filteredLeads.length === 0} className={btn}>
              <Download className="w-4 h-4" aria-hidden />
              Export CSV
            </button>
            <button type="button" onClick={() => exportJSON(filteredLeads)} disabled={filteredLeads.length === 0} className={btn}>
              JSON
            </button>
          </div>
        </header>

        <div className="px-4 sm:px-6 py-3 flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
                resetSelection();
              }}
              placeholder="Search by name, company, email or phone"
              aria-label="Search saved leads"
              className="w-full h-10 pl-9 pr-3 bg-white border border-line hover:border-line-strong focus:border-ink focus:ring-2 focus:ring-ink/10 text-sm text-ink placeholder:text-muted outline-none"
            />
          </div>
          <div className="flex overflow-x-auto border border-line" role="group" aria-label="Filter by stage">
            {STAGES.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={stage === s.id}
                onClick={() => {
                  setStage(s.id);
                  setPage(1);
                  resetSelection();
                }}
                className={`h-10 px-3 text-sm whitespace-nowrap border-r border-line last:border-r-0 cursor-pointer flex items-center gap-1.5 ${
                  stage === s.id ? 'bg-ink text-white font-medium' : 'bg-white text-ink-2 hover:bg-fill'
                }`}
              >
                {s.label}
                <span className={`text-xs tabular-nums ${stage === s.id ? 'text-white/70' : 'text-muted'}`}>{counts[s.id] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white border border-line" aria-label="Saved leads" aria-busy={isLoading}>
        {limitReached && (
          <div className="px-4 sm:px-6 py-2.5 bg-warn-bg border-b border-warn-line text-[13px] text-ink flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-warn" aria-hidden />
            <span>Showing your 2,000 most recent leads. Older ones are still stored — remove some, then Refresh to see them.</span>
          </div>
        )}

        {selectedLeads.length > 0 && (
          <div className="sticky top-0 z-20 px-4 sm:px-6 py-2.5 bg-ink text-white flex flex-wrap items-center justify-between gap-3" role="region" aria-label="Bulk actions">
            <div className="flex items-center gap-3 text-sm">
              <span className="font-semibold tabular-nums">{selectedLeads.length} selected</span>
              <button type="button" onClick={resetSelection} className="underline underline-offset-2 text-white/80 hover:text-white cursor-pointer">
                Clear
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => exportCSV(selectedLeads)}
                className="h-9 px-3 border border-white/30 hover:bg-white/10 text-sm font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-4 h-4" aria-hidden />
                Export selected
              </button>
              {onBulkDelete &&
                (confirmBulkDelete ? (
                  <>
                    <button
                      type="button"
                      onClick={handleBulkDelete}
                      disabled={isBulkDeleting}
                      className="h-9 px-3 bg-danger-strong hover:bg-danger text-sm font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      {isBulkDeleting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Trash2 className="w-4 h-4" aria-hidden />}
                      Remove {selectedLeads.length} permanently
                    </button>
                    {!isBulkDeleting && (
                      <button type="button" onClick={() => setConfirmBulkDelete(false)} className="text-sm underline text-white/80 hover:text-white cursor-pointer">
                        Cancel
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmBulkDelete(true)}
                    className="h-9 px-3 border border-white/30 hover:bg-white/10 text-sm font-medium flex items-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden />
                    Remove
                  </button>
                ))}
            </div>
          </div>
        )}

        {!hasLoaded && isLoading ? (
          <div className="px-6 py-14 flex items-center justify-center gap-2 text-sm text-ink-2" role="status">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            Loading your pipeline…
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <div className="w-12 h-12 mx-auto bg-surface-2 border border-line flex items-center justify-center text-muted">
              <Bookmark className="w-5 h-5" aria-hidden />
            </div>
            <h3 className="mt-3 font-semibold text-ink">{filtersActive ? 'No leads match these filters' : 'Your pipeline is empty'}</h3>
            <p className="mt-1 text-sm text-ink-2 max-w-md mx-auto">
              {filtersActive
                ? 'Try another stage or clear the search.'
                : 'Select leads in the Prospector and choose “Save to pipeline”, or find a contact in Quick lookup — it is saved here automatically.'}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              {filtersActive ? (
                <button
                  type="button"
                  onClick={() => {
                    setStage('all');
                    setSearchQuery('');
                  }}
                  className={btn}
                >
                  <X className="w-4 h-4" aria-hidden />
                  Clear filters
                </button>
              ) : (
                onGoToProspector && (
                  <button type="button" onClick={onGoToProspector} className="h-9 px-3 bg-ink hover:bg-black text-white text-sm font-medium flex items-center gap-1.5 cursor-pointer">
                    <Search className="w-4 h-4" aria-hidden />
                    Find leads
                  </button>
                )
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Table on large screens */}
            <div className="hidden lg:block relative overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm border-collapse">
                <caption className="sr-only">Saved leads, page {currentPage} of {totalPages}</caption>
                <thead>
                  <tr className="bg-surface-2 border-b border-line text-xs font-medium text-ink-2">
                    <th scope="col" className="w-11 pl-4 sm:pl-5 pr-1 py-3">
                      <input
                        ref={headerCheckboxRef}
                        type="checkbox"
                        checked={allPageSelected}
                        onChange={toggleSelectPage}
                        aria-label="Select all leads on this page"
                        className="w-4 h-4 accent-ink cursor-pointer align-middle"
                      />
                    </th>
                    <th scope="col" className="px-2.5 py-3">Contact</th>
                    <th scope="col" className="px-2.5 py-3">Company</th>
                    <th scope="col" className="px-2.5 py-3">Work email</th>
                    <th scope="col" className="px-2.5 py-3">Phone</th>
                    <th scope="col" className="px-2.5 py-3">Stage</th>
                    <th scope="col" className="px-2.5 py-3">Added</th>
                    <th scope="col" className="pl-2.5 pr-4 sm:pr-5 py-3 text-right"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {pageLeads.map((lead) => {
                    const isSelected = selectedIds.has(lead.id);
                    return (
                      <tr key={lead.id} className={`align-top ${isSelected ? 'bg-fill/70' : 'hover:bg-surface-2'}`}>
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
                          <div className="flex items-start gap-2.5 w-[180px] 2xl:w-[240px]">
                            <div className="w-9 h-9 rounded-full bg-ink text-white flex items-center justify-center text-xs font-semibold shrink-0" aria-hidden>
                              {initialsOf(lead.full_name)}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-ink truncate" title={lead.full_name}>{lead.full_name || 'Unnamed lead'}</span>
                                {lead.linkedin_url && (
                                  <a
                                    href={linkedinHref(lead.linkedin_url)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-muted hover:text-[#0a66c2] shrink-0"
                                    aria-label={`${lead.full_name} on LinkedIn (opens in a new tab)`}
                                  >
                                    <LinkedinIcon className="w-3.5 h-3.5" />
                                  </a>
                                )}
                              </div>
                              <p className="text-[13px] text-ink-2 line-clamp-2 break-words" title={lead.title}>{lead.title || '—'}</p>
                              <EnrichPersonButton lead={lead} />
                            </div>
                          </div>
                        </td>
                        <td className="px-2.5 py-3.5">
                          <div className="w-[150px] 2xl:w-[210px]">
                            <p className="font-medium text-ink line-clamp-2 break-words"><CompanyName name={lead.company_name} domain={lead.company_domain} /></p>
                            {lead.company_domain && (
                              <a
                                href={`https://${lead.company_domain}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[13px] text-muted hover:text-ink hover:underline inline-flex items-center gap-1 max-w-full"
                              >
                                <span className="truncate">{lead.company_domain}</span>
                                <ExternalLink className="w-3 h-3 shrink-0" aria-hidden />
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-2.5 py-3.5">
                          <div className="w-[190px] 2xl:w-[260px]">
                            <EmailCell lead={lead} />
                          </div>
                        </td>
                        <td className="px-2.5 py-3.5">
                          <PhoneCell lead={lead} />
                        </td>
                        <td className="px-2.5 py-3.5">
                          <StageSelect lead={lead} onChange={onStatusChange} />
                        </td>
                        <td className="px-2.5 py-3.5 text-[13px] text-ink-2 whitespace-nowrap pt-5">{formatDate(lead.created_at)}</td>
                        <td className="pl-2.5 pr-4 sm:pr-5 py-3.5 text-right">{deleteControl(lead)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Cards below lg */}
            <div className="lg:hidden">
              <div className="px-4 py-2.5 border-b border-line-soft flex items-center gap-2 text-sm">
                <input id="pipeline-select-page" type="checkbox" checked={allPageSelected} onChange={toggleSelectPage} className="w-4 h-4 accent-ink" />
                <label htmlFor="pipeline-select-page" className="text-ink-2">Select all on this page</label>
              </div>
              <ul className="divide-y divide-line-soft">
                {pageLeads.map((lead) => (
                  <li key={lead.id} className="p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(lead.id)}
                        onChange={() => toggleSelect(lead.id)}
                        aria-label={`Select ${lead.full_name || 'lead'}`}
                        className="mt-1 w-4 h-4 accent-ink shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-ink truncate">{lead.full_name || 'Unnamed lead'}</p>
                        <p className="text-[13px] text-ink-2 truncate">{[lead.title, lead.company_name].filter(Boolean).join(' · ') || '—'}</p>
                        <EnrichPersonButton lead={lead} />
                      </div>
                      {deleteControl(lead)}
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 pl-7">
                      <dt className="text-xs text-muted pt-1">Email</dt>
                      <dd className="min-w-0"><EmailCell lead={lead} /></dd>
                      <dt className="text-xs text-muted pt-1">Phone</dt>
                      <dd><PhoneCell lead={lead} /></dd>
                      <dt className="text-xs text-muted pt-1.5">Stage</dt>
                      <dd><StageSelect lead={lead} onChange={onStatusChange} /></dd>
                    </dl>
                  </li>
                ))}
              </ul>
            </div>

            {filteredLeads.length > PAGE_SIZE && (
              <nav className="px-4 sm:px-6 py-3 border-t border-line-soft flex items-center justify-between gap-3 text-sm" aria-label="Pipeline pages">
                <p className="text-ink-2">
                  <span className="font-medium text-ink tabular-nums">
                    {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredLeads.length)}
                  </span>{' '}
                  of <span className="font-medium text-ink tabular-nums">{filteredLeads.length}</span>
                </p>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 1} className={btn} aria-label="Previous page">
                    <ChevronLeft className="w-4 h-4" aria-hidden />
                  </button>
                  <span className="px-2 tabular-nums text-ink-2">{currentPage} / {totalPages}</span>
                  <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage === totalPages} className={btn} aria-label="Next page">
                    <ChevronRight className="w-4 h-4" aria-hidden />
                  </button>
                </div>
              </nav>
            )}
          </>
        )}
      </section>
    </div>
  );
};
