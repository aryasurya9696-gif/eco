/**
 * Echo — shared runtime constants
 * ----------------------------------------------------------------------------
 * Kept in its own module (not in a component file) so both components and
 * contexts can import them without tripping the `only-export-components`
 * fast-refresh lint.
 */
import type { Platform } from '../types';

/**
 * Feed retention options in days. 0 = keep everything.
 * Must stay in sync with profiles_feed_retention_range in Postgres.
 */
export const RETENTION_OPTIONS = [
  { days: 0, label: 'Keep everything' },
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
] as const;

/** Thresholds offered in Settings. 0 = show everything. */
export const INTENT_THRESHOLD_OPTIONS = [0, 60, 75, 85] as const;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** The one channel-label map. Every UI that names a channel reads it from here. */
export const CHANNEL_LABELS: Record<Platform, string> = {
  twitter: 'X',
  reddit: 'Reddit',
  google: 'Web',
  news: 'News',
};

/** Every sweep channel, in display order. */
export const ALL_CHANNELS: readonly Platform[] = ['twitter', 'reddit', 'google', 'news'];

/**
 * Label for a channel id. Also accepts the ids the AI suggestion API uses
 * ('x', 'web'), so callers never need a second map.
 */
export function channelLabel(id: string): string {
  if (id in CHANNEL_LABELS) return CHANNEL_LABELS[id as Platform];
  if (id === 'x') return CHANNEL_LABELS.twitter;
  if (id === 'web') return CHANNEL_LABELS.google;
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}

/** pricing_config operation charged for one keyword search on each channel. */
export const CHANNEL_PRICING_OPERATION: Record<Platform, string> = {
  twitter: 'treg.twitter.search',
  reddit: 'treg.reddit.search',
  google: 'treg.web.search',
  news: 'treg.news.search',
};

/** Mirrors public.keyword_limit() and public.channel_limit() on the server. */
export const KEYWORD_LIMIT = 8;
export const CHANNEL_LIMIT = 3;

// ---------------------------------------------------------------------------
// Public price list
// ---------------------------------------------------------------------------
//
// The single client-side copy of the price list. Signed-in views read live
// prices through src/lib/pricing.ts (the billing `pricing` action, which needs
// a session) and fall back to these values; the public landing page, which has
// no session, uses these directly. Keep them equal to pricing_config.

/** Credits per keyword, per sweep, on each channel. News is free. Fractional. */
export const CHANNEL_SEARCH_CREDITS: Record<Platform, number> = {
  twitter: 0.1,
  reddit: 0.1,
  google: 0.1,
  news: 0,
};

/** Credits per operation, keyed by pricing_config.operation. */
export const PUBLIC_PRICES: Record<string, number> = {
  'treg.twitter.search': CHANNEL_SEARCH_CREDITS.twitter,
  'treg.reddit.search': CHANNEL_SEARCH_CREDITS.reddit,
  'treg.web.search': CHANNEL_SEARCH_CREDITS.google,
  'treg.news.search': CHANNEL_SEARCH_CREDITS.news,
  /** Per billed provider call; one search can make more than one call. */
  'treg.people.search': 1,
  'treg.people.email.find': 1,
  'treg.people.phone.find': 2,
  'mail.send.connected': 0.05,
  'mail.send.hosted': 0.1,
};

export const PEOPLE_SEARCH_CREDITS = PUBLIC_PRICES['treg.people.search'];
export const VERIFIED_EMAIL_CREDITS = PUBLIC_PRICES['treg.people.email.find'];
export const DIRECT_PHONE_CREDITS = PUBLIC_PRICES['treg.people.phone.find'];
export const CONNECTED_SEND_CREDITS = PUBLIC_PRICES['mail.send.connected'];
export const HOSTED_SEND_CREDITS = PUBLIC_PRICES['mail.send.hosted'];

/**
 * Credits granted to a new account (the welcome grant in the database). They
 * can only be spent on feed sweeps; Leads and Mail need purchased credits.
 */
export const WELCOME_CREDITS = 20;

/**
 * Credits as text with up to two decimals and no trailing zeros: 2.4, 0.05,
 * 20. Credits are fractional, so they are never rounded to whole numbers.
 * Rounding to two places also hides float noise (0.1 * 3 * 8).
 */
export function formatCreditAmount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return String(Math.round(Number(n) * 100) / 100);
}

/** "1 credit", "2.4 credits". */
export function creditsText(n: number | null | undefined): string {
  const text = formatCreditAmount(n);
  return `${text} ${text === '1' ? 'credit' : 'credits'}`;
}

/** Credits for one full sweep at the product caps (all keywords, max channels). */
export const MAX_SWEEP_CREDITS =
  Math.round(
    KEYWORD_LIMIT *
      [...Object.values(CHANNEL_SEARCH_CREDITS)]
        .sort((a, b) => b - a)
        .slice(0, CHANNEL_LIMIT)
        .reduce((sum, c) => sum + c, 0) *
      100,
  ) / 100;
