import { useSyncExternalStore } from 'react';
import type { B2BLead } from '../../types';
import { invokeFunction, ApiError } from '../../lib/api';
import { walletStore, isWelcomeOnlyRefusal, WELCOME_ONLY_MESSAGE } from '../../lib/wallet-store';
import { creditsLabel } from '../../lib/billing';
import { leadKey, revealedEmail, revealedPhone, emailState } from './lead-utils';
import {
  DEFAULT_PRICING,
  type LeadPricing,
  type ProspectorSearchParams,
  type LastSearch,
  type SearchStatus,
  searchCost,
  searchFeeText,
  domainCountOf,
} from './prospector-types';

// ============================================================================
// Leads workspace store
// ----------------------------------------------------------------------------
// The search results, the enrichment queue and the saved pipeline live here,
// outside React, for two reasons that were both user-visible bugs:
//
//   1. Results lived in LeadsTab's state, so switching to Feed or Billing
//      unmounted the tab and threw the whole search away — including any
//      contacts that had just been paid for.
//   2. Enrichment ran inside a single search request, so nothing appeared
//      until every lookup had finished, and the only per-row progress was a
//      Reveal button. Now the search returns first and contacts are filled
//      in batch by batch, each row moving through queued → processing →
//      found / not found / failed as the server answers.
//
// The provider only offers one-at-a-time lookups (no bulk or async job API),
// so the queue sends small batches to the existing credit-held bulk endpoints
// and never more than one batch at a time.
// ============================================================================

export interface EnrichmentRun {
  id: number;
  /** Leads ever added to this run (email or phone queued). */
  total: number;
  /** Leads whose lookups have all finished, whatever the outcome. */
  processed: number;
  emailsFound: number;
  /** Of the emails found, the ones the verifier confirmed — the charged ones. */
  emailsVerified: number;
  phonesFound: number;
  creditsCharged: number;
  state: 'running' | 'stopping' | 'done' | 'stopped' | 'no_credits' | 'error' | 'interrupted';
  message?: string;
}

interface LeadsState {
  userId: string | null;
  leads: B2BLead[];
  lastSearch: LastSearch | null;
  searchStatus: SearchStatus;
  enrichment: EnrichmentRun | null;
  savedLeads: B2BLead[];
  savedLimitReached: boolean;
  isLoadingSaved: boolean;
  savedLoaded: boolean;
  pricing: LeadPricing;
}

type Notify = (message: string, type?: 'info' | 'success' | 'error') => void;

const EMAIL_BATCH = 10;
const PHONE_BATCH = 10;
const MAX_CONSECUTIVE_FAILURES = 2;
const STORAGE_PREFIX = 'echo_leads_workspace_v1:';

const initialState = (): LeadsState => ({
  userId: null,
  leads: [],
  lastSearch: null,
  searchStatus: { kind: 'idle' },
  enrichment: null,
  savedLeads: [],
  savedLimitReached: false,
  isLoadingSaved: false,
  savedLoaded: false,
  pricing: DEFAULT_PRICING,
});

let state: LeadsState = initialState();
const listeners = new Set<() => void>();
let notify: Notify = () => {};
let searchSeq = 0;
let runSeq = 0;
let runActive = false;
let persistTimer: number | undefined;

function emit(next: Partial<LeadsState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
  schedulePersist();
}

// ---------------------------------------------------------------------------
// Persistence (per user, per browser tab). Results survive a refresh; a run
// that was cut off by the refresh comes back as "interrupted" with Resume,
// never as rows stuck on a spinner.
// ---------------------------------------------------------------------------

function schedulePersist() {
  if (!state.userId) return;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    try {
      sessionStorage.setItem(
        STORAGE_PREFIX + state.userId,
        JSON.stringify({ leads: state.leads, lastSearch: state.lastSearch, enrichment: state.enrichment }),
      );
    } catch {
      // Storage full or blocked: the session still works, it just will not
      // survive a refresh.
    }
  }, 400);
}

