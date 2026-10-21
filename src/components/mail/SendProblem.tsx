import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { SendFailureKind } from './mail-store';
import { hashForTab } from '../../lib/tab-routing';

export interface SendProblemState {
  kind: SendFailureKind;
  message: string;
}

interface SendProblemProps {
  problem: SendProblemState;
  /** Resend with confirm_resend (only offered for uncertain_resend). */
  onSendAnyway?: () => void;
  onDismiss: () => void;
  /** Called before navigating to Billing (e.g. to close the composer). */
  onBeforeBilling?: () => void;
  busy?: boolean;
}

/**
 * A send that needs more than a toast: an uncertain earlier attempt ("Send
 * anyway"), a possibly-delivered timeout (no retry offered), or a refusal
 * because only welcome credits are left (Billing).
 */
export const SendProblem: React.FC<SendProblemProps> = ({ problem, onSendAnyway, onDismiss, onBeforeBilling, busy }) => {
  const btn = 'h-8 px-3 rounded-md text-[12px] font-medium cursor-pointer disabled:opacity-50';
  return (
    <div role="alert" className="flex flex-wrap items-start gap-2 px-3 py-2.5 rounded-lg border border-amber-200 bg-amber-50 text-[12px] text-amber-900">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" aria-hidden="true" />
      <p className="flex-1 min-w-[12rem] leading-relaxed">{problem.message}</p>
      <div className="flex items-center gap-1.5">
        {problem.kind === 'uncertain_resend' && onSendAnyway && (
          <button type="button" onClick={onSendAnyway} disabled={busy} className={`${btn} bg-[#18181b] text-white hover:bg-black`}>
            Send anyway
          </button>
        )}
        {problem.kind === 'paid_credits_required' && (
          <button
            type="button"
            onClick={() => {
              onBeforeBilling?.();
              window.location.hash = hashForTab('billing');
            }}
            className={`${btn} bg-[#18181b] text-white hover:bg-black`}
          >
            Go to Billing
          </button>
        )}
        <button type="button" onClick={onDismiss} className={`${btn} text-amber-900 hover:bg-amber-100`}>
          Dismiss
        </button>
      </div>
    </div>
  );
};
