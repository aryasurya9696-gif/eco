import React, { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { B2BLead } from '../../types';
import { invokeFunction, ApiError } from '../../lib/api';
import { usePricing } from '../../lib/pricing';
import { formatCredits, creditsLabel } from '../../lib/billing';
import { walletStore, isWelcomeOnlyRefusal, WELCOME_ONLY_MESSAGE } from '../../lib/wallet-store';
import { useEcho } from '../../context/EchoContext';
import { leadsStore } from './leads-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The saved row id, or null for a lead that is not saved. */
function savedId(lead: B2BLead): string | null {
  const id = lead.db_id || lead.id;
  return id && UUID_RE.test(id) ? id : null;
}

/**
 * "Enrich profile" for one saved lead: treg.people.enrich fills a missing
 * title, company, location or LinkedIn URL. Hidden once the lead has been
 * enriched, and for leads that are not saved.
 */
export const EnrichPersonButton: React.FC<{ lead: B2BLead }> = ({ lead }) => {
  const { addToast } = useEcho();
  const { creditsFor } = usePricing();
  const [busy, setBusy] = useState(false);
  const id = savedId(lead);
  if (!id || lead.person_enriched_at) return null;
  const price = creditsFor('treg.people.enrich');

  const run = async () => {
    setBusy(true);
    try {
      const res = await invokeFunction<{ ok: boolean; lead?: Partial<B2BLead>; credits_charged?: number }>('leads', {
        action: 'enrich-person',
        lead_id: id,
      });
      if (res?.lead) leadsStore.applySavedLead(res.lead);
      addToast(`Profile enriched for ${lead.full_name || 'this lead'} · ${creditsLabel(res?.credits_charged ?? 0)}.`, 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        addToast('No profile found for this lead. Nothing was charged.', 'info');
      } else if (err instanceof ApiError && err.status === 402) {
        addToast(isWelcomeOnlyRefusal(err, price) ? WELCOME_ONLY_MESSAGE : 'Not enough credits to enrich this lead.', 'error');
      } else {
        addToast((err as Error)?.message || 'Enrichment failed. Please try again.', 'error');
      }
    } finally {
      setBusy(false);
      void walletStore.refresh();
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
