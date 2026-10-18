import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { LeadEmailStatus, LeadRunStatus } from '../../types';

/**
 * What a run actually produced, as one bar.
 *
 * Four separate numbers — four verified, one catch-all, three invalid, the rest
 * not found — is a set of figures to add up in your head every time you look at
 * a run. The thing you want to know is the proportion: is this run mostly
 * deliverable addresses, or mostly a provider saying no?
 *
 * The order of the segments is the order of usefulness, not alphabetical: what
 * you can send to first, then what you can send to with a caveat, then what you
 * must not send to, then what you simply have not got. A bar that reads
 * left-to-right as "good to useless" means the right-hand edge tells you
 * immediately whether the run was worth running.
 *
 * Empty segments are omitted rather than drawn at zero width. A row of invisible
 * dividers is a border, not a chart.
 */

const SEGMENTS: Array<{
  key: LeadEmailStatus;
  label: string;
  /** The share of the bar this takes when present. */
  fill: string;
  /** The outline used in the legend, so a colour is never the only signal. */
  edge: string;
}> = [
  { key: 'verified', label: 'Verified', fill: '#1a7f4b', edge: '#1a7f4b' },
  { key: 'catch_all', label: 'Catch-all', fill: '#b45309', edge: '#b45309' },
  { key: 'unknown', label: 'Unchecked', fill: '#8a8a86', edge: '#8a8a86' },
  { key: 'invalid', label: 'No mailbox', fill: '#b03a20', edge: '#b03a20' },
];

