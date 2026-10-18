import React from 'react';
import {
  ListChecks, Plus, Search, FlaskConical, ShieldOff, ArrowLeft,
  AlertTriangle, Play, Pause, Square, X,
} from 'lucide-react';
import type { LeadsView, LeadRow, LeadRun, LeadAttempt } from '../../types';
import {
  getRun, bulkAction, isActiveRun, controlRun, addSuppression,
} from '../../lib/leads';
import { fetchBalance } from '../../lib/billing';
import { supabase } from '../../lib/supabase';
import { subscribeToRun, mergeRow, summarise } from '../../lib/leads-live';
import { RunsList } from '../leads/RunsList';
import { CleanList } from '../leads/CleanList';
import { NewSearch } from '../leads/NewSearch';
import { ProviderLab } from '../leads/ProviderLab';
import { OptOuts } from '../leads/OptOuts';
import { LeadsTable } from '../leads/LeadsTable';
import { CompositionBar, RunStrip, MeterFigure } from '../leads/Data';
import { WaterfallColumn } from '../leads/WaterfallChain';
import { Button } from '../leads/Screen';
import { EmptyState } from '../leads/Empty';
import { ExportMenu } from '../leads/ExportMenu';

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
      />
    );
  }

  return (
    <div className="space-y-6">
      <SubNav view={view} onViewChange={onViewChange} />

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

const SUB_NAV: Array<{ view: LeadsView; label: string; icon: React.ReactNode }> = [
  { view: 'runs', label: 'Runs', icon: <ListChecks className="w-3.5 h-3.5" /> },
  { view: 'new', label: 'New search', icon: <Plus className="w-3.5 h-3.5" /> },
  { view: 'clean', label: 'Clean a list', icon: <Search className="w-3.5 h-3.5" /> },
  { view: 'lab', label: 'Provider lab', icon: <FlaskConical className="w-3.5 h-3.5" /> },
  { view: 'optouts', label: 'Opt-outs', icon: <ShieldOff className="w-3.5 h-3.5" /> },
];

const SubNav: React.FC<{ view: LeadsView; onViewChange: (v: LeadsView) => void }> = ({
  view,
  onViewChange,
}) => (
  <div className="flex items-center gap-1 border-b border-[#e3e3de] -mt-2">
    {SUB_NAV.map((item) => {
      const active = view === item.view;
      return (
        <button
          key={item.view}
          onClick={() => onViewChange(item.view)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono transition-colors cursor-pointer border-b-2 -mb-px ${
            active
              ? 'border-[#141414] text-[#141414] font-medium'
              : 'border-transparent text-[#8a8a86] hover:text-[#141414]'
          }`}
        >
          {item.icon}
          {item.label}
        </button>
      );
    })}
  </div>
);

// ---------------------------------------------------------------------------
// One run — the table, live
// ---------------------------------------------------------------------------

const RunView: React.FC<{ runId: string | null; onBack: () => void }> = ({ runId, onBack }) => {
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
  const [notice, setNotice] = React.useState<string | null>(null);

  // The eight rows that cost the most to resolve, with their attempt history.
  //
  // Eight and not fifty: this panel makes one extra query per row, and a panel
  // that fetches fifty is a panel nobody opens twice. Eight is enough for the
  // shape to read and cheap enough to fetch on every load.
  const [expensive, setExpensive] = React.useState<Array<{ id: string; attempts: LeadAttempt[] }>>([]);

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

  const stats = React.useMemo(() => summarise(rows), [rows]);

  // Status counts for the composition bar, straight off the rows on screen rather
  // than off the run's denormalised counters. During a run the row list is the
  // thing being looked at, and the counters are written a chunk at a time, so the
  // two disagree for minutes at a time and the bar would lag the table beside it.
  const statusCounts = React.useMemo(() => {
    const out: Record<string, number> = {
      verified: 0, catch_all: 0, invalid: 0, unknown: 0, not_found: 0,
    };
    for (const r of rows) out[r.email_status] = (out[r.email_status] ?? 0) + 1;
    return out;
  }, [rows]);

  // Fetched once. Polling the wallet every three seconds alongside the run would
  // be a second realtime channel for a number that changes only when the run
  // spends something, and the run's own figures already show that.
  React.useEffect(() => {
    let cancelled = false;
    fetchBalance()
      .then((b) => {
        if (!cancelled) setBalance(b?.wallet?.available ?? null);
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
  const attemptsFor = React.useCallback(async (rowId: string): Promise<LeadAttempt[]> => {
    if (!supabase) return [];
    const { data } = await supabase
      .from('lead_attempts')
      .select('*')
      .eq('row_id', rowId)
      .order('created_at', { ascending: true });
    return (data ?? []) as LeadAttempt[];
  }, []);

  if (!runId) {
    return <EmptyState title="No run selected" body="Pick a run from the list." />;
  }

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink onBack={onBack} />
        <div className="bg-white border border-[#e3e3de] px-8 py-10">
          <p className="text-xs font-mono text-[#c0462e]">{error}</p>
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
          <h1 className="text-lg font-medium text-[#141414] truncate">
            {run?.name || (run?.target ? `${run.target} leads` : 'Run')}
          </h1>
          <p className="text-xs text-[#8a8a86] font-mono mt-1">
            {total.toLocaleString()} {total === 1 ? 'row' : 'rows'}
            {run?.target ? ` of ${run.target.toLocaleString()}` : ''}
            {run?.started_at ? ` · started ${ago(run.started_at)}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Shown because a table that stopped updating with no indication is
              indistinguishable from a run that stopped. */}
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 border ${
              live
                ? 'text-emerald-700 border-emerald-200 bg-emerald-50'
                : 'text-[#8a8a86] border-[#e3e3de]'
            }`}
            title={live ? 'Updating over a live connection' : 'Updating every few seconds'}
          >
            {live ? 'live' : 'polling'}
          </span>

          {run && <RunStrip status={run.status} pauseReason={run.pause_reason} />}

          <ExportMenu runId={runId} rowCount={total} />
        </div>
      </div>

      {/* ---- Pause ------------------------------------------------------- */}
      {run?.status === 'paused' && run.pause_reason && (
        <div className="flex items-start gap-2 px-4 py-3 bg-[#fdf6ec] border border-[#e8d9bd]">
          <AlertTriangle className="w-3.5 h-3.5 text-[#b45309] mt-0.5 flex-shrink-0" />
          <p className="text-xs font-mono text-[#b45309] leading-relaxed">
            {run.pause_reason === 'credits'
              ? 'Out of credits for the worst case of this run. Top up and it will pick up where it stopped.'
              : run.pause_reason === 'provider_balance'
                ? 'The data provider is out of credit, so no lookups can run until it is topped up.'
                : run.pause_reason.replace(/_/g, ' ')}
          </p>
        </div>
      )}

      {/* ---- What it produced, and what it cost -------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-5">
        <div className="border border-[#e3e3de] bg-white p-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block mb-3">
            What it produced
          </span>
          <CompositionBar
            counts={statusCounts}
            notFound={statusCounts.not_found ?? 0}
            height={10}
          />
        </div>

        <div className="border border-[#e3e3de] bg-white p-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block mb-3">
            What it cost
          </span>
          <div className="flex gap-8">
            <MeterFigure
              label="Spent"
              value={stats.credits}
              display={round2(stats.credits)}
              of={run?.max_credits ?? null}
              tone={
                run?.max_credits && stats.credits > run.max_credits ? 'warn' : 'default'
              }
              sub={run?.max_credits ? `of ${round2(run.max_credits)} at most` : undefined}
            />
            <MeterFigure
              label="Balance"
              value={balance ?? 0}
              display={balance === null ? '—' : Math.round(balance)}
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
        </div>
      </div>

      {notice && (
        <div className="flex items-start gap-2 px-4 py-2.5 bg-[#f6f6f4] border border-[#e3e3de]">
          <span className="text-xs font-mono text-[#4a4a47] leading-relaxed">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="ml-auto text-[#8a8a86] hover:text-[#141414] cursor-pointer flex-shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ---- Where the money went --------------------------------------- */}
      {expensive.some((e) => e.attempts.length > 1) && (
        <div className="border border-[#e3e3de] bg-white p-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block mb-1">
            Where the money went
          </span>
          <p className="text-[11px] font-mono text-[#b5b5ad] mb-4 leading-relaxed">
            The rows that took the most providers to resolve. One dot lit cost the price of one
            lookup; four dots with the last one filled cost four.
          </p>
          <WaterfallColumn rows={expensive} limit={8} />
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
          <span className="text-[10px] font-mono text-[#8a8a86] ml-1">
            Cancelling keeps every row it already found.
          </span>
        </div>
      )}

      <LeadsTable
        rows={rows}
        total={total}
        loading={loading}
        attemptsFor={attemptsFor}
        onBulk={(action, ids) => bulkAction(runId, ids, action)}
        onSuppress={(ids) => void suppressRows(ids)}
      />
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
    className="inline-flex items-center gap-1.5 text-xs font-mono text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer"
  >
    <ArrowLeft className="w-3 h-3" />
    Runs
  </button>
);

