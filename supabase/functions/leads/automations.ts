/**
 * Echo Leads — automations
 * ----------------------------------------------------------------------------
 * Scheduled work over the lead database: refresh a saved search, enrich a saved
 * view, tag a saved view. The screens' actions (list, save, pause, delete,
 * estimate, history) and the cron tick that runs what is due.
 *
 * Same tenancy rule as workspace.ts: the client is the service role, so every
 * query is filtered by the caller's user id, and the tick takes the user id from
 * the automation row it claimed, never from a request.
 *
 * Paid work goes through workspace.runFromRows like every other bulk action:
 * the same estimate, wallet check and chunked billing. What automations add is
 * the budget. Before a run is created its estimated maximum is checked against
 * the automation's cap per run and what is left of its cap for the month
 * (automation-rules.budgetDecision); createRun refuses a maximum above the
 * ceiling it is given; and the insert trigger from 20261120 checks both caps a
 * third time under a lock on the automation.
 */

import * as ws from './workspace.ts';
import {
  budgetDecision,
  cleanAutomation,
  cleanConfig,
  dedupePeople,
  afterFailure,
  isPaid,
  modeFor,
  monthStartUtc,
  nextRunAt,
  normDomain,
  normName,
  rowsPerRun,
  savedSearchKindFor,
  slotRequestId,
  AUTOMATION_KINDS,
  type AutoEnrichAction,
  type AutoEnrichConfig,
  type AutoTagConfig,
  type AutomationKind,
  type Schedule,
  type SearchRefreshConfig,
} from './automation-rules.ts';

type Db = any;

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const AUTOMATION_COLUMNS =
  'id, name, kind, config, status, pause_reason, frequency, hour, weekday, max_credits_per_run, ' +
  'max_credits_per_month, next_run_at, last_run_at, last_status, failure_count, created_at, updated_at';

const scheduleOf = (a: any): Schedule => ({ frequency: a.frequency, hour: Number(a.hour), weekday: a.weekday ?? null });

async function monthCommitted(db: Db, automationId: string, now = new Date()): Promise<number> {
  const { data, error } = await db.rpc('lead_automation_month_committed', {
    p_automation: automationId,
    p_since: monthStartUtc(now).toISOString(),
  });
  if (error) throw error;
  return num(data);
}

// ===========================================================================
// Screens
// ===========================================================================

