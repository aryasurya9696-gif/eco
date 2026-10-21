import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { invokeFunction, ApiError } from '../../lib/api';
import { formatCredits } from '../../lib/billing';
import { useEcho } from '../../context/EchoContext';
import { useAuth } from '../../context/AuthContext';
import { ProspectorView } from './ProspectorView';
import type { ProspectorSearchParams } from './prospector-types';
import { QuickLookupView } from './QuickLookupView';
import { SavedLeadsView } from './SavedLeadsView';
import { leadsStore, useLeadsStore } from './leads-store';
import { walletStore, useWallet, isWelcomeOnlyRefusal, WELCOME_ONLY_MESSAGE } from '../../lib/wallet-store';
import { foundEmail, leadKey, revealedEmail, revealedPhone } from './lead-utils';
import { Search, Zap, Bookmark, Wallet as WalletIcon, Plus } from 'lucide-react';

interface LeadsTabProps {
  onNavigateBilling?: () => void;
}

type SubTab = 'prospector' | 'quick' | 'saved';

/** What a single reveal produced, so Quick Lookup can show the right state. */
export type RevealOutcome =
  | { kind: 'found'; lead: B2BLead; cached: boolean; credits: number }
  | { kind: 'not_found' }
  /** message is set when the refusal needs explaining (welcome credits only). */
  | { kind: 'no_credits'; message?: string }
  | { kind: 'error'; message: string };

/** Same person, whichever of the three identities the caller has to hand. */
function sameLead(a: B2BLead, b: B2BLead): boolean {
  return (
    a.id === b.id ||
    Boolean(b.db_id && (a.id === b.db_id || a.db_id === b.db_id)) ||
    leadKey(a) === leadKey(b)
  );
}

