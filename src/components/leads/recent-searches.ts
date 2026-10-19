import type { ProspectorSearchParams } from './prospector-types';

// Last few searches per user, for one-click re-runs. Browser storage is a
// per-viewer convenience here: losing it costs nothing, so every access is
// wrapped and an empty list is always a valid answer.

const KEY = 'echo_leads_recent_v1:';
const MAX = 6;

export function loadRecentSearches(userId: string | null): ProspectorSearchParams[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(KEY + userId);
    const list = raw ? (JSON.parse(raw) as ProspectorSearchParams[]) : [];
    return Array.isArray(list) ? list.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

const signature = (p: ProspectorSearchParams) =>
  JSON.stringify([p.title, p.q, (p.keywords ?? []).join('|'), p.companyDomain, p.country, p.location].map((v) => (v || '').toLowerCase()));

export function saveRecentSearch(userId: string | null, params: ProspectorSearchParams): ProspectorSearchParams[] {
  if (!userId) return [];
  const next = [params, ...loadRecentSearches(userId).filter((p) => signature(p) !== signature(params))].slice(0, MAX);
  try {
    localStorage.setItem(KEY + userId, JSON.stringify(next));
  } catch {
    // Storage blocked or full: recent searches simply do not persist.
  }
  return next;
}

/** Short human label, e.g. "Founder · SaaS · India". */
export function describeSearch(p: ProspectorSearchParams, countryName?: (code: string) => string | undefined): string {
  // `q` is the keywords joined, so it is shown only for older entries without them.
  return [
    p.title,
    ...(p.keywords?.length ? p.keywords : p.q ? [p.q] : []),
    p.companyDomain,
    p.location,
    p.country ? countryName?.(p.country) ?? p.country : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
