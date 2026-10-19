import React, { useEffect, useId, useRef } from 'react';
import { ShieldCheck, AlertCircle, X, Loader2, Mail } from 'lucide-react';
import type { B2BLead } from '../../types';
import { needsEmailReveal, EMAIL_REVEAL_CREDITS } from './lead-utils';

/**
 * Mirrors MAX_BULK in supabase/functions/leads/index.ts. One run resolves at
 * most this many addresses; the server used to stop silently at the cap, so
 * the dialog quoted a charge for the whole selection instead.
 */
const MAX_BULK_REVEAL = 100;

interface ConfirmRevealModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (limit?: number) => void;
  selectedLeads: B2BLead[];
  /** null when the balance could not be loaded. */
  availableCredits: number | null;
  isProcessing: boolean;
  onNavigateBilling?: () => void;
}

export const ConfirmRevealModal: React.FC<ConfirmRevealModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  selectedLeads,
  availableCredits,
  isProcessing,
  onNavigateBilling,
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus moves into the dialog on open, returns to whatever opened it on
  // close, Escape closes it, and Tab stays inside it.
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isProcessing) {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled)');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [isOpen, isProcessing, onClose]);

  if (!isOpen) return null;

  const unrevealed = selectedLeads.filter(needsEmailReveal);
  const alreadyRevealedCount = selectedLeads.length - unrevealed.length;
  // One run resolves at most MAX_BULK_REVEAL addresses, so the quote has to
  // describe that batch — not the whole selection.
  const batch = unrevealed.slice(0, MAX_BULK_REVEAL);
  const queuedCount = unrevealed.length - batch.length;
  const maxCharge = batch.length * EMAIL_REVEAL_CREDITS;
  const balanceKnown = availableCredits !== null;
  const hasSufficientCredits = !balanceKnown || (availableCredits ?? 0) >= maxCharge;
  const affordableCount = balanceKnown
    ? Math.min(batch.length, Math.floor(Math.max(0, availableCredits ?? 0) / EMAIL_REVEAL_CREDITS))
    : batch.length;

  const row = 'flex items-center justify-between gap-4 py-2';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isProcessing) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white border border-line-strong shadow-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-soft">
          <h3 id={titleId} className="text-base font-semibold text-ink flex items-center gap-2">
            <Mail className="w-4 h-4" aria-hidden />
            Reveal {batch.length} email{batch.length === 1 ? '' : 's'}?
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="p-1.5 text-muted hover:text-ink hover:bg-fill cursor-pointer disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-sm">
          <div className="divide-y divide-line-soft">
            <div className={row}>
              <span className="text-ink-2">Selected leads</span>
              <span className="font-medium text-ink tabular-nums">{selectedLeads.length}</span>
            </div>
            {alreadyRevealedCount > 0 && (
              <div className={row}>
                <span className="text-ink-2">Already revealed (free)</span>
                <span className="font-medium text-ink tabular-nums">{alreadyRevealedCount}</span>
              </div>
            )}
            {queuedCount > 0 && (
              <div className={row}>
                <span className="text-ink-2">Over the {MAX_BULK_REVEAL}-per-run limit (not charged)</span>
                <span className="font-medium text-ink tabular-nums">{queuedCount}</span>
              </div>
            )}
            <div className={row}>
              <span className="text-ink-2">Maximum charge</span>
              <span className="font-semibold text-ink tabular-nums">
                {maxCharge} credit{maxCharge === 1 ? '' : 's'}
              </span>
            </div>
            <div className={row}>
              <span className="text-ink-2">Available balance</span>
              <span className={`font-medium tabular-nums ${hasSufficientCredits ? 'text-ink' : 'text-danger'}`}>
                {balanceKnown ? `${availableCredits} credits` : 'Unavailable'}
              </span>
            </div>
          </div>

          <p className="flex items-start gap-2 text-[13px] text-ink-2 bg-ok-bg border border-ok-line p-3">
            <ShieldCheck className="w-4 h-4 text-ok shrink-0 mt-0.5" aria-hidden />
            <span>
              You are charged {EMAIL_REVEAL_CREDITS} credit only for each email that is found. Leads with no email
              found cost nothing.
            </span>
          </p>

          {!hasSufficientCredits && (
            <div role="alert" className="flex items-center justify-between gap-3 bg-danger-bg border border-danger-line p-3 text-[13px] text-danger-ink">
              <span className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden />
                Your balance covers {affordableCount} of {batch.length}.
              </span>
              {onNavigateBilling && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onNavigateBilling();
                  }}
                  className="px-2.5 h-8 bg-danger-strong hover:bg-danger text-white text-[13px] font-medium shrink-0 cursor-pointer"
                >
                  Top up
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 px-5 py-4 border-t border-line-soft">
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="h-10 px-4 border border-line hover:bg-fill text-ink-2 text-sm font-medium cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>

          {!hasSufficientCredits && affordableCount > 0 && (
            <button
              type="button"
              onClick={() => onConfirm(affordableCount)}
              disabled={isProcessing}
              className="h-10 px-4 border border-ink hover:bg-fill text-ink text-sm font-medium cursor-pointer disabled:opacity-50"
            >
              Reveal first {affordableCount}
            </button>
          )}

          <button
            ref={confirmRef}
            type="button"
            onClick={() => onConfirm(batch.length)}
            disabled={isProcessing || !hasSufficientCredits || batch.length === 0}
            className="h-10 px-4 bg-ink hover:bg-black text-white text-sm font-medium flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                <span>Revealing…</span>
              </>
            ) : (
              <span>Reveal {batch.length} · up to {maxCharge} cr</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
