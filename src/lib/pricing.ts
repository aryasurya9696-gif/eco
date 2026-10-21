/**
 * Live per-operation prices
 * ----------------------------------------------------------------------------
 * Reads the billing function's `pricing` action (enabled pricing_config rows:
 * operation, display_name, credits). Read-only, cached for a few minutes and
 * shared by every caller, so opening Settings and the sweep preview costs one
 * request.
 *
 * The action needs a session. Where it is unavailable (signed out, not
 * deployed yet, a failure) the values in constants.ts are used instead, so a
 * price is always shown and always the same one the landing page quotes.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { invokeFunction } from './api';
import { CHANNEL_PRICING_OPERATION, CHANNEL_SEARCH_CREDITS, PUBLIC_PRICES } from './constants';
import type { Platform } from '../types';

export interface PriceRow {
  operation: string;
  display_name: string;
  credits: number;
}

type PricingResponse = PriceRow[] | { ok?: boolean; pricing?: PriceRow[]; prices?: PriceRow[]; rows?: PriceRow[] };

const TTL_MS = 5 * 60_000;

interface PricingState {
  /** credits by operation; null until the first successful load. */
  prices: Record<string, number> | null;
  loading: boolean;
  error: string | null;
}

let state: PricingState = { prices: null, loading: false, error: null };
let loadedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<PricingState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function rowsOf(res: PricingResponse | null | undefined): PriceRow[] {
  if (Array.isArray(res)) return res;
  return res?.pricing ?? res?.prices ?? res?.rows ?? [];
}

/** Fetches the price list unless a fresh copy is cached. Never throws. */
export function loadPricing(force = false): Promise<void> {
  if (!force && state.prices && Date.now() - loadedAt < TTL_MS) return Promise.resolve();
  if (inflight) return inflight;
  setState({ loading: true });
  inflight = invokeFunction<PricingResponse>('billing', { action: 'pricing' })
    .then((res) => {
      const prices: Record<string, number> = {};
      for (const row of rowsOf(res)) {
        const credits = Number(row?.credits);
        if (row?.operation && Number.isFinite(credits)) prices[row.operation] = credits;
      }
      loadedAt = Date.now();
      setState({ prices, loading: false, error: null });
    })
    .catch((err: unknown) => {
      setState({ loading: false, error: (err as Error)?.message || 'Could not load prices.' });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;

/** Credits for an operation: the live price when known, else the public one. */
export function creditsFor(prices: Record<string, number> | null, operation: string): number {
  const live = prices?.[operation];
  if (live !== undefined) return live;
  return PUBLIC_PRICES[operation] ?? 0;
}

/** Credits one keyword costs on a channel, per sweep. */
export function channelCredits(prices: Record<string, number> | null, platform: Platform): number {
  const live = prices?.[CHANNEL_PRICING_OPERATION[platform]];
  return live !== undefined ? live : CHANNEL_SEARCH_CREDITS[platform];
}

/**
 * Live prices for a signed-in view. Pass `enabled = false` while signed out so
 * nothing is requested; the fallbacks still apply through creditsFor().
 */
export function usePricing(enabled = true) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (enabled) void loadPricing();
  }, [enabled]);
  return {
    prices: snap.prices,
    loading: snap.loading,
    error: snap.error,
    /** True when the numbers shown are the built-in fallbacks. */
    isFallback: snap.prices === null,
    creditsFor: (operation: string) => creditsFor(snap.prices, operation),
    channelCredits: (platform: Platform) => channelCredits(snap.prices, platform),
  };
}
