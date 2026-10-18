/**
 * Echo Leads — Companies, Lists and Usage
 * ---------------------------------------------------------------------------
 * CompaniesView  every company the workspace holds a lead at, or saved as a
 *                target account, with how many people and verified addresses
 *                it has there. The profile shows provider-reported firmographics
 *                with their source and date; nothing is estimated or invented.
 * ListsView      people lists and target-account lists.
 * UsageView      credits spent, by run and by kind of work.
 */
import React from 'react';
import { useDialogs } from './Dialogs';
import { Search, ChevronLeft, ChevronRight, ExternalLink, Plus, Trash2, Pencil, ArrowUpDown } from 'lucide-react';
import { Button, ScreenAction } from './Screen';
import { EmptyState, RowSkeleton } from './Empty';
import { Drawer, Field, SectionLabel, ScoreBadge } from './Pick';
import { StatusBadge } from './StatusBadge';
import { CostDialog } from './CostDialog';
import { ChipRow } from './ChipRow';
import { providerLabel } from '../../lib/leads';
import { formatCredits } from '../../lib/billing';
import {
  queryCompanies, getCompany, updateCompanies, getLists, createList, updateList, deleteList, addToList, removeFromList,
  enrichEstimate, enrichStart, usageSummary, errorCopy,
  type Company, type Contact, type LeadList, type Sort,
} from '../../lib/leads-db';

const PAGE = 50;

