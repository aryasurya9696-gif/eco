/**
 * Echo — shared runtime constants
 * ----------------------------------------------------------------------------
 * Kept in its own module (not in a component file) so both components and
 * contexts can import them without tripping the `only-export-components`
 * fast-refresh lint.
 */

/**
 * Webhook URL allow-list. MUST stay in sync with the
 * guard_profile_webhook() trigger in
 * supabase/migrations/20261017_security_hardening.sql
 */
export const WEBHOOK_PATTERN =
  /^https:\/\/[a-zA-Z0-9.-]*\.(hooks\.slack\.com|slack\.com|discord\.com|discordapp\.com)\//;

/** Returns an error message, or null when the URL is acceptable. */
export function validateWebhookUrl(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  if (!WEBHOOK_PATTERN.test(url)) {
    return 'Webhook must be an https Slack (hooks.slack.com) or Discord (discord.com) URL.';
  }
  return null;
}

/**
 * Platforms the sweep functions actually implement.
 * Must stay in sync with profiles_enabled_channels_supported in Postgres.
 */
export const SUPPORTED_PLATFORMS = ['twitter', 'reddit', 'google', 'linkedin'] as const;

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

/** Score bounds produced by the intent algorithm in the edge functions. */
export const INTENT_SCORE_MIN = 0;
export const INTENT_SCORE_MAX = 97;

/** Thresholds offered in Settings. 0 = show everything. */
export const INTENT_THRESHOLD_OPTIONS = [0, 60, 75, 85] as const;