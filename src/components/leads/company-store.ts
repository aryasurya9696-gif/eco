import { useSyncExternalStore } from 'react';
import { invokeFunction, ApiError } from '../../lib/api';
import { walletStore } from '../../lib/wallet-store';
import type { Company } from '../../types';

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
  | { status: 'found'; company: Company }
  /** Enrichment ran and the providers had nothing. */
  | { status: 'not_found' }
  | { status: 'error'; message: string; noCredits?: boolean };

const IDLE: CompanyEntry = { status: 'idle' };

let entries: Record<string, CompanyEntry> = {};
const listeners = new Set<() => void>();

function set(domain: string, entry: CompanyEntry) {
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
    set(domain, { status: 'loading' });
    try {
      const res = await invokeFunction<{ ok: boolean; companies?: Record<string, Company> }>('leads', {
        action: 'company-lookup',
        domains: [domain],
      });
      const company = res?.companies?.[domain];
      set(domain, company ? { status: 'found', company } : { status: 'none' });
    } catch {
      // A failed cache read still lets the user enrich.
      set(domain, { status: 'none' });
    }
  },

  /** Buys the profile. Returns the credits charged (0 when cached or not found). */
  async enrich(domain: string): Promise<number> {
    set(domain, { status: 'enriching' });
    try {
      const res = await invokeFunction<EnrichResponse>('leads', { action: 'enrich-company', domain });
      const result = res?.results?.[domain];
      if (result?.company && (result.status === 'found' || result.status === 'cached')) {
        set(domain, { status: 'found', company: result.company });
      } else if (result?.status === 'not_found') {
        set(domain, { status: 'not_found' });
      } else {
        set(domain, { status: 'error', message: 'The lookup failed. Nothing was charged; please try again.' });
      }
      return res?.credits_charged ?? 0;
    } catch (err) {
      const noCredits = err instanceof ApiError && err.status === 402;
      set(domain, {
        status: 'error',
        message: (err as Error)?.message || 'The lookup failed. Please try again.',
        noCredits,
      });
      return 0;
    } finally {
      void walletStore.refresh();
    }
  },

  /** Forgets everything (sign-out / account switch). */
  reset() {
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
