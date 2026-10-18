import React from 'react';
import {
  ListChecks, Plus, Search, FlaskConical, ShieldOff, ArrowLeft,
  AlertTriangle, Play, Pause, Square, X, Users, Building2, List, Upload, Receipt, CalendarClock,
} from 'lucide-react';
import type { LeadsView, LeadRow, LeadRun, LeadAttempt } from '../../types';
import type { AttemptWithFailure } from '../leads/AttemptHistory';
import {
  getRun, bulkAction, isActiveRun, controlRun, addSuppression, providerLabel,
} from '../../lib/leads';
import { fetchBalance, formatUsd } from '../../lib/billing';
import { supabase } from '../../lib/supabase';
import { subscribeToRun, mergeRow, summarise } from '../../lib/leads-live';
import { RunsList } from '../leads/RunsList';
import { CleanList } from '../leads/CleanList';
import { NewSearch } from '../leads/NewSearch';
import { ProviderLab } from '../leads/ProviderLab';
import { OptOuts } from '../leads/OptOuts';
import { LeadsTable } from '../leads/LeadsTable';
import { CompositionBar, RunStrip, MeterFigure, ProviderMix } from '../leads/Data';
import { WaterfallColumn } from '../leads/WaterfallChain';
import { Button } from '../leads/Screen';
import { EmptyState } from '../leads/Empty';
import { ExportMenu } from '../leads/ExportMenu';
import { CostDialog } from '../leads/CostDialog';
import { StatusPill } from '../leads/StatusPill';
import { SearchView } from '../leads/SearchView';
import { AutomationsView } from '../leads/AutomationsView';
import { PeopleView } from '../leads/PeopleView';
import { CompaniesView, ListsView, UsageView } from '../leads/CompaniesView';
import type { ContactFilters } from '../../lib/leads-db';
import { bulkRowsEstimate, bulkRowsStart } from '../../lib/leads-db';
import { getWaterfall } from '../../lib/leads';
import type { LeadStep } from '../../types';

/**
 * The Leads tab.
 *
 * A tab, not an app: same sidebar, same wallet, same login as Feed. The
 * sub-views live in the hash so a run link survives a refresh and a browser Back
 * returns to the list rather than to the feed.
 *
 * Routing and data live here; each screen is a leaf that owns its own fetching.
 */

interface LeadsTabProps {
  view: LeadsView;
  runId: string | null;
  onViewChange: (view: LeadsView) => void;
  onOpenRun: (runId: string) => void;
}

export const LeadsTab: React.FC<LeadsTabProps> = ({ view, runId, onViewChange, onOpenRun }) => {
  // A run is a detail screen, so the sub-nav is hidden: five panels above a
  // table that belongs to none of them only invites the wrong click.
  if (view === 'run') {
    return (
      <RunView
        runId={runId}
        onBack={() => onViewChange('runs')}
        onOpenRun={onOpenRun}
      />
    );
  }

  return <LeadsWorkspace view={view} onViewChange={onViewChange} onOpenRun={onOpenRun} />;
};

/**
 * The sub-views. Kept apart from LeadsTab so the run detail screen above stays
 * an early return, and so "open this list in People" can carry its filter across
 * a view change without living in the hash.
 */
