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
  leads: 'leads',
  keywords: 'keywords',
  billing: 'billing',
  settings: 'settings',
  mail: 'mail',
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

/** The tab the hash names explicitly; null for a bare #dashboard or a non-dashboard hash. */
export function explicitTabFromHash(hash: string = window.location.hash): string | null {
  const segments = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  if (segments[0] !== 'dashboard') return null;
  return segments[1] && segments[1] in TABS ? segments[1] : null;
}

/*
 * Intents that must survive sign-in, onboarding and email-link sign-up.
 *
 * A signed-out visit to #dashboard/billing shows the sign-in page, and signing
 * in navigates to a bare #/dashboard; a Buy click on the landing page names a
 * package. Both are remembered here in between.
 *
 * localStorage, not sessionStorage: confirming a sign-up opens the email link
 * in a new tab, which has an empty sessionStorage, so the intent was lost for
 * exactly the visitors who had just decided to pay. A TTL keeps a stale intent
 * from hijacking a visit days later.
 */
const INTENDED_TAB_KEY = 'echo_intended_tab';
const INTENDED_PACKAGE_KEY = 'echo_intended_package';
const INTENT_TTL_MS = 24 * 60 * 60 * 1000;

function writeIntent(key: string, value: string): void {
  try {
    localStorage.setItem(key, JSON.stringify({ value, expires: Date.now() + INTENT_TTL_MS }));
  } catch {
    // Storage unavailable: the visitor simply lands on the default tab.
  }
}

function readIntent(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: unknown; expires?: unknown };
    if (typeof parsed?.value !== 'string' || typeof parsed.expires !== 'number' || parsed.expires < Date.now()) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

function clearIntent(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

export function rememberIntendedTab(): void {
  const tab = explicitTabFromHash();
  if (tab) writeIntent(INTENDED_TAB_KEY, tab);
}

export function peekIntendedTab(): string | null {
  const tab = readIntent(INTENDED_TAB_KEY);
  return tab && tab in TABS ? tab : null;
}

export function clearIntendedTab(): void {
  clearIntent(INTENDED_TAB_KEY);
}

/** The package picked on the landing page, until Billing has shown it. */
export function rememberIntendedPackage(code: string): void {
  if (code) writeIntent(INTENDED_PACKAGE_KEY, code);
}

export function peekIntendedPackage(): string | null {
  return readIntent(INTENDED_PACKAGE_KEY);
}

export function clearIntendedPackage(): void {
  clearIntent(INTENDED_PACKAGE_KEY);
}
