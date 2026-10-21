import React, { useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck, AlertCircle, X, Loader2, Search } from 'lucide-react';
import type { B2BLead } from '../../types';
import { needsEmailReveal, revealedPhone } from './lead-utils';
import { useLeadPricing } from './leads-store';

interface ConfirmRevealModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (opts: { email: boolean; phone: boolean }) => void;
  leads: B2BLead[];
  /** Which details start ticked (normally the options the search ran with). */
  defaultEmail?: boolean;
  defaultPhone?: boolean;
  /** null when the balance could not be loaded. */
  availableCredits: number | null;
  isProcessing: boolean;
  onNavigateBilling?: () => void;
}

/**
 * Confirms a contact lookup for a set of leads before any credits are spent.
 * The figure quoted is the most the run can cost; misses are never charged,
 * and leads that already have the detail are left out of the count.
 */
export const ConfirmRevealModal: React.FC<ConfirmRevealModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  leads,
  defaultEmail = true,
  defaultPhone = false,
  availableCredits,
  isProcessing,
  onNavigateBilling,
}) => {
  const titleId = useId();
  const pricing = useLeadPricing();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [wantEmail, setWantEmail] = useState(defaultEmail);
  const [wantPhone, setWantPhone] = useState(defaultPhone);

  // Reset the choices each time the dialog opens (adjusted during render).
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setWantEmail(defaultEmail);
      setWantPhone(defaultPhone);
    }
  }

  // Focus moves into the dialog on open and back on close; Escape closes it
  // and Tab stays inside it.
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
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
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

  const emailNeeded = leads.filter(needsEmailReveal).length;
  const phoneNeeded = leads.filter((l) => !revealedPhone(l)).length;
  const emailCost = wantEmail ? emailNeeded * pricing.email : 0;
  const phoneCost = wantPhone ? phoneNeeded * pricing.phone : 0;
  const maxCharge = emailCost + phoneCost;
  const lookups = (wantEmail ? emailNeeded : 0) + (wantPhone ? phoneNeeded : 0);
  const balanceKnown = availableCredits !== null;
  const shortfall = balanceKnown && (availableCredits ?? 0) < maxCharge;

  const row = 'flex items-center justify-between gap-4 py-2';
  const option = (
    checked: boolean,
    onChange: (v: boolean) => void,
    label: string,
    count: number,
    price: number,
  ) => (
    <label className={`flex items-start gap-3 p-3 border cursor-pointer ${checked ? 'border-ink' : 'border-line'} ${count === 0 ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        checked={checked && count > 0}
        disabled={count === 0 || isProcessing}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-ink shrink-0"
      />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="block text-xs text-muted">
          {count === 0
            ? 'All selected leads already have one.'
            : `${count} lead${count === 1 ? '' : 's'} · ${price} credit${price === 1 ? '' : 's'} each, only when found`}
        </span>
      </span>
    </label>
  );

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
            <Search className="w-4 h-4" aria-hidden />
            Find contact details for {leads.length} lead{leads.length === 1 ? '' : 's'}
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
          <div className="space-y-2">
            {option(wantEmail, setWantEmail, 'Work emails', emailNeeded, pricing.email)}
            {option(wantPhone, setWantPhone, 'Direct phone numbers', phoneNeeded, pricing.phone)}
          </div>

          <div className="divide-y divide-line-soft">
            <div className={row}>
              <span className="text-ink-2">Maximum charge</span>
              <span className="font-semibold text-ink tabular-nums">
                {maxCharge} credit{maxCharge === 1 ? '' : 's'}
              </span>
            </div>
            <div className={row}>
              <span className="text-ink-2">Available balance</span>
              <span className={`font-medium tabular-nums ${shortfall ? 'text-danger' : 'text-ink'}`}>
                {balanceKnown ? `${availableCredits} credits` : 'Unavailable'}
              </span>
            </div>
          </div>

          <p className="flex items-start gap-2 text-[13px] text-ink-2 bg-ok-bg border border-ok-line p-3">
            <ShieldCheck className="w-4 h-4 text-ok shrink-0 mt-0.5" aria-hidden />
            <span>Credits are charged only for details that are found. Lookups that find nothing, or fail, cost nothing.</span>
          </p>

          {shortfall && (
            <div role="alert" className="flex items-center justify-between gap-3 bg-warn-bg border border-warn-line p-3 text-[13px] text-ink">
              <span className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-warn" aria-hidden />
                Your balance may run out part-way. Lookups stop when it does, and the rest are marked "skipped".
              </span>
              {onNavigateBilling && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onNavigateBilling();
                  }}
                  className="px-2.5 h-8 bg-ink hover:bg-black text-white text-[13px] font-medium shrink-0 cursor-pointer"
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
          <button
            ref={confirmRef}
            type="button"
            onClick={() => onConfirm({ email: wantEmail && emailNeeded > 0, phone: wantPhone && phoneNeeded > 0 })}
            disabled={isProcessing || lookups === 0 || (balanceKnown && (availableCredits ?? 0) <= 0)}
            className="h-10 px-4 bg-ink hover:bg-black text-white text-sm font-medium flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                <span>Queuing…</span>
              </>
            ) : (
              <span>Find {lookups} detail{lookups === 1 ? '' : 's'} · up to {maxCharge} cr</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
