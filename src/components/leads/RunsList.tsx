import React from 'react';
import { ChevronRight, ListChecks, Plus } from 'lucide-react';
import type { LeadRun } from '../../types';
import { listRuns, isActiveRun } from '../../lib/leads';
import { formatUsd } from '../../lib/billing';
import { RunStatusPill } from './StatusBadge';
import { Screen, Panel, Button, Figure } from './Screen';
import { RowSkeleton } from './Empty';
import { EmptyState } from './Empty';

/**
 * Every run, and what it added up to.
 *
 * This was a 44px strip per run at the top of an otherwise empty page, with the
 * counters set small and left-aligned so that at a wide viewport one card
 * stretched across 1600px of which 1400 was nothing. Three things changed.
 *
 * The card grew, because a run's whole story is a name, a rate of progress and
 * four numbers, and squeezing that into one 44px row is what made it unreadable.
 * It now has room for the progress, which was previously invisible even on a
 * running run — the one thing a person watching a run actually wants.
 *
 * The figures got bigger. At text-base a count of 4 and a credit figure of 46
 * were the same visual weight as the labels above them, and the labels are not
 * the information.
 *
 * And the list gained a summary above it, because fifty runs each carrying four
 * counters is a list to scan but not a number to read, and "how much have I spent
 * on this" is the first question anybody asks and was answerable only by adding
 * fifty numbers up by hand.
 */

interface RunsListProps {
  onOpenRun: (runId: string) => void;
  onNewSearch: () => void;
  initialRuns?: LeadRun[] | null;
  headerSlot?: React.ReactNode;
}

const KIND_LABEL: Record<LeadRun['kind'], string> = {
  find: 'Search',
  clean: 'Clean',
  lab: 'Lab',
};

