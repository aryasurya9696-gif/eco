import React from 'react';
import type { LeadAttempt } from '../../types';
import { ProviderChip } from './ProviderChip';
import { formatUsd } from '../../lib/billing';

/**
 * The free count, shown before anything is spent.
 *
 * "About" is in the copy on purpose. These come from providers that answer with
 * an estimate of their coverage rather than an exact match, so printing a hard
 * number would claim a precision nobody has.
 *
 * Both counts are optional and independent: the company count usually answers
 * faster than the people count, because it is the cheaper query. Rendering the
 * company figure the moment it lands and leaving the second one blank looks
 * broken, so the second is only shown once both have answered, with whichever
 * arrives first held back briefly.
 */
export const CountLine: React.FC<{
  companies?: number | null;
  people?: number | null;
  loading?: boolean;
}> = ({ companies, people, loading = false }) => {
  if (loading) {
    return (
      <p className="text-[10px] font-mono text-[#8a8a86]">
        Counting matches<span className="animate-pulse">…</span>
      </p>
    );
  }

  if (companies === null || companies === undefined) {
    return (
      <p className="text-[10px] font-mono text-[#8a8a86]">
        The free count runs here, before you spend anything.
      </p>
    );
  }

  return (
    <p className="text-[10px] font-mono text-[#4a4a47] tabular-nums">
      About <span className="font-semibold text-[#141414]">{companies.toLocaleString()}</span>{' '}
      companies match
      {people !== null && people !== undefined && (
        <>
          . About <span className="font-semibold text-[#141414]">{people.toLocaleString()}</span>{' '}
          have a matching title
        </>
      )}
      .
    </p>
  );
};

/**
 * Every attempt made for one row, in order.
 *
 * This is the part that makes a waterfall trustworthy. A user looking at an
 * address and being told "Kitt found this" has no way to know whether that was
 * the first thing tried or the fourth, and the difference between those is the
 * whole cost of the row. Every attempt is shown, with its real measured charge,
 * because a price the user can audit is the only thing that distinguishes a
 * per-result charge from a per-attempt one.
 */
export const RowReceipt: React.FC<{
  attempts: LeadAttempt[];
  totalCostUsd?: number;
}> = ({ attempts, totalCostUsd }) => {
  if (attempts.length === 0) {
    return <p className="text-[10px] font-mono text-[#8a8a86]">No provider tried yet.</p>;
  }

  const sum = attempts.reduce((n, a) => n + (a.cost_usd ?? 0), 0);

  return (
    <div className="space-y-1.5">
      {attempts.map((a) => (
        <div key={a.id} className="flex items-center gap-2 text-[10px] font-mono">
          <ProviderChip endpointId={a.endpoint_id} />
          <span className="text-[#8a8a86] w-14 shrink-0">{a.step}</span>
          <span
            className={`w-14 shrink-0 ${a.hit ? 'text-[#1a7f4b]' : 'text-[#b5b5ad]'}`}
          >
            {a.hit ? 'found' : 'miss'}
          </span>
          <span className="tabular-nums text-[#4a4a47] ml-auto">
            {formatUsd(a.cost_usd ?? 0)}
          </span>
        </div>
      ))}

      <div className="flex items-center gap-2 pt-1.5 mt-1.5 border-t border-[#eeeeea] text-[10px] font-mono">
        <span className="text-[#8a8a86]">provider cost</span>
        <span className="tabular-nums text-[#141414] font-semibold ml-auto">
          {formatUsd(totalCostUsd ?? sum)}
        </span>
      </div>
    </div>
  );
};
