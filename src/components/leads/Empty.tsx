/**
 * Echo Leads — the shapes a screen has not got data for yet
 * ---------------------------------------------------------------------------
 * Deliberately small. A skeleton at the finished size, an empty state that
 * offers the action rather than describing the absence, and a dash for a count
 * that has not arrived.
 *
 * The dash is the one worth arguing for. Rendering zero while a free count is in
 * flight produces a confident "0 companies match" for as long as the provider
 * takes to answer, and a user who reads that and closes the tab has been told
 * something false. "Not asked yet" and "nothing found" are different facts and
 * they look different here.
 */
import React from 'react';

/**
 * The first-run empty state: one line and one button.
 *
 * No illustration, no second paragraph. Someone opening Leads for the first time
 * either has runs or does not, and there is nothing to choose between, so the
 * only thing to put in front of them is the action.
 */
export const EmptyState: React.FC<{
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}> = ({ title, body, action }) => (
  <div className="bg-white border border-[#e3e3de] px-8 py-16 flex flex-col items-center text-center">
    <h3 className="text-sm font-bold tracking-tight text-[#141414]">{title}</h3>
    <p className="text-xs font-mono text-[#8a8a86] mt-2 max-w-md leading-relaxed">{body}</p>
    {action && (
      <button
        onClick={action.onClick}
        className="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-[#141414] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer"
      >
        {action.label}
      </button>
    )}
  </div>
);

/**
 * Skeleton that matches the real thing's dimensions.
 *
 * Every size here is the finished size. A skeleton at a different height than
 * the content it stands in for is what makes a table jump when data lands, and
 * once the eye has seen the jump it keeps expecting it on every later load.
 */
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`bg-[#f0f0ec] animate-pulse ${className}`} aria-hidden="true" />
);

/** A 44px row skeleton, matching the table's row height exactly. */
export const RowSkeleton: React.FC = () => (
  <div className="flex items-center gap-4 px-4 h-11 border-b border-[#eeeeea]">
    <Skeleton className="w-4 h-4" />
    <Skeleton className="w-44 h-3" />
    <Skeleton className="w-32 h-3" />
    <Skeleton className="w-48 h-3" />
    <Skeleton className="w-24 h-3" />
    <Skeleton className="w-20 h-3" />
    <Skeleton className="w-16 h-3 ml-auto" />
  </div>
);

/**
 * A count that has not arrived yet.
 *
 * Renders a dash rather than a zero. "0 companies match" and "we have not asked
 * yet" are different facts, and a free count that flashes zero before the
 * provider answers reads as a confident answer that nothing exists.
 */
export const PendingCount: React.FC = () => (
  <span className="text-[#b5b5ad] text-[10px] font-mono">—</span>
);
