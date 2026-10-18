/**
 * Echo Leads — automation rules
 * ----------------------------------------------------------------------------
 * The decisions an automation makes, kept free of the database and the network
 * so they can be tested on their own: what a valid automation is, when it runs
 * next, whether a run fits its caps, and which searched people are new.
 *
 * The money rule lives in budgetDecision. Every paid automation has a cap per
 * run and a cap per calendar month (UTC), and a run is refused unless its
 * estimated maximum fits both. The trigger in 20261120_lead_automations.sql
 * applies the same rule again on the run's insert.
 */

export type AutomationKind = 'saved_search_refresh' | 'auto_enrich' | 'auto_tag';
export type Frequency = 'daily' | 'weekly';
export type AutoEnrichAction = 'find_email' | 'verify' | 'phone';

export const AUTOMATION_KINDS: AutomationKind[] = ['saved_search_refresh', 'auto_enrich', 'auto_tag'];
export const AUTO_ENRICH_ACTIONS: AutoEnrichAction[] = ['find_email', 'verify', 'phone'];

/** The clean-run mode each enrichment uses. Matches ACTION_MODE in workspace.ts. */
export const ENRICH_MODE: Record<AutoEnrichAction, string> = {
  find_email: 'verify_refind',
  verify: 'verify_only',
  phone: 'phone_only',
};

export interface Schedule {
  frequency: Frequency;
  hour: number;
  weekday: number | null;
}

export interface SearchRefreshConfig {
  saved_search_id: string;
  list_id: string | null;
  max_people: number;
  enrich: 'none' | 'find_email';
}

export interface AutoEnrichConfig {
  saved_search_id: string;
  enrich: AutoEnrichAction;
  max_rows: number;
  skip_recent_days: number;
}

export interface AutoTagConfig {
  saved_search_id: string;
  add_tags: string[];
  remove_tags: string[];
}

export type AutomationConfig = SearchRefreshConfig | AutoEnrichConfig | AutoTagConfig;

export interface AutomationInput {
  name: string;
  kind: AutomationKind;
  config: AutomationConfig;
  schedule: Schedule;
  max_credits_per_run: number;
  max_credits_per_month: number;
}

export const LIMITS = {
  maxPeople: 200,
  maxRows: 500,
  maxCredits: 1_000_000,
  failuresBeforePause: 3,
};

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d;
};
const tagList = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => str(x, 40).toLowerCase()).filter(Boolean))].slice(0, 10)
    : [];
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Whether this automation can start paid work. */
export function isPaid(kind: AutomationKind, config: Partial<AutomationConfig> | null | undefined): boolean {
  if (kind === 'auto_enrich') return true;
  if (kind === 'saved_search_refresh') return (config as SearchRefreshConfig | undefined)?.enrich === 'find_email';
  return false;
}

/** The kind of saved search each automation reads. */
export function savedSearchKindFor(kind: AutomationKind): 'people_search' | 'people_view' {
  return kind === 'saved_search_refresh' ? 'people_search' : 'people_view';
}

export type Cleaned<T> = { ok: true; value: T } | { ok: false; error: string };

