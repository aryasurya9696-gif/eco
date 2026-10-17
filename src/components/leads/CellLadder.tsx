import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ProviderChip } from './ProviderChip';
import { DEFAULT_EMAIL_ORDER, providerLabel } from '../../lib/leads';

/**
 * The little ladder a row walks down while the waterfall is working on it.
 *
 * Five rungs, one per provider in the email order, and a marker on whichever one
 * is being tried right now. It exists so the wait is legible: a row that sits on
 * "trying" with no explanation for thirty seconds looks broken, and a user who
 * thinks it is broken will cancel a run that was working fine.
 *
 * The order is computed rather than hardcoded so that what the ladder shows and
 * what the worker will actually do are the same list. A ladder showing a
 * different order than the waterfall uses would be worse than no ladder.
 */
export const CellLadder: React.FC<{
  currentProvider: string | null;
  /** The row's state, so a miss can fade the rung it just left. */
  state?: 'queued' | 'trying' | 'miss' | 'found' | 'done' | 'skipped' | 'failed';
}> = ({ currentProvider, state = 'trying' }) => {
  const reduce = useReducedMotion();

  // The shipped order. Smart and custom orders are per user and live in the
  // database; this is what a user who has not changed anything gets, and it is
  // what the worker will use. If the two ever disagree the ladder is wrong and
  // the row below is the honest signal, not the rungs above it.
  const ladder = DEFAULT_EMAIL_ORDER.map((id) => ({ id, label: providerLabel(id) }));
  const activeIndex = ladder.findIndex((e) => e.id === currentProvider);

  return (
    <div
      className="flex items-center gap-1"
      title={
        currentProvider
          ? `Trying ${providerLabel(currentProvider)}`
          : 'Waiting to start'
      }
    >
      {ladder.map((entry, i) => {
        const isActive = entry.id === currentProvider;
        const isPast = activeIndex > -1 && i < activeIndex;
        const isNext = activeIndex > -1 && i === activeIndex;

        return (
          <div key={entry.id} className="flex items-center gap-1">
            {/* The rung. 2px tall so five of them fit a 44px row without
                competing with the text beside them. */}
            <div className="relative w-3 h-[2px] bg-[#e3e3de]">
              {isPast && <div className="absolute inset-0 bg-[#b5b5ad]" />}
              {isNext && (
                <motion.div
                  className="absolute inset-0 bg-[#141414]"
                  initial={reduce ? false : { scaleX: 0.2 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: reduce ? 0 : 0.2 }}
                  style={{ originX: 0 }}
                />
              )}
            </div>
            {/* The droplet. Only on the rung in flight, so the eye has exactly
                one place to rest. */}
            {isActive && (
              <motion.span
                className="w-1.5 h-1.5 rounded-full bg-[#141414] block absolute"
                initial={reduce ? false : { y: -5, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: reduce ? 0 : 0.18 }}
                style={{ marginLeft: -6 }}
              />
            )}
          </div>
        );
      })}

      {/* The name of whoever is being tried, spelled out. A row of grey ticks
          says nothing; "Kitt" says a provider is being paid. */}
      <span className="ml-1.5">
        {state === 'miss' && !currentProvider ? (
          <span className="text-[10px] font-mono text-[#8a8a86]">moved on</span>
        ) : (
          <ProviderChip endpointId={currentProvider} />
        )}
      </span>
    </div>
  );
};
