/**
 * Echo Leads — People: every lead the workspace holds
 * ---------------------------------------------------------------------------
 * One record per person, merged across every run, search and import that found
 * them. Filtered, sorted and paged on the server - the table never holds more
 * than a page - with the id as a tiebreak so a page never repeats or skips a row.
 *
 * Selection works two ways and the difference is shown: rows ticked on this
 * page, or "all N matching", which sends the filters rather than ids so a bulk
 * action covers exactly what the view describes and not just what has loaded.
 *
 * Every paid action opens the priced confirmation. Nothing here spends credits
 * on a click.
 */
import React from 'react';
import {
  Search, SlidersHorizontal, Columns3, Download, Users2, Gauge, Trash2, ListPlus, Tag, ChevronLeft, ChevronRight, ArrowUpDown, X,
} from 'lucide-react';
import { Button } from './Screen';
import { StatusBadge } from './StatusBadge';
import { EmptyState, RowSkeleton } from './Empty';
import { Chip, ScoreBadge } from './Pick';
import { ContactPanel } from './ContactPanel';
import { CostDialog } from './CostDialog';
import { ScoringDialog, DuplicatesDialog } from './ScoringDialog';
import { downloadCsv, downloadXlsx, type ExportColumn } from '../../lib/leads-csv';
import { providerLabel, emailStatusLabel } from '../../lib/leads';
import {
  queryContacts, updateContacts, deleteContacts, getLists, addToList, createList, getSavedSearches, saveSavedSearch,
  deleteSavedSearch, enrichEstimate, enrichStart, errorCopy, LEAD_STATUSES,
  type Contact, type ContactFilters, type Sort, type LeadList, type EnrichAction, type SavedSearch, type LeadStatus,
} from '../../lib/leads-db';
import type { LeadEmailStatus } from '../../types';

const PAGE = 50;

const COLUMNS = [
  { key: 'company', label: 'Company', sort: 'company' },
  { key: 'email', label: 'Email', sort: 'email_status' },
  { key: 'phone', label: 'Phone' },
  { key: 'score', label: 'Fit', sort: 'score' },
  { key: 'status', label: 'Status' },
  { key: 'tags', label: 'Tags' },
  { key: 'location', label: 'Location' },
  { key: 'source', label: 'Source' },
  { key: 'updated', label: 'Updated', sort: 'updated' },
] as const;
type ColKey = (typeof COLUMNS)[number]['key'];
const DEFAULT_COLS: ColKey[] = ['company', 'email', 'phone', 'score', 'status', 'tags', 'updated'];

const EMAIL_FILTERS: LeadEmailStatus[] = ['verified', 'catch_all', 'unknown', 'unchecked', 'invalid', 'disposable', 'not_found'];

/** Column visibility is a per-viewer convenience, so it lives in this browser. */
function loadCols(): ColKey[] {
  try {
    const raw = localStorage.getItem('echo.leads.people.cols');
    const v = raw ? (JSON.parse(raw) as ColKey[]) : null;
    return Array.isArray(v) && v.length ? v.filter((k) => COLUMNS.some((c) => c.key === k)) : DEFAULT_COLS;
  } catch {
    return DEFAULT_COLS;
  }
}
function storeCols(cols: ColKey[]) {
  try {
    localStorage.setItem('echo.leads.people.cols', JSON.stringify(cols));
  } catch {
    /* private window: the choice lasts this session only */
  }
}

