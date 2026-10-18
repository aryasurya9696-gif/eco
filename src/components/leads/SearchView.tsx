/**
 * Echo Leads — people search
 * ---------------------------------------------------------------------------
 * Filters on the left, results on the right. Every filter here is a parameter
 * of leadsforge.people.search as the Treg catalog documents it; nothing is shown
 * that is not sent. The search and the count are free - the provider does not
 * charge for them - so nothing here asks for credits. Credits are only spent
 * when the user chooses to find emails or phones for people they have saved,
 * and that goes through the priced confirmation like every other paid action.
 *
 * Results carry names, titles, locations and firmographics, never contact
 * details: those come from the enrichment run.
 */
import React from 'react';
import { Search, Save, Bookmark, History, Loader2, Check, Database } from 'lucide-react';
import { Button } from './Screen';
import { ChipRow } from './ChipRow';
import { OptionPick, Chip } from './Pick';
import { CostDialog } from './CostDialog';
import { EmptyState, RowSkeleton } from './Empty';
import {
  searchPeople, countPeople, filterValues, saveSearchResults, getSavedSearches, saveSavedSearch, deleteSavedSearch,
  searchHistory, getLists, enrichEstimate, enrichStart, errorCopy,
  type PeopleSearchFilters, type SearchPerson, type SavedSearch, type LeadList, type VocabKind,
} from '../../lib/leads-db';

const EMPTY: PeopleSearchFilters = {};

const SIZE_PRESETS: Array<{ label: string; min: number | null; max: number | null }> = [
  { label: '1-10', min: 1, max: 10 },
  { label: '11-50', min: 11, max: 50 },
  { label: '51-200', min: 51, max: 200 },
  { label: '201-500', min: 201, max: 500 },
  { label: '501-1,000', min: 501, max: 1000 },
  { label: '1,000+', min: 1001, max: null },
];

/** Labels for the chips strip, so an active filter can be read and removed. */
function activeChips(f: PeopleSearchFilters, vocab: Partial<Record<VocabKind, Map<string, string>>>) {
  const out: Array<{ key: string; label: string; clear: (f: PeopleSearchFilters) => PeopleSearchFilters }> = [];
  const listKeys: Array<[keyof PeopleSearchFilters, string, VocabKind?]> = [
    ['jobTitles', 'Title'], ['excludeJobTitles', 'Not title'], ['seniorities', 'Seniority', 'seniorities'],
    ['departments', 'Department', 'departments'], ['personLocations', 'Person in'], ['companyDomains', 'Domain'],
    ['companyNames', 'Company'], ['industries', 'Industry', 'industries'], ['companyLocations', 'Company in'],
    ['fundingRounds', 'Funding', 'funding'], ['revenueRanges', 'Revenue', 'revenue'], ['technologies', 'Uses'],
    ['companyKeywords', 'Keyword'],
  ];
  for (const [k, name, kind] of listKeys) {
    for (const v of (f[k] as string[] | undefined) ?? []) {
      const label = kind ? vocab[kind]?.get(v) ?? v : v;
      out.push({ key: `${k}:${v}`, label: `${name}: ${label}`, clear: (x) => ({ ...x, [k]: ((x[k] as string[]) ?? []).filter((y) => y !== v) }) });
    }
  }
  if (f.employeesMin != null || f.employeesMax != null) {
    out.push({
      key: 'size',
      label: `Employees: ${f.employeesMin ?? 0}–${f.employeesMax ?? 'any'}`,
      clear: (x) => ({ ...x, employeesMin: null, employeesMax: null }),
    });
  }
  if (f.maxPerCompany) out.push({ key: 'max', label: `Max ${f.maxPerCompany} per company`, clear: (x) => ({ ...x, maxPerCompany: null }) });
  return out;
}

const hasFilters = (f: PeopleSearchFilters) => activeChips(f, {}).length > 0;