export async function listAutomations(db: Db, userId: string) {
  const { data, error } = await db
    .from('lead_automations')
    .select(AUTOMATION_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const ids = [...new Set((data ?? []).map((a: any) => a.config?.saved_search_id).filter(isUuid))];
  const names = new Map<string, { name: string; kind: string }>();
  if (ids.length) {
    const { data: ss } = await db.from('lead_saved_searches').select('id, name, kind').eq('user_id', userId).in('id', ids);
    for (const s of ss ?? []) names.set(s.id, { name: s.name, kind: s.kind });
  }

  const out = [];
  for (const a of data ?? []) {
    out.push({
      ...a,
      saved_search: names.get(a.config?.saved_search_id) ?? null,
      month_committed: isPaid(a.kind, a.config) ? await monthCommitted(db, a.id) : 0,
    });
  }
  return { ok: true, automations: out };
}

/** Create, or edit when `id` is given. Editing reschedules from now. */
export async function saveAutomation(db: Db, userId: string, body: any) {
  const c = cleanAutomation(body);
  if (!c.ok) return { ok: false, error: c.error };
  const a = c.value;

  const { data: ss } = await db
    .from('lead_saved_searches')
    .select('id, kind')
    .eq('user_id', userId)
    .eq('id', a.config.saved_search_id)
    .maybeSingle();
  if (!ss || ss.kind !== savedSearchKindFor(a.kind)) return { ok: false, error: 'saved_search_not_found' };

  const listId = a.kind === 'saved_search_refresh' ? (a.config as SearchRefreshConfig).list_id : null;
  if (listId) {
    const { data: list } = await db.from('lead_lists').select('id').eq('user_id', userId).eq('id', listId).eq('kind', 'people').maybeSingle();
    if (!list) return { ok: false, error: 'list_not_found' };
  }

  const row = {
    user_id: userId,
    name: a.name,
    kind: a.kind,
    config: a.config,
    frequency: a.schedule.frequency,
    hour: a.schedule.hour,
    weekday: a.schedule.weekday,
    max_credits_per_run: a.max_credits_per_run,
    max_credits_per_month: a.max_credits_per_month,
    next_run_at: nextRunAt(a.schedule, new Date()).toISOString(),
  };

  const res = isUuid(body?.id)
    ? await db.from('lead_automations').update(row).eq('user_id', userId).eq('id', body.id).select(AUTOMATION_COLUMNS).maybeSingle()
    : await db.from('lead_automations').insert({ ...row, status: 'active' }).select(AUTOMATION_COLUMNS).single();
  if (res.error) {
    if (res.error.code === '23505') return { ok: false, error: 'name_taken' };
    throw res.error;
  }
  if (!res.data) return { ok: false, error: 'not_found' };
  return { ok: true, automation: res.data };
}

export async function setAutomationStatus(db: Db, userId: string, body: any, status: 'active' | 'paused') {
  if (!isUuid(body?.id)) return { ok: false, error: 'bad_id' };
  const { data: a } = await db.from('lead_automations').select('id, frequency, hour, weekday').eq('user_id', userId).eq('id', body.id).maybeSingle();
  if (!a) return { ok: false, error: 'not_found' };
  const set =
    status === 'paused'
      ? { status, pause_reason: 'user_paused' }
      : { status, pause_reason: null, failure_count: 0, next_run_at: nextRunAt(scheduleOf(a), new Date()).toISOString() };
  const { error } = await db.from('lead_automations').update(set).eq('user_id', userId).eq('id', a.id);
  if (error) throw error;
  return { ok: true, status };
}

export async function deleteAutomation(db: Db, userId: string, body: any) {
  if (!isUuid(body?.id)) return { ok: false, error: 'bad_id' };
  // Runs it started are kept: they are the user's leads and charges.
  const { data, error } = await db.from('lead_automations').delete().eq('user_id', userId).eq('id', body.id).select('id');
  if (error) throw error;
  return (data ?? []).length ? { ok: true } : { ok: false, error: 'not_found' };
}

/** Makes an active automation due now. The tick runs it under the same caps. */
export async function runAutomationNow(db: Db, userId: string, body: any) {
  if (!isUuid(body?.id)) return { ok: false, error: 'bad_id' };
  const { data, error } = await db
    .from('lead_automations')
    .update({ next_run_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', body.id)
    .eq('status', 'active')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return data ? { ok: true } : { ok: false, error: 'not_active' };
}

export async function automationHistory(db: Db, userId: string, body: any) {
  let q = db
    .from('lead_automation_runs')
    .select('id, automation_id, status, started_at, finished_at, people_found, people_added, people_skipped, ' +
      'contacts_matched, contacts_tagged, credits_estimated_max, credits_charged, run_id, error, detail')
    .eq('user_id', userId)
    .order('started_at', { ascending: false })
    .limit(Math.max(1, Math.min(200, num(body?.limit, 50))));
  if (isUuid(body?.automation_id)) q = q.eq('automation_id', body.automation_id);
  const { data, error } = await q;
  if (error) throw error;

  // What the linked run has charged by now: it keeps working after the
  // automation run that started it has finished.
  const runIds = [...new Set((data ?? []).map((r: any) => r.run_id).filter(isUuid))];
  const runs = new Map<string, any>();
  if (runIds.length) {
    const { data: rs } = await db.from('lead_runs').select('id, status, charged_credits, max_credits').eq('user_id', userId).in('id', runIds);
    for (const r of rs ?? []) runs.set(r.id, r);
  }
  return {
    ok: true,
    runs: (data ?? []).map((r: any) => {
      const run = r.run_id ? runs.get(r.run_id) : null;
      return {
        ...r,
        credits_charged: run ? num(run.charged_credits) : num(r.credits_charged),
        run_status: run?.status ?? null,
      };
    }),
  };
}

/**
 * The most one run of this automation can cost: the estimate at its row limit.
 * Also says whether that fits the caps, so the form can say so before saving.
 */
export async function automationEstimate(db: Db, userId: string, body: any) {
  const kind = body?.kind as AutomationKind;
  if (!AUTOMATION_KINDS.includes(kind)) return { ok: false, error: 'bad_kind' };
  const c = cleanConfig(kind, body?.config);
  if (!c.ok) return { ok: false, error: c.error };
  const mode = modeFor(kind, c.value);
  if (!mode) return { ok: true, paid: false, rows: 0, estimate: null };

  const rows = rowsPerRun(kind, c.value);
  const { data: est, error } = await db.rpc('estimate_lead_run', {
    p_target: rows, p_mode: mode, p_phone: mode === 'phone_only', p_hit_rate: null, p_user: userId,
  });
  if (error) throw error;
  if (!est?.ok) return { ok: false, error: est?.error ?? 'cannot_price_run' };

  const perRun = num(body?.max_credits_per_run);
  const perMonth = num(body?.max_credits_per_month);
  const max = num(est.max_credits);
  return {
    ok: true,
    paid: true,
    rows,
    estimate: est,
    fits_run_cap: perRun > 0 && max <= perRun,
    runs_per_month_cap: max > 0 && perMonth > 0 ? Math.floor(perMonth / max) : null,
  };
}

// ===========================================================================
// The tick
// ===========================================================================

const TICK_BUDGET_MS = 45_000;
const LEASE_SECONDS = 300;

type Outcome = {
  status: 'succeeded' | 'skipped' | 'refused' | 'failed';
  people_found?: number;
  people_added?: number;
  people_skipped?: number;
  contacts_matched?: number;
  contacts_tagged?: number;
  credits_estimated_max?: number | null;
  run_id?: string | null;
  error?: string | null;
  detail?: Record<string, unknown>;
  /** A permanent problem (the saved search is gone): pause rather than retry. */
  pause?: string;
};

/** Runs every due automation it can claim, one at a time, within the budget. */
export async function tick(db: Db, ctx: ws.WorkspaceCtx) {
  const deadline = Date.now() + TICK_BUDGET_MS;
  const { data: due, error } = await db.rpc('lead_automations_claim_due', { p_limit: 10, p_seconds: LEASE_SECONDS });
  if (error) {
    console.error('leads: lead_automations_claim_due failed - is migration 20261120 applied? ' + error.message);
    return { ok: false, error: 'lease_unavailable' };
  }

  let ran = 0;
  for (const a of due ?? []) {
    if (Date.now() > deadline) {
      // Not started: hand it back so the next tick takes it.
      await db.from('lead_automations').update({ lease_until: null }).eq('id', a.id);
      continue;
    }
    await runOne(db, ctx, a);
    ran++;
  }
  return { ok: true, claimed: (due ?? []).length, ran };
}

async function runOne(db: Db, ctx: ws.WorkspaceCtx, a: any) {
  const slot = a.next_run_at ? new Date(a.next_run_at) : new Date();
  const { data: log, error: logErr } = await db
    .from('lead_automation_runs')
    .insert({ automation_id: a.id, user_id: a.user_id, status: 'running' })
    .select('id')
    .single();
  if (logErr) throw logErr;

  let out: Outcome;
  try {
    out = await execute(db, ctx, a, slotRequestId(a.id, slot));
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    // The insert trigger's refusal reaches here as an error from createRun.
    const guard = message.match(/automation_guard: ([a-z_]+)/);
    out = guard
      ? { status: 'refused', error: guard[1], detail: { message: 'The database refused the run: ' + guard[1] } }
      : { status: 'failed', error: message.slice(0, 500) };
  }

  const now = new Date();
  await db.from('lead_automation_runs').update({
    status: out.status,
    finished_at: now.toISOString(),
    people_found: out.people_found ?? 0,
    people_added: out.people_added ?? 0,
    people_skipped: out.people_skipped ?? 0,
    contacts_matched: out.contacts_matched ?? 0,
    contacts_tagged: out.contacts_tagged ?? 0,
    credits_estimated_max: out.credits_estimated_max ?? null,
    run_id: out.run_id ?? null,
    error: out.error ?? null,
    detail: out.detail ?? {},
  }).eq('id', log.id);

  const failed = out.status === 'failed';
  const f = failed ? afterFailure(a.failure_count) : { failure_count: 0, pause: false };
  const pauseReason = out.pause ?? (f.pause ? 'repeated_failures' : null);
  // From the later of now and the slot, so a late tick does not run it twice.
  const from = now > slot ? now : slot;
  await db.from('lead_automations').update({
    last_run_at: now.toISOString(),
    last_status: out.status,
    failure_count: f.failure_count,
    next_run_at: nextRunAt(scheduleOf(a), from).toISOString(),
    lease_until: null,
    ...(pauseReason ? { status: 'paused', pause_reason: pauseReason } : {}),
  }).eq('id', a.id).eq('user_id', a.user_id);
}

async function execute(db: Db, ctx: ws.WorkspaceCtx, a: any, requestId: string): Promise<Outcome> {
  const kind = a.kind as AutomationKind;
  const c = cleanConfig(kind, a.config);
  if (!c.ok) return { status: 'failed', error: c.error, pause: 'bad_config' };

  const { data: ss } = await db
    .from('lead_saved_searches')
    .select('id, kind, filters')
    .eq('user_id', a.user_id)
    .eq('id', c.value.saved_search_id)
    .maybeSingle();
  if (!ss || ss.kind !== savedSearchKindFor(kind)) {
    return { status: 'failed', error: 'saved_search_not_found', pause: 'saved_search_not_found' };
  }

  if (kind === 'saved_search_refresh') return refreshSearch(db, ctx, a, c.value as SearchRefreshConfig, ss, requestId);
  if (kind === 'auto_enrich') return autoEnrich(db, ctx, a, c.value as AutoEnrichConfig, ss, requestId);
  return autoTag(db, a, c.value as AutoTagConfig, ss);
}

async function suppressed(db: Db, userId: string): Promise<Set<string>> {
  const { data } = await db.from('lead_suppressions').select('value').eq('user_id', userId).limit(5000);
  return new Set((data ?? []).map((s: any) => String(s.value).toLowerCase()));
}

// ---------------------------------------------------------------------------
// saved_search_refresh
// ---------------------------------------------------------------------------

async function refreshSearch(db: Db, ctx: ws.WorkspaceCtx, a: any, cfg: SearchRefreshConfig, ss: any, requestId: string): Promise<Outcome> {
  const userId = a.user_id;
  const blocked = await suppressed(db, userId);

  // Pages until enough new people are found or the provider runs out. A page is
  // free; the cap on pages bounds the provider traffic.
  const found: any[] = [];
  let fresh: any[] = [];
  const kept = new Set<string>();
  const skipped = { existing: 0, suppressed: 0, incomplete: 0 };
  let cursor: string | null = null;
  const maxPages = Math.ceil(cfg.max_people / 50) + 2;
  for (let page = 0; page < maxPages && fresh.length < cfg.max_people; page++) {
    const r: any = await ws.searchPeople(db, ctx, userId, { filters: ss.filters, limit: 50, cursor }, { log: false });
    if (!r.ok) {
      if (page === 0) return { status: 'failed', error: r.error ?? 'search_failed' };
      break;
    }
    const people: any[] = r.people ?? [];
    found.push(...people);

    const known = await knownContacts(db, userId, people);
    // People kept from earlier pages count as held, so a repeat across pages is skipped too.
    for (const k of kept) known.nameDomains.add(k);
    const d = dedupePeople(people, { ...known, suppressed: blocked });
    for (const p of d.fresh) kept.add(`${normName(p.person_name)}@${normDomain(p.domain)}`);
    fresh.push(...d.fresh);
    skipped.existing += d.skipped.existing;
    skipped.suppressed += d.skipped.suppressed;
    skipped.incomplete += d.skipped.incomplete;

    cursor = r.cursor ?? null;
    if (!cursor || !people.length) break;
  }
  fresh = fresh.slice(0, cfg.max_people);

  await db.from('lead_saved_searches').update({ last_run_at: new Date().toISOString() }).eq('user_id', userId).eq('id', ss.id);

  const base: Outcome = {
    status: 'skipped',
    people_found: found.length,
    people_skipped: skipped.existing + skipped.suppressed + skipped.incomplete,
    detail: { skipped },
  };
  if (!fresh.length) return base;

  const saved: any = await ws.saveSearchResults(db, userId, { people: fresh, list_id: cfg.list_id });
  if (!saved.ok) {
    return { ...base, status: 'failed', error: saved.error, pause: saved.error === 'list_not_found' ? 'list_not_found' : undefined };
  }
  const added = { ...base, status: 'succeeded' as const, people_added: saved.saved, people_skipped: (base.people_skipped ?? 0) + saved.skipped };
  if (cfg.enrich !== 'find_email' || !saved.contact_ids.length) return added;

  const paid = await paidStep(db, ctx, a, 'find_email', saved.contact_ids, saved.contact_ids.length, requestId);
  // The people are saved either way; a refused enrichment is reported, not a failure of the refresh.
  return {
    ...added,
    status: paid.status === 'failed' ? 'failed' : paid.status === 'refused' ? 'refused' : 'succeeded',
    credits_estimated_max: paid.credits_estimated_max ?? null,
    run_id: paid.run_id ?? null,
    error: paid.error ?? null,
    detail: { ...added.detail, ...(paid.detail ?? {}) },
  };
}

/** Provider ids and name-at-domain keys already in the database, for one page of results. */
async function knownContacts(db: Db, userId: string, people: any[]) {
  const leadsforgeIds = new Set<string>();
  const nameDomains = new Set<string>();
  for (const p of people) if (p.contact_id && p.leadsforge_id) leadsforgeIds.add(String(p.leadsforge_id));
  const domains = [...new Set(people.map((p) => normDomain(p.domain)).filter(Boolean))] as string[];
  for (let i = 0; i < domains.length; i += 200) {
    const { data, error } = await db
      .from('lead_contacts')
      .select('name_norm, domain')
      .eq('user_id', userId)
      .in('domain', domains.slice(i, i + 200))
      .not('name_norm', 'is', null)
      .limit(5000);
    if (error) throw error;
    for (const c of data ?? []) nameDomains.add(`${c.name_norm}@${c.domain}`);
  }
  return { leadsforgeIds, nameDomains };
}

// ---------------------------------------------------------------------------
// auto_enrich
// ---------------------------------------------------------------------------

async function autoEnrich(db: Db, ctx: ws.WorkspaceCtx, a: any, cfg: AutoEnrichConfig, ss: any, requestId: string): Promise<Outcome> {
  const userId = a.user_id;
  const matched = await ws.matchingContacts<any>(db, userId, ss.filters, 'id, email, domain, last_enriched_at', 2000);
  const blocked = await suppressed(db, userId);
  const cutoff = Date.now() - cfg.skip_recent_days * 86400_000;
  let recent = 0;
  let optedOut = 0;
  const ids: string[] = [];
  for (const c of matched) {
    if (c.last_enriched_at && Date.parse(c.last_enriched_at) > cutoff) { recent++; continue; }
    const email = String(c.email ?? '').toLowerCase();
    if ((c.domain && blocked.has(String(c.domain).toLowerCase())) || (email && blocked.has(email))) { optedOut++; continue; }
    ids.push(c.id);
  }

  const base: Outcome = {
    status: 'skipped',
    contacts_matched: matched.length,
    detail: { skipped: { recent, suppressed: optedOut } },
  };
  if (!ids.length) return base;

  const paid = await paidStep(db, ctx, a, cfg.enrich, ids, cfg.max_rows, requestId, { waitForInFlight: true });
  return { ...base, ...paid, detail: { ...base.detail, ...(paid.detail ?? {}) } };
}

// ---------------------------------------------------------------------------
// The paid step, shared: plan, price, check the budget, start
// ---------------------------------------------------------------------------

async function paidStep(
  db: Db,
  ctx: ws.WorkspaceCtx,
  a: any,
  action: AutoEnrichAction,
  contactIds: string[],
  maxRows: number,
  requestId: string,
  opts?: { waitForInFlight?: boolean },
): Promise<Outcome> {
  const userId = a.user_id;

  // This slot already started its run (a tick that died before moving on).
  const prior = await ws.priorRequest(db, userId, requestId);
  if (prior) {
    return { status: 'succeeded', run_id: prior.id, credits_estimated_max: num(prior.max_credits), detail: { replayed: true } };
  }

  // A view's contacts stay in the view until their run has worked them, so a
  // second run started meanwhile would pay for the same people twice.
  if (opts?.waitForInFlight) {
    const { data: busy, error } = await db
      .from('lead_runs')
      .select('id')
      .eq('user_id', userId)
      .eq('options->>automation_id', a.id)
      .in('status', ['queued', 'running', 'paused'])
      .limit(1);
    if (error) throw error;
    if (busy?.length) return { status: 'skipped', run_id: null, detail: { waiting_on_run: busy[0].id } };
  }

  const plan: any = await ws.enrichPlan(db, userId, { enrich: action, contact_ids: contactIds });
  if (plan.error) return { status: 'skipped', detail: { plan: plan.error } };
  const rows = plan.rows.slice(0, maxRows);
  const planSkipped = { ...plan.skipped, over_row_limit: Math.max(0, plan.rows.length - rows.length) };
  if (!rows.length) return { status: 'skipped', detail: { plan_skipped: planSkipped } };

  const { data: est, error: estErr } = await db.rpc('estimate_lead_run', {
    p_target: rows.length, p_mode: plan.mode, p_phone: plan.mode === 'phone_only', p_hit_rate: null, p_user: userId,
  });
  if (estErr) throw estErr;
  const estimateMax = est?.ok ? num(est.max_credits, NaN) : NaN;

  const committed = await monthCommitted(db, a.id);
  const decision = budgetDecision({
    estimateMax,
    perRunCap: num(a.max_credits_per_run),
    perMonthCap: num(a.max_credits_per_month),
    committedThisMonth: committed,
  });
  const detail = { rows: rows.length, plan_skipped: planSkipped, month_committed: committed, remaining_month: decision.remaining_month };
  if (!decision.ok) {
    return {
      status: 'refused',
      error: decision.reason,
      credits_estimated_max: Number.isFinite(estimateMax) ? estimateMax : null,
      detail: { ...detail, message: decision.message },
    };
  }

  const started: any = await ws.runFromRows(db, ctx, userId, action, plan.mode, rows, requestId, plan.skipped, {
    extraOptions: { automation_id: a.id, automation_name: a.name },
    ceilingCredits: Math.min(num(a.max_credits_per_run), decision.remaining_month),
  });
  if (!started?.ok) {
    const refused = ['insufficient_credits', 'over_cap'].includes(started?.error);
    return {
      status: refused ? 'refused' : 'failed',
      error: started?.error ?? 'run_not_started',
      credits_estimated_max: estimateMax,
      detail: { ...detail, message: started?.message ?? null },
    };
  }
  return { status: 'succeeded', run_id: started.run.id, credits_estimated_max: num(started.run.max_credits, estimateMax), detail };
}

// ---------------------------------------------------------------------------
// auto_tag (free)
// ---------------------------------------------------------------------------

async function autoTag(db: Db, a: any, cfg: AutoTagConfig, ss: any): Promise<Outcome> {
  const matched = await ws.matchingContacts<any>(db, a.user_id, ss.filters, 'id, tags', 5000);
  const need = matched
    .filter((c) => {
      const tags: string[] = c.tags ?? [];
      return cfg.add_tags.some((t) => !tags.includes(t)) || cfg.remove_tags.some((t) => tags.includes(t));
    })
    .map((c) => c.id);
  for (let i = 0; i < need.length; i += 1000) {
    await ws.updateContacts(db, a.user_id, { ids: need.slice(i, i + 1000), patch: { add_tags: cfg.add_tags, remove_tags: cfg.remove_tags } });
  }
  return {
    status: need.length ? 'succeeded' : 'skipped',
    contacts_matched: matched.length,
    contacts_tagged: need.length,
  };
}
