import { useSyncExternalStore } from 'react';
import { invokeFunction, ApiError } from '../../lib/api';
import { walletStore } from '../../lib/wallet-store';
import type { Company, CompanySignalKind } from '../../types';

// ============================================================================
// Company profiles by domain, shared by every view that shows a company.
//
// `load` reads the server's shared cache (free, no provider call). `enrich`
// buys a profile through treg.companies.enrich, charged only when one is
// found. Both go through the leads function; the cache table is not readable
// from the browser.
// ============================================================================

export type CompanyEntry =
  /** Not asked about yet. */
  | { status: 'idle' }
  | { status: 'loading' }
  /** Asked; nothing cached yet, so it can be enriched. */
  | { status: 'none' }
  | { status: 'enriching' }
  | {
      status: 'found';
      company: Company;
      /** Signals being looked up, and the last error per signal. */
      signalLoading?: Partial<Record<CompanySignalKind, boolean>>;
      signalError?: Partial<Record<CompanySignalKind, string>>;
    }
  /** Enrichment ran and the providers had nothing. */
  | { status: 'not_found' }
  | { status: 'error'; message: string; noCredits?: boolean };

const IDLE: CompanyEntry = { status: 'idle' };

let entries: Record<string, CompanyEntry> = {};
/** Bumped by reset(): a request started before it must not write afterwards. */
let generation = 0;
const listeners = new Set<() => void>();

function set(domain: string, entry: CompanyEntry, gen = generation) {
  if (gen !== generation) return;
  entries = { ...entries, [domain]: entry };
  for (const l of listeners) l();
}

interface EnrichResponse {
  ok: boolean;
  results?: Record<string, { status: 'found' | 'cached' | 'not_found' | 'failed'; company?: Company }>;
  credits_charged?: number;
}

export const companyStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get(domain: string): CompanyEntry {
    return entries[domain] ?? IDLE;
  },

  /** Reads the shared cache once per domain. Never throws. */
  async load(domain: string): Promise<void> {
    const current = companyStore.get(domain).status;
    if (current !== 'idle' && current !== 'error') return;
    const gen = generation;
    set(domain, { status: 'loading' });
    try {
      const res = await invokeFunction<{ ok: boolean; companies?: Record<string, Company> }>('leads', {
        action: 'company-lookup',
        domains: [domain],
      });
      const company = res?.companies?.[domain];
      set(domain, company ? { status: 'found', company } : { status: 'none' }, gen);
    } catch {
      // A failed cache read still lets the user enrich.
      set(domain, { status: 'none' }, gen);
    }
  },

  /** Buys the profile. Returns the credits charged (0 when cached or not found). */
  async enrich(domain: string): Promise<number> {
    const gen = generation;
    set(domain, { status: 'enriching' });
    try {
      const res = await invokeFunction<EnrichResponse>('leads', { action: 'enrich-company', domain });
      const result = res?.results?.[domain];
      if (result?.company && (result.status === 'found' || result.status === 'cached')) {
        set(domain, { status: 'found', company: result.company }, gen);
      } else if (result?.status === 'not_found') {
        set(domain, { status: 'not_found' }, gen);
      } else {
        set(domain, { status: 'error', message: 'The lookup failed. Nothing was charged; please try again.' }, gen);
      }
      return res?.credits_charged ?? 0;
    } catch (err) {
      const noCredits = err instanceof ApiError && err.status === 402;
      set(domain, {
        status: 'error',
        message: (err as Error)?.message || 'The lookup failed. Please try again.',
        noCredits,
      }, gen);
      return 0;
    } finally {
      void walletStore.refresh();
    }
  },

  /** Buys one signal (news, funding or jobs); charged only when something is found. */
  async loadSignal(domain: string, kind: CompanySignalKind): Promise<void> {
    const current = companyStore.get(domain);
    if (current.status !== 'found' || current.signalLoading?.[kind]) return;
    const gen = generation;
    const patch = (latest: CompanyEntry, loading: boolean, error?: string): CompanyEntry =>
      latest.status === 'found'
        ? {
            ...latest,
            signalLoading: { ...latest.signalLoading, [kind]: loading },
            signalError: { ...latest.signalError, [kind]: error },
          }
        : latest;
    set(domain, patch(current, true));
    try {
      const res = await invokeFunction<{ ok: boolean; items?: unknown[] }>('leads', { action: 'company-signal', kind, domain });
      const latest = companyStore.get(domain);
      if (latest.status === 'found') {
        set(domain, patch({ ...latest, company: { ...latest.company, [kind]: res?.items ?? [] } }, false), gen);
      }
    } catch (err) {
      set(domain, patch(companyStore.get(domain), false, (err as Error)?.message || 'The lookup failed.'), gen);
    } finally {
      void walletStore.refresh();
    }
  },

  /** Forgets everything (sign-out / account switch). */
  reset() {
    generation++;
    entries = {};
    for (const l of listeners) l();
  },
};

export function useCompany(domain: string): CompanyEntry {
  return useSyncExternalStore(
    companyStore.subscribe,
    () => companyStore.get(domain),
    () => companyStore.get(domain),
  );
}
