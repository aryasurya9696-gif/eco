import React from 'react';
import { formatUsd } from '../../lib/billing';

/**
 * Credits left, as a number that ticks down while a run is spending them.
 *
 * Tabular figures throughout, because a number that changes width every second
 * makes the whole header twitch and the eye reads the movement instead of the
 * value.
 *
 * The bar is against the run's maximum, not its estimate. The estimate is what
 * will probably happen and the maximum is the ceiling the wallet is checked
 * against, so a bar drawn to the estimate would look full right up until the
 * moment it could not be paid for.
 */
export const CreditsMeter: React.FC<{
  balance: number;
  /** The most this run could cost. Optional: without it the bar is hidden. */
  runMax?: number | null;
  compact?: boolean;
}> = ({ balance, runMax, compact = false }) => {
  const ratio =
    runMax && runMax > 0 ? Math.max(0, Math.min(1, balance / runMax)) : null;

  const low = balance < 20;

  return (
    <div className="flex items-center gap-3">
      <div className="text-right">
        <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block leading-none">
          Credits
        </span>
        <span
          className={`text-sm font-bold tabular-nums leading-tight ${
            low ? 'text-[#b5801f]' : 'text-[#141414]'
          }`}
        >
          {Number.isInteger(balance) ? balance : balance.toFixed(2)}
        </span>
      </div>

      {ratio !== null && (
        <div className="w-24" title={`${ratio * 100}% of the worst case left`}>
          <div className="h-1 w-full bg-[#eeeeea]">
            <div
              className={`h-full transition-[width] duration-500 ${
                ratio < 0.15 ? 'bg-[#b5801f]' : 'bg-[#141414]'
              }`}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
          <span className="text-[9px] font-mono text-[#8a8a86] mt-1 block">
            {formatUsd(balance * 0.05)}
          </span>
        </div>
      )}

      {low && !compact && (
        <span className="text-[10px] font-mono text-[#b5801f] border border-[#f0e0bd] bg-[#f8eedb] px-1.5 py-0.5 rounded-none">
          low
        </span>
      )}
    </div>
  );
};

/**
 * One counter in a row of them.
 *
 * The label says what the number is, never what it implies. "Found" not "success
 * rate"; "Spent" not "value".
 */
export const Counter: React.FC<{
  label: string;
  value: number | string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  title?: string;
}> = ({ label, value, tone = 'default', title }) => {
  const toneClass =
    tone === 'good'
      ? 'text-[#1a7f4b]'
      : tone === 'warn'
        ? 'text-[#b5801f]'
        : tone === 'bad'
          ? 'text-[#c0462e]'
          : 'text-[#141414]';

  return (
    <div title={title}>
      <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block leading-none">
        {label}
      </span>
      <span className={`text-base font-bold tabular-nums leading-tight ${toneClass}`}>{value}</span>
    </div>
  );
};
