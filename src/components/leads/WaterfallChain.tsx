import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import type { LeadAttempt, LeadStep } from '../../types';
import { providerStyle } from '../../lib/leads';
import { formatUsd } from '../../lib/billing';

/**
 * The waterfall, drawn.
 *
 * This is the idea the whole product is built on — five providers, cheapest
 * first, stop at the one that answers — and until now it has been a list of
 * text rows. A list of text rows is what makes a waterfall look like a
 * spreadsheet with a story attached; the shape is the argument. Three providers
 * tried and the third one answered should read as three dots and a line before
 * a single word is read, because "we tried three times and it cost the price of
 * one" is exactly what the shape says.
 *
 * So each provider is a node on a line, and the state of the node carries the
 * outcome: hollow for a miss, filled for the find, dashed for a provider that
 * was never reached. The price sits under each node in its own voice, so the
 * cost of the misses before the win is legible next to the win itself rather
 * than summed somewhere else.
 *
 * Used in three places at three sizes — the row receipt, the provider lab and
 * the run header — because a waterfall you can only see in one place is a
 * diagram, not a mental model.
 */

type NodeState = 'miss' | 'hit' | 'skipped' | 'pending';

interface Node {
  endpointId: string;
  state: NodeState;
  costUsd: number;
  /** Which attempt index this was, so the order is the order it happened. */
  step: number;
}

export const WaterfallChain: React.FC<{
  /** The attempts in the order they were made. */
  attempts: LeadAttempt[];
  /** Every provider in the order, so untried ones show as skipped rather than absent. */
  fullOrder?: string[];
  size?: 'sm' | 'md';
  /** Hide the prices, for the tightest placement. */
  compact?: boolean;
}> = ({ attempts, fullOrder, size = 'md', compact = false }) => {
  const reduce = useReducedMotion();

  // Reconstruct what the worker would have walked, not just what it happened to
  // call. A run that died mid-waterfall leaves a trail of one attempt and three
  // providers it never got to, and a diagram that draws only the one attempt is
  // a diagram that makes a stopped run look like a finished one.
  const calledIds = attempts.map((a) => a.endpoint_id);
  const seen = new Set<string>();

  const nodes: Node[] = [];
  const order = fullOrder && fullOrder.length > 0 ? fullOrder : calledIds;

  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const attempt = attempts.find((a) => a.endpoint_id === id);
    nodes.push({
      endpointId: id,
      state: attempt ? (attempt.hit ? 'hit' : 'miss') : 'skipped',
      costUsd: attempt?.cost_usd ?? 0,
      step: nodes.length + 1,
    });
  }

  // Anything called that is not in the displayed order — a provider added to the
  // registry after this run started, or a custom order since changed. Dropping
  // it would understate what was paid for.
  for (const a of attempts) {
    if (seen.has(a.endpoint_id)) continue;
    seen.add(a.endpoint_id);
    nodes.push({
      endpointId: a.endpoint_id,
      state: a.hit ? 'hit' : 'miss',
      costUsd: a.cost_usd ?? 0,
      step: nodes.length + 1,
    });
  }

  if (nodes.length === 0) return null;

  const hitIndex = nodes.findIndex((n) => n.state === 'hit');
  const spent = nodes.reduce((n, x) => n + x.costUsd, 0);
  const missed = nodes.filter((n) => n.state === 'miss').length;

  const dot = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5';
  const line = size === 'sm' ? 'h-px' : 'h-[2px]';

  return (
    <div className="inline-flex flex-col gap-2">
      <div className="flex items-center">
        {nodes.map((node, i) => {
          const s = providerStyle(node.endpointId);
          const reached = node.state !== 'skipped';
          const afterHit = hitIndex !== -1 && i > hitIndex;

          return (
            <React.Fragment key={`${node.endpointId}-${i}`}>
              {i > 0 && (
                <div
                  className={`${line} flex-1 min-w-[14px] mx-1.5 ${
                    afterHit ? 'bg-line-soft' : reached ? 'bg-line-strong' : 'bg-fill'
                  }`}
                >
                  {/* The line only grows once something has actually happened on
                      it. A finished diagram that filled itself in looks like it
                      is still loading, which is the opposite of what it should
                      say. */}
                  {reached && !reduce && (
                    <motion.div
                      className={`h-full ${afterHit ? 'bg-line-soft' : 'bg-line-strong'}`}
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: 1 }}
                      transition={{ duration: 0.25, delay: i * 0.04 }}
                      style={{ originX: 0 }}
                    />
                  )}
                </div>
              )}

              <div className="flex flex-col items-center gap-1 min-w-0">
                <motion.span
                  initial={reduce ? false : { scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: reduce ? 0 : 0.2, delay: 0.05 + i * 0.04 }}
                  className={`${dot} rounded-full flex-shrink-0 ${
                    node.state === 'hit'
                      ? 'bg-ink ring-2 ring-ink ring-offset-2 ring-offset-white'
                      : node.state === 'miss'
                        ? `${s.chip} border border-current ${s.ink}`
                        : 'border border-dashed border-line-strong'
                  }`}
                  title={`${s.label} — ${
                    node.state === 'hit' ? 'found the address' : node.state === 'miss' ? 'no address' : 'never reached'
                  }`}
                />

                {!compact && (
                  <>
                    <span
                      className={`text-[9px] font-mono uppercase tracking-wider whitespace-nowrap ${
                        node.state === 'skipped' ? 'text-line-strong' : s.ink
                      }`}
                    >
                      {s.label}
                    </span>
                    <span className="text-[9px] font-mono text-faint tabular-nums whitespace-nowrap">
                      {node.state === 'skipped' ? '—' : formatUsd(node.costUsd)}
                    </span>
                  </>
                )}
              </div>
            </React.Fragment>
          );
        })}

        {/* The arrow past the end, so the chain reads as continuing rather than
            stopping. Without it a five-node diagram with three misses looks like
            a list that ran out. */}
        <ArrowRight className={`${size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-line-strong ml-2 flex-shrink-0`} />
      </div>

      {size === 'md' && (
        <p className="text-[10px] font-mono text-muted">
          {hitIndex === -1 ? (
            <>tried {nodes.filter((n) => n.state === 'miss').length} providers, none had it</>
          ) : (
            <>
              found on the {hitIndex === 0 ? 'first' : `${ordinal(hitIndex + 1)}`} try
              {missed > 0 && `, after ${missed} miss${missed === 1 ? '' : 'es'}`}
              {' · '}
              <span className="text-ink-2">{formatUsd(spent)}</span> at providers
            </>
          )}
        </p>
      )}
    </div>
  );
};

