import React from 'react';
import type { LeadRow, LeadEmailStatus, LeadRowState, LeadStep } from '../../types';

/**
 * What a row is doing, in words a person would use.
 *
 * The database has six states and a step. Both are implementation — `trying` does
 * not tell somebody watching a run whether it is looking for the person or the
 * address, and the difference is the whole wait.
 *
 * So what is drawn names the step. "Finding person" and "Finding email" are the
 * same state and completely different experiences: one is a row that will arrive
 * with an email and one is a row that will not, and a user watching a run can
 * tell them apart at a glance with the word and not at all with the state.
 *
 * The finished states are the address's status, because that is what the column
 * is for and it is what the user is actually waiting on. A row that finished with
 * no address says so, rather than saying it succeeded.
 */

export type RowStateLabel =
  | { text: string; tone: 'default' | 'good' | 'warn' | 'bad' | 'busy' };

const STEP_WORD: Record<LeadStep, string> = {
  company: 'Finding company',
  person: 'Finding person',
  email: 'Finding email',
  verify: 'Checking the address',
  phone: 'Finding phone',
  enrich: 'Adding details',
};

const ADDRESS_LABEL: Record<LeadEmailStatus, RowStateLabel> = {
  verified: { text: 'Verified', tone: 'good' },
  catch_all: { text: 'Catch-all', tone: 'warn' },
  invalid: { text: 'No mailbox', tone: 'bad' },
  unknown: { text: 'Verifier unsure', tone: 'default' },
  unchecked: { text: 'Not checked', tone: 'default' },
  disposable: { text: 'Disposable', tone: 'bad' },
  not_found: { text: 'No address', tone: 'default' },
};

const FINISHED: Record<LeadRowState, RowStateLabel> = {
  done: { text: 'Done', tone: 'default' },
  failed: { text: 'Failed', tone: 'bad' },
  skipped: { text: 'Skipped', tone: 'default' },
  found: { text: 'Found', tone: 'good' },
  miss: { text: 'Trying another', tone: 'busy' },
  queued: { text: 'Queued', tone: 'default' },
  trying: { text: 'Working', tone: 'busy' },
};

/**
 * One row, one label.
 *
 * Order of precedence matters and is not arbitrary. What is happening beats what
 * came of it: a row that is being worked right now has no result to report, and a
 * table showing "Unchecked" for a row that is actively being looked up is telling
 * the user it has been looked up and the answer is not in.
 *
 * `skipped` is checked before the address because a suppressed row may well have
 * a perfectly good address on it from an import. Saying "Verified" for somebody
 * the user asked never be contacted would be technically true and useless.
 */
export function rowStateLabel(row: {
  state: LeadRowState;
  step: LeadStep | null;
  email_status: LeadEmailStatus;
  email: string | null;
  credits?: number;
}): RowStateLabel {
  if (row.state === 'skipped') {
    return { text: 'On your opt-outs', tone: 'default' };
  }

  if (row.state === 'failed') return FINISHED.failed;

  if (row.state === 'queued') return FINISHED.queued;

  if (row.state === 'trying' || row.state === 'miss') {
    // The step is the information. "Working" on its own is a spinner in words.
    return row.step
      ? { text: STEP_WORD[row.step], tone: 'busy' }
      : FINISHED[row.state];
  }

  // Done. What came of it.
  if (row.email_status === 'not_found' && !row.email) {
    return { text: 'No address found', tone: 'default' };
  }

  return ADDRESS_LABEL[row.email_status] ?? FINISHED[row.state];
}

const TONE_CLASS: Record<RowStateLabel['tone'], string> = {
  good: 'bg-[#eef7f1] text-[#1a7f4b] border-[#cfe6da]',
  warn: 'bg-[#fdf6ec] text-[#b45309] border-[#e8d9bd]',
  bad: 'bg-[#fdf1ee] text-[#b03a20] border-[#f0cfc8]',
  busy: 'bg-white text-[#141414] border-[#e3e3de]',
  default: 'bg-[#f6f6f4] text-[#8a8a86] border-[#eeeeea]',
};

/**
 * The badge.
 *
 * A colour alone is a legend nobody has, so there is always a word. The busy tone
 * is deliberately not blue or green — the only thing that should look alive on
 * this screen is a row that is genuinely in flight, and there are always several.
 */
export const RowStateBadge: React.FC<{ row: LeadRow }> = ({ row }) => {
  const { text, tone } = rowStateLabel(row);
  const busy = tone === 'busy';

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 border text-[9px] font-mono uppercase tracking-wider whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {busy && <span className="w-1.5 h-1.5 rounded-full bg-[#141414] animate-pulse flex-shrink-0" />}
      {text}
    </span>
  );
};

/**
 * The same words for the status column.
 *
 * Kept separate from the badge because the status column shows the address's
 * outcome even while a row is being worked — "an address is being found" and "the
 * address we have is unverified" are two different columns' worth of question and
 * collapsing them into one is what produces a green tick beside an address nobody
 * checked.
 */
export const AddressBadge: React.FC<{ row: LeadRow }> = ({ row }) => {
  const { text, tone } = ADDRESS_LABEL[row.email_status] ?? ADDRESS_LABEL.unknown;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 border text-[9px] font-mono uppercase tracking-wider whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {text}
    </span>
  );
};

/**
 * What a failed provider call said, when it said something.
 *
 * The reference product shows "HTTP 429" in its attempt history and it is the
 * most useful cell on that screen: a row that came back empty looks identical to
 * a row where every provider was rate limited, and they are completely different
 * events with completely different fixes. One means the filters are wrong. The
 * other means trying again in a minute would have worked.
 */
export const CallFailure: React.FC<{ status?: number | null; code?: string | null }> = ({
  status,
  code,
}) => {
  if (!status && !code) return null;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-1.5 py-0.5 border border-[#f0cfc8] bg-[#fdf1ee] text-[#b03a20] text-[9px] font-mono whitespace-nowrap"
      title={explain(status, code)}
    >
      {status ? `HTTP ${status}` : code}
    </span>
  );
};

/** Plain language for a status, for the tooltip. */
function explain(status?: number | null, code?: string | null): string {
  if (code === 'rate_limited') return 'The provider was rate limiting us. Trying again shortly would likely have worked.';
  if (code === 'route_max_cost_or_balance') return 'The provider refused for cost. Nothing was charged.';
  if (code === 'answer_lost') return 'The call completed and was charged, but the answer was lost.';
  if (code === 'still_running') return 'The same request was still in flight.';
  if (status === 429) return 'The provider was rate limiting us.';
  if (status === 402) return 'The provider refused for cost. Nothing was charged.';
  return code ?? `The provider answered with ${status}.`;
}