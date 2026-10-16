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
  /** Approximate treg spend for this sweep, in USD. */
  usd_spent?: number;
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
    usd_spent: res?.usd_spent,
    served_by: res?.served_by,
    errors: res?.errors,
  };
}

/**
 * Buyer-intent heuristic, mirrored from the edge function for local rendering
 * of freshly fetched rows. Server-side scoring remains authoritative.
 */
export function calculateIntentScore(text: string): number {
  if (!text) return 30;
  const lower = text.toLowerCase();

  const highIntent = [
    'looking for', 'recommend', 'recommendation', 'alternative to', 'switching from',
    'anyone using', 'best tool for', 'best software for', 'pricing', 'how much does',
    'budget', 'quote', 'need software', 'any suggestions', 'help choosing', 'rfp',
    'demo', 'trial', 'contract', 'enterprise plan', 'migration',
  ];
  const mediumIntent = [
    'tool', 'software', 'automation', 'platform', 'integration', 'workflow',
    'alternative', 'vs', 'versus',
  ];
  const negative = [
    'hiring', 'job opening', 'we are looking for candidates', 'free template',
    'looking to buy followers', 'crypto giveaway',
  ];

  let score = 30;
  for (const p of highIntent) if (lower.includes(p)) score += 9;
  for (const p of mediumIntent) if (lower.includes(p)) score += 3;
  for (const p of negative) if (lower.includes(p)) score -= 40;

  return Math.max(0, Math.min(97, Math.round(score)));
}