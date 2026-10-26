import { useSyncExternalStore } from 'react';
import { hashForTab } from '../../lib/tab-routing';

// ============================================================================
// "Find people at this company": hands a company domain from wherever a
// company profile is open (results, saved leads, the feed) to the Prospector.
// Leads switches to the Prospector tab when one is pending; the Prospector
// puts it in the form and clears it. Nothing is searched until the user
// clicks Find leads, so the cost is seen first.
// ============================================================================

let pending: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const prospectorPrefill = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get: () => pending,
  /** Queues a domain and opens the Leads tab. */
  open(domain: string) {
    pending = domain;
    emit();
    if (window.location.hash !== hashForTab('leads')) window.location.hash = hashForTab('leads');
  },
  /** Takes the pending domain (once). */
  take(): string | null {
    const domain = pending;
    pending = null;
    if (domain) emit();
    return domain;
  },
};

export function usePendingProspectorDomain(): string | null {
  return useSyncExternalStore(prospectorPrefill.subscribe, prospectorPrefill.get, prospectorPrefill.get);
}