function restore(userId: string) {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + userId);
    if (!raw) return;
    const saved = JSON.parse(raw) as Pick<LeadsState, 'leads' | 'lastSearch' | 'enrichment'>;
    const interrupted = (s?: B2BLead['email_lookup']) => (s === 'queued' || s === 'processing' ? null : s);
    state.leads = (saved.leads || []).map((l) => ({
      ...l,
      email_lookup: interrupted(l.email_lookup),
      phone_lookup: interrupted(l.phone_lookup),
    }));
    state.lastSearch = saved.lastSearch || null;
    const run = saved.enrichment;
    state.enrichment =
      run && (run.state === 'running' || run.state === 'stopping') ? { ...run, state: 'interrupted' } : run || null;
    if (state.lastSearch) state.searchStatus = { kind: 'done' };
  } catch {
    // A corrupt entry is ignored rather than breaking the page.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Largest batch the leads function's bulk-save accepts (400 max_leads above it). */
const BULK_SAVE_MAX = 500;

export type BulkSaveResponse = {
  ok: boolean;
  saved_count: number;
  new_count?: number;
  already_saved_count?: number;
  skipped_count?: number;
  leads?: B2BLead[];
};

export const leadsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => state,

  /** Binds the store to the signed-in user; a different user starts clean. */
  init(userId: string | null, toast: Notify) {
    notify = toast;
    if (state.userId === userId) return;
    searchSeq++;
    runSeq++;
    runActive = false;
    state = initialState();
    state.userId = userId;
    if (userId) restore(userId);
    // No notification: this runs during LeadsTab's render, which reads the
    // fresh snapshot directly. Notifying here would update a component while
    // another is rendering.
  },

  setLeads(updater: (prev: B2BLead[]) => B2BLead[]) {
    emit({ leads: updater(state.leads) });
  },

  setSavedLeads(updater: (prev: B2BLead[]) => B2BLead[]) {
    emit({ savedLeads: updater(state.savedLeads) });
  },

  /** Re-reads the shared wallet (kept for callers; the store is walletStore). */
  loadBalance(): Promise<void> {
    return walletStore.refresh();
  },

  /**
   * Mirrors an email sent to a saved lead (by its user_leads id) into both the
   * pipeline and the Prospector rows, so both show "contacted" at once.
   */
  markContacted(dbId: string) {
    if (!dbId) return;
    const hit = (l: B2BLead) => l.db_id === dbId || l.id === dbId;
    // Only advance from "new" (or unset): a later stage is not rolled back.
    const bump = (l: B2BLead): B2BLead => (hit(l) && (!l.status || l.status === 'new') ? { ...l, status: 'contacted' } : l);
    emit({ leads: state.leads.map(bump), savedLeads: state.savedLeads.map(bump) });
  },

  /**
   * Prices the UI quotes, from the same pricing_config rows the server
   * charges from. An older deployment without the action keeps the defaults.
   */
  async loadPricing() {
    try {
      const res = await invokeFunction<{
        ok: boolean;
        email_credits: number;
        phone_credits: number;
        search_free_leads: number;
        search_block_leads: number;
        search_block_credits: number;
        /** Credits per billed provider call (older deployments: per search). */
        searchCredits?: number;
        search_credits_per_call?: number;
        search_max_provider_calls_single?: number;
        search_max_provider_calls_multi?: number;
        paid_credits_only?: boolean;
      }>('leads', { action: 'pricing' });
      if (res?.ok) {
        const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
        emit({
          pricing: {
            email: n(res.email_credits, DEFAULT_PRICING.email),
            phone: n(res.phone_credits, DEFAULT_PRICING.phone),
            freeLeads: n(res.search_free_leads, DEFAULT_PRICING.freeLeads),
            blockLeads: Math.max(1, n(res.search_block_leads, DEFAULT_PRICING.blockLeads)),
            blockCredits: n(res.search_block_credits, DEFAULT_PRICING.blockCredits),
            searchCredits: n(res.search_credits_per_call ?? res.searchCredits, DEFAULT_PRICING.searchCredits),
            searchMaxCallsSingle: Math.max(1, n(res.search_max_provider_calls_single, DEFAULT_PRICING.searchMaxCallsSingle)),
            searchMaxCallsMulti: Math.max(1, n(res.search_max_provider_calls_multi, DEFAULT_PRICING.searchMaxCallsMulti)),
            paidCreditsOnly: res.paid_credits_only ?? DEFAULT_PRICING.paidCreditsOnly,
          },
        });
      }
    } catch {
      // Defaults stay in place.
    }
  },

  async loadSaved(showSpinner = false) {
    if (showSpinner) emit({ isLoadingSaved: true });
    try {
      const res = await invokeFunction<{ ok: boolean; leads: B2BLead[]; limit_reached?: boolean }>('leads', {
        action: 'list-saved',
      });
      if (res?.ok && Array.isArray(res.leads)) {
        emit({
          savedLeads: res.leads.map((l) => ({ ...l, db_id: l.db_id || l.id, is_saved: true })),
          savedLimitReached: Boolean(res.limit_reached),
          savedLoaded: true,
        });
      }
    } catch (err) {
      console.warn('Failed to load saved leads', err);
      if (showSpinner) notify('Could not load your saved pipeline. Try Refresh.', 'error');
    } finally {
      if (showSpinner) emit({ isLoadingSaved: false });
    }
  },

  /**
   * Saves leads to the pipeline (the leads function's bulk-save) and stamps the
   * saved user_leads id onto the matching result rows as db_id. Throws on a
   * failed or rejected save; the caller reports it.
   */
  async bulkSave(selected: B2BLead[]): Promise<BulkSaveResponse> {
    // The server accepts at most BULK_SAVE_MAX leads per call, so a large
    // "save all" goes in batches and the counts are summed.
    const res: BulkSaveResponse = { ok: true, saved_count: 0, new_count: 0, already_saved_count: 0, skipped_count: 0, leads: [] };
    for (let i = 0; i < selected.length; i += BULK_SAVE_MAX) {
      const part = await invokeFunction<BulkSaveResponse>('leads', {
        action: 'bulk-save',
        leads: selected.slice(i, i + BULK_SAVE_MAX),
      });
      if (!part?.ok) throw new Error('The save was rejected.');
      res.saved_count += part.saved_count ?? 0;
      res.new_count = (res.new_count ?? 0) + (part.new_count ?? part.saved_count ?? 0);
      res.already_saved_count = (res.already_saved_count ?? 0) + (part.already_saved_count ?? 0);
      res.skipped_count = (res.skipped_count ?? 0) + (part.skipped_count ?? 0);
      res.leads = [...(res.leads ?? []), ...(part.leads ?? [])];
    }

    const savedIds = new Set(selected.map((l) => l.id));
    emit({
      leads: state.leads.map((l) => {
        if (!savedIds.has(l.id)) return l;
        const row = res.leads?.find((s) => s.id === l.db_id || leadKey(s) === leadKey(l));
        return row ? { ...l, is_saved: true, db_id: row.id, status: l.status || row.status || 'new' } : l;
      }),
    });
    if (res.leads?.length) applySavedRows(res.leads);
    return res;
  },

  /** Inserts or merges a row the server just persisted into the pipeline list. */
  applySavedLead(saved: Partial<B2BLead> | null | undefined) {
    if (!saved) return;
    applySavedRows([saved]);
  },

  /**
   * Forgets everything belonging to the signed-in user: in-flight searches and
   * enrichment runs are superseded, memory is cleared, and the per-user
   * sessionStorage snapshots are removed. Called on sign-out.
   */
  reset() {
    searchSeq++;
    runSeq++;
    runActive = false;
    window.clearTimeout(persistTimer);
    persistTimer = undefined;
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(key);
      }
    } catch {
      // Storage blocked: nothing was persisted there either.
    }
    state = initialState();
    listeners.forEach((l) => l());
    walletStore.reset();
  },

  search,
  enrichLeads,
  stopEnrichment() {
    if (state.enrichment?.state === 'running') {
      emit({ enrichment: { ...state.enrichment, state: 'stopping' } });
    }
  },
};

