/**
 * Dashboard tab routing, from the hash.
 * ----------------------------------------------------------------------------
 * Reads the tab out of the URL so a refresh, a bookmark or a shared link lands
 * on the tab it names rather than always on the feed.
 *
 * Deliberately does not use `location.hash = ...` to change tabs. Assigning to
 * `hash` pushes a history entry, so Back after switching tabs would walk back
 * through every tab click instead of leaving the dashboard. Switching tabs is
 * not navigation. Callers use `history.replaceState` for the same reason.
 *
 * An unknown or absent segment resolves to the feed rather than to nothing: a
 * stale link should show the app, not a blank page.
 */

const TABS: Record<string, string> = {
  feed: 'feed',
  keywords: 'keywords',
  billing: 'billing',
  settings: 'settings',
};

/** The tab named in the hash, or null when the hash is not a dashboard URL. */
export function tabFromHash(hash: string = window.location.hash): string | null {
  const raw = hash.replace(/^#\/?/, '').split('?')[0];
  const segments = raw.split('/').filter(Boolean);
  if (segments[0] !== 'dashboard') return null;
  const [, tab] = segments;
  return tab && tab in TABS ? tab : 'feed';
}

/** The hash for a tab. */
export function hashForTab(tab: string): string {
  return `#dashboard/${tab}`;
}
