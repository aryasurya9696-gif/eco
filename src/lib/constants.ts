/**
 * Echo — shared runtime constants
 * ----------------------------------------------------------------------------
 * Kept in its own module (not in a component file) so both components and
 * contexts can import them without tripping the `only-export-components`
 * fast-refresh lint.
 */

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