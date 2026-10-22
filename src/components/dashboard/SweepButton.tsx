import React, { useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { useEcho } from '../../context/EchoContext';
import { useAuth } from '../../context/AuthContext';
import { fetchBalance, type SweepQuote, type Wallet } from '../../lib/billing';
import { channelLabel, CHANNEL_LIMIT, creditsText, formatCreditAmount, KEYWORD_LIMIT } from '../../lib/constants';
import { usePricing } from '../../lib/pricing';
import { ModalDialog } from './ModalDialog';

interface SweepButtonProps {
  variant?: 'header' | 'empty';
  /** Opens Billing; shown when the balance cannot cover the sweep. */
  onNavigateBilling?: () => void;
  /** Opens Keywords; shown instead of a sweep when there is nothing to search. */
  onNavigateKeywords?: () => void;
}

/**
 * Runs a manual sweep, but only after saying what it will cost.
 *
 * The breakdown is computed from the live price list (or the public fallback)
 * and the saved settings, which is what the server sweeps. The total and the
 * balance come from the billing function's own quote when it answers, because
 * that is the number the reservation will use.
 */
export const SweepButton: React.FC<SweepButtonProps> = ({ variant = 'header', onNavigateBilling, onNavigateKeywords }) => {
  const { user } = useAuth();
  const { runSweep, isSweeping, keywords, savedChannels, hasUnsavedSettings } = useEcho();
  const pricing = usePricing(Boolean(user));
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<{ sweep: SweepQuote; wallet: Wallet } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);

  const keywordCount = Math.min(keywords.filter((k) => k.is_active).length, KEYWORD_LIMIT);
  const channels = savedChannels.slice(0, CHANNEL_LIMIT);
  const lines = channels.map((c) => {
    const each = pricing.channelCredits(c);
    return { channel: c, each, total: each * keywordCount };
  });
  const estimate = lines.reduce((sum, l) => sum + l.total, 0);
  const hasKeywords = keywordCount > 0;
  // "Free" describes a channel's price, not an empty total: 0.1 × 0 keywords is
  // still a paid channel that just has nothing to search yet.
  const allChannelsFree = lines.length > 0 && lines.every((l) => l.each === 0);

  const openPreview = async () => {
    setOpen(true);
    setQuote(null);
    setQuoteError(null);
    setIsQuoting(true);
    try {
      const res = await fetchBalance();
      if (res?.sweep && res?.wallet) setQuote({ sweep: res.sweep, wallet: res.wallet });
      else setQuoteError('The billing service did not return a quote.');
    } catch (err) {
      setQuoteError((err as Error)?.message || 'Could not check your balance.');
    } finally {
      setIsQuoting(false);
    }
  };

  const confirm = () => {
    setOpen(false);
    void runSweep();
  };

  const total = quote ? quote.sweep.credits : estimate;
  const shortfall = quote ? quote.sweep.shortfall : 0;
  const affordable = quote ? quote.sweep.affordable : true;

  const trigger =
    !hasKeywords && variant === 'empty' && onNavigateKeywords ? (
      <button
        type="button"
        onClick={onNavigateKeywords}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#141414] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer"
      >
        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
        <span>Add your first keyword</span>
      </button>
    ) : variant === 'header' ? (
      <button
        type="button"
        onClick={() => void openPreview()}
        disabled={isSweeping}
        className="inline-flex items-center gap-2 px-3.5 py-1.5 bg-[#121212] hover:bg-black text-white text-xs font-mono rounded-none transition-colors cursor-pointer disabled:opacity-50 shadow-xs"
      >
        <RefreshCw className={`w-3 h-3 ${isSweeping ? 'animate-spin' : ''}`} aria-hidden="true" />
        <span>{isSweeping ? 'Sweeping...' : 'Run sweep'}</span>
      </button>
    ) : (
      <button
        type="button"
        onClick={() => void openPreview()}
        disabled={isSweeping}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#141414] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer disabled:opacity-60"
      >
        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
        <span>{isSweeping ? 'Scanning...' : 'Run sweep now'}</span>
      </button>
    );

  return (
    <>
      {trigger}
      {open && (
        <ModalDialog title="Run a sweep now?" onClose={() => setOpen(false)}>
          <div className="px-5 pt-3 pb-4 space-y-3 text-xs text-[#4a4a47]">
            {!hasKeywords && (
              <p role="alert" className="text-[11px] font-mono text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1.5">
                You have no active keywords, so a sweep has nothing to search. Add a keyword first.
              </p>
            )}
            <p className="leading-relaxed">
              {keywordCount} keyword{keywordCount === 1 ? '' : 's'} × {channels.length} channel
              {channels.length === 1 ? '' : 's'} ={' '}
              <span className="font-semibold text-[#141414]">{creditsText(estimate)} per sweep</span>
              {lines.some((l) => l.each === 0) ? ' (News is free)' : ''}. Charged per keyword on each saved channel.
            </p>

            <table className="w-full text-[11px] font-mono">
              <caption className="sr-only">Sweep cost by channel</caption>
              <tbody className="divide-y divide-[#eeeeea]">
                {lines.map((l) => (
                  <tr key={l.channel}>
                    <th scope="row" className="py-1.5 text-left font-normal text-[#141414]">
                      {channelLabel(l.channel)}
                    </th>
                    <td className="py-1.5 text-right text-[#8a8a86]">
                      {l.each === 0 ? 'free' : `${formatCreditAmount(l.each)} × ${keywordCount}`}
                    </td>
                    <td className="py-1.5 pl-3 text-right text-[#141414] whitespace-nowrap">
                      {l.each === 0 ? 'Free' : formatCreditAmount(l.total)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="pt-2 text-left font-semibold text-[#141414]">
                    Total
                  </th>
                  <td />
                  <td className="pt-2 pl-3 text-right font-semibold text-[#141414] whitespace-nowrap">
                    {isQuoting ? '…' : creditsText(total)}
                  </td>
                </tr>
              </tbody>
            </table>

            <div aria-live="polite" className="space-y-2">
              {quote && (
                <p className="text-[11px] font-mono text-[#8a8a86]">
                  Available: <span className="text-[#141414]">{creditsText(quote.wallet.available)}</span>
                </p>
              )}
              {quoteError && (
                <p className="text-[11px] font-mono text-[#8a8a86]">
                  Could not check your balance ({quoteError}). The total above is an estimate; a sweep you
                  cannot afford is stopped before anything is charged.
                </p>
              )}
              {!affordable && (
                <p role="alert" className="text-[11px] font-mono text-[#8a2a2a] bg-[#fdf2f2] border border-[#f0c4c4] px-2.5 py-1.5">
                  You are {creditsText(shortfall)} short for this sweep.
                </p>
              )}
              {hasUnsavedSettings && (
                <p className="text-[11px] font-mono text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1.5">
                  You have unsaved changes in Settings. This sweep uses your saved settings.
                </p>
              )}
              {pricing.isFallback && !pricing.loading && (
                <p className="text-[10px] font-mono text-[#a8a8a2]">Per-channel prices from the published price list.</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#eeeeea] bg-[#fafaf9]">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3.5 py-1.5 text-[11px] font-mono border border-[#e3e3de] bg-white text-[#4a4a47] hover:bg-[#f6f6f4] cursor-pointer"
            >
              Cancel
            </button>
            {!hasKeywords && onNavigateKeywords ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNavigateKeywords();
                }}
                className="px-3.5 py-1.5 text-[11px] font-mono bg-[#141414] hover:bg-black text-white cursor-pointer"
              >
                Add keywords
              </button>
            ) : !affordable && onNavigateBilling ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNavigateBilling();
                }}
                className="px-3.5 py-1.5 text-[11px] font-mono bg-[#141414] hover:bg-black text-white cursor-pointer"
              >
                Buy credits
              </button>
            ) : (
              <button
                type="button"
                onClick={confirm}
                disabled={isQuoting || !affordable || keywordCount === 0}
                className="px-3.5 py-1.5 text-[11px] font-mono bg-[#141414] hover:bg-black text-white cursor-pointer disabled:opacity-50"
              >
                {allChannelsFree ? 'Run sweep (free)' : `Run sweep · ${creditsText(total)}`}
              </button>
            )}
          </div>
        </ModalDialog>
      )}
    </>
  );
};