export function cleanSchedule(v: any): Cleaned<Schedule> {
  const frequency = (v?.frequency ?? 'daily') as Frequency;
  if (frequency !== 'daily' && frequency !== 'weekly') return { ok: false, error: 'bad_frequency' };
  const hour = Number(v?.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: 'bad_hour' };
  if (frequency === 'daily') return { ok: true, value: { frequency, hour, weekday: null } };
  const weekday = Number(v?.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { ok: false, error: 'bad_weekday' };
  return { ok: true, value: { frequency, hour, weekday } };
}

export function cleanConfig(kind: AutomationKind, v: any): Cleaned<AutomationConfig> {
  if (!isUuid(v?.saved_search_id)) return { ok: false, error: 'saved_search_required' };
  if (kind === 'saved_search_refresh') {
    if (v?.list_id != null && v?.list_id !== '' && !isUuid(v.list_id)) return { ok: false, error: 'bad_list' };
    const enrich = v?.enrich === 'find_email' ? 'find_email' : v?.enrich == null || v?.enrich === 'none' ? 'none' : null;
    if (!enrich) return { ok: false, error: 'bad_enrich' };
    return {
      ok: true,
      value: {
        saved_search_id: v.saved_search_id,
        list_id: isUuid(v?.list_id) ? v.list_id : null,
        max_people: int(v?.max_people, 1, LIMITS.maxPeople, 50),
        enrich,
      },
    };
  }
  if (kind === 'auto_enrich') {
    if (!AUTO_ENRICH_ACTIONS.includes(v?.enrich)) return { ok: false, error: 'bad_enrich' };
    return {
      ok: true,
      value: {
        saved_search_id: v.saved_search_id,
        enrich: v.enrich,
        max_rows: int(v?.max_rows, 1, LIMITS.maxRows, 100),
        skip_recent_days: int(v?.skip_recent_days, 1, 365, 30),
      },
    };
  }
  const add = tagList(v?.add_tags);
  const remove = tagList(v?.remove_tags).filter((t) => !add.includes(t));
  if (!add.length && !remove.length) return { ok: false, error: 'tags_required' };
  return { ok: true, value: { saved_search_id: v.saved_search_id, add_tags: add, remove_tags: remove } };
}

/**
 * Validates a create or edit request. A paid automation must carry both caps,
 * and the run cap may not exceed the month's.
 */
export function cleanAutomation(body: any): Cleaned<AutomationInput> {
  const name = str(body?.name, 80);
  if (!name) return { ok: false, error: 'name_required' };
  const kind = body?.kind as AutomationKind;
  if (!AUTOMATION_KINDS.includes(kind)) return { ok: false, error: 'bad_kind' };
  const config = cleanConfig(kind, body?.config);
  if (!config.ok) return config;
  const schedule = cleanSchedule(body?.schedule);
  if (!schedule.ok) return schedule;

  const perRun = Number(body?.max_credits_per_run ?? 0);
  const perMonth = Number(body?.max_credits_per_month ?? 0);
  if (!Number.isFinite(perRun) || !Number.isFinite(perMonth) || perRun < 0 || perMonth < 0) {
    return { ok: false, error: 'bad_cap' };
  }
  if (perRun > LIMITS.maxCredits || perMonth > LIMITS.maxCredits) return { ok: false, error: 'bad_cap' };
  const paid = isPaid(kind, config.value);
  if (paid && (perRun <= 0 || perMonth <= 0)) return { ok: false, error: 'cap_required' };
  if (perRun > perMonth) return { ok: false, error: 'run_cap_over_month_cap' };

  return {
    ok: true,
    value: {
      name,
      kind,
      config: config.value,
      schedule: schedule.value,
      // A free automation keeps no caps: zero means it may not spend.
      max_credits_per_run: paid ? round6(perRun) : 0,
      max_credits_per_month: paid ? round6(perMonth) : 0,
    },
  };
}

/** The first scheduled instant strictly after `after`, in UTC, on the hour. */
export function nextRunAt(s: Schedule, after: Date): Date {
  const t = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), s.hour, 0, 0, 0));
  if (s.frequency === 'daily') {
    if (t.getTime() <= after.getTime()) t.setUTCDate(t.getUTCDate() + 1);
    return t;
  }
  const wd = s.weekday ?? 1;
  let days = (wd - t.getUTCDay() + 7) % 7;
  if (days === 0 && t.getTime() <= after.getTime()) days = 7;
  t.setUTCDate(t.getUTCDate() + days);
  return t;
}

/** Midnight UTC on the first of `now`'s month. The monthly cap resets here. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type BudgetRefusal = 'no_cap' | 'bad_estimate' | 'over_run_cap' | 'over_month_cap';

export type BudgetDecision =
  | { ok: true; remaining_month: number }
  | { ok: false; reason: BudgetRefusal; message: string; remaining_month: number };

/**
 * Whether a run whose estimated maximum is `estimateMax` may start.
 *
 * `committedThisMonth` is what this automation's runs have charged this month,
 * counting a run still working at its approved maximum.
 */