const LeadsWorkspace: React.FC<{
  view: LeadsView;
  onViewChange: (view: LeadsView) => void;
  onOpenRun: (runId: string) => void;
}> = ({ view, onViewChange, onOpenRun }) => {
  // A filter handed from another view (a list, a company). The key remounts the
  // view so it starts from that filter rather than merging into the old one.
  const [peopleInit, setPeopleInit] = React.useState<{ key: number; filters: ContactFilters } | null>(null);
  const [companyList, setCompanyList] = React.useState<{ key: number; id: string } | null>(null);
  const openPeople = (filters: ContactFilters) => {
    setPeopleInit({ key: Date.now(), filters });
    onViewChange('people');
  };

  return (
    <div className="space-y-6">
      <SubNav view={view} onViewChange={(v) => {
        if (v === 'people') setPeopleInit(null);
        if (v === 'companies') setCompanyList(null);
        onViewChange(v);
      }} />

      {view === 'search' && <SearchView onOpenRun={onOpenRun} onOpenPeople={() => openPeople({})} />}

      {view === 'people' && (
        <PeopleView
          key={peopleInit?.key ?? 'people'}
          initialFilters={peopleInit?.filters}
          onOpenRun={onOpenRun}
          onOpenSearch={() => onViewChange('search')}
        />
      )}

      {view === 'companies' && (
        <CompaniesView
          key={companyList?.key ?? 'companies'}
          initialListId={companyList?.id}
          onOpenRun={onOpenRun}
          onOpenPeople={(f) => openPeople(f)}
          onOpenSearch={() => onViewChange('search')}
        />
      )}

      {view === 'lists' && (
        <ListsView
          onOpenList={(l) => {
            if (l.kind === 'people') openPeople({ list_id: l.id });
            else {
              setCompanyList({ key: Date.now(), id: l.id });
              onViewChange('companies');
            }
          }}
        />
      )}

      {view === 'usage' && <UsageView onOpenRun={onOpenRun} />}

      {view === 'automations' && <AutomationsView onOpenRun={onOpenRun} />}

      {view === 'runs' && (
        <RunsList
          onOpenRun={onOpenRun}
          onNewSearch={() => onViewChange('new')}
        />
      )}

      {view === 'new' && <NewSearch onStarted={onOpenRun} />}

      {view === 'clean' && <CleanList onOpenRun={onOpenRun} />}

      {view === 'lab' && <ProviderLab />}

      {view === 'optouts' && <OptOuts />}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sub-nav
// ---------------------------------------------------------------------------

// Two groups: the lead database the user works in, then the jobs and settings
// that feed it. A divider between them rather than a second menu.
const SUB_NAV: Array<{ view: LeadsView; label: string; icon: React.ReactNode; divider?: boolean }> = [
  { view: 'search', label: 'Search', icon: <Search className="w-3.5 h-3.5" /> },
  { view: 'people', label: 'People', icon: <Users className="w-3.5 h-3.5" /> },
  { view: 'companies', label: 'Companies', icon: <Building2 className="w-3.5 h-3.5" /> },
  { view: 'lists', label: 'Lists', icon: <List className="w-3.5 h-3.5" /> },
  { view: 'runs', label: 'Runs', icon: <ListChecks className="w-3.5 h-3.5" />, divider: true },
  { view: 'new', label: 'Find by profile', icon: <Plus className="w-3.5 h-3.5" /> },
  { view: 'clean', label: 'Import', icon: <Upload className="w-3.5 h-3.5" /> },
  { view: 'automations', label: 'Automations', icon: <CalendarClock className="w-3.5 h-3.5" /> },
  { view: 'usage', label: 'Usage', icon: <Receipt className="w-3.5 h-3.5" /> },
  { view: 'lab', label: 'Provider lab', icon: <FlaskConical className="w-3.5 h-3.5" /> },
  { view: 'optouts', label: 'Opt-outs', icon: <ShieldOff className="w-3.5 h-3.5" /> },
];

const SubNav: React.FC<{ view: LeadsView; onViewChange: (v: LeadsView) => void }> = ({
  view,
  onViewChange,
}) => (
  <nav className="flex items-center gap-1 border-b border-line -mt-2 overflow-x-auto" aria-label="Leads sections">
    {SUB_NAV.map((item) => {
      const active = view === item.view;
      return (
        <React.Fragment key={item.view}>
        {item.divider && <span className="w-px h-4 bg-line mx-1.5 flex-shrink-0" aria-hidden="true" />}
        <button
          aria-current={active ? 'page' : undefined}
          onClick={() => onViewChange(item.view)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono transition-colors cursor-pointer border-b-2 -mb-px ${
            active
              ? 'border-ink text-ink font-medium'
              : 'border-transparent text-muted hover:text-ink'
          }`}
        >
          {item.icon}
          {item.label}
        </button>
        </React.Fragment>
      );
    })}
  </nav>
);

// ---------------------------------------------------------------------------
// One run — the table, live
// ---------------------------------------------------------------------------

const RunView: React.FC<{ runId: string | null; onBack: () => void; onOpenRun: (id: string) => void }> = ({
  runId,
  onBack,
  onOpenRun,
}) => {
  // Rows waiting on the re-verify confirmation. Re-verifying is a new priced
  // run, so it is confirmed with its price like every other paid action.
  const [reverifyIds, setReverifyIds] = React.useState<string[] | null>(null);
  const [run, setRun] = React.useState<LeadRun | null>(null);
  const [rows, setRows] = React.useState<LeadRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [live, setLive] = React.useState(false);

  // The real wallet balance. It used to be a hardcoded 1000, so the meter beside
  // it was drawing a picture of nobody's account — a balance figure that is
  // confidently wrong is worse than no balance figure, because it is the one
  // number somebody checks before starting a run.
  const [balance, setBalance] = React.useState<number | null>(null);
  const [reserved, setReserved] = React.useState<number | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // The eight rows that cost the most to resolve, with their attempt history.
  //
  // Eight and not fifty: this panel makes one extra query per row, and a panel
  // that fetches fifty is a panel nobody opens twice. Eight is enough for the
  // shape to read and cheap enough to fetch on every load.
  const [expensive, setExpensive] = React.useState<Array<{ id: string; attempts: LeadAttempt[] }>>([]);
  // Every attempt made on the rows currently on the page, by row.
  //
  // One query for the page rather than the per-row fetch below, because the same
  // data answers two questions: which providers earned a row, and what each of
  // those providers was paid. Both are things the run detail view cannot state
  // without it.
  const [attemptsByRow, setAttemptsByRow] = React.useState<Map<string, LeadAttempt[]>>(new Map());
  // The order each step's providers run in, so an untried provider is drawn as a
  // rung rather than omitted.
  //
  // This is the thing the chain diagram was always supposed to do and never
  // could: "tried Kitt, then ContactOut, then gave up" is only believable if
  // there was a plan to be honest to, and without the plan the diagram shows
  // three providers when five ran and two were never reached. Six steps' worth is
  // one fetch of six small calls, and it only happens when the panel is on screen.
  const [stepOrders, setStepOrders] = React.useState<Partial<Record<LeadStep, string[]>>>({});

  const fetchPage = React.useCallback(async (id: string) => {
    const res = await getRun(id, { limit: 500, offset: 0 });
    if (!res.ok) throw new Error(res.error);
    return { rows: res.rows, total: res.total };
  }, []);

  // Initial page. Then the subscription owns the updates.
  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    getRun(runId, { limit: 500, offset: 0 })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error);
          setLoading(false);
          return;
        }
        setRun(res.run);
        setRows(res.rows);
        setTotal(res.total);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error)?.message ?? 'Could not load the run.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Live updates, with polling underneath until the socket proves itself.
  React.useEffect(() => {
    if (!runId || !supabase) return;

    const dispose = subscribeToRun(supabase, runId, fetchPage, {
      onPage: (pageRows, pageTotal) => {
        setRows(pageRows);
        setTotal(pageTotal);
        setLoading(false);
      },
      onRow: (row) => setRows((prev) => mergeRow(prev, row)),
      onRun: (next) => setRun(next),
      onLiveChange: setLive,
    });

    return dispose;
  }, [runId, fetchPage, supabase]);

  // Attempts for whatever is on the page. Refetched when the row ids change,
  // which is once per page rather than once per row - the alternative was eight
  // round trips to build one bar.
  const pageKey = React.useMemo(() => rows.map((r) => r.id).join(','), [rows]);

  React.useEffect(() => {
    if (!supabase || !rows.length) {
      setAttemptsByRow(new Map());
      return;
    }

    let cancelled = false;
    const ids = pageKey ? pageKey.split(',') : [];

    void (async () => {
      const { data } = await supabase
        .from('lead_attempts')
        .select('row_id, endpoint_id, step, hit, cost_usd, created_at')
        .in('row_id', ids)
        .order('created_at', { ascending: true });

      if (cancelled) return;

      const byRow = new Map<string, LeadAttempt[]>();
      for (const a of (data ?? []) as LeadAttempt[]) {
        if (!a.row_id) continue;
        const list = byRow.get(a.row_id);
        if (list) list.push(a);
        else byRow.set(a.row_id, [a]);
      }
      setAttemptsByRow(byRow);
    })();

    return () => {
      cancelled = true;
    };
  }, [pageKey, rows.length, supabase]);

  const stats = React.useMemo(() => summarise(rows), [rows]);

  // Status counts for the composition bar, straight off the rows on screen rather
  // than off the run's denormalised counters. During a run the row list is the
  // thing being looked at, and the counters are written a chunk at a time, so the
  // two disagree for minutes at a time and the bar would lag the table beside it.
  // What the providers actually charged, across the rows on screen. Shown beside
  // the credits because a per-result waterfall's whole claim is that the charge is
  // the measured provider cost at a mark-up, and a mark-up nobody can see is one
  // they have to take on trust.
  const providerUsd = React.useMemo(
    () => rows.reduce((n, r) => n + (r.treg_cost_usd ?? 0), 0),
    [rows],
  );

  const statusCounts = React.useMemo(() => {
    const out: Record<string, number> = {
      verified: 0, catch_all: 0, invalid: 0, unknown: 0, not_found: 0,
    };
    for (const r of rows) out[r.email_status] = (out[r.email_status] ?? 0) + 1;
    return out;
  }, [rows]);

  // Who actually supplied each address, in waterfall order rather than by size,
  // so a provider moving in the bar is visibly moving.
  //
  // Built from lead_attempts rather than from the row's email_provider. That
  // column is written by exactly one step, so before this the panel counted the
  // address providers and nothing else - and on a find run the decision-maker
  // step is 28% of what the row costs, entirely absent from a bar captioned "a
  // provider high on this bar is earning its place in the waterfall". It also
  // credited the whole row's provider cost to whichever step found the address,
  // which puts a person lookup's money on the email provider's bar.
  //
  // First hit per row is what counts, for the same reason it is what the lab
  // counts on: a provider that repeated what another one had already found did
  // not earn that row.
  const mix = React.useMemo(() => {
    const credited = new Set<string>();
    const found = new Map<string, { found: number; costUsd: number }>();

    for (const r of rows) {
      for (const a of attemptsByRow.get(r.id) ?? []) {
        if (!a.hit) continue;
        if (credited.has(a.row_id + '|' + a.endpoint_id)) continue;
        credited.add(a.row_id + '|' + a.endpoint_id);
        const cur = found.get(a.endpoint_id) ?? { found: 0, costUsd: 0 };
        cur.found++;
        cur.costUsd += a.cost_usd ?? 0;
        found.set(a.endpoint_id, cur);
      }
    }

    // Every step's providers can appear, in no fixed order, ranked by what they
    // earned. An ordered list keyed on the email default would leave the
    // decision-maker providers off the end of it.
    return [...found.entries()]
      .map(([endpointId, v]) => ({
        endpointId,
        label: providerLabel(endpointId),
        found: v.found,
        costUsd: v.costUsd,
      }))
      .sort((a, b) => b.found - a.found || b.costUsd - a.costUsd);
  }, [rows, attemptsByRow]);

  // Fetched once. Polling the wallet every three seconds alongside the run would
  // be a second realtime channel for a number that changes only when the run
  // spends something, and the run's own figures already show that.
  React.useEffect(() => {
    let cancelled = false;
    fetchBalance()
      .then((b) => {
        if (cancelled) return;
        setBalance(b?.wallet?.available ?? null);
        // What is held right now is one chunk's worst case, not the run's ceiling.
        // Conflating the two is precisely what makes a balance look wrong to
        // somebody reading it: the ceiling is checked once, at the start.
        setReserved(b?.wallet?.reserved ?? 0);
      })
      .catch(() => {
        // Left null, which renders a dash. The meter is drawn against the run's
        // ceiling and does not need the balance to be meaningful.
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Skipped while loading and until there are rows, because the ranking is
  // only meaningful once something has been worked — a run at 3 rows would
  // otherwise render a "where the money went" panel from two attempts and
  // present it as a finding.
  React.useEffect(() => {
    if (!runId || loading || !supabase) {
      if (!rows.length) setExpensive([]);
      return;
    }

    let cancelled = false;

    const ranked = [...rows]
      .filter((r) => r.email || r.credits)
      .sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0))
      .slice(0, 8);

    if (ranked.length === 0) {
      setExpensive([]);
      return;
    }

    void (async () => {
      const out: Array<{ id: string; attempts: LeadAttempt[] }> = [];
      for (const r of ranked) {
        if (cancelled) return;
        const { data } = await supabase
          .from('lead_attempts')
          .select('*')
          .eq('row_id', r.id)
          .order('created_at', { ascending: true });
        out.push({ id: r.id, attempts: (data ?? []) as LeadAttempt[] });
      }
      if (!cancelled) setExpensive(out);
    })();

    // The chains the rows will be drawn against. Fetched here rather than passed
    // in because they belong to the run detail view, not to a component that
    // might be mounted for a clean run where two of the six steps are never used.
    void (async () => {
      const steps: LeadStep[] = ['company', 'person', 'email', 'verify', 'phone', 'enrich'];
      const settled = await Promise.all(steps.map((s) => getWaterfall(s)));
      if (cancelled) return;
      const orders: Partial<Record<LeadStep, string[]>> = {};
      settled.forEach((w, i) => {
        if (w.effectiveOrder.length) orders[steps[i]] = w.effectiveOrder;
      });
      setStepOrders(orders);
    })();

    return () => {
      cancelled = true;
    };
  }, [runId, rows, loading, supabase]);

  const doControl = async (action: 'pause' | 'resume' | 'cancel') => {
    try {
      await controlRun(runId!, action);
      const res = await getRun(runId!, { limit: 500, offset: 0 });
      if (res.ok) setRun(res.run);
    } catch {
      setNotice('That did not work. Try again in a moment.');
    }
  };

  // Bulk suppression. Addresses before domains, and the domains are dropped when
  // any address at that domain is also being suppressed — suppressing the company
  // as well is the same protection and one less row on a list the user then has
  // to maintain.
  const suppressRows = async (ids: string[]) => {
    const chosen = rows.filter((r) => ids.includes(r.id));
    const domains = new Set(chosen.map((r) => r.domain).filter(Boolean) as string[]);
    const values: string[] = [];

    for (const r of chosen) {
      if (r.email) {
        values.push(r.email);
        if (r.domain) domains.delete(r.domain);
      }
    }
    for (const d of domains) values.push(d);

    if (values.length === 0) {
      setNotice('Those rows have no address or domain to suppress.');
      return;
    }

    for (const v of values) await addSuppression(v, 'suppressed from a run');
    setNotice(
      `${values.length} ${values.length === 1 ? 'value' : 'values'} suppressed. They will not be looked up again.`,
    );
  };

  // Attempt history is fetched per expanded row rather than with the page.
  // One query, because the foreign key now exists.
//
// Before it did not — api_usage_id was uuid and api_usage.id is bigint, so the two
// could never reference each other — and every attempt had it null. That is why a
// refused call could not be shown: there was no row to carry its status, and no
// way to have found one. Two columns in api_usage exist for exactly this and
// neither was reachable from a lead.
const attemptsFor = React.useCallback(async (rowId: string): Promise<AttemptWithFailure[]> => {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('lead_attempts')
    .select('*, api_usage:api_usage_id(http_status, error_code)')
    .eq('row_id', rowId)
    .order('created_at', { ascending: true });

  if (error) {
    // Left to the caller's empty placeholder. A row that cannot show its history
    // says so; it does not claim to have none.
    console.warn('leads: attempt history unavailable', error.message);
    return [];
  }

  return ((data ?? []) as Array<AttemptWithFailure & { api_usage: { http_status: number | null; error_code: string | null } | null }>).map(
    (a) => ({
      ...a,
      // PostgREST returns the embed as an object or as null depending on whether
      // the FK was set. Both shapes have to flatten to the same thing, or half
      // the rows would show an error and half would not — which is worse than
      // showing neither.
      http_status: a.api_usage?.http_status ?? null,
      error_code: a.api_usage?.error_code ?? null,
      api_usage: undefined,
    }),
  );
}, []);

  if (!runId) {
    return <EmptyState title="No run selected" body="Pick a run from the list." />;
  }

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink onBack={onBack} />
        <div className="bg-white border border-line px-8 py-10">
          <p className="text-xs font-mono text-danger">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-5">
      <BackLink onBack={onBack} />

      {/* ---- Title ------------------------------------------------------- */}
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-lg font-medium text-ink truncate">
            {run?.name || (run?.target ? `${run.target} leads` : 'Run')}
          </h1>
          <p className="text-xs text-muted font-mono mt-1">
            {total.toLocaleString()} {total === 1 ? 'row' : 'rows'}
            {run?.target ? ` of ${run.target.toLocaleString()}` : ''}
            {run?.started_at ? ` · started ${ago(run.started_at)}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Shown because a table that stopped updating with no indication is
              indistinguishable from a run that stopped. */}
          <StatusPill
            tone={live ? 'ok' : 'outline'}
            dot={live ? 'pulse' : undefined}
            title={live ? 'Updating over a live connection' : 'Updating every few seconds'}
          >
            {live ? 'live' : 'polling'}
          </StatusPill>

          {run && <RunStrip status={run.status} pauseReason={run.pause_reason} />}

          <ExportMenu runId={runId} rowCount={total} />
        </div>
      </div>

      {/* ---- Pause ------------------------------------------------------- */}
      {run?.status === 'paused' && run.pause_reason && (
        <div className="flex items-start gap-2 px-4 py-3 bg-warn-bg border border-warn-line">
          <AlertTriangle className="w-3.5 h-3.5 text-warn mt-0.5 flex-shrink-0" />
          <p className="text-xs font-mono text-warn leading-relaxed">
            {run.pause_reason === 'credits'
              ? 'Out of credits for the worst case of this run. Top up and it will pick up where it stopped.'
              : run.pause_reason === 'provider_balance'
                ? 'The data provider is out of credit, so no lookups can run until it is topped up.'
                : run.pause_reason === 'importing'
                  ? 'Waiting for the rows to finish uploading. If the upload was interrupted, Resume works the rows that arrived.'
                  : run.pause_reason.replace(/_/g, ' ')}
          </p>
        </div>
      )}

      {/* ---- What it produced, and what it cost -------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-5">
        <div className="border border-line bg-white p-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-3">
            What it produced
          </span>
          <CompositionBar
            counts={statusCounts}
            notFound={statusCounts.not_found ?? 0}
            height={10}
          />
        </div>

        <div className="border border-line bg-white p-5 flex flex-col">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-3">
            What it cost
          </span>

          <div className="flex gap-8">
            <MeterFigure
              label="Spent"
              value={stats.credits}
              display={`${round2(stats.credits)} cr`}
              of={run?.max_credits ?? null}
              tone={run?.max_credits && stats.credits > run.max_credits ? 'warn' : 'default'}
              sub={providerUsd > 0 ? `${formatUsd(providerUsd, { decimals: 4 })} at providers` : undefined}
            />

            <MeterFigure
              label="Held now"
              value={reserved ?? 0}
              display={reserved === null ? '—' : `${round2(reserved)} cr`}
              tone={reserved !== null && reserved > 0 ? 'warn' : 'default'}
              sub="released as each batch finishes"
            />

            <MeterFigure
              label="Balance"
              value={balance ?? 0}
              display={balance === null ? '—' : `${Math.round(balance)} cr`}
              of={run?.max_credits ?? null}
              tone={
                balance !== null && run?.max_credits && balance < run.max_credits
                  ? 'warn'
                  : 'default'
              }
              sub={
                balance === null
                  ? 'not loaded'
                  : run?.max_credits
                    ? balance < run.max_credits
                      ? 'less than this run may still need'
                      : 'covers the worst case'
                    : undefined
              }
            />
          </div>

          {/* The sentence.
              We have reserved the worst case and settled down since the first
              migration and this screen has never said so. A user who watches
              credits leave their balance and is never told what happens next has
              every reason to think the worst, and this is the line that prevents
              it. It is the cheapest and most load-bearing sentence in the app. */}
          <p className="text-[10px] font-mono text-muted leading-relaxed mt-5 pt-3 border-t border-line-soft">
            {run?.max_credits
              ? `This run can cost at most ${round2(run.max_credits)} credits, and that figure is what was checked against your balance before it started. ` +
                `Each batch holds only what it might spend and returns the rest as it finishes, so the balance moves in steps rather than dropping all at once.`
              : 'Each batch holds only what it might spend and returns the rest as it finishes.'}
          </p>
        </div>
      </div>

      {notice && (
        <div className="flex items-start gap-2 px-4 py-2.5 bg-surface border border-line">
          <span className="text-xs font-mono text-ink-2 leading-relaxed">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="ml-auto text-muted hover:text-ink cursor-pointer flex-shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ---- Who actually did the work ----------------------------------- */}
      {mix.length > 0 && (
        <div className="border border-line bg-white p-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-1">
            Who found them
          </span>
          <p className="text-[11px] font-mono text-faint mb-4 leading-relaxed">
            Of the rows on this page. A provider high on this bar is earning its place in the
            waterfall; one at the end is costing money on every call it is asked about.
          </p>
          <ProviderMix mix={mix} />
        </div>
      )}

      {/* ---- Where the money went --------------------------------------- */}
      {expensive.some((e) => e.attempts.length > 1) && (
        <div className="border border-line bg-white p-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-1">
            Where the money went
          </span>
          <p className="text-[11px] font-mono text-faint mb-4 leading-relaxed">
            The rows that took the most providers to resolve. One dot lit cost the price of one
            lookup; four dots with the last one filled cost four.
          </p>
          <WaterfallColumn rows={expensive} fullOrders={stepOrders} limit={8} />
        </div>
      )}

      {/* ---- Controls ---------------------------------------------------- */}
      {run && isActiveRun(run.status) && (
        <div className="flex items-center gap-2">
          {run.status === 'paused' ? (
            <Button variant="secondary" onClick={() => void doControl('resume')}>
              <Play className="w-3 h-3" />
              Resume
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void doControl('pause')}>
              <Pause className="w-3 h-3" />
              Pause
            </Button>
          )}
          <Button variant="secondary" onClick={() => void doControl('cancel')}>
            <Square className="w-3 h-3" />
            Cancel run
          </Button>
          <span className="text-[10px] font-mono text-muted ml-1">
            Cancelling keeps every row it already found.
          </span>
        </div>
      )}

      <LeadsTable
        rows={rows}
        total={total}
        loading={loading}
        attemptsFor={attemptsFor}
        onBulk={async (action, ids) => {
          if (action === 'delete') return bulkAction(runId, ids, action);
          setReverifyIds(ids);
          return { ok: true, note: null };
        }}
        onSuppress={(ids) => void suppressRows(ids)}
      />

      {reverifyIds && (
        <CostDialog
          title={`Re-verify ${reverifyIds.length} addresses`}
          description="Checks each selected address again with the verifiers, as a new run. This run and its charges are not changed."
          getEstimate={() => bulkRowsEstimate(runId, reverifyIds, 'reverify')}
          start={(requestId) => bulkRowsStart(runId, reverifyIds, 'reverify', requestId)}
          onStarted={(id) => {
            setReverifyIds(null);
            onOpenRun(id);
          }}
          onClose={() => setReverifyIds(null)}
        />
      )}
    </div>
  );
};

const round2 = (n: number) => Math.round((n ?? 0) * 100) / 100;

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const BackLink: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <button
    onClick={onBack}
    className="inline-flex items-center gap-1.5 text-xs font-mono text-muted hover:text-ink transition-colors cursor-pointer"
  >
    <ArrowLeft className="w-3 h-3" />
    Runs
  </button>
);

