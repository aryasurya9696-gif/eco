import React, { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { B2BLead } from '../../types';
import { usePricing } from '../../lib/pricing';
import { formatCredits, creditsLabel } from '../../lib/billing';
import { isWelcomeOnlyRefusal, WELCOME_ONLY_MESSAGE } from '../../lib/wallet-store';
import { useEcho } from '../../context/EchoContext';
import { ModalDialog } from '../dashboard/ModalDialog';
import { canEnrichPerson, enrichPeople, enrichPerson } from './person-enrich';

/**
 * "Enrich profile" for one lead, saved or not: treg.people.enrich fills a
 * missing title, company, location or LinkedIn URL. Hidden once the lead has
 * been enriched, or when there is nothing to match it on.
 */
export const EnrichPersonButton: React.FC<{ lead: B2BLead }> = ({ lead }) => {
  const { addToast } = useEcho();
  const { creditsFor } = usePricing();
  const [busy, setBusy] = useState(false);
  if (!canEnrichPerson(lead)) return null;
  const price = creditsFor('treg.people.enrich');

  const run = async () => {
    setBusy(true);
    const outcome = await enrichPerson(lead);
    setBusy(false);
    if (outcome.kind === 'found') {
      addToast(`Profile enriched for ${lead.full_name || 'this lead'} · ${creditsLabel(outcome.credits)}.`, 'success');
    } else if (outcome.kind === 'not_found') {
      addToast('No profile found for this lead. Nothing was charged.', 'info');
    } else if (outcome.kind === 'no_credits') {
      addToast(isWelcomeOnlyRefusal(outcome.error, price) ? WELCOME_ONLY_MESSAGE : 'Not enough credits to enrich this lead.', 'error');
    } else {
      addToast(outcome.message, 'error');
    }
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      title={`Fill in this lead's missing title, company, location and LinkedIn. ${creditsLabel(price)}, only when a profile is found.`}
      className="mt-1 inline-flex items-center gap-1 text-xs text-muted hover:text-ink hover:underline cursor-pointer disabled:opacity-60 disabled:cursor-wait"
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <Sparkles className="w-3 h-3" aria-hidden />}
      {busy ? 'Enriching…' : `Enrich profile · ${formatCredits(price)} cr`}
    </button>
  );
};

/** Bulk "Enrich profiles" for a selection, with the maximum cost confirmed first. */
export const BulkEnrichPeopleButton: React.FC<{ leads: B2BLead[] }> = ({ leads }) => {
  const { addToast } = useEcho();
  const { creditsFor } = usePricing();
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const eligible = leads.filter(canEnrichPerson);
  const price = creditsFor('treg.people.enrich');
  const running = progress !== null;

  const run = async () => {
    setConfirming(false);
    setProgress({ done: 0, total: eligible.length });
    const totals = await enrichPeople(eligible, (done) => setProgress({ done, total: eligible.length }));
    setProgress(null);
    const parts = [
      `${totals.found} enriched · ${creditsLabel(totals.credits)}`,
      totals.notFound > 0 ? `${totals.notFound} not found (free)` : '',
      totals.failed > 0 ? `${totals.failed} failed (free, can retry)` : '',
    ].filter(Boolean);
    if (totals.stoppedForCredits) {
      addToast(
        `${parts.join(' · ')}. Stopped: ${isWelcomeOnlyRefusal(totals.stoppedForCredits, price) ? WELCOME_ONLY_MESSAGE : 'not enough credits.'}`,
        'error',
      );
    } else {
      addToast(`${parts.join(' · ')}.`, totals.found > 0 ? 'success' : 'info');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={running || eligible.length === 0}
        title={eligible.length === 0 ? 'The selected leads are already enriched, or have nothing to match on' : undefined}
        className="h-9 px-3 border border-white/30 hover:bg-white/10 text-sm font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {running ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Sparkles className="w-4 h-4" aria-hidden />}
        {running ? `Enriching ${progress!.done}/${progress!.total}` : `Enrich ${eligible.length} profile${eligible.length === 1 ? '' : 's'}`}
      </button>
      {confirming && (
        <ModalDialog title="Enrich profiles" onClose={() => setConfirming(false)} className="max-w-sm">
          <div className="px-5 py-4 space-y-3 text-sm text-ink-2">
            <p>
              Fill in the missing title, company, location and LinkedIn for {eligible.length} lead{eligible.length === 1 ? '' : 's'}.
              {' '}{creditsLabel(price)} each, charged only when a profile is found.
            </p>
            <p className="font-medium text-ink">Up to {formatCredits(price * eligible.length)} credits.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="h-9 px-3 border border-line hover:bg-fill text-ink-2 text-sm font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void run()}
                className="h-9 px-3 bg-ink hover:bg-black text-white text-sm font-medium cursor-pointer"
              >
                Enrich {eligible.length}
              </button>
            </div>
          </div>
        </ModalDialog>
      )}
    </>
  );
};
