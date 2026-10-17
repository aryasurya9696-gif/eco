/**
 * Echo Leads — live run updates
 * ----------------------------------------------------------------------------
 * A run fills in over minutes. Without a socket the user watches a spinner and
 * learns nothing until it finishes, which is the same experience as a run that
 * is broken.
 *
 * Two channels, and the fallback matters:
 *
 *   postgres_changes  a live subscription on the run's rows. Fast, and RLS-scoped,
 *                     so a row belonging to another workspace never arrives even
 *                     if someone worked out the filter.
 *   polling           get_run every few seconds, used whenever the socket has not
 *                     reached SUBSCRIBED. Realtime silently fails in more places
 *                     than it works — a corporate proxy, a sleeping laptop, a
 *                     websocket the network ate — and none of those produce an
 *                     error the user would notice. Without the fallback a run
 *                     just stops updating.
 *
 * The fallback stops on its own once the socket is live, so a healthy connection
 * costs one subscription and no timers.
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { LeadRow, LeadRun } from '../types';

const POLL_MS = 3000;

export interface LiveRun {
  /** Replace the whole row set. Called for a page load and on fallback polls. */
  onPage: (rows: LeadRow[], total: number) => void;
  /** Merge one changed row. */
  onRow: (row: LeadRow) => void;
  onRun: (run: LeadRun) => void;
  /** True while the socket is carrying updates. */
  onLiveChange?: (live: boolean) => void;
}

export function subscribeToRun(
  supabase: SupabaseClient,
  runId: string,
  fetchPage: (runId: string) => Promise<{ rows: LeadRow[]; total: number }>,
  live: LiveRun,
): () => void {
  let channel: RealtimeChannel | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const startPolling = () => {
    if (timer || disposed) return;
    timer = setInterval(async () => {
      if (disposed) return;
      try {
        const page = await fetchPage(runId);
        if (!disposed) live.onPage(page.rows, page.total);
      } catch {
        // A failed poll keeps the previous rows on screen rather than clearing
        // them. Blanking a table because one request timed out makes a working
        // run look deleted.
      }
    }, POLL_MS);
  };

  const stopPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  channel = supabase
    .channel(`leads:run:${runId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'lead_rows',
        filter: `run_id=eq.${runId}`,
      },
      (payload) => {
        const row = payload.new as LeadRow;
        if (row?.id) live.onRow(row);
      },
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'lead_runs',
        filter: `id=eq.${runId}`,
      },
      (payload) => {
        const run = payload.new as LeadRun;
        if (run?.id) live.onRun(run);
      },
    )
    .subscribe((status) => {
      if (disposed) return;

      if (status === 'SUBSCRIBED') {
        stopPolling();
        live.onLiveChange?.(true);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // Not reported to the user as an error. A run is still running and still
        // worth watching over polling; saying "live updates unavailable" invites
        // them to assume the run itself has stopped.
        live.onLiveChange?.(false);
        startPolling();
      }
    });

  // Poll until the socket proves itself, then stop.
  startPolling();

  return () => {
    disposed = true;
    stopPolling();
    if (channel) {
      // removeChannel rather than unsubscribe: unsubscribe leaves the channel
      // registered, and re-opening the run view then stacks a new one per visit.
      supabase.removeChannel(channel);
      channel = null;
    }
  };
}

/**
 * Merge one row into a list.
 *
 * Upsert by id rather than append, because a row is written several times as the
 * waterfall progresses and an append would show the same person four times.
 */
export function mergeRow(rows: LeadRow[], incoming: LeadRow): LeadRow[] {
  const i = rows.findIndex((r) => r.id === incoming.id);
  if (i === -1) return [...rows, incoming];

  const next = rows.slice();
  next[i] = { ...next[i], ...incoming };
  return next;
}

/**
 * Recompute the header counters from the rows on screen.
 *
 * From the page rather than from the run's denormalised counters, because the
 * two are written by different code and during a run the row list is the one the
 * user is actually looking at. The run's own counters are used for the credit
 * total, which is the wallet's figure and not something rows can be summed into.
 */
export function summarise(rows: LeadRow[]) {
  let found = 0;
  let verified = 0;
  let catchAll = 0;
  let invalid = 0;
  let credits = 0;

  for (const r of rows) {
    credits += r.credits ?? 0;
    if (r.email) found++;
    if (r.email_status === 'verified') verified++;
    else if (r.email_status === 'catch_all') catchAll++;
    else if (r.email_status === 'invalid') invalid++;
  }

  return { found, verified, catchAll, invalid, credits: Math.round(credits * 1e6) / 1e6 };
}

/** How many rows each provider was the one that found. */
export function byProvider(rows: LeadRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.email_provider) continue;
    out[r.email_provider] = (out[r.email_provider] ?? 0) + 1;
  }
  return out;
}
