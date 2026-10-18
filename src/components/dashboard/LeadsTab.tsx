import React from 'react';
import { ListChecks, Plus, Search, FlaskConical, ShieldOff, ArrowLeft } from 'lucide-react';
import type { LeadsView, LeadRow, LeadRun, LeadAttempt } from '../../types';
import { getRun } from '../../lib/leads';
import { supabase } from '../../lib/supabase';
import { subscribeToRun, mergeRow, summarise } from '../../lib/leads-live';
import { RunsList } from '../leads/RunsList';
import { CleanList } from '../leads/CleanList';
import { NewSearch } from '../leads/NewSearch';
import { ProviderLab } from '../leads/ProviderLab';
import { OptOuts } from '../leads/OptOuts';
import { LeadsTable } from '../leads/LeadsTable';
import { RunStatusPill } from '../leads/StatusBadge';
import { CreditsMeter, Counter } from '../leads/CreditsMeter';
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
    <div className="space-y-4">
      <BackLink onBack={onBack} />

      {/* Header */}
      <div className="bg-white border border-[#e3e3de] px-4 py-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-bold tracking-tight text-[#141414] truncate">
              {run?.name || (run?.target ? `${run.target} leads` : 'Run')}
            </h2>
            <span className="text-[10px] font-mono text-[#8a8a86]">
              {total} {total === 1 ? 'row' : 'rows'}
              {run?.target ? ` of ${run.target}` : ''}
            </span>
          </div>

          {run && (
            <RunStatusPill
              status={run.status}
              pauseReason={run.pause_reason}
              done={stats.found}
              target={run.target}
            />
          )}

          {/* Live or polling. Shown because a table that stopped updating with
              no indication is indistinguishable from a run that stopped. */}
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 border rounded-none ${
              live ? 'text-emerald-700 border-emerald-200 bg-emerald-50' : 'text-[#8a8a86] border-[#e3e3de]'
            }`}
            title={live ? 'Updating over a live connection' : 'Updating every few seconds'}
          >
            {live ? 'live' : 'polling'}
          </span>

          <div className="ml-auto flex items-center gap-6">
        <ExportMenu runId={runId} rowCount={total} />
            <Counter label="Found" value={stats.found} />
            <Counter label="Verified" value={stats.verified} tone={stats.verified ? 'good' : 'default'} />
            <Counter label="Catch-all" value={stats.catchAll} tone={stats.catchAll ? 'warn' : 'default'} />
            <Counter label="Spent" value={Math.round(stats.credits * 100) / 100} />
            <CreditsMeter balance={1000} runMax={run?.max_credits ?? null} compact />
          </div>
        </div>

        {run?.status === 'paused' && run.pause_reason && (
          <p className="text-[10px] font-mono text-[#b5801f] mt-2 pt-2 border-t border-[#eeeeea]">
            Paused: {run.pause_reason === 'credits'
              ? 'out of credits for the worst case. Top up and resume.'
              : run.pause_reason.replace(/_/g, ' ')}
          </p>
        )}
      </div>

      <LeadsTable rows={rows} total={total} loading={loading} attemptsFor={attemptsFor} />
    </div>
  );
};

const BackLink: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <button
    onClick={onBack}
    className="inline-flex items-center gap-1.5 text-xs font-mono text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer"
  >
    <ArrowLeft className="w-3 h-3" />
    Runs
  </button>
);