export function useLeadsStore(): LeadsState {
  return useSyncExternalStore(leadsStore.subscribe, leadsStore.getSnapshot);
}

const getPricing = () => state.pricing;

/** Spendable credits from the shared wallet, or null when unknown. */
function walletAvailable(): number | null {
  const w = walletStore.getSnapshot().wallet;
  return w ? Number(w.available) : null;
}

// Topped up after a search that could not afford its contacts: the user
// already chose automatic enrichment for it, so carry on.
let lastAvailable: number | null = null;
walletStore.watch(() => {
  const now = walletAvailable();
  const before = lastAvailable;
  if (now !== null) lastAvailable = now;
  if (before !== null && before <= 0 && now !== null && now > 0) resumeAfterTopUp();
});

/**
 * Just the server prices. The reference only changes when pricing is reloaded,
 * so per-row cells can read it without re-rendering on every store update.
 */
export function useLeadPricing(): LeadPricing {
  return useSyncExternalStore(leadsStore.subscribe, getPricing);
}

/**
 * Queues the contacts the last search wanted but could not pay for. Rows the
 * provider already answered "not found" for are left alone.
 */
function resumeAfterTopUp() {
  const p = state.lastSearch?.params;
  if (!p || !(p.autoEnrich || p.autoPhone) || state.leads.length === 0) return;
  if (state.enrichment?.state === 'running' || state.enrichment?.state === 'stopping') return;
  const emailIds = p.autoEnrich
    ? state.leads.filter((l) => !revealedEmail(l) && emailState(l).kind !== 'not_found').map((l) => l.id)
    : [];
  const phoneIds = p.autoPhone ? state.leads.filter((l) => !revealedPhone(l) && l.phone_lookup !== 'not_found').map((l) => l.id) : [];
  const added = enrichLeads(emailIds, { email: true }) + enrichLeads(phoneIds, { phone: true });
  if (added > 0) notify(`Credits added — finding contacts for your ${state.leads.length} leads now.`, 'success');
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function search(params: ProspectorSearchParams, opts: { email: boolean; phone: boolean }) {
  // One search at a time; a newer one supersedes any in flight.
  if (state.searchStatus.kind === 'searching') return;
  // Searching needs credits to reveal what it finds (the server enforces the
  // same rule); refuse here too so no request is made on an empty wallet.
  const minimum = Math.max(1, state.pricing.searchCredits);
  const available = walletAvailable();
  if (available !== null && available < minimum) {
    emit({
      searchStatus: {
        kind: 'error',
        message: `Add credits to search. A search costs ${searchFeeText(state.pricing)}, plus ${state.pricing.email} per verified email and ${state.pricing.phone} per phone found.`,
        params,
      },
    });
    return;
  }
  const seq = ++searchSeq;
  // A new result set ends the old enrichment run: its answers belong to rows
  // that are no longer on screen.
  runSeq++;
  runActive = false;
  if (state.enrichment?.state === 'running' || state.enrichment?.state === 'stopping') {
    emit({ enrichment: { ...state.enrichment, state: 'stopped', message: 'Stopped by a new search.' } });
  }

  emit({ searchStatus: { kind: 'searching', params, enriching: opts.email || opts.phone } });
  try {
    const res = await invokeFunction<{
      ok: boolean;
      people: B2BLead[];
      requested_limit?: number;
      skipped_domains?: number;
      failed_batches?: number;
      search_credits_charged?: number;
      enrichment_limited_by?: 'cap' | 'balance' | 'rate_limit' | null;
    }>('leads', {
      action: 'search',
      company_domain: params.companyDomain,
      title: params.title,
      q: params.q,
      keywords: params.keywords?.length ? params.keywords : undefined,
      country: params.country,
      location: params.location,
      limit: params.limit,
      // Contacts are filled in afterwards by the queue below, so the result
      // list appears as soon as the search itself is done.
      auto_enrich: false,
    });
    if (seq !== searchSeq) return;
    if (!res?.ok || !Array.isArray(res.people)) throw new Error('The search returned an unexpected response.');

    const leads = res.people.map((l) => ({ ...l, email_lookup: null, phone_lookup: null }));
    emit({
      leads,
      lastSearch: {
        params,
        requested: res.requested_limit ?? params.limit,
        count: leads.length,
        enrichRequested: opts.email || opts.phone,
        creditsCharged: res.search_credits_charged ?? 0,
        skippedDomains: res.skipped_domains ?? 0,
        failedBatches: res.failed_batches ?? 0,
        completedAt: Date.now(),
      },
      searchStatus: { kind: 'done' },
      enrichment: null,
    });

    if (res.enrichment_limited_by === 'rate_limit') {
      notify('Hourly contact-lookup limit reached: some contacts were not looked up or charged. Use Find contacts later.', 'info');
    }
    if (leads.length === 0) {
      notify('No leads matched these filters. Try a broader role, keyword or location.', 'info');
      return;
    }
    if (opts.email || opts.phone) {
      enrichLeads(leads.map((l) => l.id), opts);
    } else {
      notify(`Found ${leads.length} leads.`, 'success');
    }
  } catch (err) {
    if (seq !== searchSeq) return;
    let message = (err as Error)?.message || 'Search failed. Please try again.';
    let affordableLimit: number | undefined;
    if (err instanceof ApiError && err.status === 402 && isWelcomeOnlyRefusal(err, searchCost(params.limit, state.pricing, domainCountOf(params.companyDomain)))) {
      message = WELCOME_ONLY_MESSAGE;
    } else if (err instanceof ApiError && err.status === 402) {
      message = message || `Add credits to search. A search holds up to ${searchCost(params.limit, state.pricing, domainCountOf(params.companyDomain))} credits.`;
      // A per-lead search fee (off by default) can make a large search
      // unaffordable; offer the size the balance covers when it is on.
      const p = state.pricing;
      if (p.blockCredits > 0) {
        const credits = Math.max(0, (walletAvailable() ?? 0) - searchCost(0, p));
        affordableLimit = Math.min(params.limit - 1, p.freeLeads + Math.floor(credits / p.blockCredits) * p.blockLeads);
      }
    } else if (err instanceof ApiError && err.status === 429) {
      message = message || 'Too many searches in the last hour. Please wait a few minutes.';
    } else if (err instanceof ApiError && err.status === 503) {
      message = message || 'Search is temporarily unavailable (pricing is not configured). Nothing was charged.';
    }
    // Previous results stay; only the status reports the failure.
    emit({ searchStatus: { kind: 'error', message, params, affordableLimit } });
  } finally {
    // A search is a charging action whether or not it returned anything (a
    // provider-billed empty search is still charged; a failed one releases
    // its hold).
    if (seq === searchSeq) void walletStore.refresh();
  }
}

// ---------------------------------------------------------------------------
// Enrichment queue
// ---------------------------------------------------------------------------

/**
 * Queues email and/or phone lookups for the given rows and makes sure a run is
 * processing them. Rows that already have the detail, or are already queued,
 * are skipped — the same contact is never sent twice. Used by automatic
 * enrichment after a search, the bulk "Find contacts" action, the per-row
 * Reveal buttons and Resume.
 */
function enrichLeads(ids: string[], opts: { email?: boolean; phone?: boolean }) {
  const wanted = new Set(ids);
  let added = 0;
  const busy = (s?: B2BLead['email_lookup']) => s === 'queued' || s === 'processing';
  const leads = state.leads.map((l) => {
    if (!wanted.has(l.id)) return l;
    const email = opts.email && !revealedEmail(l) && !busy(l.email_lookup);
    const phone = opts.phone && !revealedPhone(l) && !busy(l.phone_lookup);
    if (!email && !phone) return l;
    added++;
    return {
      ...l,
      ...(email ? { email_lookup: 'queued' as const } : {}),
      ...(phone ? { phone_lookup: 'queued' as const } : {}),
    };
  });
  if (added === 0) return 0;

  const live = runActive && state.enrichment && (state.enrichment.state === 'running' || state.enrichment.state === 'stopping');
  const enrichment: EnrichmentRun = live
    ? { ...state.enrichment!, state: 'running', total: state.enrichment!.total + added }
    : {
        id: ++runSeq,
        total: added,
        processed: 0,
        emailsFound: 0,
        emailsVerified: 0,
        phonesFound: 0,
        creditsCharged: 0,
        state: 'running',
      };
  emit({ leads, enrichment });
  if (!live) void runQueue(enrichment.id);
  return added;
}

const isQueued = (l: B2BLead) => l.email_lookup === 'queued' || l.phone_lookup === 'queued';

function patchRows(match: (l: B2BLead) => boolean, patch: (l: B2BLead) => Partial<B2BLead>) {
  emit({ leads: state.leads.map((l) => (match(l) ? { ...l, ...patch(l) } : l)) });
}

function bumpRun(runId: number, delta: Partial<Record<'processed' | 'emailsFound' | 'emailsVerified' | 'phonesFound' | 'creditsCharged', number>>) {
  const run = state.enrichment;
  if (!run || run.id !== runId) return;
  emit({
    enrichment: {
      ...run,
      processed: run.processed + (delta.processed ?? 0),
      emailsFound: run.emailsFound + (delta.emailsFound ?? 0),
      emailsVerified: (run.emailsVerified ?? 0) + (delta.emailsVerified ?? 0),
      phonesFound: run.phonesFound + (delta.phonesFound ?? 0),
      creditsCharged: run.creditsCharged + (delta.creditsCharged ?? 0),
    },
  });
}

function finishRun(runId: number, final: EnrichmentRun['state'], message?: string) {
  const run = state.enrichment;
  if (!run || run.id !== runId) return;
  // Whatever was still queued was never attempted: clear it rather than leave
  // a spinner, and mark it "no credits" when that is the reason.
  const reason = final === 'no_credits' ? 'no_credits' : null;
  emit({
    leads: state.leads.map((l) =>
      isQueued(l)
        ? {
            ...l,
            email_lookup: l.email_lookup === 'queued' ? reason : l.email_lookup,
            phone_lookup: l.phone_lookup === 'queued' ? reason : l.phone_lookup,
          }
        : l,
    ),
    enrichment: { ...run, state: final, message },
  });
  runActive = false;

  const r = state.enrichment!;
  const found = [
    `${r.emailsFound} email${r.emailsFound === 1 ? '' : 's'}${r.emailsFound > (r.emailsVerified ?? 0) ? ` (${r.emailsVerified ?? 0} verified)` : ''}`,
    r.phonesFound ? `${r.phonesFound} phone${r.phonesFound === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' and ');
  const charged = `${creditsLabel(r.creditsCharged)} used`;
  if (final === 'done') notify(`Enrichment finished: ${found} found · ${charged}.`, r.emailsFound + r.phonesFound > 0 ? 'success' : 'info');
  else if (final === 'no_credits') notify(`${message || 'Enrichment paused — out of credits.'} ${found} found · ${charged}.`, 'error');
  else if (final === 'error') notify(message || 'Enrichment stopped after repeated errors.', 'error');
  else if (final === 'stopped') notify(`${message || 'Enrichment stopped.'} ${found} found · ${charged}.`, 'info');

  void leadsStore.loadBalance();
}

async function availableCredits(): Promise<number | null> {
  await walletStore.refresh();
  return walletAvailable();
}

interface BulkResult {
  ok: boolean;
  revealed_count: number;
  verified_count?: number;
  credits_charged: number;
  updated_records?: Array<Partial<B2BLead>>;
  existing_records?: Array<Partial<B2BLead>>;
  not_found_keys?: string[];
  failed_keys?: string[];
  /** Hourly limit hit part-way: these keys were skipped and not charged. */
  partial?: boolean;
  message?: string;
  rate_limited_keys?: string[];
  rate_limited_count?: number;
}

async function runQueue(runId: number) {
  runActive = true;
  let consecutiveFailures = 0;
  let lastError: string | null = null;

  while (true) {
    const run = state.enrichment;
    if (!run || run.id !== runId || runSeq !== runId) return; // superseded
    if (run.state === 'stopping') return finishRun(runId, 'stopped');

    const group = state.leads.filter(isQueued).slice(0, EMAIL_BATCH);
    if (group.length === 0) return finishRun(runId, 'done');
    const ids = new Set(group.map((l) => l.id));

    // ---- Emails -----------------------------------------------------------
    let emailTargets = group.filter((l) => l.email_lookup === 'queued');
    if (emailTargets.length > 0) {
      const credits = await availableCredits();
      if (credits !== null && credits < state.pricing.email) return finishRun(runId, 'no_credits');
      if (credits !== null) emailTargets = emailTargets.slice(0, Math.floor(credits / Math.max(1, state.pricing.email)));
      const emailIds = new Set(emailTargets.map((l) => l.id));
      patchRows((l) => emailIds.has(l.id), () => ({ email_lookup: 'processing' }));

      const outcome = await callBulk('bulk-reveal-email', emailTargets);
      if (state.enrichment?.id !== runId || runSeq !== runId) return;
      if (outcome.kind === 'no_credits') {
        patchRows((l) => emailIds.has(l.id), () => ({ email_lookup: 'queued' }));
        return finishRun(runId, 'no_credits', outcome.welcomeOnly ? WELCOME_ONLY_MESSAGE : undefined);
      }
      if (outcome.kind === 'halt') {
        // Not attempted (rate limit / pricing unavailable): retryable later.
        patchRows((l) => emailIds.has(l.id), () => ({ email_lookup: null }));
        return finishRun(runId, outcome.state, outcome.message);
      }
      if (outcome.kind === 'error') {
        consecutiveFailures++;
        lastError = outcome.message;
        patchRows((l) => emailIds.has(l.id), () => ({ email_lookup: 'failed' }));
      } else {
        consecutiveFailures = 0;
        const found = applyBulk(outcome.data, emailIds, 'email');
        bumpRun(runId, {
          emailsFound: found,
          emailsVerified: outcome.data.verified_count ?? found,
          creditsCharged: outcome.data.credits_charged || 0,
        });
        if (isPartial(outcome.data)) return finishRun(runId, 'stopped', partialMessage(outcome.data));
      }
    }

    // ---- Phones (after emails, so a just-found address helps the lookup) --
    let phoneTargets = state.leads.filter((l) => ids.has(l.id) && l.phone_lookup === 'queued');
    if (phoneTargets.length > 0 && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      const credits = await availableCredits();
      if (credits !== null && credits < state.pricing.phone) return finishRun(runId, 'no_credits');
      if (credits !== null) phoneTargets = phoneTargets.slice(0, Math.min(PHONE_BATCH, Math.floor(credits / Math.max(1, state.pricing.phone))));
      const phoneIds = new Set(phoneTargets.map((l) => l.id));
      patchRows((l) => phoneIds.has(l.id), () => ({ phone_lookup: 'processing' }));

      const outcome = await callBulk(
        'bulk-reveal-phone',
        phoneTargets.map((l) => ({ ...l, work_email: revealedEmail(l) || undefined })),
      );
      if (state.enrichment?.id !== runId || runSeq !== runId) return;
      if (outcome.kind === 'no_credits') {
        patchRows((l) => phoneIds.has(l.id), () => ({ phone_lookup: 'queued' }));
        return finishRun(runId, 'no_credits', outcome.welcomeOnly ? WELCOME_ONLY_MESSAGE : undefined);
      }
      if (outcome.kind === 'halt') {
        patchRows((l) => phoneIds.has(l.id), () => ({ phone_lookup: null }));
        return finishRun(runId, outcome.state, outcome.message);
      }
      if (outcome.kind === 'error') {
        consecutiveFailures++;
        lastError = outcome.message;
        patchRows((l) => phoneIds.has(l.id), () => ({ phone_lookup: 'failed' }));
      } else {
        consecutiveFailures = 0;
        const found = applyBulk(outcome.data, phoneIds, 'phone');
        bumpRun(runId, { phonesFound: found, creditsCharged: outcome.data.credits_charged || 0 });
        if (isPartial(outcome.data)) return finishRun(runId, 'stopped', partialMessage(outcome.data));
      }
    }

    bumpRun(runId, {
      processed: state.leads.filter((l) => ids.has(l.id) && !isQueued(l) && l.email_lookup !== 'processing' && l.phone_lookup !== 'processing').length,
    });

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return finishRun(
        runId,
        'error',
        lastError && lastError !== 'Lookup failed'
          ? `Enrichment stopped: ${lastError}`
          : 'Enrichment stopped: the contact lookup service failed twice in a row. Try Resume in a moment.',
      );
    }
  }
}

type BulkOutcome =
  | { kind: 'ok'; data: BulkResult }
  | { kind: 'no_credits'; welcomeOnly: boolean }
  /** Stop the run without marking rows failed: they stay retryable. */
  | { kind: 'halt'; state: 'stopped' | 'error'; message: string }
  | { kind: 'error'; message: string };

const RATE_LIMIT_MESSAGE = 'Hourly contact-lookup limit reached. The rest were not looked up or charged — Resume later.';
const PRICING_UNAVAILABLE_MESSAGE =
  'Contact lookups are temporarily unavailable (pricing is not configured). Nothing was charged; try again later.';

/** A batch the server only partly ran (hourly limit): some keys were skipped, uncharged. */
function isPartial(data: BulkResult): boolean {
  return Boolean(data.partial || (data.rate_limited_count ?? 0) > 0 || data.rate_limited_keys?.length);
}

function partialMessage(data: BulkResult): string {
  const n = data.rate_limited_count ?? data.rate_limited_keys?.length ?? 0;
  const base = data.message || RATE_LIMIT_MESSAGE;
  return n > 0 ? `${base} (${n} lead${n === 1 ? '' : 's'} skipped, not charged.)` : base;
}

async function callBulk(action: 'bulk-reveal-email' | 'bulk-reveal-phone', leads: B2BLead[]): Promise<BulkOutcome> {
  try {
    const data = await invokeFunction<BulkResult>('leads', { action, leads });
    if (!data?.ok) return { kind: 'error', message: 'Unexpected response' };
    return { kind: 'ok', data };
  } catch (err) {
    if (err instanceof ApiError && err.status === 402) {
      const price = action === 'bulk-reveal-email' ? state.pricing.email : state.pricing.phone;
      return { kind: 'no_credits', welcomeOnly: isWelcomeOnlyRefusal(err, price) };
    }
    if (err instanceof ApiError && err.status === 429) {
      return { kind: 'halt', state: 'stopped', message: err.message || RATE_LIMIT_MESSAGE };
    }
    if (err instanceof ApiError && err.status === 503) {
      // pricing_unavailable (or the service is paused): retrying now won't help.
      return { kind: 'halt', state: 'error', message: err.message || PRICING_UNAVAILABLE_MESSAGE };
    }
    if (err instanceof ApiError && err.status === 500 && /saved/i.test(err.message || '')) {
      // save_failed: nothing saved, zero credits charged; the server says so.
      return { kind: 'error', message: err.message };
    }
    // An older deployment of the function has no bulk phone action and
    // answers 400 "Unknown action"; report that plainly.
    return { kind: 'error', message: (err as Error)?.message || 'Lookup failed' };
  }
}

/**
 * Maps a bulk response back onto the rows it was for (by domain + name, the
 * key the server matches on). Returns how many details were found.
 */
function applyBulk(data: BulkResult, targetIds: Set<string>, kind: 'email' | 'phone'): number {
  const records = [...(data.updated_records ?? []), ...(data.existing_records ?? [])];
  const byKey = new Map<string, Partial<B2BLead>>();
  records.forEach((r) => byKey.set(leadKey({ company_domain: r.company_domain ?? '', full_name: r.full_name ?? '' }), r));
  const notFound = new Set(data.not_found_keys ?? []);
  const failed = new Set(data.failed_keys ?? []);
  // Skipped by the hourly limit: never looked up, so left retryable (no state),
  // not "not found" — Resume / Find contacts picks them up later.
  const skipped = new Set(data.rate_limited_keys ?? []);
  let found = 0;

  emit({
    leads: state.leads.map((l) => {
      if (!targetIds.has(l.id)) return l;
      const key = leadKey(l);
      const r = byKey.get(key);
      if (kind === 'email') {
        if (r?.work_email) {
          found++;
          return {
            ...l,
            revealed_email: r.work_email,
            work_email: r.work_email,
            email_status: r.email_status || 'valid',
            email_lookup: null,
            is_saved: true,
            db_id: r.id || l.db_id || null,
            status: l.status || r.status || 'new',
          };
        }
        if (skipped.has(key) || skipped.has(l.id)) return { ...l, email_lookup: null };
        return { ...l, email_lookup: failed.has(key) ? 'failed' : 'not_found' };
      }
      if (r?.phone_number) {
        found++;
        return {
          ...l,
          revealed_phone: r.phone_number,
          phone_number: r.phone_number,
          phone_type: r.phone_type || l.phone_type,
          phone_lookup: null,
          is_saved: true,
          db_id: r.id || l.db_id || null,
          status: l.status || r.status || 'new',
        };
      }
      if (skipped.has(key) || skipped.has(l.id)) return { ...l, phone_lookup: null };
      return { ...l, phone_lookup: failed.has(key) ? 'failed' : notFound.has(key) ? 'not_found' : 'not_found' };
    }),
  });

  // Revealed contacts are saved by the server; mirror them into the pipeline
  // list so its count and rows are right without a reload.
  if (data.updated_records?.length) applySavedRows(data.updated_records);
  return found;
}

function applySavedRows(rows: Array<Partial<B2BLead>>) {
  const next = [...state.savedLeads];
  for (const saved of rows) {
    const key = leadKey({ company_domain: saved.company_domain ?? '', full_name: saved.full_name ?? '' });
    const index = next.findIndex((l) => (saved.id && (l.id === saved.id || l.db_id === saved.id)) || leadKey(l) === key);
    const normalized: B2BLead = {
      ...(saved as B2BLead),
      id: saved.id || (index !== -1 ? next[index].id : `saved_${key}`),
      db_id: saved.db_id || saved.id || (index !== -1 ? next[index].db_id : null),
      is_saved: true,
    };
    if (index === -1) next.unshift(normalized);
    else next[index] = { ...next[index], ...normalized };
  }
  emit({ savedLeads: next });
}