export function budgetDecision(o: {
  estimateMax: number;
  perRunCap: number;
  perMonthCap: number;
  committedThisMonth: number;
}): BudgetDecision {
  const perRun = Number(o.perRunCap);
  const perMonth = Number(o.perMonthCap);
  const committed = Math.max(0, Number(o.committedThisMonth) || 0);
  const remaining = round6(Math.max(0, (Number.isFinite(perMonth) ? perMonth : 0) - committed));
  const max = Number(o.estimateMax);

  if (!Number.isFinite(perRun) || !Number.isFinite(perMonth) || perRun <= 0 || perMonth <= 0) {
    return { ok: false, reason: 'no_cap', remaining_month: remaining, message: 'This automation has no spending cap, so it may not start paid work.' };
  }
  if (!Number.isFinite(max) || max < 0) {
    return { ok: false, reason: 'bad_estimate', remaining_month: remaining, message: 'The run could not be priced, so it was not started.' };
  }
  if (max > perRun) {
    return {
      ok: false,
      reason: 'over_run_cap',
      remaining_month: remaining,
      message: `The run could cost up to ${round6(max)} credits, over this automation's cap of ${round6(perRun)} per run.`,
    };
  }
  if (round6(committed + max) > perMonth) {
    return {
      ok: false,
      reason: 'over_month_cap',
      remaining_month: remaining,
      message: `The run could cost up to ${round6(max)} credits, and only ${remaining} of this month's ${round6(perMonth)} remain.`,
    };
  }
  return { ok: true, remaining_month: remaining };
}

/** Same as lead_norm_name in SQL. */
export function normName(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return s || null;
}

/** Same as lead_norm_domain in SQL. */
export function normDomain(v: unknown): string | null {
  const s = String(v ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)*/, '')
    .replace(/[/?#:].*$/, '');
  return s || null;
}

export interface SearchedPerson {
  leadsforge_id?: string | null;
  person_name?: string | null;
  domain?: string | null;
  email?: string | null;
  contact_id?: string | null;
}

export interface Known {
  leadsforgeIds: Set<string>;
  /** `${normName}@${normDomain}` of contacts already held. */
  nameDomains: Set<string>;
  suppressed: Set<string>;
}

/**
 * Splits searched people into those to save and those to skip: already in the
 * database (by provider id, or name at domain, the same key the merge uses), on
 * the opt-out list (address or domain), or without the name and domain a
 * contact needs. Repeats within the batch count as existing.
 */
export function dedupePeople<T extends SearchedPerson>(people: T[], known: Known) {
  const fresh: T[] = [];
  const skipped = { existing: 0, suppressed: 0, incomplete: 0 };
  const seen = new Set<string>();
  for (const p of people) {
    const name = normName(p.person_name);
    const domain = normDomain(p.domain);
    if (!name || !domain) {
      skipped.incomplete++;
      continue;
    }
    const email = String(p.email ?? '').trim().toLowerCase();
    if (known.suppressed.has(domain) || (email && known.suppressed.has(email))) {
      skipped.suppressed++;
      continue;
    }
    const key = `${name}@${domain}`;
    const lf = p.leadsforge_id ? String(p.leadsforge_id) : '';
    if (p.contact_id || (lf && known.leadsforgeIds.has(lf)) || known.nameDomains.has(key) || seen.has(key)) {
      skipped.existing++;
      continue;
    }
    seen.add(key);
    fresh.push(p);
  }
  return { fresh, skipped };
}

/** How many leads the per-run estimate is priced at: the most one run can take. */
export function rowsPerRun(kind: AutomationKind, config: AutomationConfig): number {
  if (kind === 'saved_search_refresh') return (config as SearchRefreshConfig).max_people;
  if (kind === 'auto_enrich') return (config as AutoEnrichConfig).max_rows;
  return 0;
}

/** The clean-run mode for an automation's paid step, or null when it has none. */
export function modeFor(kind: AutomationKind, config: AutomationConfig): string | null {
  if (!isPaid(kind, config)) return null;
  if (kind === 'saved_search_refresh') return ENRICH_MODE.find_email;
  return ENRICH_MODE[(config as AutoEnrichConfig).enrich];
}

/** After a failed run: the new failure count, and whether to pause. */
export function afterFailure(failureCount: number): { failure_count: number; pause: boolean } {
  const n = Math.max(0, Math.floor(Number(failureCount) || 0)) + 1;
  return { failure_count: n, pause: n >= LIMITS.failuresBeforePause };
}

/**
 * A request id that is the same for every attempt at one slot: a tick that died
 * before rescheduling retries the same next_run_at and gets its run back. Exact
 * to the millisecond, so a "Run now" is a slot of its own.
 */
export function slotRequestId(automationId: string, slot: Date): string {
  return `auto-${automationId}-${slot.getTime().toString(36)}`;
}
