/**
 * Echo Leads — Automations
 * ---------------------------------------------------------------------------
 * Scheduled work over the lead database: refresh a saved search, enrich a saved
 * People view, tag a saved People view.
 *
 * Anything that can spend carries two caps, per run and per month, and the form
 * shows what one run can cost at its limit before it is saved. The function
 * refuses a run whose estimated maximum would break either cap, and the history
 * says so rather than leaving a silent gap.
 */
import React from 'react';
import { useDialogs } from './Dialogs';
import { Plus, Pause, Play, Trash2, Pencil, Zap, AlertTriangle, Loader2, History } from 'lucide-react';
import { Button, Input, ScreenAction } from './Screen';
import { EmptyState, RowSkeleton } from './Empty';
import { Drawer, SectionLabel } from './Pick';
import { StatusPill, type PillTone } from './StatusPill';
import { PriceSummary } from './PriceSummary';
import { formatCredits } from '../../lib/billing';
import {
  getAutomations, saveAutomation, pauseAutomation, resumeAutomation, deleteAutomation, runAutomationNow,
  automationEstimate, automationHistory, getSavedSearches, getLists, errorCopy, automationIsPaid,
  type Automation, type AutomationDraft, type AutomationEstimate, type AutomationKind, type AutomationRun,
  type LeadList, type SavedSearch,
} from '../../lib/leads-db';

const KINDS: Array<{ value: AutomationKind; label: string; hint: string }> = [
  {
    value: 'saved_search_refresh',
    label: 'Refresh a saved search',
    hint: 'Runs a saved search again (free), saves the people you do not have yet, and can find their emails (priced).',
  },
  {
    value: 'auto_enrich',
    label: 'Enrich a saved view',
    hint: 'Finds emails, verifies them or finds phones for people matching a saved People view (priced).',
  },
  {
    value: 'auto_tag',
    label: 'Tag a saved view',
    hint: 'Adds or removes tags on people matching a saved People view (free).',
  },
];

const KIND_LABEL: Record<AutomationKind, string> = {
  saved_search_refresh: 'Search refresh',
  auto_enrich: 'Enrich',
  auto_tag: 'Tag',
};