export const RunsList: React.FC<RunsListProps> = ({ onOpenRun, onNewSearch, initialRuns, headerSlot }) => {
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
        setError((err as Error)?.message ?? 'Could not load your runs.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialRuns]);

  // Refresh only while something is in flight, and stop the moment everything is
  // finished. A list that polls forever is a list that never lets a laptop sleep.
  React.useEffect(() => {
    if (!runs?.some((r) => isActiveRun(r.status))) return;
    const timer = setInterval(() => {
      listRuns(50)
        .then(setRuns)
        .catch(() => {
          /* keep what is on screen */
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [runs]);

  const totals = React.useMemo(() => {
    let found = 0;
    let verified = 0;
    let catchAll = 0;
    let credits = 0;
    let active = 0;
    for (const r of runs ?? []) {
      const c = (r.counters ?? {}) as Record<string, number | undefined>;
      found += c.found ?? 0;
      verified += c.verified ?? 0;
      catchAll += c.catch_all ?? 0;
      credits += r.charged_credits ?? 0;
      if (isActiveRun(r.status)) active++;
    }
    return { found, verified, catchAll, credits, active };
  }, [runs]);

  if (error) {
    return (
      <Screen title="Runs" icon={<ListChecks className="w-4 h-4" />}>
        <div className="bg-white border border-line px-8 py-10">
          <p className="text-xs font-mono text-danger-strong">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 text-[10px] font-mono text-muted hover:text-ink underline cursor-pointer"
          >
            Try again
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      title="Runs"
      subtitle={
        loading
          ? 'Every search and clean you have run.'
          : runs && runs.length > 0
            ? `Every search and clean you have run. ${runs.length} so far.`
            : 'Every search and clean you have run.'
      }
      icon={<ListChecks className="w-4 h-4" />}
      action={<Button onClick={onNewSearch}><Plus className="w-3.5 h-3.5" />New search</Button>}
    >
      {headerSlot}
      {loading ? (
        <div className="border border-line bg-white">
          {[0, 1, 2].map((i) => (
            <RowSkeleton key={i} />
          ))}
        </div>
      ) : !runs || runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          body="Describe who buys from you and Echo finds them. Or start from a list you already have."
          action={{ label: 'New search', onClick: onNewSearch }}
        />
      ) : (
        <>
          {/* The number, rather than fifty of them stacked up. */}
          <Panel label="Across every run">
            <div className="flex gap-10 sm:gap-14 flex-wrap">
              <Figure label="Leads found" value={totals.found.toLocaleString()} size="sm" />
              <Figure
                label="Verified"
                value={totals.verified.toLocaleString()}
                size="sm"
                tone={totals.verified > 0 ? 'good' : 'default'}
              />
              <Figure
                label="Catch-all"
                value={totals.catchAll.toLocaleString()}
                size="sm"
                tone={totals.catchAll > 0 ? 'warn' : 'default'}
              />
              <Figure
                label="Credits spent"
                value={Math.round(totals.credits * 100) / 100}
                size="sm"
                sub={formatUsd(totals.credits)}
              />
              {totals.active > 0 && (
                <Figure
                  label="Running now"
                  value={totals.active}
                  size="sm"
                  tone="good"
                  sub="watch them fill in"
                />
              )}
            </div>
          </Panel>

          <div className="space-y-3">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} onOpen={() => onOpenRun(run.id)} />
            ))}
          </div>
        </>
      )}
    </Screen>
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
  const target = run.target ?? 0;

  // Progress against the target, but never past it. A run that found more rows
  // than it was aimed at — a refind landing several people at one company — would
  // otherwise draw a bar running off the end of the track, which reads as a bug.
  const pct = target > 0 ? Math.min(100, (found / target) * 100) : 0;
  const running = isActiveRun(run.status);

  return (
    <button
      onClick={onOpen}
      className="w-full text-left bg-white border border-line hover:border-faint transition-colors cursor-pointer group"
    >
      <div className="px-5 pt-4 pb-3">
        {/* Title line */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted flex-shrink-0">
            {KIND_LABEL[run.kind]}
          </span>
          <span className="text-sm font-medium text-ink truncate min-w-0">{run.name || 'Run'}</span>

          {run.mode && (
            <span className="text-[10px] font-mono text-faint hidden sm:inline flex-shrink-0">
              {run.mode.replace(/_/g, ' ')}
            </span>
          )}

          <div className="ml-auto flex items-center gap-3 flex-shrink-0">
            <RunStatusPill status={run.status} pauseReason={run.pause_reason} />
            <span className="text-[10px] font-mono text-muted tabular-nums w-16 text-right">
              {when(run)}
            </span>
            <ChevronRight className="w-3.5 h-3.5 text-line-strong group-hover:text-muted transition-colors" />
          </div>
        </div>

        {/* Progress. Only where there is a target to be a percentage of, and only
            while it means something: a finished run's bar is always full and says
            nothing, so it is not drawn. */}
        {target > 0 && (running || pct < 100) && (
          <div className="mt-3">
            <div className="h-1 w-full bg-line-soft">
              <div
                className={`h-full transition-[width] duration-700 ${running ? 'bg-ok' : 'bg-muted'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {/* Pause reason, where there is one. "top up to continue" is the single
            most useful thing on this card and it used to need a click. */}
        {run.status === 'paused' && run.pause_reason && (
          <p className="text-[10px] font-mono text-warn mt-2.5">
            {run.pause_reason === 'credits'
              ? 'Out of credits — top up to continue.'
              : run.pause_reason === 'provider_balance'
                ? 'The data provider is out of credit.'
                : run.pause_reason.replace(/_/g, ' ')}
          </p>
        )}
      </div>

      {/* Counters. Below a hairline so the numbers are a separate thing from the
          title rather than floating in the middle of the card. */}
      <div className="px-5 py-3 border-t border-line-soft flex items-baseline gap-8 flex-wrap">
        <Stat label="Rows" value={found} />
        <Stat label="Verified" value={verified} tone={verified > 0 ? 'good' : undefined} />
        <Stat label="Catch-all" value={catchAll} tone={catchAll > 0 ? 'warn' : undefined} />
        <Stat label="Credits" value={Math.round((run.charged_credits ?? 0) * 100) / 100} />
        <Stat
          label={target > 0 ? 'Of target' : 'Target'}
          value={target > 0 ? `${found} / ${target}` : '—'}
          muted
        />
      </div>
    </button>
  );
};

/** Smaller than Figure: these are four in a row and they are not the headline. */
const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: 'good' | 'warn'; muted?: boolean }> = ({
  label,
  value,
  tone,
  muted,
}) => (
  <div className="flex items-baseline gap-1.5">
    <span className="text-[10px] font-mono uppercase tracking-wider text-muted">{label}</span>
    <span
      className={`text-xs font-mono tabular-nums ${
        tone === 'good' ? 'text-ok' : tone === 'warn' ? 'text-warn' : muted ? 'text-faint' : 'text-ink'
      }`}
    >
      {value}
    </span>
  </div>
);

/** Coarse: "2h ago" is more use in a list than a timestamp nobody reads. */
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