import React from 'react';
import type { LeadEmailStatus, LeadRunStatus } from '../../types';
import { emailStatusLabel, isActiveRun } from '../../lib/leads';

/**
 * The five email states, which answer two different questions.
 *
 * "Was an address found?" and "can it be trusted?" are separate, and collapsing
 * them is how a table ends up showing a green tick next to something nobody ever
 * verified. `not_found` is deliberately the quietest of the five: nothing was
 * found and nothing was charged, which is a normal outcome, not a failure. And
 * `invalid` is the loudest, because it is the only one worth retrying.
 *
 * Catch-all carries its explanation in the tooltip rather than needing a second
 * word on screen, because the badge is 100px wide and the row is 44px tall.
 */
export const StatusBadge: React.FC<{
  status: LeadEmailStatus;
  credits?: number;
}> = ({ status }) => {
  const { label, className, title } = emailStatusLabel(status);

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider rounded-none whitespace-nowrap ${className}`}
      title={title}
    >
      {label}
    </span>
  );
};

/**
 * Run state, worded for the user rather than for the database.
 *
 * `paused` is called out separately from `running` because the two need opposite
 * actions and opposite feelings: a paused run is usually waiting on the user, and
 * the reason travels with the pill so nobody has to go looking.
 */
export const RunStatusPill: React.FC<{
  status: LeadRunStatus;
  pauseReason?: string | null;
  done?: number;
  target?: number | null;
}> = ({ status, pauseReason, done, target }) => {
  const active = isActiveRun(status);

  const label =
    status === 'running' && target
      ? `running · ${done ?? 0} of ${target}`
      : status;

  const tone =
    status === 'done'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
      : status === 'paused'
        ? 'bg-[#f8eedb] text-[#b5801f] border-[#f0e0bd]'
        : status === 'failed'
          ? 'bg-[#f8e4df] text-[#c0462e] border-[#f2d6cf]'
          : status === 'cancelled'
            ? 'bg-[#eeeeea] text-[#8a8a86] border-[#e3e3de]'
            : 'bg-white text-[#4a4a47] border-[#e3e3de]';

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border rounded-none whitespace-nowrap ${tone}`}
      title={pauseReason ? `Paused: ${pauseReason.replace(/_/g, ' ')}` : undefined}
    >
      {active && (
        <span
          className={`w-1.5 h-1.5 rounded-full ${status === 'paused' ? 'bg-[#b5801f]' : 'bg-emerald-500 animate-pulse'}`}
          aria-hidden="true"
        />
      )}
      {label}
    </span>
  );
};

/**
 * Credits on a row, and what they were spent on.
 *
 * "0" is shown as "no charge" rather than as a zero, because the difference
 * between "this cost nothing" and "this row has not been worked yet" is the
 * difference between a free miss and an unfinished job.
 */
export const CreditsCell: React.FC<{ credits: number; worked: boolean }> = ({
  credits,
  worked,
}) => {
  if (!worked) return <span className="text-[#b5b5ad] text-[10px] font-mono">—</span>;
  if (credits <= 0) return <span className="text-[#8a8a86] text-[10px] font-mono">no charge</span>;

  return (
    <span className="text-[10px] font-mono tabular-nums text-[#4a4a47]">
      {Number.isInteger(credits) ? credits : credits.toFixed(2)}
    </span>
  );
};
