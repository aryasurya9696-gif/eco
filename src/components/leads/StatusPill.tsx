import React from 'react';

/**
 * Echo Leads — the one pill
 * ---------------------------------------------------------------------------
 * Every small status label in Leads is this component: email status, run
 * status, fit score, automation state, opt-out kind. One shape (square, a
 * hairline border, mono caps) and five meanings, so a colour means the same
 * thing on every screen:
 *
 *   ok       done, verified, active
 *   warn     needs attention but is not broken: paused, catch-all, refused
 *   danger   failed or unusable: invalid, failed
 *   info     neutral information with a hue: an email opt-out
 *   neutral  quiet facts: not found, cancelled, unknown
 *   outline  not yet: not checked, queued
 */
export type PillTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'outline';

const TONE: Record<PillTone, string> = {
  ok: 'bg-ok-bg text-ok border-ok-line',
  warn: 'bg-warn-bg text-warn border-warn-line',
  danger: 'bg-danger-bg text-danger border-danger-line',
  info: 'bg-info-bg text-info border-info-bg',
  neutral: 'bg-line-soft text-muted border-line-soft',
  outline: 'bg-white text-muted border-line',
};

const DOT: Record<PillTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-muted',
  outline: 'bg-muted',
};

export const StatusPill: React.FC<{
  tone: PillTone;
  children: React.ReactNode;
  title?: string;
  /** A dot before the label: 'pulse' for something happening now. */
  dot?: 'still' | 'pulse';
  /** Numbers (a score) are not upper-cased and use tabular figures. */
  numeric?: boolean;
  className?: string;
}> = ({ tone, children, title, dot, numeric = false, className = '' }) => (
  <span
    className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] font-mono border rounded-none whitespace-nowrap ${
      numeric ? 'tabular-nums' : 'uppercase tracking-wider'
    } ${TONE[tone]} ${className}`}
    title={title}
  >
    {dot && <span className={`w-1.5 h-1.5 rounded-full ${DOT[tone]} ${dot === 'pulse' ? 'animate-pulse' : ''}`} aria-hidden="true" />}
    {children}
  </span>
);
