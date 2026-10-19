import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { invokeFunction, ApiError } from '../../lib/api';
import { fetchBalance, formatCredits, type Wallet } from '../../lib/billing';
import { useEcho } from '../../context/EchoContext';
import {
  ProspectorView,
  type ProspectorSearchParams,
  type LastSearch,
  type SearchStatus,
} from './ProspectorView';
import { QuickLookupView } from './QuickLookupView';
import { SavedLeadsView } from './SavedLeadsView';
import { leadKey, revealedEmail, EMAIL_REVEAL_CREDITS, PHONE_REVEAL_CREDITS } from './lead-utils';
import { Search, Zap, Bookmark, Wallet as WalletIcon, Plus } from 'lucide-react';

interface LeadsTabProps {
  onNavigateBilling?: () => void;
}

type SubTab = 'prospector' | 'quick' | 'saved';

/**
 * Merges a persisted lead into a client-side one.
 *
 * The server returns the saved row under `work_email`/`phone_number`, while
 * search results carry `revealed_email`/`revealed_phone`. Writing only one of
 * the two pairings is how the revealed address ends up on screen in one view
 * and missing in the next one.
 */
function mergeRevealed(prev: B2BLead, saved: Partial<B2BLead> | undefined, revealed: string): B2BLead {
  const email = saved?.work_email || saved?.revealed_email || revealed;
  return {
    ...prev,
    ...(saved || {}),
    id: prev.id,
    db_id: saved?.db_id || saved?.id || prev.db_id || null,
    preview_email: prev.preview_email,
    revealed_email: email,
    work_email: email,
    revealed_phone: saved?.phone_number || saved?.revealed_phone || prev.revealed_phone || prev.phone_number || null,
    phone_number: saved?.phone_number || saved?.revealed_phone || prev.phone_number || prev.revealed_phone || null,
    email_status: saved?.email_status || prev.email_status,
    company_name: (saved?.company_name && saved.company_name !== 'Target Company') ? saved.company_name : prev.company_name,
    company_domain: saved?.company_domain || prev.company_domain,
    title: (saved?.title && saved.title !== 'Target Decision Maker') ? saved.title : prev.title,
    location: saved?.location || prev.location,
    is_saved: true,
  };
}

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
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('prospector');

  const [leads, setLeads] = useState<B2BLead[]>([]);
  const [savedLeads, setSavedLeads] = useState<B2BLead[]>([]);
  const [savedLimitReached, setSavedLimitReached] = useState(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState(false);
  const [isBulkRevealing, setIsBulkRevealing] = useState(false);
  const [revealingEmailIds, setRevealingEmailIds] = useState<ReadonlySet<string>>(new Set());
  const [revealingPhoneIds, setRevealingPhoneIds] = useState<ReadonlySet<string>>(new Set());
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>({ kind: 'idle' });
  const [lastSearch, setLastSearch] = useState<LastSearch | null>(null);

  // Synchronous in-flight guards. State updates are batched, so a fast double
  // click reads the old state twice and fires two requests — two reveals of
  // the same lead are two credit holds. The refs are checked before anything
  // is sent; the state copies only drive the spinners.
  const searchSeq = useRef(0);
  const searchInFlight = useRef(false);
  const emailInFlight = useRef(new Set<string>());
  const phoneInFlight = useRef(new Set<string>());
  const bulkInFlight = useRef(false);

  const loadBalance = useCallback(async () => {
    try {
      const res = await fetchBalance();
      if (res?.wallet) setWallet(res.wallet);
    } catch (err) {
      console.warn('Failed to load wallet balance', err);
    }
  }, []);

  // The wallet is topped up outside this tab. Refresh it when the window
  // regains focus so affordability copy is not based on an old balance.
  useEffect(() => {
    const onFocus = () => {
      void loadBalance();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadBalance]);

  const loadSavedLeads = useCallback(async (showSpinner = false) => {
    if (showSpinner) setIsLoadingSaved(true);
    try {
      const res = await invokeFunction<{
        ok: boolean;
        leads: B2BLead[];
        limit_reached?: boolean;
      }>('leads', { action: 'list-saved' });
      if (res?.ok && Array.isArray(res.leads)) {
        setSavedLeads(res.leads.map((l) => ({ ...l, db_id: l.db_id || l.id, is_saved: true })));
        setSavedLimitReached(Boolean(res.limit_reached));
      }
    } catch (err) {
      console.warn('Failed to load saved leads', err);
    } finally {
      if (showSpinner) setIsLoadingSaved(false);
    }
  }, []);

  useEffect(() => {
    void loadBalance();
    void loadSavedLeads();
  }, [loadBalance, loadSavedLeads]);

  /** Refreshes the wallet and pipeline without holding up the caller. */
  const refreshAfterWrite = useCallback(() => {
    void Promise.all([loadBalance(), loadSavedLeads()]);
  }, [loadBalance, loadSavedLeads]);

  const availableCredits = wallet ? Number(wallet.available) : null;

  const handleSearch = async (params: ProspectorSearchParams) => {
    // One search at a time. The button is disabled while one runs, but a
    // preset click or an Enter press in a field can still land in between.
    if (searchInFlight.current) return;
    searchInFlight.current = true;
    const seq = ++searchSeq.current;

    // A wallet with nothing in it cannot fund a single enrich. Asking for it
    // anyway meant the provider work was attempted, nothing was found, and the
    // panel still carried an "auto-enriched" badge over a list with no
    // contacts on it. Skipping it is free; pretending to do it is not.
    const walletIsKnownEmpty = availableCredits !== null && availableCredits <= 0;
    const willEnrich = params.autoEnrich && !walletIsKnownEmpty;

    setSearchStatus({ kind: 'searching', params, enriching: willEnrich });
    try {
      const res = await invokeFunction<{
        ok: boolean;
        people: B2BLead[];
        count: number;
        requested_limit?: number;
        enriched_count?: number;
        credits_charged?: number;
        enrichment_pending?: number;
        enrichment_limited_by?: 'cap' | 'balance' | null;
        skipped_domains?: number;
        failed_batches?: number;
      }>('leads', {
        action: 'search',
        company_domain: params.companyDomain,
        title: params.title,
        q: params.q,
        country: params.country,
        location: params.location,
        limit: params.limit,
        auto_enrich: willEnrich,
      });

      // A newer search started while this one was in flight: its results win.
      if (seq !== searchSeq.current) return;

      if (!res?.ok || !Array.isArray(res.people)) {
        throw new Error('The search returned an unexpected response.');
      }

      setLeads(res.people);
      setLastSearch({
        params,
        requested: res.requested_limit ?? params.limit,
        count: res.people.length,
        enrichRequested: willEnrich,
        enrichedCount: res.enriched_count ?? 0,
        creditsCharged: res.credits_charged ?? 0,
        enrichmentPending: res.enrichment_pending ?? 0,
        enrichmentLimitedBy: res.enrichment_limited_by ?? null,
        skippedDomains: res.skipped_domains ?? 0,
        failedBatches: res.failed_batches ?? 0,
        completedAt: Date.now(),
      });
      setSearchStatus({ kind: 'done' });
      refreshAfterWrite();

      if (res.people.length === 0) {
        addToast('No leads matched these filters. Try a broader role, keyword or location.', 'info');
      } else if (willEnrich) {
        const enriched = res.enriched_count ?? 0;
        addToast(
          enriched > 0
            ? `Found ${res.people.length} leads · ${enriched} verified emails (${res.credits_charged ?? enriched} credits).`
            : `Found ${res.people.length} leads · no verified emails resolved, 0 credits charged.`,
          enriched > 0 ? 'success' : 'info',
        );
      } else {
        addToast(`Found ${res.people.length} leads.`, 'success');
      }
    } catch (err) {
      if (seq !== searchSeq.current) return;
      // The previous results stay on screen: a failed refinement should not
      // wipe the list the user was working from.
      const message =
        err instanceof ApiError || err instanceof Error ? err.message : 'Search failed. Please try again.';
      setSearchStatus({ kind: 'error', message: message || 'Search failed. Please try again.', params });
    } finally {
      if (seq === searchSeq.current) searchInFlight.current = false;
    }
  };

  /** Shared by the Prospector, the cards view and Quick Lookup. */
  const applySavedLead = useCallback((saved: Partial<B2BLead> | null | undefined) => {
    if (!saved) return;
    setSavedLeads((prev) => {
      const key = leadKey({ company_domain: saved.company_domain ?? '', full_name: saved.full_name ?? '' });
      const index = prev.findIndex(
        (l) => (saved.id && (l.id === saved.id || l.db_id === saved.id)) || leadKey(l) === key,
      );
      const normalized: B2BLead = {
        ...(saved as B2BLead),
        id: saved.id || (index !== -1 ? prev[index].id : `saved_${Date.now()}`),
        db_id: saved.db_id || saved.id || (index !== -1 ? prev[index].db_id : null),
        is_saved: true,
      };
      if (index === -1) return [normalized, ...prev];
      const next = [...prev];
      next[index] = { ...next[index], ...normalized };
      return next;
    });
  }, []);

  const patchLead = (target: B2BLead, patch: Partial<B2BLead>) => {
    setLeads((prev) => prev.map((l) => (sameLead(l, target) ? { ...l, ...patch } : l)));
  };

  const setFlag = (
    setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
    id: string,
    on: boolean,
  ) => {
    setter((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // Reveal Email (single, 1 credit; misses are refunded server-side)
  const handleRevealEmail = async (lead: B2BLead): Promise<B2BLead | null> => {
    const flightKey = leadKey(lead) || lead.id;
    if (emailInFlight.current.has(flightKey)) return null;
    emailInFlight.current.add(flightKey);
    setFlag(setRevealingEmailIds, lead.id, true);
    try {
      const res = await invokeFunction<{
        ok: boolean;
        lead?: Partial<B2BLead>;
        credits_charged: number;
        already_revealed?: boolean;
      }>('leads', {
        action: 'reveal-email',
        full_name: lead.full_name,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company_domain: lead.company_domain,
        company_name: lead.company_name,
        title: lead.title,
        linkedin_url: lead.linkedin_url,
        company_size: lead.company_size,
        company_revenue: lead.company_revenue,
        location: lead.location,
      });

      if (!res?.ok) return null;

      const email = res.lead?.work_email || res.lead?.revealed_email;
      if (!email) return null;

      const updated = mergeRevealed(lead, res.lead, email);
      setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, ...updated } : l)));
      applySavedLead(res.lead);
      void loadBalance();

      addToast(
        res.already_revealed
          ? `${lead.full_name || 'Lead'}: email already on file (0 credits).`
          : `Email revealed for ${lead.full_name || 'lead'} (${res.credits_charged ?? EMAIL_REVEAL_CREDITS} credit).`,
        res.already_revealed ? 'info' : 'success',
      );
      return updated;
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        addToast('Not enough credits to reveal this email. Top up to continue.', 'error');
      } else if (err instanceof ApiError && err.status === 404) {
        // A miss is refunded server-side, so say that rather than "failed".
        patchLead(lead, { email_status: 'not_found' });
        addToast(`No email found for ${lead.full_name || 'this lead'} — 0 credits charged.`, 'info');
      } else {
        addToast((err as Error)?.message || 'Email reveal failed.', 'error');
      }
      return null;
    } finally {
      emailInFlight.current.delete(flightKey);
      setFlag(setRevealingEmailIds, lead.id, false);
    }
  };

  // Bulk Reveal Emails
  const handleBulkRevealEmails = async (selected: B2BLead[]) => {
    if (selected.length === 0 || bulkInFlight.current) return;
    bulkInFlight.current = true;
    setIsBulkRevealing(true);
    try {
      const res = await invokeFunction<{
        ok: boolean;
        revealed_count: number;
        credits_charged: number;
        already_revealed_count?: number;
        processed_count?: number;
        capped_count?: number;
        updated_records?: Array<Partial<B2BLead>>;
        not_found_keys?: string[];
      }>('leads', {
        action: 'bulk-reveal-email',
        leads: selected,
      });

      if (res?.ok) {
        const records = res.updated_records ?? [];
        const byKey = new Map<string, Partial<B2BLead>>();
        records.forEach((r) => {
          if (r.work_email) byKey.set(leadKey({ company_domain: r.company_domain ?? '', full_name: r.full_name ?? '' }), r);
        });
        const notFound = new Set(res.not_found_keys ?? []);

        setLeads((prev) =>
          prev.map((l) => {
            const key = leadKey(l);
            const record = byKey.get(key);
            if (record?.work_email) {
              return {
                ...l,
                revealed_email: record.work_email,
                work_email: record.work_email,
                email_status: record.email_status || 'valid',
                is_saved: true,
                db_id: record.id || l.db_id || null,
              };
            }
            if (notFound.has(key) && !revealedEmail(l)) return { ...l, email_status: 'not_found' };
            return l;
          }),
        );
        refreshAfterWrite();

        // "Refunded" is only claimed for leads that were actually attempted:
        // leads already on file and leads past the per-run cap were never
        // charged in the first place.
        const alreadyFree = res.already_revealed_count ?? 0;
        const queued = res.capped_count ?? 0;
        const processed = res.processed_count ?? selected.length;
        const missed = Math.max(0, processed - res.revealed_count);
        const parts = [
          `Revealed ${res.revealed_count} of ${processed} emails (${res.credits_charged} credits)`,
          missed > 0 ? `${missed} not found, not charged` : '',
          alreadyFree > 0 ? `${alreadyFree} already on file` : '',
          queued > 0 ? `${queued} left for the next run` : '',
        ].filter(Boolean);
        addToast(parts.join(' · ') + '.', res.revealed_count > 0 ? 'success' : 'info');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        addToast('Not enough credits for this bulk reveal. Top up or reveal fewer leads.', 'error');
      } else {
        addToast((err as Error)?.message || 'Bulk reveal failed.', 'error');
      }
    } finally {
      bulkInFlight.current = false;
      setIsBulkRevealing(false);
    }
  };

  // Bulk Save Leads
  const handleBulkSave = async (selected: B2BLead[]) => {
    if (selected.length === 0) return null;
    try {
      const res = await invokeFunction<{ ok: boolean; saved_count: number; leads?: B2BLead[] }>('leads', {
        action: 'bulk-save',
        leads: selected,
      });
      if (res?.ok) {
        const savedIds = new Set(selected.map((l) => l.id));
        setLeads((prev) =>
          prev.map((l) => {
            if (!savedIds.has(l.id)) return l;
            const saved = res.leads?.find((s) => s.id === l.id || s.id === l.db_id || leadKey(s) === leadKey(l));
            return { ...l, is_saved: true, db_id: saved?.id || l.db_id || null, status: l.status || saved?.status || 'new' };
          }),
        );
        void loadSavedLeads();
        addToast(`Saved ${res.saved_count ?? selected.length} lead(s) to your pipeline.`, 'success');
        return res;
      }
      return null;
    } catch (err) {
      addToast('Could not save leads: ' + ((err as Error)?.message || 'unknown error'), 'error');
      return null;
    }
  };

  // Reveal Phone (2 credits; misses are refunded server-side)
  const handleRevealPhone = async (lead: B2BLead): Promise<B2BLead | null> => {
    const flightKey = leadKey(lead) || lead.id;
    if (phoneInFlight.current.has(flightKey)) return null;
    phoneInFlight.current.add(flightKey);
    setFlag(setRevealingPhoneIds, lead.id, true);
    try {
      const res = await invokeFunction<{
        ok: boolean;
        lead?: Partial<B2BLead>;
        credits_charged: number;
        already_revealed?: boolean;
      }>('leads', {
        action: 'reveal-phone',
        full_name: lead.full_name,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company_domain: lead.company_domain,
        company_name: lead.company_name,
        title: lead.title,
        location: lead.location,
        linkedin_url: lead.linkedin_url,
        work_email: revealedEmail(lead) || undefined,
      });

      if (!res?.ok) return null;

      const phone = res.lead?.phone_number || res.lead?.revealed_phone;
      if (!phone) return null;

      const updated: B2BLead = {
        ...lead,
        phone_number: phone,
        revealed_phone: phone,
        phone_type: res.lead?.phone_type || lead.phone_type,
        is_saved: true,
        db_id: res.lead?.id || lead.db_id || null,
      };

      setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, ...updated } : l)));
      applySavedLead(res.lead);
      void loadBalance();

      addToast(
        res.already_revealed
          ? `${lead.full_name || 'Lead'}: phone already on file (0 credits).`
          : `Phone revealed for ${lead.full_name || 'lead'} (${res.credits_charged ?? PHONE_REVEAL_CREDITS} credits).`,
        res.already_revealed ? 'info' : 'success',
      );
      return updated;
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        addToast('Not enough credits to reveal this phone number. Top up to continue.', 'error');
      } else if (err instanceof ApiError && err.status === 404) {
        patchLead(lead, { phone_lookup: 'not_found' });
        addToast(`No direct phone found for ${lead.full_name || 'this lead'} — 0 credits charged.`, 'info');
      } else {
        addToast((err as Error)?.message || 'Phone reveal failed.', 'error');
      }
      return null;
    } finally {
      phoneInFlight.current.delete(flightKey);
      setFlag(setRevealingPhoneIds, lead.id, false);
    }
  };

  // Delete Single Saved Lead
  const handleDeleteSavedLead = async (lead: B2BLead) => {
    try {
      const res = await invokeFunction<{ ok: boolean; deleted_count: number }>('leads', {
        action: 'delete-saved',
        lead_id: lead.db_id || (lead.id.length === 36 ? lead.id : undefined),
        company_domain: lead.company_domain,
        full_name: lead.full_name,
      });

      if (res?.ok) {
        setSavedLeads((prev) => prev.filter((l) => !sameLead(l, lead) && l.db_id !== lead.id));
        setLeads((prev) =>
          prev.map((l) => (sameLead(l, lead) ? { ...l, is_saved: false, db_id: null, status: undefined } : l)),
        );
        addToast('Lead removed from pipeline.', 'info');
      }
    } catch (err) {
      addToast((err as Error)?.message || 'Failed to remove lead', 'error');
    }
  };

  // Bulk Delete Saved Leads
  const handleBulkDeleteSavedLeads = async (leadsToDelete: B2BLead[]) => {
    if (leadsToDelete.length === 0) return;
    try {
      const ids = leadsToDelete
        .map((l) => l.db_id || l.id)
        .filter((id): id is string => typeof id === 'string' && id.length === 36);

      const res = await invokeFunction<{ ok: boolean; deleted_count: number }>('leads', {
        action: 'delete-saved',
        lead_ids: ids,
      });

      if (res?.ok) {
        const deletedKeys = new Set(leadsToDelete.map(leadKey));
        const deletedIds = new Set(ids);
        const isDeleted = (l: B2BLead) =>
          deletedIds.has(l.id) || deletedIds.has(l.db_id || '') || deletedKeys.has(leadKey(l));

        setSavedLeads((prev) => prev.filter((l) => !isDeleted(l)));
        setLeads((prev) =>
          prev.map((l) => (isDeleted(l) ? { ...l, is_saved: false, db_id: null, status: undefined } : l)),
        );

        const removed = typeof res.deleted_count === 'number' ? res.deleted_count : leadsToDelete.length;
        addToast(removed > 0 ? `Removed ${removed} lead(s) from pipeline.` : 'Those leads were already removed.', 'info');
      }
    } catch (err) {
      addToast((err as Error)?.message || 'Failed to remove leads', 'error');
    }
  };

  // Save / Toggle Single Lead
  const handleSaveLead = async (lead: B2BLead) => {
    if (lead.is_saved) {
      await handleDeleteSavedLead(lead);
      return null;
    }
    const res = await handleBulkSave([lead]);
    return res?.leads?.[0] ?? null;
  };

  // Update pipeline status — saves an unsaved prospect with the chosen stage.
  const handleStatusChange = async (lead: B2BLead, status: B2BPipelineStatus): Promise<boolean> => {
    const previous = lead.status;
    const previousSaved = Boolean(lead.is_saved);
    const patch = (l: B2BLead) => (sameLead(l, lead) ? { ...l, status, is_saved: true } : l);

    setLeads((prev) => prev.map(patch));
    setSavedLeads((prev) => prev.map(patch));

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
        work_email: revealedEmail(lead) || undefined,
        phone_number: lead.revealed_phone || lead.phone_number,
        linkedin_url: lead.linkedin_url,
        location: lead.location,
        status,
      });
      if (!res?.ok) throw new Error('Update rejected');

      if (res.lead?.id) {
        const dbId = res.lead.id;
        setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, db_id: dbId, is_saved: true, status } : l)));
      }
      applySavedLead(res.lead || { ...lead, status });
      addToast(res.auto_saved ? `Saved to pipeline as "${status}".` : `Stage updated to "${status}".`, 'success');
      return true;
    } catch (err) {
      const rollback = (l: B2BLead) => (sameLead(l, lead) ? { ...l, status: previous, is_saved: previousSaved } : l);
      setLeads((prev) => prev.map(rollback));
      setSavedLeads((prev) => prev.map(rollback));
      addToast((err as Error)?.message || 'Failed to update stage', 'error');
      return false;
    }
  };

  const tabs: { id: SubTab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'prospector', label: 'Prospector', icon: <Search className="w-4 h-4" /> },
    { id: 'quick', label: 'Quick lookup', icon: <Zap className="w-4 h-4" /> },
    { id: 'saved', label: 'Saved pipeline', icon: <Bookmark className="w-4 h-4" />, count: savedLeads.length },
  ];

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-surface overflow-hidden">
      {/* Sub navigation + wallet */}
      <div className="bg-white border-b border-line shrink-0">
        <div className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
          <nav className="flex items-center gap-1 overflow-x-auto -mx-1 px-1" aria-label="Leads sections">
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
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <div
              className="h-9 px-3 flex items-center gap-2 border border-line bg-surface-2 text-sm"
              title="Credits available to spend (balance minus any credits held for a running job)"
            >
              <WalletIcon className="w-4 h-4 text-muted" aria-hidden />
              {wallet ? (
                <span>
                  <span className="font-semibold text-ink tabular-nums">{formatCredits(wallet.available)}</span>
                  <span className="text-muted"> credits</span>
                </span>
              ) : (
                <span className="text-muted">Balance unavailable</span>
              )}
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

      <main className="flex-1 overflow-y-auto" id="leads-scroll">
        <div className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6">
          {activeSubTab === 'prospector' ? (
            <ProspectorView
              onSearch={handleSearch}
              onRevealEmail={handleRevealEmail}
              onRevealPhone={handleRevealPhone}
              onBulkRevealEmails={handleBulkRevealEmails}
              onBulkSave={handleBulkSave}
              onSaveLead={handleSaveLead}
              onStatusChange={handleStatusChange}
              leads={leads}
              searchStatus={searchStatus}
              lastSearch={lastSearch}
              isBulkRevealing={isBulkRevealing}
              revealingEmailIds={revealingEmailIds}
              revealingPhoneIds={revealingPhoneIds}
              availableCredits={availableCredits}
              onNavigateBilling={onNavigateBilling}
            />
          ) : activeSubTab === 'quick' ? (
            <div className="space-y-4">
              <QuickLookupView
                onRevealEmail={handleRevealEmail}
                onRevealPhone={handleRevealPhone}
                onSaveLead={handleSaveLead}
                onStatusChange={handleStatusChange}
                revealingEmailIds={revealingEmailIds}
                revealingPhoneIds={revealingPhoneIds}
              />
            </div>
          ) : (
            <SavedLeadsView
              leads={savedLeads}
              isLoading={isLoadingSaved}
              onStatusChange={handleStatusChange}
              onDeleteLead={handleDeleteSavedLead}
              onBulkDelete={handleBulkDeleteSavedLeads}
              onRefresh={() => loadSavedLeads(true)}
              limitReached={savedLimitReached}
            />
          )}
        </div>
      </main>
    </div>
  );
};