const ago = (iso: string) => {
  const d = (Date.now() - Date.parse(iso)) / 86400_000;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.floor(d)}d ago` : new Date(iso).toLocaleDateString();
};

export const PeopleView: React.FC<{
  onOpenRun: (id: string) => void;
  onOpenSearch: () => void;
  /** Opens the view already filtered, e.g. to one list or one company. */
  initialFilters?: ContactFilters;
  onOpenCompany?: (id: string) => void;
}> = ({ onOpenRun, onOpenSearch, initialFilters, onOpenCompany }) => {
  const [filters, setFilters] = React.useState<ContactFilters>(initialFilters ?? {});
  const [q, setQ] = React.useState(initialFilters?.q ?? '');
  const [sort, setSort] = React.useState<Sort>({ field: 'updated', dir: 'desc' });
  const [page, setPage] = React.useState(0);
  const [rows, setRows] = React.useState<Contact[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);

  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = React.useState(false);
  const [cols, setCols] = React.useState<ColKey[]>(loadCols);
  const [showFilters, setShowFilters] = React.useState(false);
  const [showCols, setShowCols] = React.useState(false);

  const [lists, setLists] = React.useState<LeadList[]>([]);
  const [views, setViews] = React.useState<SavedSearch[]>([]);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [enrich, setEnrich] = React.useState<{ action: EnrichAction; ids: string[] | null } | null>(null);
  const [dialog, setDialog] = React.useState<'scoring' | 'duplicates' | null>(null);

  React.useEffect(() => {
    void getLists().then((r) => r.ok && setLists(r.lists.filter((l) => l.kind === 'people'))).catch(() => {});
    void getSavedSearches('people_view').then((r) => r.ok && setViews(r.searches)).catch(() => {});
  }, []);

  // Search box settles before it queries.
  React.useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === (q || undefined) ? f : { ...f, q: q || undefined })), 350);
    return () => clearTimeout(t);
  }, [q]);

  // Any change to what is shown starts again from the first page with nothing selected.
  React.useEffect(() => {
    setPage(0);
    setPicked(new Set());
    setAllMatching(false);
  }, [filters, sort]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    queryContacts(filters, sort, page, PAGE)
      .then((r) => {
        if (cancelled) return;
        setRows(r.contacts);
        setTotal(r.total);
      })
      .catch((e) => !cancelled && setError((e as Error)?.message ?? 'Could not load leads.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filters, sort, page, reload]);

  const refresh = () => setReload((n) => n + 1);
  const ids = [...picked];
  const count = allMatching ? total : ids.length;
  const pageAll = rows.length > 0 && rows.every((r) => picked.has(r.id));

  const toggleSort = (field: string) =>
    setSort((s) => (s.field === field ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: field === 'name' || field === 'company' ? 'asc' : 'desc' }));

  const doUpdate = async (patch: Parameters<typeof updateContacts>[1], label: string) => {
    if (allMatching) {
      setError('Status and tag changes apply to ticked rows. Untick "all matching" and select the rows to change.');
      return;
    }
    const r = await updateContacts(ids, patch).catch(() => null);
    if (!r?.ok) setError(errorCopy(r && !r.ok ? r.error : undefined));
    else {
      setNote(`${label} on ${ids.length} leads.`);
      refresh();
    }
  };

  const doAddToList = async (listId: string) => {
    let id = listId;
    if (listId === '__new') {
      const name = window.prompt('New list name');
      if (!name?.trim()) return;
      const c = await createList(name.trim(), 'people');
      if (!c.ok) {
        setError(errorCopy(c.error));
        return;
      }
      id = c.list.id;
      void getLists().then((r) => r.ok && setLists(r.lists.filter((l) => l.kind === 'people')));
    }
    const r = await addToList(id, allMatching ? [] : ids, allMatching ? filters : undefined);
    if (!r.ok) setError(errorCopy(r.error));
    else setNote(`${r.added} added${r.already ? `, ${r.already} were already in the list` : ''}.`);
  };

  const doDelete = async () => {
    if (allMatching) {
      setError('Deleting applies to ticked rows only.');
      return;
    }
    if (!window.confirm(`Delete ${ids.length} leads from your database? This cannot be undone. Runs keep their own rows.`)) return;
    const r = await deleteContacts(ids);
    if (r.ok) {
      setNote(`${r.deleted} deleted.`);
      setPicked(new Set());
      refresh();
    }
  };

  const doExport = async (format: 'csv' | 'xlsx') => {
    setNote('Preparing export…');
    // Ticked rows, or every row matching the filters, paged in from the server.
    let out: Contact[] = [];
    if (!allMatching && ids.length) out = rows.filter((r) => picked.has(r.id));
    else {
      for (let p = 0; p < 20; p++) {
        const r = await queryContacts(filters, sort, p, 500);
        out = out.concat(r.contacts);
        if (r.contacts.length < 500) break;
      }
    }
    const columns: ExportColumn[] = [
      { header: 'Name', value: (c: Contact) => c.person_name },
      { header: 'Title', value: (c: Contact) => c.title },
      { header: 'Company', value: (c: Contact) => c.company_name },
      { header: 'Domain', value: (c: Contact) => c.domain },
      { header: 'Email', value: (c: Contact) => c.email },
      { header: 'Email status', value: (c: Contact) => emailStatusLabel(c.email_status).label },
      { header: 'Email checked', value: (c: Contact) => c.email_checked_at?.slice(0, 10) },
      { header: 'Email found by', value: (c: Contact) => (c.email_provider ? providerLabel(c.email_provider) : '') },
      { header: 'Phone', value: (c: Contact) => c.phone },
      { header: 'Phone found by', value: (c: Contact) => (c.phone_provider ? providerLabel(c.phone_provider) : '') },
      { header: 'LinkedIn', value: (c: Contact) => c.linkedin_url },
      { header: 'Location', value: (c: Contact) => c.location },
      { header: 'Fit score', value: (c: Contact) => c.score },
      { header: 'Fit', value: (c: Contact) => c.score_label },
      { header: 'Status', value: (c: Contact) => c.status },
      { header: 'Tags', value: (c: Contact) => (c.tags ?? []).join('; ') },
      { header: 'Source', value: (c: Contact) => c.source },
      { header: 'Updated', value: (c: Contact) => c.updated_at?.slice(0, 10) },
    ];
    const name = `leads-${out.length}-${new Date().toISOString().slice(0, 10)}.${format}`;
    if (format === 'csv') downloadCsv(columns, out, name);
    else await downloadXlsx(columns, out, name);
    setNote(`Exported ${out.length} leads.`);
  };

  const saveView = async () => {
    const name = window.prompt('Name this view');
    if (!name?.trim()) return;
    const r = await saveSavedSearch({ name: name.trim(), kind: 'people_view', filters: { ...filters, _sort: sort } });
    if (!r.ok) setError(errorCopy(r.error));
    else void getSavedSearches('people_view').then((x) => x.ok && setViews(x.searches));
  };

  const chips = filterChips(filters, lists);
  const show = (k: ColKey) => cols.includes(k);
  const empty = !loading && total === 0 && Object.keys(filters).filter((k) => (filters as any)[k] !== undefined).length === 0;

  return (
    <div className="space-y-3">
      {/* ---- Toolbar ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8a8a86]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, title, company, domain or email"
            aria-label="Search leads"
            className="w-full pl-8 pr-2 py-1.5 text-xs font-mono bg-white border border-[#e3e3de] focus:outline-none focus:ring-1 focus:ring-[#141414]"
          />
        </div>
        <Button variant="secondary" onClick={() => setShowFilters((v) => !v)}>
          <SlidersHorizontal className="w-3 h-3" /> Filters{chips.length ? ` (${chips.length})` : ''}
        </Button>
        <ViewsMenu
          views={views}
          onApply={(v) => {
            const { _sort, ...f } = v.filters as any;
            setFilters(f);
            setQ(f.q ?? '');
            if (_sort) setSort(_sort);
          }}
          onSave={() => void saveView()}
          onDelete={async (id) => {
            await deleteSavedSearch(id);
            void getSavedSearches('people_view').then((x) => x.ok && setViews(x.searches));
          }}
        />
        <div className="relative">
          <Button variant="quiet" onClick={() => setShowCols((v) => !v)}><Columns3 className="w-3 h-3" /> Columns</Button>
          {showCols && (
            <div className="absolute right-0 top-full mt-1 z-20 w-44 bg-white border border-[#e3e3de] shadow-lg p-2 space-y-1">
              {COLUMNS.map((c) => (
                <label key={c.key} className="flex items-center gap-2 text-xs font-mono cursor-pointer">
                  <input
                    type="checkbox"
                    checked={show(c.key)}
                    onChange={() => {
                      const next = show(c.key) ? cols.filter((k) => k !== c.key) : [...cols, c.key];
                      setCols(next);
                      storeCols(next);
                    }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <Button variant="quiet" onClick={() => setDialog('scoring')}><Gauge className="w-3 h-3" /> Scoring</Button>
        <Button variant="quiet" onClick={() => setDialog('duplicates')}><Users2 className="w-3 h-3" /> Duplicates</Button>
        <Button variant="quiet" onClick={() => void doExport('csv')} disabled={total === 0}><Download className="w-3 h-3" /> Export</Button>
      </div>

      {showFilters && <FilterPanel filters={filters} lists={lists} onChange={setFilters} />}

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => <Chip key={c.key} label={c.label} onRemove={() => setFilters(c.clear)} />)}
          <button onClick={() => { setFilters({}); setQ(''); }} className="text-[11px] font-mono text-[#8a8a86] hover:text-[#141414] cursor-pointer ml-1">
            Clear all
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start justify-between gap-2 text-xs font-mono text-[#c0462e]" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss"><X className="w-3 h-3" /></button>
        </div>
      )}
      {note && (
        <div className="flex items-start justify-between gap-2 text-xs font-mono text-[#1a7f4b]" aria-live="polite">
          {note}
          <button onClick={() => setNote(null)} aria-label="Dismiss"><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* ---- Bulk bar ---------------------------------------------------------- */}
      {count > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-[#141414] text-white px-3 py-2 text-xs font-mono">
          <span className="tabular-nums">{count.toLocaleString()} {allMatching ? 'matching' : 'selected'}</span>
          {!allMatching && pageAll && total > rows.length && (
            <button className="underline cursor-pointer" onClick={() => setAllMatching(true)}>Select all {total.toLocaleString()} matching</button>
          )}
          {allMatching && <button className="underline cursor-pointer" onClick={() => { setAllMatching(false); setPicked(new Set()); }}>Clear</button>}
          <span className="text-white/30">|</span>
          <BulkButton onClick={() => setEnrich({ action: 'find_email', ids: allMatching ? null : ids })}>Find emails</BulkButton>
          <BulkButton onClick={() => setEnrich({ action: 'verify', ids: allMatching ? null : ids })}>Verify</BulkButton>
          <BulkButton onClick={() => setEnrich({ action: 'phone', ids: allMatching ? null : ids })}>Find phones</BulkButton>
          <BulkButton onClick={() => setEnrich({ action: 'company', ids: allMatching ? null : ids })}>Company details</BulkButton>
          <span className="text-white/30">|</span>
          <label className="inline-flex items-center gap-1">
            <ListPlus className="w-3 h-3" />
            <select className="bg-transparent border border-white/30 px-1 py-0.5 cursor-pointer" value="" aria-label="Add to list"
              onChange={(e) => e.target.value && void doAddToList(e.target.value)}>
              <option value="">Add to list…</option>
              {lists.map((l) => <option key={l.id} value={l.id} className="text-black">{l.name}</option>)}
              <option value="__new" className="text-black">+ New list…</option>
            </select>
          </label>
          <label className="inline-flex items-center gap-1">
            <select className="bg-transparent border border-white/30 px-1 py-0.5 cursor-pointer" value="" aria-label="Set status"
              onChange={(e) => e.target.value && void doUpdate({ status: e.target.value as LeadStatus }, `Status set to ${e.target.value}`)}>
              <option value="">Set status…</option>
              {LEAD_STATUSES.map((s) => <option key={s.value} value={s.value} className="text-black">{s.label}</option>)}
            </select>
          </label>
          <BulkButton onClick={() => {
            const t = window.prompt('Tag to add');
            if (t?.trim()) void doUpdate({ add_tags: [t.trim()] }, `Tagged "${t.trim()}"`);
          }}><Tag className="w-3 h-3" /> Tag</BulkButton>
          <BulkButton onClick={() => void doExport('csv')}><Download className="w-3 h-3" /> CSV</BulkButton>
          <BulkButton onClick={() => void doExport('xlsx')}>Excel</BulkButton>
          <BulkButton onClick={() => void doDelete()}><Trash2 className="w-3 h-3" /> Delete</BulkButton>
        </div>
      )}

      {/* ---- Table ---------------------------------------------------------------- */}
      {empty ? (
        <EmptyState
          title="No leads yet"
          body="Leads you save from a search, find in a run or import from a file all land here, merged into one record per person."
          action={{ label: 'Search for people', onClick: onOpenSearch }}
        />
      ) : (
        <div className="bg-white border border-[#e3e3de] overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="h-10 border-b border-[#e3e3de] text-left text-[10px] uppercase tracking-wider text-[#8a8a86]">
                <th className="pl-4 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select this page"
                    checked={pageAll}
                    onChange={() => {
                      setAllMatching(false);
                      setPicked(pageAll ? new Set() : new Set(rows.map((r) => r.id)));
                    }}
                  />
                </th>
                <SortTh label="Person" field="name" sort={sort} onSort={toggleSort} />
                {COLUMNS.filter((c) => show(c.key)).map((c) =>
                  'sort' in c ? (
                    <SortTh key={c.key} label={c.label} field={c.sort} sort={sort} onSort={toggleSort} />
                  ) : (
                    <th key={c.key} className="px-3 font-normal">{c.label}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0
                ? [0, 1, 2, 3, 4, 5].map((i) => <tr key={i}><td colSpan={12}><RowSkeleton /></td></tr>)
                : rows.length === 0
                  ? (
                    <tr><td colSpan={12} className="px-4 py-10 text-center text-[#8a8a86]">No leads match these filters.</td></tr>
                  )
                  : rows.map((c) => {
                    const on = allMatching || picked.has(c.id);
                    return (
                      <tr
                        key={c.id}
                        className={`h-11 border-b border-[#eeeeea] hover:bg-[#fafaf8] cursor-pointer ${on ? 'bg-[#f6f6f4]' : ''} ${loading ? 'opacity-60' : ''}`}
                        onClick={() => setOpenId(c.id)}
                      >
                        <td className="pl-4" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${c.person_name ?? c.email ?? 'lead'}`}
                            checked={on}
                            disabled={allMatching}
                            onChange={() =>
                              setPicked((s) => {
                                const n = new Set(s);
                                if (n.has(c.id)) n.delete(c.id);
                                else n.add(c.id);
                                return n;
                              })
                            }
                          />
                        </td>
                        <td className="px-3 max-w-[220px]">
                          <div className="text-[#141414] truncate">{c.person_name ?? '—'}</div>
                          <div className="text-[10px] text-[#8a8a86] truncate">{c.title ?? '—'}</div>
                        </td>
                        {show('company') && (
                          <td className="px-3 max-w-[180px]">
                            <div className="truncate text-[#141414]">{c.company_name ?? c.domain ?? '—'}</div>
                            {c.company_name && <div className="text-[10px] text-[#8a8a86] truncate">{c.domain}</div>}
                          </td>
                        )}
                        {show('email') && (
                          <td className="px-3 max-w-[240px]">
                            {c.email ? (
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="truncate">{c.email}</span>
                                <StatusBadge status={c.email_status} />
                              </div>
                            ) : (
                              <span className="text-[#b5b5ad]">—</span>
                            )}
                          </td>
                        )}
                        {show('phone') && <td className="px-3 whitespace-nowrap">{c.phone ?? <span className="text-[#b5b5ad]">—</span>}</td>}
                        {show('score') && <td className="px-3"><ScoreBadge score={c.score} label={c.score_label} /></td>}
                        {show('status') && <td className="px-3 text-[#4a4a47]">{LEAD_STATUSES.find((s) => s.value === c.status)?.label ?? c.status}</td>}
                        {show('tags') && (
                          <td className="px-3 max-w-[160px]">
                            <div className="flex gap-1 overflow-hidden">
                              {(c.tags ?? []).slice(0, 3).map((t) => (
                                <span key={t} className="px-1.5 py-0.5 text-[10px] bg-[#f0f0ec] whitespace-nowrap">{t}</span>
                              ))}
                            </div>
                          </td>
                        )}
                        {show('location') && <td className="px-3 truncate max-w-[160px] text-[#4a4a47]">{c.location ?? '—'}</td>}
                        {show('source') && <td className="px-3 text-[#4a4a47]">{c.source}</td>}
                        {show('updated') && <td className="px-3 text-[#8a8a86] whitespace-nowrap">{ago(c.updated_at)}</td>}
                      </tr>
                    );
                  })}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-4 py-2 text-[11px] font-mono text-[#8a8a86]">
            <span className="tabular-nums">
              {total === 0 ? '0' : `${page * PAGE + 1}–${Math.min(total, page * PAGE + rows.length)}`} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <button className="p-1 disabled:opacity-30 cursor-pointer" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button className="p-1 disabled:opacity-30 cursor-pointer" disabled={(page + 1) * PAGE >= total || loading} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {openId && (
        <ContactPanel
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
          onEnrich={(action, ids2) => setEnrich({ action, ids: ids2 })}
          onOpenCompany={onOpenCompany}
        />
      )}

      {enrich && (
        <CostDialog
          title={ENRICH_TITLE[enrich.action]}
          description={ENRICH_COPY[enrich.action]}
          allowRefresh={enrich.action !== 'phone'}
          getEstimate={(refresh_stale) =>
            enrichEstimate({ action: enrich.action, ...(enrich.ids ? { contact_ids: enrich.ids } : { filters }), refresh_stale })}
          start={(request_id, refresh_stale) =>
            enrichStart({ action: enrich.action, ...(enrich.ids ? { contact_ids: enrich.ids } : { filters }), refresh_stale, request_id })}
          onStarted={(id) => {
            setEnrich(null);
            onOpenRun(id);
          }}
          onClose={() => setEnrich(null)}
        />
      )}

      {dialog === 'scoring' && <ScoringDialog onClose={() => setDialog(null)} onSaved={() => { setNote('Scoring rules saved; every lead was rescored.'); refresh(); }} />}
      {dialog === 'duplicates' && <DuplicatesDialog onClose={() => setDialog(null)} onMerged={refresh} />}
    </div>
  );
};

const ENRICH_TITLE: Record<EnrichAction, string> = {
  find_email: 'Find and verify emails',
  verify: 'Verify emails',
  phone: 'Find phone numbers',
  company: 'Add company details',
};

const ENRICH_COPY: Record<EnrichAction, string> = {
  find_email:
    'Checks any address already held, then runs the email waterfall for leads without a good one, cheapest provider first, and verifies what it finds. Leads with a recently verified address are skipped.',
  verify:
    'Checks each address with the verifiers and records Verified, Catch-all, Invalid, Disposable or Unknown exactly as they answer. Nothing is emailed.',
  phone: 'Looks up a direct or mobile number for each lead that has none, cheapest provider first. Only a number that is found is charged.',
  company: "Fetches each lead's company details (industry, size, revenue range, location, technologies). Companies enriched in the last 90 days are skipped.",
};

const BulkButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button onClick={onClick} className="inline-flex items-center gap-1 hover:underline cursor-pointer">{children}</button>
);

const SortTh: React.FC<{ label: string; field: string; sort: Sort; onSort: (f: string) => void }> = ({ label, field, sort, onSort }) => (
  <th className="px-3 font-normal" aria-sort={sort.field === field ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button onClick={() => onSort(field)} className={`inline-flex items-center gap-1 uppercase tracking-wider cursor-pointer ${sort.field === field ? 'text-[#141414]' : ''}`}>
      {label}
      <ArrowUpDown className="w-3 h-3 opacity-50" />
    </button>
  </th>
);

function filterChips(f: ContactFilters, lists: LeadList[]) {
  const out: Array<{ key: string; label: string; clear: (f: ContactFilters) => ContactFilters }> = [];
  if (f.q) out.push({ key: 'q', label: `"${f.q}"`, clear: (x) => ({ ...x, q: undefined }) });
  for (const s of f.email_status ?? []) {
    out.push({ key: `es:${s}`, label: `Email: ${emailStatusLabel(s).label}`, clear: (x) => ({ ...x, email_status: (x.email_status ?? []).filter((y) => y !== s) }) });
  }
  if (f.has_email !== undefined) out.push({ key: 'he', label: f.has_email ? 'Has email' : 'No email', clear: (x) => ({ ...x, has_email: undefined }) });
  if (f.has_phone !== undefined) out.push({ key: 'hp', label: f.has_phone ? 'Has phone' : 'No phone', clear: (x) => ({ ...x, has_phone: undefined }) });
  for (const s of f.status ?? []) out.push({ key: `st:${s}`, label: `Status: ${s}`, clear: (x) => ({ ...x, status: (x.status ?? []).filter((y) => y !== s) }) });
  for (const t of f.tags ?? []) out.push({ key: `t:${t}`, label: `Tag: ${t}`, clear: (x) => ({ ...x, tags: (x.tags ?? []).filter((y) => y !== t) }) });
  if (f.list_id) out.push({ key: 'list', label: `List: ${lists.find((l) => l.id === f.list_id)?.name ?? '…'}`, clear: (x) => ({ ...x, list_id: undefined }) });
  if (f.company_id) out.push({ key: 'co', label: 'One company', clear: (x) => ({ ...x, company_id: undefined }) });
  if (f.score_min != null) out.push({ key: 'smin', label: `Fit ≥ ${f.score_min}`, clear: (x) => ({ ...x, score_min: null }) });
  if (f.source) out.push({ key: 'src', label: `Source: ${f.source}`, clear: (x) => ({ ...x, source: undefined }) });
  if (f.stale_days) out.push({ key: 'stale', label: `Not checked in ${f.stale_days}d`, clear: (x) => ({ ...x, stale_days: undefined }) });
  return out;
}

const Tri: React.FC<{ label: string; value: boolean | undefined; set: (v: boolean | undefined) => void }> = ({ label, value, set }) => (
  <div className="flex items-center gap-1 text-[11px] font-mono">
    <span className="text-[#8a8a86] w-20">{label}</span>
    {([['any', undefined], ['yes', true], ['no', false]] as const).map(([l, v]) => (
      <button key={l} onClick={() => set(v)} aria-pressed={value === v}
        className={`px-2 py-0.5 border cursor-pointer ${value === v ? 'bg-[#141414] border-[#141414] text-white' : 'border-[#e3e3de]'}`}>{l}</button>
    ))}
  </div>
);

const FilterPanel: React.FC<{ filters: ContactFilters; lists: LeadList[]; onChange: (f: ContactFilters) => void }> = ({ filters, lists, onChange }) => {
  const toggle = <T extends string>(arr: T[] | undefined, v: T) => ((arr ?? []).includes(v) ? (arr ?? []).filter((x) => x !== v) : [...(arr ?? []), v]);
  return (
    <div className="bg-white border border-[#e3e3de] p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <div className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-1.5">Email status</div>
        <div className="flex flex-wrap gap-1">
          {EMAIL_FILTERS.map((s) => {
            const on = (filters.email_status ?? []).includes(s);
            return (
              <button key={s} aria-pressed={on} onClick={() => onChange({ ...filters, email_status: toggle(filters.email_status, s) })}
                className={`px-2 py-0.5 text-[11px] font-mono border cursor-pointer ${on ? 'bg-[#141414] border-[#141414] text-white' : 'border-[#e3e3de]'}`}>
                {emailStatusLabel(s).label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-1.5">Lead status</div>
        <div className="flex flex-wrap gap-1">
          {LEAD_STATUSES.map((s) => {
            const on = (filters.status ?? []).includes(s.value);
            return (
              <button key={s.value} aria-pressed={on} onClick={() => onChange({ ...filters, status: toggle(filters.status, s.value) })}
                className={`px-2 py-0.5 text-[11px] font-mono border cursor-pointer ${on ? 'bg-[#141414] border-[#141414] text-white' : 'border-[#e3e3de]'}`}>
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1.5">
        <Tri label="Email" value={filters.has_email} set={(v) => onChange({ ...filters, has_email: v })} />
        <Tri label="Phone" value={filters.has_phone} set={(v) => onChange({ ...filters, has_phone: v })} />
      </div>
      <div className="grid grid-cols-2 gap-3 text-[11px] font-mono">
        <label className="space-y-1">
          <span className="text-[#8a8a86] block">List</span>
          <select className="w-full border border-[#e3e3de] px-1 py-1" value={filters.list_id ?? ''} onChange={(e) => onChange({ ...filters, list_id: e.target.value || undefined })}>
            <option value="">Any</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[#8a8a86] block">Minimum fit</span>
          <input type="number" min={0} max={100} className="w-full border border-[#e3e3de] px-1 py-1" value={filters.score_min ?? ''}
            onChange={(e) => onChange({ ...filters, score_min: e.target.value === '' ? null : Number(e.target.value) })} />
        </label>
        <label className="space-y-1">
          <span className="text-[#8a8a86] block">Source</span>
          <select className="w-full border border-[#e3e3de] px-1 py-1" value={filters.source ?? ''} onChange={(e) => onChange({ ...filters, source: (e.target.value || undefined) as ContactFilters['source'] })}>
            <option value="">Any</option>
            <option value="search">People search</option>
            <option value="run">Lead run</option>
            <option value="import">Import</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[#8a8a86] block">Email not checked in</span>
          <select className="w-full border border-[#e3e3de] px-1 py-1" value={filters.stale_days ?? ''} onChange={(e) => onChange({ ...filters, stale_days: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Any time</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </label>
      </div>
      <div className="md:col-span-2">
        <label className="text-[11px] font-mono flex items-center gap-2">
          <span className="text-[#8a8a86]">Tag</span>
          <input
            className="border border-[#e3e3de] px-2 py-1"
            placeholder="Type a tag and press Enter"
            onKeyDown={(e) => {
              const v = (e.target as HTMLInputElement).value.trim().toLowerCase();
              if (e.key === 'Enter' && v) {
                onChange({ ...filters, tags: [...new Set([...(filters.tags ?? []), v])] });
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
        </label>
      </div>
    </div>
  );
};

const ViewsMenu: React.FC<{ views: SavedSearch[]; onApply: (v: SavedSearch) => void; onSave: () => void; onDelete: (id: string) => void }> = ({ views, onApply, onSave, onDelete }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="relative">
      <Button variant="quiet" onClick={() => setOpen((v) => !v)}>Views{views.length ? ` (${views.length})` : ''}</Button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 w-60 bg-white border border-[#e3e3de] shadow-lg py-1">
          {views.map((v) => (
            <div key={v.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-[#f6f6f4]">
              <button className="text-xs font-mono truncate cursor-pointer" onClick={() => { onApply(v); setOpen(false); }}>{v.name}</button>
              <button className="text-[10px] font-mono text-[#8a8a86] hover:text-[#c0462e] cursor-pointer" onClick={() => onDelete(v.id)}>delete</button>
            </div>
          ))}
          <button className="w-full text-left px-3 py-1.5 text-xs font-mono text-[#141414] hover:bg-[#f6f6f4] cursor-pointer border-t border-[#eeeeea]" onClick={() => { onSave(); setOpen(false); }}>
            Save current view…
          </button>
        </div>
      )}
    </div>
  );
};
