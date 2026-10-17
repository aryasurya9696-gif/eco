import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { LeadRun } from '../../types';
import { listRuns, isActiveRun } from '../../lib/leads';
import { useAuth } from '../../context/AuthContext';
import { RunStatusPill } from './StatusBadge';
import { Counter } from './CreditsMeter';
import { EmptyState, RowSkeleton } from './EmptyPanel';

/**
 * The run list — the first thing you see when you open Leads.
 *
 * Everything on it comes from one place. `listRuns` reads `lead_runs`, whose
 * `counters` column is denormalised precisely so this screen does not have to
 * aggregate thousands of rows on every load, and so the sidebar badge and this
 * list cannot disagree about how much is running.
 */

interface RunsListProps {
  onOpenRun: (runId: string) => void;
  onNewSearch: () => void;
  /** Set when the parent already knows the count, to skip the first fetch. */
  initialRuns?: LeadRun[] | null;
}

const KIND_LABEL: Record<LeadRun['kind'], string> = {
  find: 'Find',
  clean: 'Clean a list',
  lab: 'Provider lab',
};

export const RunsList: React.FC<RunsListProps> = ({ onOpenRun, onNewSearch, initialRuns }) => {
  const { user } = useAuth();
  const [runs, setRuns] = React.useState<LeadRun[] | null>(initialRuns ?? null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(initialRuns ? false : true);

  React.useEffect(() => {
    if (initialRuns) return;
    let cancelled = false;

    listRuns(50)
      .then((r) => {
        if (!cancelled) {
          setRuns(r);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // Stated plainly. An empty list and a failed load look identical on
        // screen, and the first one invites the user to think they have no runs.
        setError((err as Error)?.message ?? 'Could not load your runs.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialRuns]);

  // Refresh while something is in flight, so a run started from the New search
  // screen appears here without a reload. Stopped as soon as everything is
  // finished rather than polling forever.
  React.useEffect(() => {
    if (!runs || !runs.some((r) => isActiveRun(r.status))) return;
    if (!user) return;

    const timer = setInterval(() => {
      listRuns(50)
        .then(setRuns)
        .catch(() => {
          /* keep what is on screen */
        });
    }, 5000);

    return () => clearInterval(timer);
  }, [runs, user]);

  if (error) {
    return (
      <div className="bg-white border border-[#e3e3de] px-8 py-10">
        <p className="text-xs font-mono text-[#c0462e]">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-3 text-[10px] font-mono text-[#8a8a86] hover:text-[#141414] underline cursor-pointer"
        >
          Try again
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-white border border-[#e3e3de]">
        {[0, 1, 2].map((i) => (
          <RowSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        body="Describe who buys from you and Echo finds them."
        action={{ label: 'New search', onClick: onNewSearch }}
      />
    );
  }

  return (
    <div className="space-y-px">
      {runs.map((run) => (
        <RunCard key={run.id} run={run} onOpen={() => onOpenRun(run.id)} />
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

const RunCard: React.FC<{ run: LeadRun; onOpen: () => void }> = ({ run, onOpen }) => {
  const c = (run.counters ?? {}) as Record<string, number | undefined>;
  const found = c.found ?? 0;
  const verified = c.verified ?? 0;
  const catchAll = c.catch_all ?? 0;

  return (
    <button
      onClick={onOpen}
      className="w-full bg-white border border-[#e3e3de] hover:border-[#b5b5ad] transition-colors cursor-pointer text-left"
    >
      {/* Row 1 — 44px, matching the table rows below it in the detail view. */}
      <div className="flex items-center gap-3 h-11 px-4">
        <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] w-16 shrink-0">
          {KIND_LABEL[run.kind]}
        </span>

        <span className="text-xs font-medium text-[#141414] truncate flex-1 min-w-0">
          {run.name || (run.target ? `${run.target} leads` : 'Run')}
        </span>

        <RunStatusPill status={run.status} pauseReason={run.pause_reason} />

        <span className="text-[10px] font-mono text-[#8a8a86] tabular-nums w-20 text-right shrink-0">
          {when(run)}
        </span>

        <ChevronRight className="w-3.5 h-3.5 text-[#b5b5ad] shrink-0" />
      </div>

      {/* Row 2 — the numbers. Below the fold of the 44px row, so the list stays
          scannable and every card is the same height whether it is running or
          finished. */}
      <div className="flex items-center gap-6 px-4 pb-3 pt-1 border-t border-[#eeeeea]">
        <Counter label="Found" value={found} tone={found ? 'default' : 'default'} />
        <Counter label="Verified" value={verified} tone={verified ? 'good' : 'default'} />
        <Counter label="Catch-all" value={catchAll} tone={catchAll ? 'warn' : 'default'} />
        <Counter
          label="Credits"
          value={round2(run.charged_credits)}
          title={run.max_credits ? `Maximum was ${round2(run.max_credits)}` : undefined}
        />

        {run.status === 'paused' && run.pause_reason && (
          <span className="ml-auto text-[10px] font-mono text-[#b5801f]">
            {run.pause_reason === 'credits'
              ? 'top up to continue'
              : run.pause_reason.replace(/_/g, ' ')}
          </span>
        )}
      </div>
    </button>
  );
};

/** Coarse by design: "2h ago" is more use in a list than a timestamp nobody reads. */
function when(run: LeadRun): string {
  const iso = run.finished_at ?? run.created_at;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';

  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const round2 = (n: number): number => Math.round((n ?? 0) * 100) / 100;