export const LeadsTab: React.FC<LeadsTabProps> = ({ onNavigateBilling }) => {
  const { addToast } = useEcho();
  const { user } = useAuth();
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('prospector');

  // Bind the workspace store to this user before reading it, so a refresh
  // restores this user's results and never another account's.
  const uid = user?.id ?? null;
  if (leadsStore.getSnapshot().userId !== uid) leadsStore.init(uid, addToast);
  const store = useLeadsStore();
  const { leads, savedLeads, enrichment } = store;
  // The shared wallet store (also shown in the Sidebar and Billing).
  const { balance: availableCredits } = useWallet();

  useEffect(() => {
    leadsStore.init(uid, addToast);
  }, [uid, addToast]);

  useEffect(() => {
    // The wallet store also re-reads on window focus (a top-up happens on
    // the payment provider's site).
    void walletStore.refresh();
    void leadsStore.loadSaved();
    void leadsStore.loadPricing();
  }, [uid]);

  // Row spinners come from the queue itself, so a row shows "processing"
  // exactly while the server is working on it.
  const revealingEmailIds = useMemo(
    () => new Set(leads.filter((l) => l.email_lookup === 'queued' || l.email_lookup === 'processing').map((l) => l.id)),
    [leads],
  );
  const revealingPhoneIds = useMemo(
    () => new Set(leads.filter((l) => l.phone_lookup === 'queued' || l.phone_lookup === 'processing').map((l) => l.id)),
    [leads],
  );

  const handleSearch = async (params: ProspectorSearchParams) => {
    // Searching requires credits (the store and the server both refuse on an
    // empty wallet), so every search goes straight on to verified contacts.
    await leadsStore.search(params, { email: params.autoEnrich, phone: params.autoPhone });
  };

  // ---- Prospector reveals all go through the shared queue -----------------
  const queueEmail = async (lead: B2BLead) => {
    leadsStore.enrichLeads([lead.id], { email: true });
  };
  const queuePhone = async (lead: B2BLead) => {
    leadsStore.enrichLeads([lead.id], { phone: true });
  };
  const queueBulkContacts = (selected: B2BLead[], opts: { email: boolean; phone: boolean }) => {
    const added = leadsStore.enrichLeads(selected.map((l) => l.id), opts);
    if (added === 0) addToast('Those leads already have the requested contact details.', 'info');
    return added;
  };

  // ---- Quick Lookup: a one-off reveal outside the result list -------------
  const inFlight = useRef(new Set<string>());

  const revealOne = async (lead: B2BLead, kind: 'email' | 'phone'): Promise<RevealOutcome> => {
    const flightKey = `${kind}:${leadKey(lead) || lead.linkedin_url || lead.id}`;
    if (inFlight.current.has(flightKey)) return { kind: 'error', message: 'A lookup for this contact is already running.' };
    inFlight.current.add(flightKey);
    try {
      const res = await invokeFunction<{
        ok: boolean;
        lead?: Partial<B2BLead>;
        credits_charged: number;
        already_revealed?: boolean;
      }>('leads', {
        action: kind === 'email' ? 'reveal-email' : 'reveal-phone',
        full_name: lead.full_name,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company_domain: lead.company_domain,
        company_name: lead.company_name,
        title: lead.title,
        linkedin_url: lead.linkedin_url,
        location: lead.location,
        work_email: kind === 'phone' ? revealedEmail(lead) || undefined : undefined,
      });
      const saved = res?.lead;
      const value = kind === 'email' ? saved?.work_email || saved?.revealed_email : saved?.phone_number || saved?.revealed_phone;
      if (!res?.ok || !saved || !value) return { kind: 'not_found' };

      const merged: B2BLead = {
        ...lead,
        ...(saved as B2BLead),
        id: lead.id,
        db_id: saved.id || lead.db_id || null,
        revealed_email: kind === 'email' ? value : revealedEmail(lead) || saved.work_email || null,
        work_email: kind === 'email' ? value : revealedEmail(lead) || saved.work_email || null,
        revealed_phone: kind === 'phone' ? value : revealedPhone(lead) || saved.phone_number || null,
        phone_number: kind === 'phone' ? value : revealedPhone(lead) || saved.phone_number || null,
        email_lookup: null,
        phone_lookup: null,
        is_saved: true,
      };
      leadsStore.applySavedLead(saved);
      leadsStore.setLeads((prev) => prev.map((l) => (sameLead(l, merged) ? { ...l, ...merged, id: l.id } : l)));
      return { kind: 'found', lead: merged, cached: Boolean(res.already_revealed), credits: res.credits_charged ?? 0 };
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        const price = kind === 'email' ? store.pricing.email : store.pricing.phone;
        return isWelcomeOnlyRefusal(err, price) ? { kind: 'no_credits', message: WELCOME_ONLY_MESSAGE } : { kind: 'no_credits' };
      }
      if (err instanceof ApiError && err.status === 404) return { kind: 'not_found' };
      return { kind: 'error', message: (err as Error)?.message || 'Lookup failed. Please try again.' };
    } finally {
      inFlight.current.delete(flightKey);
      // A reveal is a charging action (and a miss may still release a hold).
      void walletStore.refresh();
    }
  };

  // ---- Pipeline -----------------------------------------------------------
  const handleBulkSave = async (selected: B2BLead[]) => {
    if (selected.length === 0) return null;
    try {
      const res = await leadsStore.bulkSave(selected);

      const added = res.new_count ?? res.saved_count;
      const existing = res.already_saved_count ?? 0;
      const skipped = res.skipped_count ?? 0;
      addToast(
        [
          added > 0 ? `Added ${added} lead${added === 1 ? '' : 's'} to your pipeline` : 'No new leads added',
          existing > 0 ? `${existing} already saved` : '',
          skipped > 0 ? `${skipped} skipped (no name)` : '',
        ].filter(Boolean).join(' · ') + '.',
        added > 0 ? 'success' : 'info',
      );
      return res;
    } catch (err) {
      addToast('Could not save leads: ' + ((err as Error)?.message || 'unknown error'), 'error');
      return null;
    }
  };

  const handleDeleteSavedLead = async (lead: B2BLead) => {
    try {
      const res = await invokeFunction<{ ok: boolean; deleted_count: number }>('leads', {
        action: 'delete-saved',
        lead_id: lead.db_id || (lead.id.length === 36 ? lead.id : undefined),
        company_domain: lead.company_domain,
        full_name: lead.full_name,
      });
      if (res?.ok) {
        leadsStore.setSavedLeads((prev) => prev.filter((l) => !sameLead(l, lead) && l.db_id !== lead.id));
        leadsStore.setLeads((prev) =>
          prev.map((l) => (sameLead(l, lead) ? { ...l, is_saved: false, db_id: null, status: undefined } : l)),
        );
        addToast('Lead removed from pipeline.', 'info');
      }
    } catch (err) {
      addToast((err as Error)?.message || 'Failed to remove lead', 'error');
    }
  };

  const handleBulkDeleteSavedLeads = async (leadsToDelete: B2BLead[]) => {
    if (leadsToDelete.length === 0) return;
    try {
      const withId = leadsToDelete.filter((l) => {
        const id = l.db_id || l.id;
        return typeof id === 'string' && id.length === 36;
      });
      const ids = withId.map((l) => (l.db_id || l.id) as string);
      // The server deletes by id only; a row without one cannot be targeted.
      if (ids.length === 0) {
        addToast('Could not identify those leads. Refresh the pipeline and try again.', 'error');
        void leadsStore.loadSaved();
        return;
      }
      const res = await invokeFunction<{ ok: boolean; deleted_count: number }>('leads', {
        action: 'delete-saved',
        lead_ids: ids,
      });
      if (res?.ok) {
        const deletedKeys = new Set(withId.map(leadKey));
        const deletedIds = new Set(ids);
        const isDeleted = (l: B2BLead) =>
          deletedIds.has(l.id) || deletedIds.has(l.db_id || '') || deletedKeys.has(leadKey(l));
        leadsStore.setSavedLeads((prev) => prev.filter((l) => !isDeleted(l)));
        leadsStore.setLeads((prev) =>
          prev.map((l) => (isDeleted(l) ? { ...l, is_saved: false, db_id: null, status: undefined } : l)),
        );
        const removed = typeof res.deleted_count === 'number' ? res.deleted_count : leadsToDelete.length;
        addToast(removed > 0 ? `Removed ${removed} lead(s) from pipeline.` : 'Those leads were already removed.', 'info');
      }
    } catch (err) {
      addToast((err as Error)?.message || 'Failed to remove leads', 'error');
    }
  };

  const handleSaveLead = async (lead: B2BLead) => {
    if (lead.is_saved) {
      await handleDeleteSavedLead(lead);
      return null;
    }
    const res = await handleBulkSave([lead]);
    return res?.leads?.[0] ?? null;
  };

  // Changing the stage saves an unsaved prospect with that stage.
  const handleStatusChange = async (lead: B2BLead, status: B2BPipelineStatus): Promise<boolean> => {
    const previous = lead.status;
    const previousSaved = Boolean(lead.is_saved);
    const patch = (l: B2BLead) => (sameLead(l, lead) ? { ...l, status, is_saved: true } : l);
    leadsStore.setLeads((prev) => prev.map(patch));
    leadsStore.setSavedLeads((prev) => prev.map(patch));

    try {
      const res = await invokeFunction<{ ok: boolean; lead?: Partial<B2BLead>; auto_saved?: boolean }>('leads', {
        action: 'update-status',
        lead_id: lead.db_id || undefined,
        company_domain: lead.company_domain,
        company_name: lead.company_name,
        full_name: lead.full_name,
        first_name: lead.first_name,
        last_name: lead.last_name,
        title: lead.title,
        work_email: foundEmail(lead) || undefined,
        phone_number: revealedPhone(lead) || undefined,
        linkedin_url: lead.linkedin_url,
        location: lead.location,
        status,
      });
      if (!res?.ok) throw new Error('Update rejected');
      if (res.lead?.id) {
        const dbId = res.lead.id;
        leadsStore.setLeads((prev) => prev.map((l) => (sameLead(l, lead) ? { ...l, db_id: dbId, is_saved: true, status } : l)));
      }
      leadsStore.applySavedLead(res.lead || { ...lead, status });
      addToast(res.auto_saved ? `Saved to pipeline as "${status}".` : `Stage updated to "${status}".`, 'success');
      return true;
    } catch (err) {
      const rollback = (l: B2BLead) => (sameLead(l, lead) ? { ...l, status: previous, is_saved: previousSaved } : l);
      leadsStore.setLeads((prev) => prev.map(rollback));
      leadsStore.setSavedLeads((prev) => prev.map(rollback));
      addToast((err as Error)?.message || 'Failed to update stage', 'error');
      return false;
    }
  };

  const tabs: { id: SubTab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'prospector', label: 'Prospector', icon: <Search className="w-4 h-4" /> },
    { id: 'quick', label: 'Quick lookup', icon: <Zap className="w-4 h-4" /> },
    { id: 'saved', label: 'Saved pipeline', icon: <Bookmark className="w-4 h-4" />, count: savedLeads.length },
  ];
  const enriching = enrichment?.state === 'running' || enrichment?.state === 'stopping';

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-surface overflow-hidden">
      <div className="bg-white border-b border-line shrink-0">
        <div className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
          <nav className="flex items-center gap-1 overflow-x-auto -mx-1 px-1 [scrollbar-width:none]" aria-label="Leads sections">
            {tabs.map((tab) => {
              const active = activeSubTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSubTab(tab.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`h-9 px-3 text-sm font-medium flex items-center gap-2 whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                    active ? 'bg-ink text-white' : 'text-ink-2 hover:text-ink hover:bg-fill'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                  {typeof tab.count === 'number' && (
                    <span
                      className={`min-w-5 h-5 px-1.5 inline-flex items-center justify-center text-[11px] font-semibold tabular-nums ${
                        active ? 'bg-white/20 text-white' : 'bg-fill text-ink-2'
                      }`}
                    >
                      {tab.count}
                    </span>
                  )}
                  {tab.id === 'prospector' && enriching && !active && (
                    <span className="w-2 h-2 rounded-full bg-info animate-pulse" aria-label="Enrichment running" />
                  )}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <div
              className={`h-9 px-3 flex items-center gap-2 border text-sm ${
                availableCredits !== null && availableCredits <= 0 ? 'border-warn-line bg-warn-bg' : 'border-line bg-surface-2'
              }`}
              title="Credits available to spend (balance minus any credits held for a running job)"
            >
              <WalletIcon className="w-4 h-4 text-muted" aria-hidden />
              {/* "—" while unknown or when the balance could not be read, never 0. */}
              <span>
                <span className="font-semibold text-ink tabular-nums">{formatCredits(availableCredits)}</span>
                <span className="text-muted"> credits</span>
              </span>
            </div>
            {onNavigateBilling && (
              <button
                type="button"
                onClick={onNavigateBilling}
                className="h-9 px-3 bg-ink hover:bg-black text-white text-sm font-medium flex items-center gap-1.5 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                <Plus className="w-4 h-4" aria-hidden />
                <span>Top up</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Not <main>: the dashboard shell already provides the page's main landmark. */}
      <div className="flex-1 overflow-y-auto" id="leads-scroll">
        <div className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6">
          {activeSubTab === 'prospector' ? (
            <ProspectorView
              userId={uid}
              pricing={store.pricing}
              onSearch={handleSearch}
              onRevealEmail={queueEmail}
              onRevealPhone={queuePhone}
              onEnrichContacts={queueBulkContacts}
              onStopEnrichment={leadsStore.stopEnrichment}
              onBulkSave={handleBulkSave}
              onSaveLead={handleSaveLead}
              onStatusChange={handleStatusChange}
              leads={leads}
              searchStatus={store.searchStatus}
              lastSearch={store.lastSearch}
              enrichment={enrichment}
              isBulkRevealing={enriching}
              revealingEmailIds={revealingEmailIds}
              revealingPhoneIds={revealingPhoneIds}
              availableCredits={availableCredits}
              onNavigateBilling={onNavigateBilling}
            />
          ) : activeSubTab === 'quick' ? (
            <QuickLookupView
              onReveal={revealOne}
              onSaveLead={handleSaveLead}
              onStatusChange={handleStatusChange}
              savedLeads={savedLeads}
              availableCredits={availableCredits}
              onNavigateBilling={onNavigateBilling}
            />
          ) : (
            <SavedLeadsView
              leads={savedLeads}
              isLoading={store.isLoadingSaved}
              hasLoaded={store.savedLoaded}
              onStatusChange={handleStatusChange}
              onDeleteLead={handleDeleteSavedLead}
              onBulkDelete={handleBulkDeleteSavedLeads}
              onRefresh={() => leadsStore.loadSaved(true)}
              limitReached={store.savedLimitReached}
              onGoToProspector={() => setActiveSubTab('prospector')}
            />
          )}
        </div>
      </div>
    </div>
  );
};