export const CompositionBar: React.FC<{
  counts: Partial<Record<LeadEmailStatus, number>>;
  /** Rows that came back with no address at all. Drawn as the empty remainder. */
  notFound?: number;
  height?: number;
  showLegend?: boolean;
}> = ({ counts, notFound = 0, height = 8, showLegend = true }) => {
  const reduce = useReducedMotion();

  const present = SEGMENTS.filter((s) => (counts[s.key] ?? 0) > 0);
  const total = present.reduce((n, s) => n + (counts[s.key] ?? 0), 0);

  if (total === 0) {
    return (
      <div>
        <div className="w-full bg-[#eeeeea]" style={{ height }} />
        <p className="text-[10px] font-mono text-[#b5b5ad] mt-1.5">
          {notFound > 0 ? `${notFound.toLocaleString()} rows, none with an address` : 'nothing worked yet'}
        </p>
      </div>
    );
  }

  // Rows still in flight are not in any of the four states yet, so the bar is
  // scaled to what has finished rather than to the target. Otherwise a run at
  // 10% done draws a completely full bar of the four states it has so far and
  // the progress looks like completion.
  const finished = total + notFound;

  return (
    <div>
      <div className="w-full flex" style={{ height }}>
        {present.map((s, i) => {
          const n = counts[s.key] ?? 0;
          const pct = (n / finished) * 100;
          return (
            <motion.div
              key={s.key}
              initial={reduce ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: reduce ? 0 : 0.45, delay: i * 0.06, ease: [0.22, 1, 0.36, 1] }}
              style={{ width: `${pct}%`, backgroundColor: s.fill, originX: 0 }}
              title={`${n.toLocaleString()} ${s.label.toLowerCase()}`}
              className="h-full first:rounded-l-sm last:rounded-r-sm"
            />
          );
        })}
      </div>

      {showLegend && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5">
          {present.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: s.fill }} />
              <span className="text-[10px] font-mono text-[#8a8a86]">{s.label}</span>
              <span className="text-[10px] font-mono text-[#141414] tabular-nums">{counts[s.key]}</span>
            </span>
          ))}
          {notFound > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm border border-[#e3e3de] flex-shrink-0" />
              <span className="text-[10px] font-mono text-[#8a8a86]">No address</span>
              <span className="text-[10px] font-mono text-[#141414] tabular-nums">{notFound}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * A run's state as a picture.
 *
 * Five states that are easy to confuse from a word: queued has not started,
 * running is working, paused needs the user, cancelled was stopped, done
 * finished. Rendered as a strip whose colour and position say which, so a list
 * of twenty runs can be scanned for the one that needs attention without reading
 * twenty status words.
 */
export const RunStrip: React.FC<{ status: LeadRunStatus; pauseReason?: string | null }> = ({
  status,
  pauseReason,
}) => {
  const reduce = useReducedMotion();

  const tone =
    status === 'done'
      ? { bar: 'bg-[#1a7f4b]', text: 'text-[#1a7f4b]', label: 'Done' }
      : status === 'running'
        ? { bar: 'bg-[#141414]', text: 'text-[#141414]', label: 'Running' }
        : status === 'paused'
          ? { bar: 'bg-[#b45309]', text: 'text-[#b45309]', label: 'Paused' }
          : status === 'failed'
            ? { bar: 'bg-[#b03a20]', text: 'text-[#b03a20]', label: 'Failed' }
            : status === 'cancelled'
              ? { bar: 'bg-[#c9c9c2]', text: 'text-[#8a8a86]', label: 'Cancelled' }
              : { bar: 'bg-[#d5d5cf]', text: 'text-[#8a8a86]', label: 'Queued' };

  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={pauseReason ? `Paused: ${pauseReason.replace(/_/g, ' ')}` : tone.label}
    >
      <span className="w-1 h-3 flex-shrink-0 relative overflow-hidden">
        <span className={`absolute inset-0 ${tone.bar}`} />
        {status === 'running' && !reduce && (
          <motion.span
            className="absolute inset-0 bg-white"
            initial={{ y: '-100%' }}
            animate={{ y: '100%' }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </span>
      <span className={`text-[10px] font-mono uppercase tracking-wider ${tone.text}`}>
        {tone.label}
      </span>
    </span>
  );
};

/**
 * A figure with its share of a ceiling drawn underneath.
 *
 * The bar is always against a total the user can see named. A credits figure
 * reading 46 beside a bar scaled to some distant maximum says nothing; 46
 * against 61 — this run's own ceiling — says it cost three quarters of what it
 * might have, which is the thing worth seeing.
 *
 * The number and what is printed are separate inputs rather than one that has to
 * satisfy both. A figure has a value; sometimes what reads better is "46 cr".
 * Passing a formatted string and parsing it back out to draw a bar is how a
 * decimal point ends up on the wrong side of a progress line.
 */
export const MeterFigure: React.FC<{
  label: string;
  /** The number the bar is drawn from. */
  value: number;
  /** What to print. Defaults to the value. */
  display?: React.ReactNode;
  /** The denominator. No bar without it. */
  of?: number | null;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  sub?: React.ReactNode;
}> = ({ label, value, display, of, tone = 'default', sub }) => {
  const pct = typeof of === 'number' && of > 0 ? Math.min(100, (value / of) * 100) : null;

  const toneClass =
    tone === 'good'
      ? 'text-[#1a7f4b]'
      : tone === 'warn'
        ? 'text-[#b45309]'
        : tone === 'bad'
          ? 'text-[#b03a20]'
          : 'text-[#141414]';

  return (
    <div className="min-w-0">
      <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block leading-none">
        {label}
      </span>
      <span className={`text-xl font-mono font-medium tabular-nums leading-tight ${toneClass} block`}>
        {display ?? value}
      </span>

      {pct !== null && (
        <div
          className="h-0.5 w-full bg-[#eeeeea] mt-2"
          title={`${Math.round(pct)}% of ${of}`}
        >
          <motion.div
            className={`h-full ${tone === 'default' ? 'bg-[#8a8a86]' : toneClass}`}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      )}

      {sub && <span className="block text-[10px] font-mono text-[#8a8a86] mt-1.5">{sub}</span>}
    </div>
  );
};