/**
 * The order the steps run in, which is also the order they cost money in.
 *
 * Used to draw one chain per step for a row. It was drawn as one chain for the
 * whole row, which was correct while a row only ever had email attempts in it and
 * is wrong from the moment it has more: a find run asks for the company, then
 * the decision maker, then the address, and drawing those as a single ladder of
 * providers reads as though one waterfall asked five providers for the same
 * thing. It also made the misses meaningless - three misses across three
 * different steps looks like one expensive lookup when it is three cheap ones.
 */
const STEP_SEQUENCE: LeadStep[] = ['company', 'person', 'email', 'verify', 'phone', 'enrich'];

const STEP_HEADING: Record<LeadStep, string> = {
  company: 'Finding the company',
  person: 'Finding the decision maker',
  email: 'Finding the address',
  verify: 'Checking the address',
  phone: 'Finding the number',
  enrich: "Adding the company's details",
};

/**
 * The same shape across a whole run.
 *
 * A vertical list of rows, each carrying its own chains, is how a run's economics
 * become visible: most rows have one node lit, the expensive ones have four
 * misses in front of it, and the difference between those two rows is what the
 * price is actually made of.
 *
 * One chain per step per row rather than one per row, for the reason on STEP_SEQUENCE.
 */
export const WaterfallColumn: React.FC<{
  rows: Array<{ id: string; attempts: LeadAttempt[] }>;
  /** The shipped or saved order, per step. Optional per step, not in total. */
  fullOrders?: Partial<Record<LeadStep, string[]>>;
  limit?: number;
}> = ({ rows, fullOrders, limit = 12 }) => {
  const reduce = useReducedMotion();
  const shown = rows.slice(0, limit);

  if (shown.length === 0) return null;

  const totalMisses = rows.reduce(
    (n, r) => n + r.attempts.filter((a) => !a.hit).length,
    0,
  );
  const totalSpent = rows.reduce((n, r) => n + r.attempts.reduce((m, a) => m + (a.cost_usd ?? 0), 0), 0);
  const foundOn = rows.filter((r) => r.attempts.length > 0).length;

  return (
    <div className="space-y-4">
      {shown.map((r, i) => {
        // Steps this row actually has attempts for, in run order. A step with no
        // attempts is not drawn as an empty chain: an untried step is not a chain
        // of skipped providers, it is a step the run did not perform.
        const used = STEP_SEQUENCE.filter((s) => r.attempts.some((a) => a.step === s));

        return (
          <motion.div
            key={r.id}
            initial={reduce ? false : { opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: reduce ? 0 : 0.2, delay: i * 0.03 }}
            className="space-y-1.5"
          >
            {used.length > 1 && (
              // Only when there is more than one. A single chain says what it is
              // from the providers in it; a caption on every row would be a line
              // of text repeating itself down the panel.
              <p className="text-[9px] font-mono text-faint uppercase tracking-wider">
                {used.map((s) => STEP_HEADING[s]).join(' · then ')}
              </p>
            )}
            {used.map((s) => (
              <WaterfallChain
                key={s}
                attempts={r.attempts.filter((a) => a.step === s)}
                fullOrder={fullOrders?.[s]}
                size="sm"
                compact
              />
            ))}
          </motion.div>
        );
      })}

      <p className="text-[10px] font-mono text-muted pt-2 border-t border-line-soft">
        {rows.length} row{rows.length === 1 ? '' : 's'} · {foundOn} with any history ·{' '}
        {totalMisses} miss{totalMisses === 1 ? '' : 'es'} · {formatUsd(totalSpent)} at providers
      </p>
    </div>
  );
};

function ordinal(n: number): string {
  const words = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
  return words[n] ?? `${n}th`;
}