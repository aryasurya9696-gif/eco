import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { LeadAttempt } from '../../types';
import { providerStyle } from '../../lib/leads';
import { formatUsd } from '../../lib/billing';
import { CallFailure } from './RowState';
import { PendingCount } from './Empty';

/**
 * Every provider that was asked, for one row, in the order it was asked.
 *
 * This is the screen that makes a waterfall auditable, and the reason it lists
 * failures rather than hiding them is the whole point. A row that came back empty
 * looks identical whether the filters were wrong or every provider was rate
 * limited, and those have nothing in common except the outcome: one needs the
 * search changed, the other needs a minute and a retry. A history that only
 * records successes makes that distinction impossible to make after the fact.
 *
 * So the transport detail is carried through alongside the billing outcome. They
 * are two different columns in the database for a reason, and collapsing them
 * means either losing "rate limited" or losing "was not charged".
 *
 * It was, in fact, impossible for a while: api_usage's CHECK constraint rejected
 * the outcome every 402 and 429 produced, so those rows were never written and
 * there was nothing to show. The hole in this list was a check constraint.
 */

export interface AttemptWithFailure extends LeadAttempt {
  http_status?: number | null;
  error_code?: string | null;
}

const STEP_LABEL: Record<string, string> = {
  company: 'Company',
  person: 'Person',
  email: 'Email',
  verify: 'Verify',
  phone: 'Phone',
  enrich: 'Enrich',
};

export const AttemptHistory: React.FC<{
  attempts: AttemptWithFailure[];
  /** True while the fetch is in flight, so the list is not drawn empty. */
  loading?: boolean;
}> = ({ attempts, loading }) => {
  const [showTable, setShowTable] = React.useState(false);

  if (loading) return <PendingCount />;

  if (attempts.length === 0) {
    return (
      <p className="text-[10px] font-mono text-[#8a8a86] py-1">
        No provider has been asked about this row yet.
      </p>
    );
  }

  const total = attempts.reduce((n, a) => n + (a.cost_usd ?? 0), 0);
  const misses = attempts.filter((a) => !a.hit).length;
  const failures = attempts.filter((a) => a.http_status && a.http_status >= 400);

  return (
    <div>
      {/* Summary line. The total is the point — it is what makes one row's expense
          comparable with another's, which is the question a user opens this to
          answer. */}
      <div className="flex items-center gap-3 mb-2.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]">
          Every attempt for this row
        </span>
        <span className="text-[11px] font-mono text-[#141414] tabular-nums">
          {formatUsd(total)}
        </span>
        <span className="text-[10px] font-mono text-[#8a8a86]">
          {attempts.length} {attempts.length === 1 ? 'call' : 'calls'}
          {misses > 0 && `, ${misses} missed`}
        </span>
      </div>

      {/* A failure at the top and in the app's own language. A 429 buried in a
          table of successes is a row somebody has to expand a history to find,
          and the thing they need to know is "would this have worked if I had
          waited". */}
      {failures.length > 0 && (
        <div className="flex items-start gap-2 mb-2.5 px-2.5 py-2 bg-[#fdf1ee] border border-[#f0cfc8]">
          <AlertTriangle className="w-3 h-3 text-[#b03a20] mt-0.5 flex-shrink-0" />
          <p className="text-[10px] font-mono text-[#b03a20] leading-relaxed">
            {failures.length === 1 ? 'One call was refused' : `${failures.length} calls were refused`} by
            the provider. {describeFailures(failures)} Nothing was charged for those.
          </p>
        </div>
      )}

      {/* The chain, which is the visual answer. */}
      <AttemptChain attempts={attempts} />

      {/* The table, which is the auditable one. Behind a control because it is
          four columns of detail and almost nobody opens a run to read all of
          them — but it is there for the one person who needs to reconcile a bill,
          and hiding it entirely is what makes a number unfalsifiable. */}
      <button
        onClick={() => setShowTable((v) => !v)}
        className="mt-2.5 text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer"
      >
        {showTable ? 'Hide the detail' : 'Show every call'}
      </button>

      {showTable && (
        <table className="mt-2 w-full text-[10px] font-mono">
          <thead>
            <tr className="text-[#b5b5ad] text-left">
              <th className="font-normal pb-1 w-16">Step</th>
              <th className="font-normal pb-1">Provider</th>
              <th className="font-normal pb-1 w-40">Result</th>
              <th className="font-normal pb-1 text-right w-20">Cost</th>
            </tr>
          </thead>
          <tbody className="border-t border-[#eeeeea]">
            {attempts.map((a) => {
              const s = providerStyle(a.endpoint_id);
              const failed = Boolean(a.http_status && a.http_status >= 400);

              return (
                <tr key={a.id} className="border-b border-[#eeeeea] last:border-b-0">
                  <td className="py-1.5 text-[#8a8a86]">
                    {STEP_LABEL[a.step] ?? a.step}
                  </td>
                  <td className={`py-1.5 ${s.ink}`}>{s.label}</td>
                  <td className="py-1.5">
                    {failed ? (
                      <CallFailure status={a.http_status} code={a.error_code} />
                    ) : a.hit ? (
                      <span className="text-[#1a7f4b]">found</span>
                    ) : (
                      <span className="text-[#b5b5ad]">nothing</span>
                    )}
                  </td>
                  <td className="py-1.5 text-right text-[#4a4a47] tabular-nums">
                    {formatUsd(a.cost_usd ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

/** One dot per call, filled for a find and hollow for a miss. */
const AttemptChain: React.FC<{ attempts: AttemptWithFailure[] }> = ({ attempts }) => (
  <div className="flex items-center gap-1.5">
    {attempts.map((a, i) => {
      const s = providerStyle(a.endpoint_id);
      const failed = Boolean(a.http_status && a.http_status >= 400);
      return (
        <React.Fragment key={`${a.id}-${i}`}>
          {i > 0 && <span className="w-3 h-px bg-[#e3e3de]" />}
          <span
            className={`w-2 h-2 rounded-full ${
              failed
                ? 'bg-[#b03a20]'
                : a.hit
                  ? 'bg-[#141414]'
                  : `${s.chip} border border-current ${s.ink}`
            }`}
            title={`${s.label} — ${failed ? `HTTP ${a.http_status}` : a.hit ? 'found' : 'nothing'} · ${formatUsd(a.cost_usd ?? 0)}`}
          />
        </React.Fragment>
      );
    })}
  </div>
);

/** In the app's words, because "429" is a number and the sentence is the answer. */
function describeFailures(failures: AttemptWithFailure[]): string {
  const codes = failures.map((f) => f.error_code ?? String(f.http_status));
  if (codes.every((c) => c === 'rate_limited' || c === '429')) {
    return 'That was rate limiting, so the same row would probably have worked a minute later.';
  }
  if (codes.some((c) => c === 'route_max_cost_or_balance' || c === '402')) {
    return 'The provider ran out of credit on our account, which stops every lookup until it is topped up.';
  }
  if (codes.every((c) => c === 'answer_lost' || c === '410')) {
    return 'The answer was lost after the call completed. Those may or may not have been charged.';
  }
  return 'The full detail is below.';
}