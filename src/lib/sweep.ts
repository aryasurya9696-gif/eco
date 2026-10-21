/**
 * Search client
 * ----------------------------------------------------------------------------
 * Talks to the `social-search` Supabase Edge Function, which holds the treg
 * token. Channels, lookback window and keywords are resolved server-side from
 * the caller's profile — nothing quota-relevant is trusted from the browser.
 */
import type { MonitoredPost, Platform } from '../types';
import { invokeFunction } from './api';

export interface SweepResult {
  ok: boolean;
  posts: MonitoredPost[];
  scanned: number;
  channels: Platform[];
  lookback_hours?: number;
  /** Results dropped because they fell outside the real lookback window. */
  dropped_stale?: number;
  /** Mentions the retention pass removed after this sweep. */
  pruned?: number;
  /** Which treg endpoint actually answered for each channel. */
  served_by?: Record<string, string>;
  errors?: string[];
}

/**
 * Runs a search sweep for the signed-in user.
 *
 * The edge function has already persisted anything new to `monitored_posts`, so
 * the returned rows are only used to refresh the client cache immediately.
 */
export async function invokeSearchSweep(
  options: { keyword?: string } = {},
): Promise<SweepResult> {
  const res = await invokeFunction<SweepResult>(
    'social-search',
    options.keyword ? { keyword: options.keyword } : {},
    { timeoutMs: 120000 },
  );

  return {
    ok: res?.ok ?? false,
    posts: Array.isArray(res?.posts) ? res.posts : [],
    scanned: res?.scanned ?? 0,
    channels: res?.channels ?? [],
    lookback_hours: res?.lookback_hours,
    dropped_stale: res?.dropped_stale,
    pruned: res?.pruned,
    served_by: res?.served_by,
    errors: res?.errors,
  };
}

// The buyer-intent heuristic lives only in the edge functions now. A copy used
// to sit here for "local rendering of freshly fetched rows", but nothing called
// it — the rows that reach the browser already carry the score the server
// computed. Two copies of a scoring algorithm drift, and the one that goes
// unedited is the one nobody notices.