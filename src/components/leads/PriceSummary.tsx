/**
 * Echo Leads — unified price summary component
 * ---------------------------------------------------------------------------
 * Displays pricing figures (expected, maximum, wallet coverage, rows, caps)
 * in one consistent format across the entire Leads module.
 *
 * It never decides anything: confirmation and blocking logic stay in the caller.
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatCredits } from '../../lib/billing';

export interface PriceSummaryProps {
  /** Expected credits to be charged */
  expected: number;
  /** Maximum worst-case credits that will be reserved */
  max: number;
  /** Available wallet credits, if known */
  available?: number | null;
  /** Number of rows or leads being worked, if applicable */
  rows?: number | null;
  /** Explanatory note or charging terms */
  note?: React.ReactNode;
  /** Cap per run limit in credits, if configured */
  capPerRun?: number | null;
  /** Optional detailed breakdown of cost items */
  breakdown?: Array<{ label: string; credits: number; note?: string }>;
  /** Optional action slot (e.g. submit or clean button) */
  action?: React.ReactNode;
  /** Additional CSS class names */
  className?: string;
}

export const PriceSummary: React.FC<PriceSummaryProps> = ({
  expected,
  max,
  available,
  rows,
  note,
  capPerRun,
  breakdown,
  action,
  className = '',
}) => {
  const hasAvailable = available !== undefined && available !== null && Number.isFinite(available);
  const isShort = hasAvailable && (available as number) < max;
  const isOverCap =
    capPerRun !== undefined &&
    capPerRun !== null &&
    capPerRun > 0 &&
    max > capPerRun;

  const span = Math.max(max, expected, 1);
  const expectedPct = Math.min(100, Math.max(0, (expected / span) * 100));
  const coveredPct = hasAvailable ? Math.min(100, Math.max(0, ((available as number) / span) * 100)) : null;

  // Determine grid columns dynamically based on which optional cells are present
  const cells: Array<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'bad' | 'warn' | 'ok' }> = [
    { label: 'Expected', value: `${formatCredits(expected)} cr` },
    { label: 'At most', value: `${formatCredits(max)} cr` },
  ];

  if (hasAvailable) {
    cells.push({
      label: 'Available',
      value: `${formatCredits(available as number)} cr`,
      tone: isShort ? 'bad' : undefined,
    });
  }

  if (rows !== undefined && rows !== null) {
    cells.push({
      label: 'Rows',
      value: rows.toLocaleString(),
    });
  }

  if (capPerRun !== undefined && capPerRun !== null && capPerRun > 0) {
    cells.push({
      label: 'Cap / run',
      value: `${formatCredits(capPerRun)} cr`,
      tone: isOverCap ? 'warn' : undefined,
    });
  }

  return (
    <div className={`border border-line bg-white ${className}`}>
      {/* Grid of figures */}
      <div
        className={`grid divide-line-soft ${
          cells.length >= 4
            ? 'grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0'
            : cells.length === 3
              ? 'grid-cols-3 divide-x'
              : 'grid-cols-2 divide-x'
        }`}
      >
        {cells.map((c, i) => (
          <Cell key={i} label={c.label} value={c.value} sub={c.sub} tone={c.tone} />
        ))}
      </div>

      {/* Visual worst-case track */}
      {max > 0 && (
        <div className="px-3.5 py-2.5 border-t border-line-soft space-y-1.5">
          <div className="relative h-1.5 w-full bg-line-soft overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-ink transition-[width] duration-300"
              style={{ width: `${expectedPct}%` }}
            />
            {coveredPct !== null && coveredPct < 100 && (
              <div
                className="absolute inset-y-0 border-r-2 border-warn"
                style={{ left: `${coveredPct}%` }}
                title={`Wallet balance covers ${Math.round(coveredPct)}% of the maximum`}
              />
            )}
          </div>
          <div className="flex justify-between items-center text-[10px] font-mono text-muted">
            <span>likely {Math.round(expectedPct)}% of the worst case</span>
            {coveredPct !== null && (
              <span className={coveredPct < 100 ? 'text-warn font-medium' : 'text-ok'}>
                {coveredPct < 100
                  ? `balance covers ${Math.round(coveredPct)}%`
                  : 'balance covers 100%'}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Breakdown list */}
      {breakdown && breakdown.length > 0 && (
        <ul className="border-t border-line-soft px-3.5 py-2 space-y-1 bg-surface-2">
          {breakdown.map((b) => (
            <li key={b.label} className="flex justify-between gap-3 text-[11px] font-mono text-ink-2">
              <span>
                {b.label}
                {b.note && <span className="text-muted"> · {b.note}</span>}
              </span>
              <span className="tabular-nums font-medium">{formatCredits(b.credits)} cr</span>
            </li>
          ))}
        </ul>
      )}

      {/* Balance shortage warning */}
      {isShort && (
        <div className="border-t border-line-soft px-3.5 py-2.5 bg-warn-bg text-warn border-warn-line flex items-start gap-2 text-xs font-mono">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>
            The balance does not cover the maximum ({formatCredits(max)} credits).{' '}
            <a href="#dashboard/billing" className="underline font-medium hover:text-ink">
              Top up
            </a>{' '}
            or select fewer.
          </span>
        </div>
      )}

      {/* Over cap-per-run warning */}
      {isOverCap && (
        <div className="border-t border-line-soft px-3.5 py-2.5 bg-warn-bg text-warn border-warn-line flex items-start gap-2 text-xs font-mono">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>
            That is over the cap per run ({formatCredits(capPerRun as number)} credits), so a run this size will be refused. Raise the cap or lower the number of people.
          </span>
        </div>
      )}

      {/* Explanatory note */}
      {note && (
        <div className="border-t border-line-soft px-3.5 py-2 text-[11px] font-mono text-muted leading-relaxed">
          {note}
        </div>
      )}

      {/* Optional action slot */}
      {action && (
        <div className="border-t border-line-soft px-3.5 py-2.5 bg-surface-2 flex items-center justify-end">
          {action}
        </div>
      )}
    </div>
  );
};

const Cell: React.FC<{
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'bad' | 'warn' | 'ok';
}> = ({ label, value, sub, tone }) => (
  <div className="px-3.5 py-2.5 min-w-0">
    <div className="text-[10px] font-mono uppercase tracking-wider text-muted truncate">{label}</div>
    <div
      className={`text-sm sm:text-base font-mono font-medium tabular-nums truncate ${
        tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-ink'
      }`}
    >
      {value}
    </div>
    {sub && <div className="text-[10px] font-mono text-muted truncate mt-0.5">{sub}</div>}
  </div>
);