export const CompaniesView: React.FC<{
  onOpenRun: (id: string) => void;
  onOpenPeople: (f: { company_id: string }) => void;
  onOpenSearch: () => void;
  initialListId?: string;
}> = ({ onOpenRun, onOpenPeople, onOpenSearch, initialListId }) => {
  const { prompt } = useDialogs();
  const [q, setQ] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [flags, setFlags] = React.useState<{ enriched?: boolean; missing_emails?: boolean; list_id?: string }>(
    initialListId ? { list_id: initialListId } : {},
  );
  const [sort, setSort] = React.useState<Sort>({ field: 'contacts', dir: 'desc' });
  const [page, setPage] = React.useState(0);
  const [rows, setRows] = React.useState<Company[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [enrichIds, setEnrichIds] = React.useState<string[] | null>(null);
  const [lists, setLists] = React.useState<LeadList[]>([]);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    void getLists().then((r) => r.ok && setLists(r.lists.filter((l) => l.kind === 'companies'))).catch(() => {});
  }, []);
  React.useEffect(() => {
    const t = setTimeout(() => setQuery(q), 350);
    return () => clearTimeout(t);
  }, [q]);
  React.useEffect(() => {
    setPage(0);
    setPicked(new Set());
  }, [query, flags, sort]);
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    queryCompanies({ q: query || undefined, ...flags }, sort, page, PAGE)
      .then((r) => {
        if (cancelled) return;
        setRows(r.companies);
        setTotal(r.total);
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query, flags, sort, page, reload]);

  const ids = [...picked];
  const pageAll = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const toggleSort = (field: string) => setSort((s) => (s.field === field ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: field === 'name' ? 'asc' : 'desc' }));

  const addToTargets = async (listId: string) => {
    let id = listId;
    if (listId === '__new') {
      const made = { id: '' };
      const name = await prompt({
        title: 'New target account list',
        label: 'List name',
        confirmLabel: 'Create list',
        submit: async (v) => {
          const c = await createList(v, 'companies');
          if (!c.ok) return errorCopy(c.error);
          made.id = c.list.id;
        },
      });
      if (!name || !made.id) return;
      id = made.id;
      void getLists().then((r) => r.ok && setLists(r.lists.filter((l) => l.kind === 'companies')));
    }
    const r = await addToList(id, ids);
    if (!r.ok) setError(errorCopy(r.error));
    else setNote(`${r.added} added to the list.`);
  };

  if (!loading && total === 0 && !query && !Object.values(flags).some((v) => v !== undefined)) {
    return (
      <EmptyState
        title="No companies yet"
        body="Every company where you hold a lead appears here, with the people you have there and what is missing. Start by finding people."
        action={{ label: 'Search for people', onClick: onOpenSearch }}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company name or domain" aria-label="Search companies"
            className="w-full pl-8 pr-2 py-1.5 text-xs font-mono bg-white border border-line focus:outline-none focus:ring-1 focus:ring-ink" />
        </div>
        <Toggle on={flags.missing_emails === true} onClick={() => setFlags((f) => ({ ...f, missing_emails: f.missing_emails ? undefined : true }))}>Missing emails</Toggle>
        <Toggle on={flags.enriched === false} onClick={() => setFlags((f) => ({ ...f, enriched: f.enriched === false ? undefined : false }))}>Not enriched</Toggle>
        {lists.length > 0 && (
          <select className="text-xs font-mono border border-line px-1.5 py-1.5 bg-white" value={flags.list_id ?? ''} aria-label="Filter by target list"
            onChange={(e) => setFlags((f) => ({ ...f, list_id: e.target.value || undefined }))}>
            <option value="">All companies</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>

      {error && <div className="text-xs font-mono text-danger" role="alert">{error}</div>}
      {note && <div className="text-xs font-mono text-ok" aria-live="polite">{note}</div>}

      {ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 bg-ink text-white px-3 py-2 text-xs font-mono">
          <span className="tabular-nums">{ids.length} selected</span>
          <button className="hover:underline cursor-pointer" onClick={() => setEnrichIds(ids)}>Company details</button>
          <select className="bg-transparent border border-white/30 px-1 py-0.5 cursor-pointer" value="" aria-label="Add to target list"
            onChange={(e) => e.target.value && void addToTargets(e.target.value)}>
            <option value="">Add to target list…</option>
            {lists.map((l) => <option key={l.id} value={l.id} className="text-black">{l.name}</option>)}
            <option value="__new" className="text-black">+ New list…</option>
          </select>
          {flags.list_id && (
            <button className="hover:underline cursor-pointer" onClick={async () => {
              const r = await removeFromList(flags.list_id!, ids);
              if (r.ok) { setNote(`${r.removed} removed from the list.`); setReload((n) => n + 1); }
            }}>Remove from list</button>
          )}
        </div>
      )}

      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="h-10 border-b border-line text-left text-[10px] uppercase tracking-wider text-muted">
              <th className="pl-4 w-8">
                <input type="checkbox" aria-label="Select this page" checked={pageAll}
                  onChange={() => setPicked(pageAll ? new Set() : new Set(rows.map((r) => r.id)))} />
              </th>
              <Th label="Company" field="name" sort={sort} onSort={toggleSort} />
              <th className="px-3 font-normal">Industry</th>
              <th className="px-3 font-normal text-right">Employees</th>
              <Th label="People" field="contacts" sort={sort} onSort={toggleSort} right />
              <Th label="Verified" field="verified" sort={sort} onSort={toggleSort} right />
              <Th label="Best fit" field="score" sort={sort} onSort={toggleSort} />
              <th className="px-3 font-normal">Details</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0
              ? [0, 1, 2, 3].map((i) => <tr key={i}><td colSpan={8}><RowSkeleton /></td></tr>)
              : rows.length === 0
                ? <tr><td colSpan={8} className="px-4 py-10 text-center text-muted">No companies match.</td></tr>
                : rows.map((c) => (
                  <tr key={c.id} className={`h-11 border-b border-line-soft hover:bg-surface-2 cursor-pointer ${picked.has(c.id) ? 'bg-surface' : ''}`} onClick={() => setOpenId(c.id)}>
                    <td className="pl-4" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${c.name ?? c.domain}`} checked={picked.has(c.id)}
                        onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />
                    </td>
                    <td className="px-3 max-w-[220px]">
                      <div className="truncate text-ink">{c.name ?? c.domain}</div>
                      <div className="text-[10px] text-muted truncate">{c.domain}</div>
                    </td>
                    <td className="px-3 truncate max-w-[160px] text-ink-2">{c.data?.industry ?? '—'}</td>
                    <td className="px-3 text-right tabular-nums text-ink-2">{c.data?.employee_count?.toLocaleString?.() ?? c.data?.employee_range ?? '—'}</td>
                    <td className="px-3 text-right tabular-nums">{c.contacts}</td>
                    <td className="px-3 text-right tabular-nums">
                      {c.verified_emails}
                      {c.missing_emails > 0 && <span className="text-[10px] text-warn"> · {c.missing_emails} missing</span>}
                    </td>
                    <td className="px-3"><ScoreBadge score={c.best_score} label={null} /></td>
                    <td className="px-3 text-muted">{c.enriched_at ? `Enriched ${new Date(c.enriched_at).toLocaleDateString()}` : 'Not enriched'}</td>
                  </tr>
                ))}
          </tbody>
        </table>
        <Pager page={page} total={total} shown={rows.length} loading={loading} onPage={setPage} />
      </div>

      {openId && (
        <CompanyPanel
          id={openId}
          onClose={() => setOpenId(null)}
          onEnrich={() => setEnrichIds([openId])}
          onOpenPeople={() => onOpenPeople({ company_id: openId })}
          onChanged={() => setReload((n) => n + 1)}
        />
      )}
      {enrichIds && (
        <CostDialog
          title={`Company details for ${enrichIds.length} ${enrichIds.length === 1 ? 'company' : 'companies'}`}
          description="Fetches industry, size, revenue range, location and technologies from the company data provider. Companies enriched in the last 90 days are skipped unless you refresh them. A company the provider does not know costs nothing."
          allowRefresh
          getEstimate={(refresh_stale) => enrichEstimate({ action: 'company', company_ids: enrichIds, refresh_stale })}
          start={(request_id, refresh_stale) => enrichStart({ action: 'company', company_ids: enrichIds, refresh_stale, request_id })}
          onStarted={(id) => { setEnrichIds(null); onOpenRun(id); }}
          onClose={() => setEnrichIds(null)}
        />
      )}
    </div>
  );
};

const CompanyPanel: React.FC<{ id: string; onClose: () => void; onEnrich: () => void; onOpenPeople: () => void; onChanged: () => void }> = ({
  id, onClose, onEnrich, onOpenPeople, onChanged,
}) => {
  const [data, setData] = React.useState<{ company: Company; people: Contact[]; lists: Array<{ id: string; name: string }> } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    getCompany(id).then((r) => (r.ok ? setData(r) : setError(errorCopy(r.error)))).catch((e) => setError((e as Error).message));
  }, [id]);
  React.useEffect(load, [load]);

  const c = data?.company;
  const d = c?.data ?? {};
  const noDecisionMakers = data && !data.people.some((p) => /\b(ceo|cto|cfo|coo|cmo|chief|founder|owner|president|vp|vice president|head|director|partner)\b/i.test(p.title ?? ''));

  return (
    <Drawer
      onClose={onClose}
      title={c ? (
        <div>
          <div className="text-sm font-medium text-ink">{c.name ?? c.domain}</div>
          <a href={`https://${c.domain}`} target="_blank" rel="noreferrer noopener" className="text-[11px] font-mono text-muted inline-flex items-center gap-1 hover:underline">
            {c.domain} <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      ) : <div className="text-sm text-muted">Loading…</div>}
      footer={c && (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onEnrich}>{c.enriched_at ? 'Refresh details' : 'Add company details'}</Button>
          <Button variant="quiet" onClick={onOpenPeople}>Open people</Button>
        </div>
      )}
    >
      {error && <div className="text-xs font-mono text-danger">{error}</div>}
      {c && (
        <>
          <section className="space-y-2">
            <SectionLabel>Firmographics</SectionLabel>
            {!c.enriched_at && (
              <p className="text-[11px] font-mono text-muted">Not enriched yet. Values below, if any, came with the people found here.</p>
            )}
            <Field label="Industry">{d.industry}</Field>
            <Field label="Employees">{d.employee_count != null ? Number(d.employee_count).toLocaleString() : d.employee_range}</Field>
            <Field label="Revenue">{d.revenue_range}</Field>
            <Field label="Founded">{d.founded}</Field>
            <Field label="Type">{d.type}</Field>
            <Field label="Location">{[d.city, d.state, d.country].filter(Boolean).join(', ')}</Field>
            <Field label="Technologies">{Array.isArray(d.technologies) && d.technologies.length ? d.technologies.join(', ') : null}</Field>
            <Field label="About">{d.description}</Field>
            <Field label="Source" source={null}>
              {d.source ? `${providerLabel(String(d.source))}, ${c.enriched_at ? new Date(c.enriched_at).toLocaleDateString() : ''}` : null}
            </Field>
          </section>
          <section className="space-y-2">
            <SectionLabel>People here ({data!.people.length})</SectionLabel>
            {noDecisionMakers && (
              <p className="text-[11px] font-mono text-warn">
                No decision-maker titles among the people you hold here. Search this domain on the Search tab to find them.
              </p>
            )}
            {data!.people.length === 0 ? (
              <p className="text-[11px] font-mono text-muted">None yet.</p>
            ) : (
              <ul className="divide-y divide-line-soft border border-line-soft">
                {data!.people.slice(0, 25).map((p) => (
                  <li key={p.id} className="px-3 py-2 text-xs font-mono flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{p.person_name ?? '—'}</span>
                      <span className="block truncate text-[10px] text-muted">{p.title ?? '—'}</span>
                    </span>
                    <span className="flex items-center gap-1.5 flex-shrink-0">
                      {p.email ? <StatusBadge status={p.email_status} /> : <span className="text-[10px] text-faint">no email</span>}
                      <ScoreBadge score={p.score} label={p.score_label} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="space-y-2">
            <ChipRow boxed label="Tags" values={c.tags ?? []} onChange={async (next) => {
              await updateCompanies([c.id], {
                add_tags: next.filter((t) => !(c.tags ?? []).includes(t)),
                remove_tags: (c.tags ?? []).filter((t) => !next.includes(t)),
              });
              load();
              onChanged();
            }} />
          </section>
          {data!.lists.length > 0 && (
            <section className="space-y-2">
              <SectionLabel>Target lists</SectionLabel>
              <div className="flex flex-wrap gap-1">{data!.lists.map((l) => <span key={l.id} className="px-2 py-0.5 text-[11px] font-mono bg-fill">{l.name}</span>)}</div>
            </section>
          )}
        </>
      )}
    </Drawer>
  );
};

export const ListsView: React.FC<{ onOpenList: (l: LeadList) => void }> = ({ onOpenList }) => {
  const { confirm, prompt } = useDialogs();
  const [lists, setLists] = React.useState<LeadList[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    getLists().then((r) => r.ok && setLists(r.lists)).catch((e) => setError((e as Error).message));
  }, []);
  React.useEffect(load, [load]);

  const create = async (kind: 'people' | 'companies') => {
    const name = await prompt({
      title: kind === 'people' ? 'New people list' : 'New target account list',
      label: 'List name',
      placeholder: kind === 'people' ? 'e.g. Marketing decision-makers' : 'e.g. Q1 target accounts',
      confirmLabel: 'Create list',
      submit: async (v) => {
        const r = await createList(v, kind);
        return r.ok ? null : errorCopy(r.error);
      },
    });
    if (name) load();
  };

  const groups: Array<{ kind: 'people' | 'companies'; title: string; hint: string }> = [
    { kind: 'people', title: 'People lists', hint: 'Add leads from People or Search. A lead can be in many lists.' },
    { kind: 'companies', title: 'Target account lists', hint: 'Add companies from the Companies tab.' },
  ];

  return (
    <div className="space-y-6">
      {error && <div className="text-xs font-mono text-danger">{error}</div>}
      {groups.map((g) => {
        const mine = (lists ?? []).filter((l) => l.kind === g.kind);
        return (
          <section key={g.kind} className="bg-white border border-line">
            <div className="flex items-center justify-between px-5 py-3 border-b border-line-soft">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted">{g.title}</span>
                <p className="text-[11px] font-mono text-muted mt-0.5">{g.hint}</p>
              </div>
              <Button variant="secondary" onClick={() => void create(g.kind)}><Plus className="w-3 h-3" /> New list</Button>
            </div>
            {lists === null ? (
              <RowSkeleton />
            ) : mine.length === 0 ? (
              <p className="px-5 py-6 text-xs font-mono text-muted">No lists yet.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {mine.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 px-5 h-11">
                    <button className="text-xs font-mono text-ink hover:underline cursor-pointer truncate" onClick={() => onOpenList(l)}>{l.name}</button>
                    <span className="flex items-center gap-3 text-[11px] font-mono text-muted">
                      <span className="tabular-nums">{l.members} {l.kind === 'people' ? 'leads' : 'companies'}</span>
                      <button aria-label={`Rename ${l.name}`} className="hover:text-ink cursor-pointer" onClick={async () => {
                        const name = await prompt({
                          title: 'Rename list',
                          label: 'List name',
                          initial: l.name,
                          confirmLabel: 'Rename',
                          submit: async (v) => {
                            if (v === l.name) return null;
                            const r = await updateList(l.id, { name: v });
                            return r.ok ? null : errorCopy(r.error);
                          },
                        });
                        if (name) load();
                      }}><Pencil className="w-3 h-3" /></button>
                      <button aria-label={`Delete ${l.name}`} className="hover:text-danger cursor-pointer" onClick={async () => {
                        const ok = await confirm({
                          title: 'Delete list',
                          body: `Delete the list "${l.name}"? The ${l.kind === 'people' ? 'leads' : 'companies'} in it are kept.`,
                          confirmLabel: 'Delete list',
                          danger: true,
                        });
                        if (!ok) return;
                        await deleteList(l.id);
                        load();
                      }}><Trash2 className="w-3 h-3" /></button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
};

export const UsageView: React.FC<{ onOpenRun: (id: string) => void }> = ({ onOpenRun }) => {
  const [days, setDays] = React.useState(30);
  const [data, setData] = React.useState<Awaited<ReturnType<typeof usageSummary>> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setData(null);
    usageSummary(days).then(setData).catch((e) => setError((e as Error).message));
  }, [days]);

  return (
    <div className="space-y-4">
      <ScreenAction>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-xs font-mono border border-line px-1.5 py-1 bg-white" aria-label="Period">
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>12 months</option>
        </select>
      </ScreenAction>
      {error && <div className="text-xs font-mono text-danger">{error}</div>}
      {!data ? <RowSkeleton /> : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white border border-line p-4">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted">Credits charged</div>
              <div className="text-2xl font-mono tabular-nums mt-1">{formatCredits(data.total_credits)}</div>
            </div>
            <div className="bg-white border border-line p-4 sm:col-span-2">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted mb-2">By kind of work</div>
              {data.by_type.length === 0 ? <p className="text-xs font-mono text-muted">Nothing in this period.</p> : (
                <ul className="space-y-1">
                  {data.by_type.map((t) => (
                    <li key={t.type} className="flex justify-between text-xs font-mono">
                      <span>{t.type} <span className="text-muted">· {t.runs} runs</span></span>
                      <span className="tabular-nums">{formatCredits(t.credits)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="bg-white border border-line overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="h-10 border-b border-line text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="px-4 font-normal">Run</th>
                  <th className="px-3 font-normal">Started</th>
                  <th className="px-3 font-normal">Status</th>
                  <th className="px-3 font-normal text-right">Quoted (max)</th>
                  <th className="px-3 font-normal text-right">Charged</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id} className="h-11 border-b border-line-soft hover:bg-surface-2 cursor-pointer" onClick={() => onOpenRun(r.id)}>
                    <td className="px-4 truncate max-w-[260px]">{r.name ?? (r.kind === 'find' ? 'Find by profile' : 'Clean')}</td>
                    <td className="px-3 text-muted whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-3">{r.status}</td>
                    <td className="px-3 text-right tabular-nums text-muted">{formatCredits(r.max_credits)}</td>
                    <td className="px-3 text-right tabular-nums">{formatCredits(r.charged_credits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

const Toggle: React.FC<{ on: boolean; onClick: () => void; children: React.ReactNode }> = ({ on, onClick, children }) => (
  <button onClick={onClick} aria-pressed={on} className={`px-2.5 py-1.5 text-xs font-mono border cursor-pointer ${on ? 'bg-ink border-ink text-white' : 'border-line bg-white text-ink-2'}`}>
    {children}
  </button>
);

const Th: React.FC<{ label: string; field: string; sort: Sort; onSort: (f: string) => void; right?: boolean }> = ({ label, field, sort, onSort, right }) => (
  <th className={`px-3 font-normal ${right ? 'text-right' : ''}`} aria-sort={sort.field === field ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button onClick={() => onSort(field)} className={`inline-flex items-center gap-1 uppercase tracking-wider cursor-pointer ${sort.field === field ? 'text-ink' : ''}`}>
      {label} <ArrowUpDown className="w-3 h-3 opacity-50" />
    </button>
  </th>
);

const Pager: React.FC<{ page: number; total: number; shown: number; loading: boolean; onPage: (p: number) => void }> = ({ page, total, shown, loading, onPage }) => (
  <div className="flex items-center justify-between px-4 py-2 text-[11px] font-mono text-muted">
    <span className="tabular-nums">{total === 0 ? '0' : `${page * PAGE + 1}–${page * PAGE + shown}`} of {total.toLocaleString()}</span>
    <div className="flex items-center gap-1">
      <button className="p-1 disabled:opacity-30 cursor-pointer" disabled={page === 0 || loading} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
      <button className="p-1 disabled:opacity-30 cursor-pointer" disabled={(page + 1) * PAGE >= total || loading} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
    </div>
  </div>
);
