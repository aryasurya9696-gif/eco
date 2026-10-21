import { useSyncExternalStore } from 'react';
import { fetchBalance, type SweepQuote, type Wallet } from './billing';
import { supabase } from './supabase';
import { ApiError } from './api';

// ============================================================================
// Wallet store
// ----------------------------------------------------------------------------
// The one copy of the signed-in user's credit balance. Leads, Billing, the
// Sidebar and Mail all read it from here, and every charging action (a sweep,
// a lead search or reveal, a mail send or reply) calls walletStore.refresh()
// when it finishes, so the balance drops everywhere at once.
//
// A failed fetch clears the balance to null rather than keeping a number that
// is known to be stale: every reader shows "—" for null, never 0.
//
// Same useSyncExternalStore pattern as mail-store.ts / leads-store.ts.
// ============================================================================

export interface WalletState {
  wallet: Wallet | null;
  sweep: SweepQuote | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /** Set when the last fetch failed; the wallet is null then. */
  error: string | null;
  /** When the last successful fetch landed (ms since epoch), or 0. */
  loadedAt: number;
}

const initialState = (): WalletState => ({ wallet: null, sweep: null, loading: false, error: null, loadedAt: 0 });

let state: WalletState = initialState();
const listeners = new Set<() => void>();
/** Internal observers (other stores); they do not count as readers. */
const watchers = new Set<() => void>();
/** Bumped by reset() so a fetch for a previous user is dropped. */
let generation = 0;
let inFlight: Promise<void> | null = null;
/** A refresh was asked for while one was in flight: run once more after it. */
let again = false;
let currentUserId: string | null | undefined;

function notifyAll() {
  listeners.forEach((l) => l());
  watchers.forEach((w) => w());
}

function emit(next: Partial<WalletState>) {
  state = { ...state, ...next };
  notifyAll();
}

async function fetchOnce(gen: number): Promise<void> {
  emit({ loading: true });
  try {
    const res = await fetchBalance();
    if (gen !== generation) return;
    if (!res?.wallet) throw new Error('The balance response was empty.');
    emit({ wallet: res.wallet, sweep: res.sweep ?? null, loading: false, error: null, loadedAt: Date.now() });
  } catch (err) {
    if (gen !== generation) return;
    console.warn('[wallet] balance fetch failed', err);
    emit({
      wallet: null,
      sweep: null,
      loading: false,
      error: (err as Error)?.message || 'Could not load your balance.',
    });
  }
}

function refresh(): Promise<void> {
  if (inFlight) {
    // The in-flight fetch may have been answered before the charge that
    // triggered this call settled, so one more fetch follows it.
    again = true;
    return inFlight;
  }
  const gen = generation;
  inFlight = (async () => {
    try {
      do {
        again = false;
        await fetchOnce(gen);
      } while (again && gen === generation);
    } finally {
      if (gen === generation) inFlight = null;
    }
  })();
  return inFlight;
}

function reset() {
  generation++;
  inFlight = null;
  again = false;
  state = initialState();
  notifyAll();
}

export const walletStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    // First reader loads the balance. Deferred so subscribing never emits
    // synchronously inside React's subscribe phase.
    if (listeners.size === 1 && !state.wallet && !state.loading && !state.error) {
      window.setTimeout(() => {
        if (!state.wallet && !state.loading && listeners.size > 0) void refresh();
      }, 0);
    }
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: (): WalletState => state,
  /**
   * Observes changes without counting as a reader (so it never triggers a
   * load by itself). For other stores, e.g. leads resuming after a top-up.
   */
  watch(fn: () => void) {
    watchers.add(fn);
    return () => {
      watchers.delete(fn);
    };
  },
  /** Re-reads the balance. Concurrent calls share one fetch (plus one follow-up). */
  refresh,
  /** Forgets the balance (sign-out / account switch). */
  reset,
};

// Reset on sign-out or an account switch, so one user never sees another's
// balance. The refresh is deferred: supabase-js deadlocks if its own API is
// awaited inside this callback.
if (supabase) {
  supabase.auth.onAuthStateChange((_event, session) => {
    const id = session?.user?.id ?? null;
    if (id === currentUserId) return;
    const hadUser = currentUserId !== undefined;
    currentUserId = id;
    if (hadUser) reset();
    if (id && listeners.size > 0) window.setTimeout(() => void refresh(), 0);
  });
}

// A top-up happens on another site; re-read on return, at most every 15 s.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    if (listeners.size === 0 || state.loading) return;
    if (Date.now() - state.loadedAt < 15_000 && !state.error) return;
    void refresh();
  });
}

/** The full wallet record (Billing, Leads). */
export function useWalletState(): WalletState {
  return useSyncExternalStore(walletStore.subscribe, walletStore.getSnapshot);
}

/**
 * The spendable balance for display. `balance` is what can actually be spent
 * (wallet.available: balance minus credits on hold); `reserved` is what is on
 * hold. Both are null when unknown or when the fetch failed — render "—".
 */
export function useWallet(): { balance: number | null; reserved: number | null; loading: boolean; error: string | null } {
  const s = useWalletState();
  const num = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    balance: s.wallet ? num(s.wallet.available) : null,
    reserved: s.wallet ? num(s.wallet.reserved) : null,
    loading: s.loading,
    error: s.error,
  };
}

// ---------------------------------------------------------------------------
// Welcome credits
// ---------------------------------------------------------------------------

/**
 * Welcome (free) credits pay for sweeps only; leads and mail need bought
 * credits. Shown when a hold fails because only welcome credits are left.
 */
export const WELCOME_ONLY_MESSAGE =
  "Your free welcome credits can't be used for leads or mail. Buy credits in Billing to continue.";

/**
 * Credits that leads and mail can spend, when the server reports it
 * (paid_available); null when it does not, in which case only the server's
 * answer to a hold tells us.
 */
export function paidAvailable(wallet: Wallet | null | undefined): number | null {
  const v = wallet?.paid_available;
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
}

/**
 * Whether a refused hold (402) was refused because only welcome credits are
 * left. Recognised from the server's wording, or inferred when the wallet
 * holds enough credits in total for the price that was refused.
 */
export function isWelcomeOnlyRefusal(err: unknown, price?: number): boolean {
  if (!(err instanceof ApiError) || err.status !== 402) return false;
  if (/welcome|free credits|purchased credits|paid credits|bought credits/i.test(err.message || '')) return true;
  const w = walletStore.getSnapshot().wallet;
  if (!w) return false;
  const paid = paidAvailable(w);
  const needed = price && price > 0 ? price : 1;
  if (paid !== null) return paid < needed && Number(w.available) >= needed;
  return Number(w.credits_free) > 0 && Number(w.credits_purchased) <= 0 && Number(w.available) >= needed;
}
