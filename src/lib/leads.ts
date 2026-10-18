/**
 * Echo Leads — routing and API surface
 * ----------------------------------------------------------------------------
 * Leads is a tab inside the dashboard, not a separate app, so it has no router
 * of its own. What it does have is a sub-view, and that sub-view lives in the
 * hash so a refresh lands on the same screen and a run can be linked to.
 *
 *   #dashboard                 feed
 *   #dashboard/leads/runs      the run list
 *   #dashboard/leads/new       the New search form
 *   #dashboard/leads/clean     Clean a list
 *   #dashboard/leads/lab       Provider lab
 *   #dashboard/leads/optouts   Opt-outs
 *   #dashboard/leads/run/<id>  one run, its rows filling in
 *
 * Parsed and rebuilt here rather than inside LeadsTab, because the sidebar also
 * needs to know which tab is active on first paint — a refresh deep inside
 * #dashboard/leads/run/<id> has to come up on Leads, not on the feed.
 *
 * The API wrappers are thin on purpose. Every call goes through
 * invokeFunction, which attaches the signed-in user's JWT, and every one of them
 * is a read or a control action: the only things that cost credits are `start`,
 * `import`, `bulk` and the lab, and each of those returns its estimate before it
 * spends anything.
 */

import { invokeFunction } from './api';
import type {
  LeadEstimate,
  LeadRun,
  LeadRow,
  LeadSuppression,
  LeadRunStatus,
  LeadIcp,
  LeadIcpDocument,
  LeadsView,
  LeadStep,
} from '../types';

// ---------------------------------------------------------------------------
// Hash routing
// ---------------------------------------------------------------------------

const TAB_FROM_SEGMENT: Record<string, string> = {
  feed: 'feed',
  keywords: 'keywords',
  leads: 'leads',
  billing: 'billing',
  settings: 'settings',
};

/**
 * Reads the tab out of the hash.
 *
 * Only the first segment after `dashboard` decides the tab. Anything deeper is a
 * Leads sub-view and belongs to the tab, not to a route of its own — which is
 * why `#dashboard/leads/run/abc` comes back as `leads`.
 */