const ENRICH_LABEL: Record<string, string> = {
  find_email: 'Find emails',
  verify: 'Verify emails',
  phone: 'Find phones',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const PAUSE_COPY: Record<string, string> = {
  user_paused: 'Paused',
  repeated_failures: 'Paused after 3 failed runs',
  saved_search_not_found: 'Paused: its saved search was deleted',
  list_not_found: 'Paused: its list was deleted',
  bad_config: 'Paused: its settings are no longer valid',
};

const RUN_STATUS: Record<string, { label: string; tone: PillTone }> = {
  running: { label: 'Running', tone: 'outline' },
  succeeded: { label: 'Done', tone: 'ok' },
  skipped: { label: 'Nothing to do', tone: 'neutral' },
  refused: { label: 'Refused', tone: 'warn' },
  failed: { label: 'Failed', tone: 'danger' },
};

const RunPill: React.FC<{ status: string | null }> = ({ status }) => {
  const s = RUN_STATUS[status ?? ''] ?? { label: status ?? '—', tone: 'neutral' as PillTone };
  return <StatusPill tone={s.tone} dot={status === 'running' ? 'pulse' : undefined}>{s.label}</StatusPill>;
};

const hh = (h: number) => `${String(h).padStart(2, '0')}:00 UTC`;

function scheduleCopy(a: Pick<Automation, 'frequency' | 'hour' | 'weekday'>): string {
  return a.frequency === 'weekly' ? `${WEEKDAYS[a.weekday ?? 1]}s at ${hh(a.hour)}` : `Daily at ${hh(a.hour)}`;
}

function whenCopy(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function refusalCopy(r: AutomationRun): string | null {
  if (r.detail?.message) return String(r.detail.message);
  if (r.error) return errorCopy(r.error);
  return null;
}

function outcomeCopy(r: AutomationRun, kind?: AutomationKind): string {
  if (kind === 'auto_tag') return `${r.contacts_tagged} tagged of ${r.contacts_matched} matching`;
  if (kind === 'auto_enrich') return `${r.contacts_matched} matching${r.detail?.rows ? `, ${r.detail.rows} sent to enrich` : ''}`;
  return `${r.people_found} found, ${r.people_added} new, ${r.people_skipped} skipped`;
}

export const AutomationsView: React.FC<{ onOpenRun: (id: string) => void }> = ({ onOpenRun }) => {
  const { confirm } = useDialogs();
  const [items, setItems] = React.useState<Automation[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Automation | 'new' | null>(null);
  const [historyFor, setHistoryFor] = React.useState<string | null>(null);
  const [historyKey, setHistoryKey] = React.useState(0);

  const load = React.useCallback(() => {
    getAutomations()
      .then((r) => setItems(r.automations))
      .catch((e) => setError((e as Error).message));
  }, []);
  React.useEffect(load, [load]);

  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    try {
      const r = await p;
      if (!r.ok) setError(errorCopy(r.error));
    } catch (e) {
      setError((e as Error).message);
    }
    load();
    setHistoryKey((k) => k + 1);
  };

  return (
    <div className="space-y-4">
      <ScreenAction>
        <Button onClick={() => setEditing('new')}><Plus className="w-3 h-3" /> New automation</Button>
      </ScreenAction>

      {error && <div className="text-xs font-mono text-danger" role="alert">{error}</div>}

      {items === null ? (
        <RowSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          title="No automations yet"
          body="Keep a saved search topped up with new people, enrich a saved view every week, or tag leads as they arrive."
        />
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <AutomationCard
              key={a.id}
              a={a}
              onEdit={() => setEditing(a)}
              onPause={() => void act(pauseAutomation(a.id))}
              onResume={() => void act(resumeAutomation(a.id))}
              onRunNow={() => void act(runAutomationNow(a.id))}
              onDelete={async () => {
                const ok = await confirm({
                  title: 'Delete automation',
                  body: `Delete "${a.name}"? Leads and runs it created are kept.`,
                  confirmLabel: 'Delete',
                  danger: true,
                });
                if (!ok) return;
                if (historyFor === a.id) setHistoryFor(null);
                void act(deleteAutomation(a.id));
              }}
              historyOpen={historyFor === a.id}
              onHistory={() => setHistoryFor(historyFor === a.id ? null : a.id)}
            />
          ))}
        </ul>
      )}

      {items && items.length > 0 && (
        <HistoryTable
          key={`${historyFor ?? 'all'}-${historyKey}`}
          automationId={historyFor}
          automations={items}
          onOpenRun={onOpenRun}
          onShowAll={() => setHistoryFor(null)}
        />
      )}

      {editing && (
        <AutomationEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// One automation
// ---------------------------------------------------------------------------

const AutomationCard: React.FC<{
  a: Automation;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRunNow: () => void;
  onDelete: () => void;
  historyOpen: boolean;
  onHistory: () => void;
}> = ({ a, onEdit, onPause, onResume, onRunNow, onDelete, historyOpen, onHistory }) => {
  const paid = automationIsPaid(a.kind, a.config);
  const active = a.status === 'active';
  const what =
    a.kind === 'auto_enrich'
      ? ENRICH_LABEL[a.config.enrich ?? ''] ?? 'Enrich'
      : a.kind === 'auto_tag'
        ? [
            ...(a.config.add_tags ?? []).map((t) => `+${t}`),
            ...(a.config.remove_tags ?? []).map((t) => `−${t}`),
          ].join(' ')
        : a.config.enrich === 'find_email'
          ? `Up to ${a.config.max_people} new people, then find emails`
          : `Up to ${a.config.max_people} new people`;
  const used = paid && a.max_credits_per_month > 0 ? Math.min(1, a.month_committed / a.max_credits_per_month) : 0;

  return (
    <li className="bg-white border border-line px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-ink truncate">{a.name}</span>
            <StatusPill tone="outline">{KIND_LABEL[a.kind]}</StatusPill>
            <StatusPill tone={active ? 'ok' : 'warn'} dot="still">
              {active ? 'Active' : PAUSE_COPY[a.pause_reason ?? 'user_paused'] ?? 'Paused'}
            </StatusPill>
          </div>
          <p className="text-[11px] font-mono text-ink-2 mt-1">
            {a.saved_search ? `“${a.saved_search.name}”` : <span className="text-danger">Saved search deleted</span>}
            <span className="text-muted"> · {what} · {scheduleCopy(a)}</span>
          </p>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {active ? (
            <>
              <Button variant="quiet" className="px-2" onClick={onRunNow} title="Run at the next tick, within ten minutes"><Zap className="w-3 h-3" /> Run now</Button>
              <Button variant="quiet" className="px-2" onClick={onPause}><Pause className="w-3 h-3" /> Pause</Button>
            </>
          ) : (
            <Button variant="quiet" className="px-2" onClick={onResume}><Play className="w-3 h-3" /> Resume</Button>
          )}
          <Button variant="quiet" className="px-2" onClick={onEdit}><Pencil className="w-3 h-3" /> Edit</Button>
          <Button variant="quiet" className="px-2" onClick={onHistory} title="Show this automation's runs below">
            <History className="w-3 h-3" /> {historyOpen ? 'All history' : 'History'}
          </Button>
          <Button variant="quiet" className="px-2 hover:text-danger" onClick={onDelete}><Trash2 className="w-3 h-3" /> Delete</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-[11px] font-mono">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted">Next run</div>
          <div className="text-ink">{active ? whenCopy(a.next_run_at) : '—'}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted">Last run</div>
          <div className="text-ink flex flex-wrap items-center gap-1.5">
            {a.last_run_at ? <><RunPill status={a.last_status} /> {whenCopy(a.last_run_at)}</> : 'Not yet'}
          </div>
        </div>
        {paid ? (
          <>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted">Cap per run</div>
              <div className="tabular-nums">{formatCredits(a.max_credits_per_run)} credits</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted">This month</div>
              <div className="tabular-nums">
                {formatCredits(a.month_committed)} of {formatCredits(a.max_credits_per_month)}
              </div>
              <div className="h-1 bg-line-soft mt-1" aria-hidden="true">
                <div className={`h-1 ${used >= 1 ? 'bg-danger' : 'bg-ink'}`} style={{ width: `${Math.round(used * 100)}%` }} />
              </div>
            </div>
          </>
        ) : (
          <div className="col-span-2">
            <div className="text-[10px] uppercase tracking-wider text-muted">Cost</div>
            <div>Free</div>
          </div>
        )}
      </div>
    </li>
  );
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const HistoryTable: React.FC<{
  automationId: string | null;
  automations: Automation[];
  onOpenRun: (id: string) => void;
  onShowAll: () => void;
}> = ({ automationId, automations, onOpenRun, onShowAll }) => {
  const [runs, setRuns] = React.useState<AutomationRun[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    automationHistory(automationId ?? undefined)
      .then((r) => setRuns(r.runs))
      .catch((e) => setError((e as Error).message));
  }, [automationId]);

  const byId = new Map(automations.map((a) => [a.id, a]));
  const title = automationId ? `History · ${byId.get(automationId)?.name ?? ''}` : 'History · all automations';

  return (
    <section className="bg-white border border-line">
      <div className="flex items-center justify-between px-5 py-3 border-b border-line-soft">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted">{title}</span>
        {automationId && <Button variant="quiet" className="px-2" onClick={onShowAll}>Show all</Button>}
      </div>
      {error && <div className="px-5 py-3 text-xs font-mono text-danger">{error}</div>}
      {runs === null ? (
        <RowSkeleton />
      ) : runs.length === 0 ? (
        <p className="px-5 py-6 text-xs font-mono text-muted">No runs yet. The first runs at its next scheduled time.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="h-10 border-b border-line text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-4 font-normal">Started</th>
                {!automationId && <th className="px-3 font-normal">Automation</th>}
                <th className="px-3 font-normal">Status</th>
                <th className="px-3 font-normal">Outcome</th>
                <th className="px-3 font-normal text-right">Max</th>
                <th className="px-3 font-normal text-right">Charged</th>
                <th className="px-3 font-normal">Run</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const a = byId.get(r.automation_id);
                const note = r.status === 'refused' || r.status === 'failed' ? refusalCopy(r) : null;
                return (
                  <React.Fragment key={r.id}>
                    <tr className={`h-10 ${note ? '' : 'border-b border-line-soft'}`}>
                      <td className="px-4 text-muted whitespace-nowrap">{whenCopy(r.started_at)}</td>
                      {!automationId && <td className="px-3 truncate max-w-[180px]">{a?.name ?? 'Deleted'}</td>}
                      <td className="px-3"><RunPill status={r.status} /></td>
                      <td className="px-3 text-ink-2">{outcomeCopy(r, a?.kind)}</td>
                      <td className="px-3 text-right tabular-nums text-muted">
                        {r.credits_estimated_max == null ? '—' : formatCredits(r.credits_estimated_max)}
                      </td>
                      <td className="px-3 text-right tabular-nums">{r.run_id ? formatCredits(r.credits_charged) : '—'}</td>
                      <td className="px-3">
                        {r.run_id ? (
                          <button className="underline cursor-pointer text-ink" onClick={() => onOpenRun(r.run_id!)}>
                            Open{r.run_status ? ` · ${r.run_status}` : ''}
                          </button>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                    </tr>
                    {note && (
                      <tr className="border-b border-line-soft">
                        <td colSpan={automationId ? 6 : 7} className="px-4 pb-2 text-[11px] text-muted">
                          <AlertTriangle className="w-3 h-3 inline mr-1 -mt-0.5 text-warn" />
                          {note}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

function draftFrom(a: Automation | null): AutomationDraft {
  if (!a) {
    return {
      name: '',
      kind: 'saved_search_refresh',
      config: { max_people: 50, enrich: 'none', list_id: null },
      schedule: { frequency: 'daily', hour: 6, weekday: null },
      max_credits_per_run: 0,
      max_credits_per_month: 0,
    };
  }
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    config: { ...a.config },
    schedule: { frequency: a.frequency, hour: a.hour, weekday: a.weekday },
    max_credits_per_run: Number(a.max_credits_per_run),
    max_credits_per_month: Number(a.max_credits_per_month),
  };
}

const DEFAULT_CONFIG: Record<AutomationKind, AutomationDraft['config']> = {
  saved_search_refresh: { max_people: 50, enrich: 'none', list_id: null },
  auto_enrich: { enrich: 'find_email', max_rows: 100, skip_recent_days: 30 },
  auto_tag: { add_tags: [], remove_tags: [] },
};

const tagsFrom = (s: string) => s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

const AutomationEditor: React.FC<{ initial: Automation | null; onClose: () => void; onSaved: () => void }> = ({
  initial,
  onClose,
  onSaved,
}) => {
  const [d, setD] = React.useState<AutomationDraft>(() => draftFrom(initial));
  const [searches, setSearches] = React.useState<SavedSearch[]>([]);
  const [lists, setLists] = React.useState<LeadList[]>([]);
  const [est, setEst] = React.useState<AutomationEstimate | null>(null);
  const [estLoading, setEstLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [addTags, setAddTags] = React.useState((initial?.config.add_tags ?? []).join(', '));
  const [removeTags, setRemoveTags] = React.useState((initial?.config.remove_tags ?? []).join(', '));

  const searchKind = d.kind === 'saved_search_refresh' ? 'people_search' : 'people_view';
  React.useEffect(() => {
    getSavedSearches(searchKind).then((r) => setSearches(r.searches)).catch(() => setSearches([]));
  }, [searchKind]);
  React.useEffect(() => {
    getLists().then((r) => setLists(r.lists.filter((l) => l.kind === 'people'))).catch(() => {});
  }, []);

  const paid = automationIsPaid(d.kind, d.config);
  const config = d.kind === 'auto_tag' ? { ...d.config, add_tags: tagsFrom(addTags), remove_tags: tagsFrom(removeTags) } : d.config;

  // The price of one run at its limit. Debounced: it is a database call per keystroke otherwise.
  const estKey = JSON.stringify({ k: d.kind, c: d.config, r: d.max_credits_per_run, m: d.max_credits_per_month });
  React.useEffect(() => {
    if (!paid || !d.config.saved_search_id) {
      setEst(null);
      return;
    }
    let cancelled = false;
    setEstLoading(true);
    const t = setTimeout(() => {
      automationEstimate({ kind: d.kind, config: d.config, max_credits_per_run: d.max_credits_per_run, max_credits_per_month: d.max_credits_per_month })
        .then((r) => !cancelled && setEst(r))
        .catch(() => !cancelled && setEst(null))
        .finally(() => !cancelled && setEstLoading(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // estKey is the input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estKey, paid]);

  const setConfig = (patch: Partial<AutomationDraft['config']>) => setD((x) => ({ ...x, config: { ...x.config, ...patch } }));
  const capsMissing = paid && (!(d.max_credits_per_run > 0) || !(d.max_credits_per_month > 0));
  const capsInverted = paid && d.max_credits_per_run > d.max_credits_per_month;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await saveAutomation({ ...d, config });
      if (!r.ok) setError(errorCopy(r.error));
      else onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={<span className="text-sm font-mono">{initial ? 'Edit automation' : 'New automation'}</span>}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-mono text-danger">{error}</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void save()} disabled={busy || !d.name.trim() || !d.config.saved_search_id || capsMissing || capsInverted}>
              {busy && <Loader2 className="w-3 h-3 animate-spin" />} Save
            </Button>
          </div>
        </div>
      }
    >
      <div>
        <SectionLabel>Name</SectionLabel>
        <Input value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. New marketing leaders, weekly" />
      </div>

      <div>
        <SectionLabel>What it does</SectionLabel>
        <div className="space-y-1.5">
          {KINDS.map((k) => (
            <label key={k.value} className={`flex gap-2 items-start border px-3 py-2 cursor-pointer ${d.kind === k.value ? 'border-ink' : 'border-line'} ${initial ? 'opacity-60 cursor-not-allowed' : ''}`}>
              <input
                type="radio"
                name="kind"
                className="mt-0.5"
                checked={d.kind === k.value}
                disabled={Boolean(initial)}
                onChange={() => setD({ ...d, kind: k.value, config: { ...DEFAULT_CONFIG[k.value] } })}
              />
              <span>
                <span className="block text-xs font-mono text-ink">{k.label}</span>
                <span className="block text-[11px] font-mono text-muted leading-relaxed">{k.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>{d.kind === 'saved_search_refresh' ? 'Saved search' : 'Saved People view'}</SectionLabel>
        <select
          value={d.config.saved_search_id ?? ''}
          onChange={(e) => setConfig({ saved_search_id: e.target.value || undefined })}
          className="w-full text-xs font-mono border border-line px-2 py-1.5 bg-white"
          aria-label="Saved search"
        >
          <option value="">Choose…</option>
          {searches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {searches.length === 0 && (
          <p className="text-[11px] font-mono text-muted mt-1">
            {d.kind === 'saved_search_refresh' ? 'Save a search from Search first.' : 'Save a view from People first.'}
          </p>
        )}
      </div>

      {d.kind === 'saved_search_refresh' && (
        <div className="space-y-3">
          <NumberField label="New people per run, at most" value={d.config.max_people ?? 50} min={1} max={200}
            onChange={(n) => setConfig({ max_people: n })} />
          <div>
            <SectionLabel>Save them to a list (optional)</SectionLabel>
            <select value={d.config.list_id ?? ''} onChange={(e) => setConfig({ list_id: e.target.value || null })}
              className="w-full text-xs font-mono border border-line px-2 py-1.5 bg-white" aria-label="List">
              <option value="">No list</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs font-mono">
            <input type="checkbox" checked={d.config.enrich === 'find_email'} onChange={(e) => setConfig({ enrich: e.target.checked ? 'find_email' : 'none' })} />
            Then find their emails (priced)
          </label>
        </div>
      )}

      {d.kind === 'auto_enrich' && (
        <div className="space-y-3">
          <div>
            <SectionLabel>Enrichment</SectionLabel>
            <select value={d.config.enrich ?? 'find_email'} onChange={(e) => setConfig({ enrich: e.target.value as 'find_email' | 'verify' | 'phone' })}
              className="w-full text-xs font-mono border border-line px-2 py-1.5 bg-white" aria-label="Enrichment">
              <option value="find_email">Find emails</option>
              <option value="verify">Verify emails</option>
              <option value="phone">Find phones</option>
            </select>
          </div>
          <NumberField label="People per run, at most" value={d.config.max_rows ?? 100} min={1} max={500} onChange={(n) => setConfig({ max_rows: n })} />
          <NumberField label="Skip people enriched in the last N days" value={d.config.skip_recent_days ?? 30} min={1} max={365}
            onChange={(n) => setConfig({ skip_recent_days: n })} />
        </div>
      )}

      {d.kind === 'auto_tag' && (
        <div className="space-y-3">
          <div>
            <SectionLabel>Add tags (comma separated)</SectionLabel>
            <Input value={addTags} onChange={(e) => setAddTags(e.target.value)} placeholder="e.g. icp, q4" />
          </div>
          <div>
            <SectionLabel>Remove tags (comma separated)</SectionLabel>
            <Input value={removeTags} onChange={(e) => setRemoveTags(e.target.value)} placeholder="optional" />
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Schedule (UTC)</SectionLabel>
        <div className="flex flex-wrap gap-2">
          <select value={d.schedule.frequency}
            onChange={(e) => setD({ ...d, schedule: { ...d.schedule, frequency: e.target.value as 'daily' | 'weekly', weekday: e.target.value === 'weekly' ? (d.schedule.weekday ?? 1) : null } })}
            className="text-xs font-mono border border-line px-2 py-1.5 bg-white" aria-label="Frequency">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          {d.schedule.frequency === 'weekly' && (
            <select value={d.schedule.weekday ?? 1} onChange={(e) => setD({ ...d, schedule: { ...d.schedule, weekday: Number(e.target.value) } })}
              className="text-xs font-mono border border-line px-2 py-1.5 bg-white" aria-label="Day">
              {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
            </select>
          )}
          <select value={d.schedule.hour} onChange={(e) => setD({ ...d, schedule: { ...d.schedule, hour: Number(e.target.value) } })}
            className="text-xs font-mono border border-line px-2 py-1.5 bg-white" aria-label="Hour">
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}
          </select>
        </div>
      </div>

      {paid ? (
        <div className="space-y-3">
          <SectionLabel>Spending caps (credits)</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Per run" value={d.max_credits_per_run} min={0} step="any"
              onChange={(n) => setD({ ...d, max_credits_per_run: n })} />
            <NumberField label="Per month" value={d.max_credits_per_month} min={0} step="any"
              onChange={(n) => setD({ ...d, max_credits_per_month: n })} />
          </div>
          {capsMissing && <p className="text-[11px] font-mono text-warn">Both caps are required: this automation spends credits.</p>}
          {capsInverted && <p className="text-[11px] font-mono text-danger">{errorCopy('run_cap_over_month_cap')}</p>}

          {!d.config.saved_search_id ? (
            <div className="border border-line bg-surface-2 px-3 py-2.5 text-[11px] font-mono text-muted">
              Choose a saved search to see what one run can cost.
            </div>
          ) : estLoading && !est ? (
            <div className="border border-line bg-surface-2 px-3 py-2.5 text-[11px] font-mono text-muted">
              <Loader2 className="w-3 h-3 inline animate-spin mr-1" />Pricing one run…
            </div>
          ) : est && !est.ok ? (
            <div className="border border-line bg-surface-2 px-3 py-2.5 text-[11px] font-mono text-danger">
              {errorCopy(est.error)}
            </div>
          ) : est?.estimate ? (
            <PriceSummary
              expected={est.estimate.expected_credits}
              max={est.estimate.max_credits}
              rows={est.rows}
              capPerRun={d.max_credits_per_run}
              note={
                est.runs_per_month_cap != null && est.fits_run_cap
                  ? `The monthly cap covers at least ${est.runs_per_month_cap} full-size runs. A miss is never charged.`
                  : 'A miss is never charged.'
              }
            />
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] font-mono text-muted">This automation is free: it never starts a priced run.</p>
      )}
    </Drawer>
  );
};

const NumberField: React.FC<{
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: string;
  onChange: (n: number) => void;
}> = ({ label, value, min, max, step, onChange }) => (
  <label className="block">
    <span className="block text-[10px] font-mono uppercase tracking-wider text-muted mb-1">{label}</span>
    <Input
      type="number"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
    />
  </label>
);