export const SearchView: React.FC<{ onOpenRun: (id: string) => void; onOpenPeople: () => void }> = ({ onOpenRun, onOpenPeople }) => {
  const [filters, setFilters] = React.useState<PeopleSearchFilters>(EMPTY);
  const [vocab, setVocab] = React.useState<Partial<Record<VocabKind, Array<{ value: string; label: string }>>>>({});
  const [vocabLoading, setVocabLoading] = React.useState(true);

  const [count, setCount] = React.useState<number | null>(null);
  const [counting, setCounting] = React.useState(false);

  const [people, setPeople] = React.useState<SearchPerson[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [lists, setLists] = React.useState<LeadList[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [savedIds, setSavedIds] = React.useState<string[] | null>(null);
  const [enrichFor, setEnrichFor] = React.useState<string[] | null>(null);

  const [saved, setSaved] = React.useState<SavedSearch[]>([]);
  const [history, setHistory] = React.useState<Array<{ id: string; filters: PeopleSearchFilters; created_at: string }>>([]);
  const [showHistory, setShowHistory] = React.useState(false);

  const refreshSaved = async () => {
    const r = await getSavedSearches('people_search').catch(() => null);
    if (r?.ok) setSaved(r.searches);
  };

  // Vocabularies, once.
  React.useEffect(() => {
    const kinds: VocabKind[] = ['seniorities', 'departments', 'industries', 'funding', 'revenue'];
    Promise.all(kinds.map((k) => filterValues(k).then((v) => [k, v] as const)))
      .then((pairs) => setVocab(Object.fromEntries(pairs)))
      .finally(() => setVocabLoading(false));
    void getLists().then((r) => r.ok && setLists(r.lists.filter((l) => l.kind === 'people'))).catch(() => {});
    void refreshSaved();
  }, []);

  const vocabMaps = React.useMemo(() => {
    const m: Partial<Record<VocabKind, Map<string, string>>> = {};
    for (const [k, v] of Object.entries(vocab)) m[k as VocabKind] = new Map((v ?? []).map((o) => [o.value, o.label]));
    return m;
  }, [vocab]);

  // The free count, after the filters settle.
  React.useEffect(() => {
    if (!hasFilters(filters)) {
      setCount(null);
      return;
    }
    let cancelled = false;
    setCounting(true);
    const t = setTimeout(() => {
      countPeople(filters)
        .then((r) => !cancelled && setCount(r.ok ? r.total : null))
        .catch(() => !cancelled && setCount(null))
        .finally(() => !cancelled && setCounting(false));
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [filters]);

  const set = <K extends keyof PeopleSearchFilters>(k: K, v: PeopleSearchFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  const run = async (more = false) => {
    setSearching(true);
    setError(null);
    setNote(null);
    try {
      const r = await searchPeople(filters, more ? cursor : null, 25);
      if (!r.ok) {
        setError(errorCopy(r.error));
        return;
      }
      setPeople((prev) => (more && prev ? [...prev, ...r.people] : r.people));
      setCursor(r.cursor);
      if (!more) {
        setPicked(new Set());
        setSavedIds(null);
      }
    } catch (err) {
      setError((err as Error)?.message ?? 'The search did not run.');
    } finally {
      setSearching(false);
    }
  };

  const selected = (people ?? []).filter((p) => picked.has(p.leadsforge_id));

  const save = async (listId: string | null) => {
    if (!selected.length) return;
    setSaving(true);
    setError(null);
    try {
      const r = await saveSearchResults(selected, listId);
      if (!r.ok) {
        setError(errorCopy(r.error));
        return;
      }
      setSavedIds(r.contact_ids);
      const listName = listId ? lists.find((l) => l.id === listId)?.name : null;
      setNote(
        `${r.saved} saved to your leads${listName ? ` and added to "${listName}"` : ''}` +
          (r.skipped ? ` · ${r.skipped} skipped (no name or company domain)` : '') + '.',
      );
      setPeople((prev) =>
        // The server skips anyone without a name and a company domain; mark only the rest.
        (prev ?? []).map((p) => (picked.has(p.leadsforge_id) && p.person_name && p.domain ? { ...p, contact_id: p.contact_id ?? 'saved' } : p)),
      );
    } catch (err) {
      setError((err as Error)?.message ?? 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const saveAsSearch = async () => {
    const name = window.prompt('Name this search', '');
    if (!name?.trim()) return;
    const r = await saveSavedSearch({ name: name.trim(), kind: 'people_search', filters, last_total: count });
    if (!r.ok) setError(errorCopy(r.error));
    else {
      setNote(`Saved "${name.trim()}".`);
      void refreshSaved();
    }
  };

  const chips = activeChips(filters, vocabMaps);
  const allPicked = people && people.length > 0 && people.every((p) => picked.has(p.leadsforge_id));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-5">
      {/* ---- Filters --------------------------------------------------------- */}
      <aside className="bg-white border border-[#e3e3de] p-4 space-y-5 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto" aria-label="Search filters">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]">Who</span>
          {hasFilters(filters) && (
            <button onClick={() => setFilters(EMPTY)} className="text-[10px] font-mono text-[#8a8a86] hover:text-[#141414] cursor-pointer">
              Reset all
            </button>
          )}
        </div>
        <ChipRow boxed label="Job titles" values={filters.jobTitles ?? []} onChange={(v) => set('jobTitles', v)} placeholder="e.g. Marketing Director" />
        <ChipRow boxed label="Exclude titles" values={filters.excludeJobTitles ?? []} onChange={(v) => set('excludeJobTitles', v)} placeholder="e.g. Assistant" />
        <OptionPick label="Seniority" options={vocab.seniorities ?? []} loading={vocabLoading} values={filters.seniorities ?? []} onChange={(v) => set('seniorities', v)} />
        <OptionPick label="Department" options={vocab.departments ?? []} loading={vocabLoading} values={filters.departments ?? []} onChange={(v) => set('departments', v)} />
        <ChipRow boxed label="Person located in" values={filters.personLocations ?? []} onChange={(v) => set('personLocations', v)} placeholder="Country, state or city" />

        <div className="pt-1 border-t border-[#eeeeea]" />
        <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block">Where they work</span>
        <OptionPick label="Industry" options={vocab.industries ?? []} loading={vocabLoading} values={filters.industries ?? []} onChange={(v) => set('industries', v)} />
        <div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block mb-1.5">Employees</span>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {SIZE_PRESETS.map((p) => {
              const on = filters.employeesMin === p.min && filters.employeesMax === p.max;
              return (
                <button
                  key={p.label}
                  onClick={() => setFilters((f) => (on ? { ...f, employeesMin: null, employeesMax: null } : { ...f, employeesMin: p.min, employeesMax: p.max }))}
                  aria-pressed={on}
                  className={`px-2 py-0.5 text-[11px] font-mono border cursor-pointer ${on ? 'bg-[#141414] border-[#141414] text-white' : 'border-[#e3e3de] text-[#4a4a47] hover:border-[#141414]'}`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <NumberBox label="Min employees" value={filters.employeesMin ?? null} onChange={(v) => set('employeesMin', v)} />
            <span className="text-[#8a8a86] text-xs">–</span>
            <NumberBox label="Max employees" value={filters.employeesMax ?? null} onChange={(v) => set('employeesMax', v)} />
          </div>
        </div>
        <ChipRow boxed label="Company located in" values={filters.companyLocations ?? []} onChange={(v) => set('companyLocations', v)} placeholder="e.g. United States" />
        <ChipRow boxed label="Company domains" values={filters.companyDomains ?? []} onChange={(v) => set('companyDomains', v)} placeholder="acme.com" />
        <ChipRow boxed label="Company names" values={filters.companyNames ?? []} onChange={(v) => set('companyNames', v)} placeholder="Partial names work" />
        <ChipRow boxed label="Technologies used" values={filters.technologies ?? []} onChange={(v) => set('technologies', v)} placeholder="e.g. hubspot" />
        <OptionPick label="Funding round" options={vocab.funding ?? []} loading={vocabLoading} values={filters.fundingRounds ?? []} onChange={(v) => set('fundingRounds', v)} />
        <OptionPick label="Revenue" options={vocab.revenue ?? []} loading={vocabLoading} values={filters.revenueRanges ?? []} onChange={(v) => set('revenueRanges', v)} />
        <ChipRow boxed label="Company keywords" values={filters.companyKeywords ?? []} onChange={(v) => set('companyKeywords', v)} placeholder="e.g. saas" />
        <div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block mb-1.5">At most per company</span>
          <NumberBox label="At most per company" value={filters.maxPerCompany ?? null} onChange={(v) => set('maxPerCompany', v)} />
        </div>
      </aside>

      {/* ---- Results --------------------------------------------------------- */}
      <section className="min-w-0 space-y-3">
        <div className="bg-white border border-[#e3e3de] p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="text-xs font-mono text-[#141414]" aria-live="polite">
              {!hasFilters(filters) ? (
                <span className="text-[#8a8a86]">Add filters to see how many people match. Searching is free.</span>
              ) : counting ? (
                <span className="text-[#8a8a86] inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Counting…</span>
              ) : count === null ? (
                <span className="text-[#8a8a86]">Count unavailable.</span>
              ) : (
                <>
                  About <span className="tabular-nums font-medium">{count.toLocaleString()}</span> people match · free to search
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <SavedMenu
                saved={saved}
                onApply={(s) => setFilters(s.filters as PeopleSearchFilters)}
                onDelete={async (id) => {
                  await deleteSavedSearch(id);
                  void refreshSaved();
                }}
              />
              <Button variant="quiet" onClick={async () => {
                setShowHistory((v) => !v);
                const r = await searchHistory().catch(() => null);
                if (r?.ok) setHistory(r.history);
              }}>
                <History className="w-3 h-3" /> History
              </Button>
              <Button variant="secondary" onClick={() => void saveAsSearch()} disabled={!hasFilters(filters)}>
                <Bookmark className="w-3 h-3" /> Save search
              </Button>
              <Button onClick={() => void run(false)} disabled={!hasFilters(filters) || searching}>
                {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />} Search
              </Button>
            </div>
          </div>

          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <Chip key={c.key} label={c.label} onRemove={() => setFilters((f) => c.clear(f))} />
              ))}
            </div>
          )}

          {showHistory && (
            <div className="border-t border-[#eeeeea] pt-3">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-1.5">Recent searches</div>
              {history.length === 0 ? (
                <p className="text-[11px] font-mono text-[#9b9b96]">No searches yet.</p>
              ) : (
                <ul className="space-y-1">
                  {history.map((h) => (
                    <li key={h.id}>
                      <button
                        onClick={() => {
                          setFilters(h.filters);
                          setShowHistory(false);
                        }}
                        className="text-left text-[11px] font-mono text-[#4a4a47] hover:text-[#141414] cursor-pointer"
                      >
                        {new Date(h.created_at).toLocaleString()} · {activeChips(h.filters, vocabMaps).map((c) => c.label).join(', ') || 'no filters'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {error && <div className="text-xs font-mono text-[#c0462e] px-1" role="alert">{error}</div>}
        {note && (
          <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-[#1a7f4b] bg-[#eef7f1] border border-[#cfe7d8] px-3 py-2">
            <Check className="w-3.5 h-3.5" /> {note}
            {savedIds && savedIds.length > 0 && (
              <>
                <Button variant="secondary" className="!py-1" onClick={() => setEnrichFor(savedIds)}>Find emails for these</Button>
                <Button variant="quiet" className="!py-1" onClick={onOpenPeople}>Open in People</Button>
              </>
            )}
          </div>
        )}

        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 bg-[#141414] text-white px-3 py-2 text-xs font-mono">
            <span className="tabular-nums">{selected.length} selected</span>
            <span className="text-white/40">·</span>
            <button onClick={() => void save(null)} disabled={saving} className="inline-flex items-center gap-1 hover:underline cursor-pointer disabled:opacity-50">
              <Database className="w-3 h-3" /> Save to leads
            </button>
            {lists.length > 0 && (
              <label className="inline-flex items-center gap-1">
                <Save className="w-3 h-3" />
                <select
                  className="bg-transparent border border-white/30 px-1 py-0.5 cursor-pointer"
                  value=""
                  onChange={(e) => e.target.value && void save(e.target.value)}
                  disabled={saving}
                  aria-label="Save to a list"
                >
                  <option value="">Save to list…</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id} className="text-black">{l.name}</option>
                  ))}
                </select>
              </label>
            )}
            <span className="text-white/50 ml-auto">Saving is free. Emails are found as a separate, priced step.</span>
          </div>
        )}

        {searching && !people ? (
          <div className="bg-white border border-[#e3e3de]">{[0, 1, 2, 3, 4, 5].map((i) => <RowSkeleton key={i} />)}</div>
        ) : !people ? (
          <EmptyState
            title="Find people by role and company"
            body="Combine titles, seniority, industry, company size, location, funding and technology. Searching and counting are free; you choose who to save, then pay only for the contact details that are found."
          />
        ) : people.length === 0 ? (
          <EmptyState title="Nobody matches these filters" body="Remove a filter or widen a range. The count above updates as you change them." />
        ) : (
          <div className="bg-white border border-[#e3e3de] overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="h-10 border-b border-[#e3e3de] text-left text-[10px] uppercase tracking-wider text-[#8a8a86]">
                  <th className="pl-4 w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all results"
                      checked={Boolean(allPicked)}
                      onChange={() => setPicked(allPicked ? new Set() : new Set(people.map((p) => p.leadsforge_id)))}
                    />
                  </th>
                  <th className="px-3">Person</th>
                  <th className="px-3">Company</th>
                  <th className="px-3">Industry</th>
                  <th className="px-3 text-right">Employees</th>
                  <th className="px-3">Location</th>
                  <th className="px-3"></th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const on = picked.has(p.leadsforge_id);
                  return (
                    <tr key={p.leadsforge_id} className={`h-11 border-b border-[#eeeeea] ${on ? 'bg-[#f6f6f4]' : ''}`}>
                      <td className="pl-4">
                        <input
                          type="checkbox"
                          aria-label={`Select ${p.person_name}`}
                          checked={on}
                          onChange={() =>
                            setPicked((s) => {
                              const n = new Set(s);
                              if (n.has(p.leadsforge_id)) n.delete(p.leadsforge_id);
                              else n.add(p.leadsforge_id);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 max-w-[220px]">
                        <div className="text-[#141414] truncate">{p.person_name}</div>
                        <div className="text-[10px] text-[#8a8a86] truncate">{p.title ?? '—'}</div>
                      </td>
                      <td className="px-3 max-w-[180px]">
                        <div className="text-[#141414] truncate">{p.company_name ?? p.domain ?? '—'}</div>
                        {p.company_name && <div className="text-[10px] text-[#8a8a86] truncate">{p.domain}</div>}
                      </td>
                      <td className="px-3 text-[#4a4a47] truncate max-w-[140px]">{p.company.industry ?? '—'}</td>
                      <td className="px-3 text-right tabular-nums text-[#4a4a47]">{p.company.employee_count?.toLocaleString() ?? '—'}</td>
                      <td className="px-3 text-[#4a4a47] truncate max-w-[160px]">{p.person_location ?? '—'}</td>
                      <td className="px-3 text-right">
                        {p.contact_id && <span className="text-[10px] text-[#1a7f4b]">In your leads</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex items-center justify-between px-4 py-2 text-[11px] font-mono text-[#8a8a86]">
              <span>
                Showing {people.length}
                {count !== null ? ` of about ${count.toLocaleString()}` : ''} · source: LeadsForge via Treg
              </span>
              {cursor && (
                <Button variant="secondary" className="!py-1" onClick={() => void run(true)} disabled={searching}>
                  {searching ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </div>
          </div>
        )}
      </section>

      {enrichFor && (
        <CostDialog
          title={`Find emails for ${enrichFor.length} people`}
          description="Runs the email waterfall for the people you just saved, cheapest provider first, then checks each address with a verifier. You are charged only for addresses that are found."
          getEstimate={(refresh) => enrichEstimate({ action: 'find_email', contact_ids: enrichFor, refresh_stale: refresh })}
          start={(request_id, refresh) => enrichStart({ action: 'find_email', contact_ids: enrichFor, refresh_stale: refresh, request_id })}
          onStarted={(id) => {
            setEnrichFor(null);
            onOpenRun(id);
          }}
          onClose={() => setEnrichFor(null)}
        />
      )}
    </div>
  );
};

const NumberBox: React.FC<{ label: string; value: number | null; onChange: (v: number | null) => void }> = ({ label, value, onChange }) => (
  <input
    type="number"
    min={0}
    inputMode="numeric"
    aria-label={label}
    placeholder={label.startsWith('Max') ? 'Max' : label.startsWith('Min') ? 'Min' : 'Any'}
    value={value ?? ''}
    onChange={(e) => {
      const n = e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value)));
      onChange(Number.isFinite(n as number) || n === null ? n : null);
    }}
    className="w-24 bg-transparent text-xs font-mono px-2 py-1 border border-[#e3e3de] focus:outline-none focus:ring-1 focus:ring-[#141414] tabular-nums"
  />
);

const SavedMenu: React.FC<{ saved: SavedSearch[]; onApply: (s: SavedSearch) => void; onDelete: (id: string) => void }> = ({ saved, onApply, onDelete }) => {
  const [open, setOpen] = React.useState(false);
  if (saved.length === 0) return null;
  return (
    <div className="relative">
      <Button variant="quiet" onClick={() => setOpen((v) => !v)}>
        <Bookmark className="w-3 h-3" /> Saved ({saved.length})
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-64 bg-white border border-[#e3e3de] shadow-lg py-1">
          {saved.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-[#f6f6f4]">
              <button className="text-left text-xs font-mono text-[#141414] truncate cursor-pointer" onClick={() => { onApply(s); setOpen(false); }}>
                {s.name}
                {s.last_total != null && <span className="text-[10px] text-[#8a8a86]"> · ~{s.last_total.toLocaleString()}</span>}
              </button>
              <button className="text-[10px] font-mono text-[#8a8a86] hover:text-[#c0462e] cursor-pointer" onClick={() => onDelete(s.id)} aria-label={`Delete saved search ${s.name}`}>
                delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