export function tabFromHash(hash: string = window.location.hash): string | null {
  const raw = hash.replace(/^#\/?/, '').split('?')[0];
  const segments = raw.split('/').filter(Boolean);
  if (segments[0] !== 'dashboard') return null;
  const [, tab] = segments;
  return tab && tab in TAB_FROM_SEGMENT ? tab : 'feed';
}

const DEFAULT_VIEW: LeadsView = 'people';

const KNOWN_VIEWS: LeadsView[] = [
  'search', 'people', 'companies', 'lists', 'usage', 'runs', 'new', 'clean', 'lab', 'optouts', 'automations', 'run',
];

/**
 * Reads the Leads sub-view, and the run id when the view is a run.
 *
 * An unrecognised segment falls back to the run list rather than rendering
 * nothing. A stale or hand-edited hash should land somewhere useful, not on an
 * empty panel that looks like a bug.
 */
export function leadsRouteFromHash(hash: string = window.location.hash): {
  view: LeadsView;
  runId: string | null;
} {
  const raw = hash.replace(/^#\/?/, '').split('?')[0];
  const segments = raw.split('/').filter(Boolean);

  if (segments[0] !== 'dashboard' || segments[1] !== 'leads') {
    return { view: DEFAULT_VIEW, runId: null };
  }

  const [, , view, id] = segments;

  if (view === 'run') {
    // A run route without an id is not a run. Same reasoning as above.
    return id ? { view: 'run', runId: id } : { view: DEFAULT_VIEW, runId: null };
  }

  if (view && KNOWN_VIEWS.includes(view as LeadsView)) {
    return { view: view as LeadsView, runId: null };
  }

  return { view: DEFAULT_VIEW, runId: null };
}

/** The hash for a tab, preserving whatever Leads sub-view is showing. */
export function hashForTab(tab: string, leadsRoute?: { view: LeadsView; runId: string | null }): string {
  if (tab !== 'leads') return `#dashboard/${tab}`;
  if (!leadsRoute) return '#dashboard/leads/people';
  if (leadsRoute.view === 'run') {
    return leadsRoute.runId
      ? `#dashboard/leads/run/${leadsRoute.runId}`
      : '#dashboard/leads/runs';
  }
  return `#dashboard/leads/${leadsRoute.view}`;
}

/**
 * Writes the hash.
 *
 * Uses replaceState rather than assigning location.hash, because assigning
 * pushes a history entry, and a browser Back after switching Leads panels would
 * walk back through every panel click instead of leaving the dashboard. Panel
 * switches are not navigation.
 */
export function setHash(hash: string): void {
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// ---------------------------------------------------------------------------
// Reads — safe to call freely
// ---------------------------------------------------------------------------

export async function listRuns(limit = 50): Promise<LeadRun[]> {
  const res = await invokeFunction<{ runs: LeadRun[] }>('leads', {
    action: 'list_runs',
    limit,
  });
  return res.runs ?? [];
}

/**
 * Union return, because the function genuinely has two answers.
 *
 * A run id that is not a uuid, and a run belonging to somebody else, both come
 * back as { ok: false } rather than as a thrown error — "not found" is an answer
 * here, not a failure of the request. Typing it as always-succeeding would make
 * every caller's error branch unreachable, and a run id pointing at another
 * workspace would render as an empty table rather than as not-found.
 */
export type GetRunResult =
  | { ok: true; run: LeadRun; rows: LeadRow[]; total: number }
  | { ok: false; error: string };

export async function getRun(
  runId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<GetRunResult> {
  const { limit = 200, offset = 0 } = opts;
  return invokeFunction<GetRunResult>('leads', {
    action: 'get_run',
    run_id: runId,
    limit,
    offset,
  });
}

export async function getActiveRunCount(): Promise<number> {
  // Straight through the function rather than counting rows client-side: the
  // badge must not depend on the browser having loaded the run list.
  const res = await invokeFunction<{ count: number }>('leads', { action: 'active_count' });
  return res.count ?? 0;
}

export async function getSuppressions(): Promise<LeadSuppression[]> {
  const res = await invokeFunction<{ suppressions: LeadSuppression[] }>('leads', {
    action: 'suppressions_list',
  });
  return res.suppressions ?? [];
}

/**
 * The price of a run, before it starts.
 *
 * Called on every change to the New search form, so the button can never show a
 * figure that disagrees with what the run will actually be checked against. A
 * failed estimate returns null rather than zero: a zero estimate would render a
 * free-looking button, and the run would then be refused at reserve time with
 * the user having been told nothing.
 */
export async function estimateRun(input: {
  kind?: 'find' | 'clean' | 'lab';
  target: number;
  mode?: string;
  icp_id?: string | null;
  row_cap_usd?: number;
  phone?: boolean;
}): Promise<LeadEstimate | null> {
  try {
    const res = await invokeFunction<{ estimate: LeadEstimate }>('leads', {
      action: 'estimate',
      ...input,
    });
    return res.estimate ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The ideal customer profile
// ---------------------------------------------------------------------------

/**
 * The user's saved ICP, or null.
 *
 * Ordered by approval rather than creation, so returning to the New search
 * screen shows the profile they last approved rather than the newest draft
 * somebody half-filled and abandoned. A screen that greets a returning user with
 * a blank form for an ICP that already exists reads as losing their work.
 */
export async function getIcp(): Promise<LeadIcp | null> {
  const res = await invokeFunction<{ icp: LeadIcp | null }>('leads', { action: 'icp_get' });
  return res.icp ?? null;
}

/**
 * Writes the ICP.
 *
 * "approved" is a separate argument rather than a field inside the document
 * because approval is a fact about the row, not about what the user wrote. The
 * search screen marks the profile it is about to run as approved so it is the
 * one that comes back next time.
 */
export async function saveIcp(input: {
  id?: string | null;
  website?: string | null;
  offer?: string | null;
  icp: LeadIcpDocument;
  approved?: boolean;
  note?: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  return invokeFunction<{ ok: true; id: string } | { ok: false; error: string }>('leads', {
    action: 'save_icp',
    ...input,
  });
}

// ---------------------------------------------------------------------------
// The waterfall order
// ---------------------------------------------------------------------------

export interface WaterfallOrder {
  /** Null means "no custom order", which is what the shipped default means. */
  order: string[] | null;
  mode: 'default' | 'smart' | 'custom';
  /** The shipped order for this step, from the registry. */
  defaultOrder: string[];
  /**
   * What will actually run: the saved order with anything newer appended, or the
   * shipped one when there is no saved order. Empty when the server could not
   * answer, so the lab can say so rather than drawing an empty list.
   */
  effectiveOrder: string[];
}

export async function getWaterfall(step: LeadStep): Promise<WaterfallOrder> {
  try {
    const res = await invokeFunction<{
      order: string[] | null;
      mode: string;
      default_order: string[];
      effective_order: string[];
    }>('leads', {
      action: 'waterfall_get',
      step,
    });
    return {
      order: res.order ?? null,
      mode: (res.mode as WaterfallOrder['mode']) ?? 'default',
      defaultOrder: res.default_order ?? [],
      effectiveOrder: res.effective_order ?? res.default_order ?? [],
    };
  } catch {
    // A screen that cannot read the order shows the shipped default rather than
    // an error, because the default is genuinely what will run. Failing to read
    // is not a reason to tell the user their waterfall is broken when it is
    // working exactly as it did before they opened this page.
    //
    // The shipped order is still filled in, from the copy this file has always
    // held for the email step. It is a copy and it can go stale, which is why
    // it is only the fallback: the server's list is preferred wherever it arrives.
    return {
      order: null,
      mode: 'default',
      defaultOrder: DEFAULT_EMAIL_ORDER,
      effectiveOrder: DEFAULT_EMAIL_ORDER,
    };
  }
}

export async function setWaterfall(
  step: LeadStep,
  endpointIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  return invokeFunction<{ ok: boolean; error?: string }>('leads', {
    action: 'waterfall_put',
    step,
    endpoint_ids: endpointIds,
  });
}

// ---------------------------------------------------------------------------
// What the providers actually did
// ---------------------------------------------------------------------------

export interface ProviderStat {
  endpoint_id: string;
  label: string;
  step: string;
  price_usd: number;
  verified: boolean;
  in_order: boolean;
  attempts: number;
  hits: number;
  /** Attempts that supplied an address no other provider had already. */
  first_to_find: number;
  cost_usd: number;
  runs: number;
  rows: number;
  /** Null rather than 0 for a provider nobody has asked yet. */
  hit_rate: number | null;
  /** Null until there has been at least one independent find. */
  cost_per_find: number | null;
  cost_per_attempt: number | null;
}

export interface ProviderStatsResult {
  step: string;
  providers: ProviderStat[];
  total_attempts: number;
  total_cost_usd: number;
}

/**
 * The lab's numbers, across every run rather than one.
 *
 * Returns every endpoint in the registry, not only the ones with history,
 * because "in the chain and never called" is itself an answer to a question
 * somebody is on this screen to ask.
 */
export async function getProviderStats(
  step: LeadStep = 'email',
): Promise<ProviderStatsResult | null> {
  try {
    return await invokeFunction<ProviderStatsResult>('leads', { action: 'provider_stats', step });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------

export async function addSuppression(
  value: string,
  reason?: string,
): Promise<{ ok: boolean; kind?: 'email' | 'domain'; error?: string }> {
  return invokeFunction<{ ok: boolean; kind?: 'email' | 'domain'; error?: string }>('leads', {
    action: 'suppressions_add',
    value,
    reason,
  });
}

export async function removeSuppression(
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  return invokeFunction<{ ok: boolean; error?: string }>('leads', {
    action: 'suppressions_remove',
    value,
  });
}

/**
 * Whether a value will be filed as an address or as a domain.
 *
 * The server derives the same thing and is what actually decides, so this only
 * exists to show the user what they are about to add. Deliberately the identical
 * test: a UI that labelled it one way and the server filed it another would be
 * worse than not labelling it at all.
 */
export function suppressionKind(value: string): 'email' | 'domain' {
  return value.includes('@') ? 'email' : 'domain';
}

/**
 * What to send, so what is typed is what is stored.
 *
 * Mirrors the server's normalisation rather than inventing a tidier one: an
 * opt-out for "HTTPS://Pemberton.example/pricing" has to become the same row as
 * one for "pemberton.example", or the list silently fails to suppress anything
 * and the user believes it is working.
 */
export function normaliseSuppression(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .trim();
}
// ---------------------------------------------------------------------------
// Starting and feeding a run
// ---------------------------------------------------------------------------

/**
 * The most rows one run can be priced for.
 *
 * `start_run` clamps its target to 2000 before it calls `estimate_lead_run`, and
 * it is the *maximum* that is checked against the wallet. Importing more than
 * this into a run priced for 2000 would be working past the ceiling that was
 * reserved, so the run would pause on credits partway through instead of failing
 * at the start — which is the worse of the two places to find out. The cap is
 * enforced here and the user is told, rather than discovered.
 */
export const MAX_RUN_ROWS = 2000;

/** What the function takes, and what it gives back on failure. */
export type StartRunResult =
  | { ok: true; run: LeadRun }
  | { ok: false; error: string; message?: string; shortfall?: number; max_credits?: number };

export async function startRun(input: {
  kind: 'find' | 'clean' | 'lab';
  target: number;
  name?: string;
  mode?: string;
  icp_id?: string | null;
  phone?: boolean;
  company_data?: boolean;
  row_cap_usd?: number;
}): Promise<StartRunResult> {
  return invokeFunction<StartRunResult>('leads', {
    action: 'start',
    ...input,
    // Clamped here as well as server-side, so the target the user is told about
    // and the target that is priced are the same number rather than the first
    // being optimistic and the second quietly smaller.
    target: Math.max(1, Math.min(MAX_RUN_ROWS, Math.floor(input.target))),
  });
}

/**
 * Union, because the function has two answers.
 *
 * `skipped` is not an error and is not a failure count. It is rows that matched
 * something on the caller's opt-outs list and were therefore never written — so
 * it is reported alongside the inserted count rather than as an exception, and a
 * suppressed row is never billed for.
 */
export type ImportResult =
  | { ok: true; inserted: number; skipped: number }
  | { ok: false; error: string };

/**
 * Sends one batch of rows into an existing run.
 *
 * One thousand is the function's own cap and it slices to that, so a larger batch
 * would be silently truncated and the caller would believe every row went in.
 * The caller batches; this refuses to pretend otherwise.
 */
export async function importRows(
  runId: string,
  rows: Array<{
    person_name?: string;
    first_name?: string;
    last_name?: string;
    company_name?: string;
    domain?: string;
    website?: string;
    title?: string;
    email?: string;
    linkedin_url?: string;
    extra?: Record<string, string>;
  }>,
  /**
   * True on the final batch. A clean run is created on hold so the worker does
   * not find it empty and finish it; the last batch releases it.
   */
  last = false,
): Promise<ImportResult> {
  if (rows.length > 1000) throw new Error('importRows takes at most 1000 rows');
  return invokeFunction<ImportResult>('leads', { action: 'import', run_id: runId, rows, last });
}

// ---------------------------------------------------------------------------
// Bulk actions on a run's rows
// ---------------------------------------------------------------------------

export type BulkAction = 'delete' | 'reverify' | 'find_phone';

/**
 * Acts on several rows at once.
 *
 * The server refuses a list of anything that is not a uuid, and refuses an
 * unknown action, so this cannot be used to smuggle an id past the ownership
 * check — but it is worth knowing that the client filters anyway, because an
 * array of nulls in a query string is a confusing failure and one that only
 * appears in somebody's production logs.
 */
export async function bulkAction(
  runId: string,
  rowIds: string[],
  action: BulkAction,
): Promise<{ ok: boolean; error?: string; deleted?: number; requeued?: number }> {
  const ids = rowIds.filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  );

  if (ids.length === 0) return { ok: false, error: 'Nothing selected.' };

  return invokeFunction<{ ok: boolean; error?: string; deleted?: number; requeued?: number }>('leads', {
    action: 'bulk',
    row_ids: ids,
    bulk: action,
    run_id: runId,
  });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export type RunControl = 'pause' | 'resume' | 'cancel';

export async function controlRun(runId: string, action: RunControl): Promise<LeadRunStatus> {
  const res = await invokeFunction<{ status: LeadRunStatus }>('leads', {
    action,
    run_id: runId,
  });
  return res.status;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Whether a run still needs the sidebar badge.
 *
 * `paused` counts as active on purpose: a paused run is unfinished work sitting
 * in the user's account, and it is exactly the run they need to notice in order
 * to top up and resume it. Hiding it would leave the reason invisible.
 */
export function isActiveRun(status: LeadRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'paused';
}

/**
 * The provider chip colours, keyed by endpoint prefix.
 *
 * The provider id is matched on its prefix rather than an exact string, because
 * the registry and the attempt log both refer to endpoints as
 * `quickenrich.people.email.find` while the waterfall refers to them by a short
 * name. Matching the prefix means a new endpoint on a provider already in this
 * list is coloured correctly without touching this file.
 */
const PROVIDER_STYLE: Array<{ match: string; label: string; chip: string; ink: string }> = [
  { match: 'quickenrich', label: 'QuickEnrich', chip: 'bg-[#dff3ea]', ink: 'text-[#2f7d5b]' },
  { match: 'trykitt', label: 'Kitt', chip: 'bg-[#dcebfa]', ink: 'text-[#2f6aa8]' },
  { match: 'aiark', label: 'AI Ark', chip: 'bg-[#ece5f7]', ink: 'text-[#6a4fa3]' },
  { match: 'tomba', label: 'Tomba', chip: 'bg-[#fbe8dc]', ink: 'text-[#a65a2e]' },
  { match: 'leadsforge', label: 'LeadsForge', chip: 'bg-[#f8f0d2]', ink: 'text-[#8a6d16]' },
  { match: 'contactout', label: 'ContactOut', chip: 'bg-[#e6efe0]', ink: 'text-[#4f7a3a]' },
  { match: 'millionverifier', label: 'MillionVerifier', chip: 'bg-[#f7e2e6]', ink: 'text-[#a2445a]' },
  { match: 'icypeas', label: 'Icypeas', chip: 'bg-[#e8eef2]', ink: 'text-[#4a6572]' },
  { match: 'findymail', label: 'Findymail', chip: 'bg-[#e8eef2]', ink: 'text-[#4a6572]' },
  { match: 'leadmagic', label: 'LeadMagic', chip: 'bg-[#e8eef2]', ink: 'text-[#4a6572]' },
  { match: 'dropleads', label: 'Dropleads', chip: 'bg-[#f1ece4]', ink: 'text-[#7a6650]' },
  { match: 'hlrlookup', label: 'HLR Lookup', chip: 'bg-[#f1ece4]', ink: 'text-[#7a6650]' },
  // The rest of the registry. Every vendor in the catalogue needs an entry,
  // because the lab now has a tab per step and a row labelled "Provider" is a
  // row that says we do not know who was just charged. Prospeo in particular is
  // the only endpoint in the enrich step, so before this the one provider a user
  // could see on that tab had no name on it.
  { match: 'prospeo', label: 'Prospeo', chip: 'bg-[#ece5f7]', ink: 'text-[#6a4fa3]' },
  { match: 'branddev', label: 'BrandDev', chip: 'bg-[#e8eef2]', ink: 'text-[#4a6572]' },
  { match: 'crustdata', label: 'Crustdata', chip: 'bg-[#f1ece4]', ink: 'text-[#7a6650]' },
  { match: 'companyenrich', label: 'Company Enrich', chip: 'bg-[#e6efe0]', ink: 'text-[#4f7a3a]' },
  { match: 'treg', label: 'Treg', chip: 'bg-[#eeeeea]', ink: 'text-[#8a8a86]' },
];

const UNKNOWN_PROVIDER = {
  label: 'Provider',
  chip: 'bg-[#eeeeea]',
  ink: 'text-[#8a8a86]',
};

/**
 * The shipped email order, and now only a fallback.
 *
 * The chain the run view draws is the one the server sends: waterfall_get
 * returns both the shipped order and the effective one, so a user with a saved
 * order sees their order, and a provider added to the registry since is visible
 * rather than invisible. This list was what that used to fall back on, and the
 * registry has since grown steps this copy does not have.
 *
 * Kept rather than deleted because it is the only thing the lab can show if
 * waterfall_get itself fails, and showing the shipped order is correct then -
 * it is what the worker would do. It is now only ever used for the email step.
 *
 * The alternative - importing the registry - is not available: it lives in
 * supabase/functions, which the browser bundler does not resolve. Which is
 * exactly why the server sends it and this is the backstop.
 */
export const DEFAULT_EMAIL_ORDER: string[] = [
  'quickenrich.people.email.find',
  'trykitt.people.email.find',
  'aiark.people.email.find',
  'tomba.people.email.find',
  'leadsforge.people.email.find',
];

/** The provider's display name, or the raw id when it is one we do not know. */
export function providerLabel(endpointId: string): string {
  return providerStyle(endpointId).label;
}

export interface ProviderStyle {
  label: string;
  chip: string;
  ink: string;
}

export function providerStyle(endpointId: string | null | undefined): ProviderStyle {
  if (!endpointId) return UNKNOWN_PROVIDER;
  const hit = PROVIDER_STYLE.find((p) => endpointId.startsWith(p.match));
  return hit ? { label: hit.label, chip: hit.chip, ink: hit.ink } : UNKNOWN_PROVIDER;
}

/**
 * How an email's verification state should read.
 *
 * `not_found` is deliberately the quietest of the five: nothing was found and
 * nothing was charged, which is a normal outcome and should not look like a
 * failure. `invalid` is the loud one, because it is the one worth retrying.
 */
export function emailStatusLabel(status: LeadRow['email_status']): {
  label: string;
  className: string;
  title: string;
} {
  switch (status) {
    case 'verified':
      return {
        label: 'Verified',
        className: 'bg-[#e3f2e9] text-[#1a7f4b]',
        title: 'Deliverability confirmed by a verifier.',
      };
    case 'catch_all':
      return {
        label: 'Catch-all',
        className: 'bg-[#f8eedb] text-[#b5801f]',
        title:
          'Valid syntax at a domain that accepts any mailbox. It may not reach this person. ' +
          'Treat it as risky rather than as a found address.',
      };
    case 'invalid':
      return {
        label: 'Invalid',
        className: 'bg-[#f8e4df] text-[#c0462e]',
        title: 'Confirmed dead. Worth re-running the waterfall from the next provider.',
      };
    case 'disposable':
      return {
        label: 'Disposable',
        className: 'bg-[#f8e4df] text-[#c0462e]',
        title: 'A throwaway mailbox, as reported by the verifier. Not a usable work address.',
      };
    case 'unknown':
      return {
        label: 'Unknown',
        className: 'bg-[#eeeeea] text-[#8a8a86]',
        title: 'A verifier was asked and could not tell either way.',
      };
    case 'unchecked':
      return {
        label: 'Not checked',
        className: 'bg-white text-[#8a8a86] border border-[#e3e3de]',
        title: 'An address nothing has verified yet. Found or imported, not confirmed.',
      };
    case 'not_found':
    default:
      return {
        label: 'Not found',
        className: 'bg-[#eeeeea] text-[#8a8a86]',
        title: 'No provider produced an email for this person. Nothing was charged for it.',
      };
  }
}
