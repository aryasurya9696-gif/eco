// ============================================================================
// Supabase Edge Function: leads
// --------------------------------------------
// Echo's second service. Finds companies that would buy, the decision maker at
// each, and a verified work email for them through a waterfall of providers,
// cheapest first.
//
// Deployed with verify_jwt OFF, because pg_cron cannot present a JWT and the
// gateway would refuse the worker before this code runs. That makes this
// function's own authentication the only authentication, so the two doors are
// separated deliberately:
//
//   user actions   requireUserId() validates the caller's JWT against the auth
//                  server on every call. Not a decode — a decode would accept a
//                  token nobody signed.
//   work           gated on a shared secret, because cron has no user. Fail-closed
//                  when the secret is unset.
//
// Getting that flag wrong is invisible from cron.job_run_details, which records
// that the SQL ran rather than that the call succeeded. scripts/deploy-functions.cjs
// holds the intended value per function so it is not a judgement call each deploy.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { tregCallWithRetry, tregConfig, resolveToken, type TregConfig } from './treg.ts';
import { orderFor, REGISTRY, DEFAULT_ORDER, type LeadStep, type EndpointEntry } from './registry.ts';
import {
  reserveChunk,
  settleChunk,
  releaseChunk,
  loadLeadPrices,
  type LeadPrices,
} from './billing.ts';
import { planSteps, shouldFindEmail, worstCasePerRow, shouldDiscover } from './steps.ts';
import { creditsForRow, round6 } from './pricing-row.ts';
import { foldAttempts } from './attribution.ts';
import {
  emailFindRequest,
  readEmailHit,
  verifyRequest,
  readVerifyVerdict,
  phoneRequest,
  readPhoneHit,
  companyEnrichRequest,
  readCompanyEnrich,
  personAtCompanyRequest,
  readPeopleAtCompany,
  type CallShape,
  type EmailHit,
  type PersonHit,
  type RowInput,
  type Verdict,
  statusFor,
} from './endpoints.ts';
import { scoreTitle, describeChoice } from './choose-person.ts';
import {
  discoverCompanies,
  isSearchable,
  hasJunkRange,
  seedFailureMessage,
  type SearchableSegment,
  type DiscoveryAttempt,
} from './discover.ts';
import { billingOutcome, errorCodeFor } from './api-usage.ts';
import * as ws from './workspace.ts';
import * as auto from './automations.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';

let WORKER_SECRET: string | undefined = Deno.env.get('LEADS_WORKER_SECRET');

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function fail(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

/**
 * Validates the caller's JWT server-side.
 *
 * Identity is never taken from the body, and the token is checked against the auth
 * server rather than decoded: with verify_jwt off, this is the only thing standing
 * between the public internet and every workspace's leads.
 */
async function requireUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_URL || !anonKey) return null;

  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: anonKey },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
// Per process, in memory. Not a shared limit: with more than one instance this
// multiplies rather than divides. That is an acceptable trade for a per-user cap
// on a route the wallet already bounds, but it is a cap, not a guarantee, and the
// wallet is the real limit.

const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;

  bucket.count++;
  return true;
}

/** Keeps the map from growing without bound in a long-lived isolate. */
function pruneBuckets(): void {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const asString = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

const asBool = (v: unknown): boolean => v === true || v === 'true' || v === 1;

/** Ids are echoed back into a header and into SQL, so they are checked, not trusted. */
const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

/** Steps whose provider order a user can see and change. */
const ORDERABLE_STEPS: LeadStep[] = ['company', 'person', 'email', 'verify', 'phone', 'enrich'];

/** Actions that can start paid work. */
const PAID_ACTIONS = new Set(['start', 'resume', 'bulk', 'enrich_start', 'import', 'automation_run_now']);
/** Actions that call a provider for free. */
const SEARCH_ACTIONS = new Set(['search_people', 'search_count', 'filter_values']);

/** What workspace.ts needs from this module, without importing it. */
function wsCtx(db: any): ws.WorkspaceCtx {
  return {
    tregCfg: async () => tregConfig({ user: 'search' }, await resolveToken(db)),
    createRun: (userId, o) => createRun(db, userId, o),
    kickWorker,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  // The worker resolves its secret before the gate, so a deployment with only the
  // secrets table configured still authenticates its own cron caller.
  if (!WORKER_SECRET) {
    const db = admin();
    const { data } = await db.from('service_secrets').select('name, value').eq('name', 'leads_worker_secret').maybeSingle();
    if (data?.value) WORKER_SECRET = String(data.value);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail('Invalid JSON body');
  }

  const action = String(body?.action ?? '');

  // ---- worker: the only unauthenticated door ------------------------------
  if (action === 'work') {
    const provided = req.headers.get('x-leads-worker-secret') ?? '';
    if (!WORKER_SECRET) {
      console.error('LEADS_WORKER_SECRET is not configured — refusing to work.');
      return fail('worker not configured', 503);
    }
    if (provided !== WORKER_SECRET) return fail('unauthorized', 401);

    pruneBuckets();
    return json(await workRun(admin(), body));
  }

  // ---- automations tick: same door, same secret ---------------------------
  if (action === 'automations_tick') {
    const provided = req.headers.get('x-leads-worker-secret') ?? '';
    if (!WORKER_SECRET) {
      console.error('LEADS_WORKER_SECRET is not configured — refusing to run automations.');
      return fail('worker not configured', 503);
    }
    if (provided !== WORKER_SECRET) return fail('unauthorized', 401);
    const db = admin();
    try {
      return json(await auto.tick(db, wsCtx(db)));
    } catch (err) {
      console.error('[leads] automations tick failed:', (err as Error)?.message);
      return fail('automations tick failed', 500);
    }
  }

  // ---- everything else needs a user --------------------------------------
  const userId = await requireUserId(req);
  if (!userId) return fail('Unauthorized', 401);

  // Three tiers. Anything that can start paid work: 60 an hour, so a leaked
  // session cannot run the wallet dry. Provider searches (free, but upstream
  // traffic): 300. Database reads and edits: 2000 - the old flat 60 was used up
  // by a few minutes of filtering a table.
  const tier = PAID_ACTIONS.has(action) ? 'paid' : SEARCH_ACTIONS.has(action) ? 'search' : 'read';
  const limit = tier === 'paid' ? 60 : tier === 'search' ? 300 : 2000;
  if (!rateLimit(`leads:${tier}:` + userId, limit, 60 * 60 * 1000)) {
    return fail('Too many requests. Please try again later.', 429);
  }

  const db = admin();

  try {
    switch (action) {
      case 'active_count': {
        const { data, error } = await db.rpc('lead_active_run_count');
        if (error) throw error;
        return json({ ok: true, count: num(data) });
      }

      case 'list_runs':
        return json(await listRuns(db, userId, num(body?.limit, 50)));

      case 'get_run':
        return json(await getRun(db, userId, body));

      case 'estimate': {
        if (!isUuid(body?.icp_id) && body?.icp_id != null) return fail('Bad icp_id');
        const { data, error } = await db.rpc('estimate_lead_run', {
          p_target: Math.max(1, Math.min(2000, num(body?.target, 50))),
          p_mode: asString(body?.mode, 40) || null,
          p_phone: asBool(body?.phone),
          p_hit_rate: body?.hit_rate == null ? null : num(body?.hit_rate, 0.7),
          p_user: userId,
        });
        if (error) throw error;
        // Nested: the database owns the number and the client reads it whole.
        return json({ ok: true, estimate: data });
      }

      case 'icp_get': {
        // The approved one, falling back to the most recent draft. Returning to
        // the screen and being shown a blank form for an ICP that already exists
        // reads as losing work.
        const { data, error } = await db
          .from('lead_icps')
          .select('*')
          .eq('user_id', userId)
          .order('approved_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        return json({ ok: true, icp: data ?? null });
      }

      case 'save_icp':
        return json(await saveIcp(db, userId, body));

      case 'start':
        return json(await startRun(db, userId, body));

      case 'pause':
      case 'resume':
      case 'cancel':
        return json(await controlRun(db, userId, action, body));

      case 'suppressions_list': {
        const { data, error } = await db
          .from('lead_suppressions')
          .select('id, value, kind, reason, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });
        if (error) throw error;
        return json({ ok: true, suppressions: data ?? [] });
      }

      case 'suppressions_add': {
        const value = asString(body?.value, 200).toLowerCase();
        if (!value) return fail('Nothing to suppress');
        // An email and a domain are matched differently later, so the kind is
        // derived here rather than accepted from the client.
        const kind = value.includes('@') ? 'email' : 'domain';
        const { error } = await db
          .from('lead_suppressions')
          .upsert(
            { user_id: userId, value, kind, reason: asString(body?.reason, 200) || null },
            { onConflict: 'user_id,value', ignoreDuplicates: true },
          );
        if (error) throw error;
        return json({ ok: true, kind });
      }

      case 'suppressions_remove': {
        const value = asString(body?.value, 200).toLowerCase();
        if (!value) return fail('Nothing to remove');
        const { error } = await db
          .from('lead_suppressions')
          .delete()
          .eq('user_id', userId)
          .eq('value', value);
        if (error) throw error;
        return json({ ok: true });
      }

      case 'waterfall_get': {
        const step = asString(body?.step, 20) as LeadStep;
        // 'search' is a registry grouping, not a waterfall step with an order.
        if (!ORDERABLE_STEPS.includes(step)) return fail('Unknown step');
        const { data, error } = await db
          .from('lead_waterfall_orders')
          .select('step, endpoint_ids, mode')
          .eq('user_id', userId)
          .eq('step', step)
          .maybeSingle();
        if (error) throw error;

        // The shipped order comes from here rather than from a copy in the client.
        // The lab needs it to show a user what "reset to default" actually resets
        // to, and a client-side copy of a table with six steps and twenty-five
        // entries is a table that goes stale silently - the same reason the
        // endpoint ids themselves are not held by the browser.
        return json({
          ok: true,
          order: data?.endpoint_ids ?? null,
          mode: data?.mode ?? 'default',
          default_order: DEFAULT_ORDER[step] ?? [],
          // With a saved order, the effective chain is that order plus anything
          // in the shipped one the user has not seen. Sent whole, so the list a
          // user drags is the list that will actually run rather than their
          // saved prefix with new providers invisible below it.
          effective_order: orderFor(step, {}, (data?.endpoint_ids as string[]) ?? null).map(
            (e) => e.id,
          ),
        });
      }

      case 'waterfall_put': {
        const step = asString(body?.step, 20) as LeadStep;
        // 'search' is a registry grouping, not a waterfall step with an order.
        if (!ORDERABLE_STEPS.includes(step)) return fail('Unknown step');
        const ids = Array.isArray(body?.endpoint_ids)
          ? body.endpoint_ids.filter((x: unknown) => typeof x === 'string').map(String)
          : [];
        // Only endpoints this function knows about may be ordered. Otherwise a
        // client could put an arbitrary string in the order and the waterfall
        // would try to call it.
        const known = ids.filter((id: string) => Boolean(REGISTRY[id]));
        if (known.length !== ids.length) return fail('Unknown endpoint in order');

        const { error } = await db.from('lead_waterfall_orders').upsert(
          { user_id: userId, step, endpoint_ids: known, mode: 'custom' },
          { onConflict: 'user_id,step' },
        );
        if (error) throw error;
        return json({ ok: true, order: known });
      }

      case 'provider_stats':
        return json(await providerStats(db, userId, body));

      case 'lab_results':
        return json(await labResults(db, userId, body));

      case 'import':
        return json(await importRows(db, userId, body));

      case 'bulk':
        return json(await bulkAction(db, userId, body));

      // ---- search (free provider calls) ------------------------------------
      case 'search_people':
        return json(await ws.searchPeople(db, wsCtx(db), userId, body));
      case 'search_count':
        return json(await ws.countPeople(db, wsCtx(db), userId, body));
      case 'filter_values':
        return json(await ws.filterValues(db, wsCtx(db), body));
      case 'search_save':
        return json(await ws.saveSearchResults(db, userId, body));
      case 'search_history':
        return json(await ws.searchHistory(db, userId));

      // ---- the lead database ----------------------------------------------
      case 'contacts_query':
        return json(await ws.queryContacts(db, userId, body));
      case 'contact_get':
        return json(await ws.getContact(db, userId, body));
      case 'contacts_update':
        return json(await ws.updateContacts(db, userId, body));
      case 'contacts_delete':
        return json(await ws.deleteContacts(db, userId, body));
      case 'contacts_import':
        return json(await ws.importContacts(db, userId, body));
      case 'duplicates':
        return json(await ws.findDuplicates(db, userId));
      case 'contacts_merge':
        return json(await ws.mergeContacts(db, userId, body));
      case 'companies_query':
        return json(await ws.queryCompanies(db, userId, body));
      case 'company_get':
        return json(await ws.getCompany(db, userId, body));
      case 'companies_update':
        return json(await ws.updateCompanies(db, userId, body));

      case 'lists':
        return json(await ws.listLists(db, userId));
      case 'list_create':
        return json(await ws.createList(db, userId, body));
      case 'list_update':
        return json(await ws.updateList(db, userId, body));
      case 'list_delete':
        return json(await ws.deleteList(db, userId, body));
      case 'list_add':
        return json(await ws.listMembers(db, userId, body, false));
      case 'list_remove':
        return json(await ws.listMembers(db, userId, body, true));

      case 'saved_searches':
        return json(await ws.listSavedSearches(db, userId, body));
      case 'saved_search_save':
        return json(await ws.saveSearch(db, userId, body));
      case 'saved_search_delete':
        return json(await ws.deleteSavedSearch(db, userId, body));

      case 'scoring_get':
        return json(await ws.getScoring(db, userId));
      case 'scoring_put':
        return json(await ws.putScoring(db, userId, body));

      case 'enrich_estimate':
        return json(await ws.enrichEstimate(db, userId, body));
      case 'enrich_start':
        return json(await ws.enrichStart(db, wsCtx(db), userId, body));

      case 'usage':
        return json(await ws.usageSummary(db, userId, body));

      // ---- automations ----------------------------------------------------
      case 'automations':
        return json(await auto.listAutomations(db, userId));
      case 'automation_save':
        return json(await auto.saveAutomation(db, userId, body));
      case 'automation_pause':
        return json(await auto.setAutomationStatus(db, userId, body, 'paused'));
      case 'automation_resume':
        return json(await auto.setAutomationStatus(db, userId, body, 'active'));
      case 'automation_delete':
        return json(await auto.deleteAutomation(db, userId, body));
      case 'automation_estimate':
        return json(await auto.automationEstimate(db, userId, body));
      case 'automation_history':
        return json(await auto.automationHistory(db, userId, body));
      case 'automation_run_now': {
        const r = await auto.runAutomationNow(db, userId, body);
        if (r.ok) kickAutomations();
        return json(r);
      }

      default:
        return fail('Unknown action', 400);
    }
  } catch (err) {
    console.error('[leads] action failed:', action, (err as Error)?.message);
    return fail('Leads request failed', 500);
  }
});

// ===========================================================================
// Reads
// ===========================================================================

async function listRuns(db: any, userId: string, limit: number) {
  const { data, error } = await db
    .from('lead_runs')
    .select(
      'id, name, kind, status, pause_reason, target, mode, est_credits, max_credits, charged_credits, treg_cost_usd, counters, created_at, finished_at',
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));

  if (error) throw error;
  return { ok: true, runs: data ?? [] };
}

async function getRun(db: any, userId: string, body: any) {
  const runId = body?.run_id;
  if (!isUuid(runId)) return { ok: false, error: 'bad_run_id' };

  const { data: run, error } = await db
    .from('lead_runs')
    .select('*')
    .eq('user_id', userId)
    .eq('id', runId)
    .maybeSingle();

  if (error) throw error;
  if (!run) return { ok: false, error: 'run_not_found' };

  const limit = Math.max(1, Math.min(1000, num(body?.limit, 200)));
  const offset = Math.max(0, num(body?.offset, 0));

  const { data: rows, error: rowsErr } = await db
    .from('lead_rows')
    .select(
      'id, company_name, domain, logo_url, person_name, title, linkedin_url, email, email_status, email_provider, email_checked_at, email_verifier, phone, phone_provider, credits, state, step, current_provider, company_data, extra, updated_at',
    )
    .eq('user_id', userId)
    .eq('run_id', runId)
    // Rows seeded by one insert share a created_at; without the id the pages
    // could repeat or skip rows.
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (rowsErr) throw rowsErr;

  const { count } = await db
    .from('lead_rows')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('run_id', runId);

  return { ok: true, run, rows: rows ?? [], total: num(count) };
}

/**
 * Provider lab results, computed from logged attempts.
 *
 * Nothing here calls a provider. It is arithmetic over what already happened,
 * which is the point: running every provider on every row costs far more than a
 * waterfall, so the comparison the lab exists to make is reconstructed from the
 * attempts a waterfall run already logged rather than bought twice.
 */
/**
 * Every provider this workspace has ever used, with what it actually did.
 *
 * Across all runs, not one. The per-run numbers in lab_results answer "how did
 * this run go"; this answers "which of the five is worth keeping in the
 * waterfall", which can only be answered on the whole history — a provider that
 * was fourth in one run and never reached in another still has something to say
 * about its hit rate.
 *
 * Two numbers per provider that are easy to confuse and must not be.
 *
 *   found          attempts that returned an answer for the step. Includes answers
 *                  a provider repeated after another one already had it.
 *   first_to_find  attempts that were the first for that row on that step, so
 *                  nobody else had already answered. This is the number worth
 *                  ranking on: a provider that re-finds what Kitt already found is
 *                  not earning its place in the chain, and a lab that cannot see
 *                  that will recommend it.
 *
 * Both are per step, and both used to be measured against the row's final email
 * rather than against the step being looked at. See where creditedRows is built.
 *
 * Cost per first find is the ranking key. Price on its own is misleading — a
 * cheap provider that misses most of the time costs more per successful address
 * than a dearer one that does not — and the user already pays that lesson in the
 * waterfall without ever seeing it written down.
 */
async function providerStats(db: any, userId: string, body: any) {
  const step = (asString(body?.step, 20) || 'email') as LeadStep;

  const { data: attempts, error } = await db
    .from('lead_attempts')
    .select('endpoint_id, hit, cost_usd, row_id, run_id')
    .eq('user_id', userId)
    .eq('step', step)
    // Ascending, and stable. "Which provider supplied this" is decided by who
    // answered first, so the order the rows come back in is part of the
    // calculation rather than a display concern.
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw error;

  // Rows this provider was the first to answer for, on this step. Built as the
  // loop goes rather than by comparing against the row's final state.
  //
  // It used to compare the attempt against `lead_rows.email_provider`, which is
  // only meaningful for the email and verify steps: those are the only two that
  // write an address, so on the person, company, phone and enrich tabs
  // first_to_find was structurally zero. Every provider read as though it had
  // never found anything, no matter how well it performed, and the lab's whole
  // claim - rank providers by what one independent find cost - could not be
  // checked on four of the six steps.
  //
  // First hit wins is also the more honest definition of what the waterfall is.
  // Under the old one, a provider that found a real address which a later
  // provider then replaced under verify_refind scored nothing for it.

  const acc = new Map<string, {
    attempts: number;
    hits: number;
    costUsd: number;
    firstToFind: number;
    runs: Set<string>;
    rows: Set<string>;
  }>();

  const rows = (attempts ?? []) as Array<{
    endpoint_id: string; hit: boolean | null; cost_usd: number | null;
    row_id: string | null; run_id: string | null;
  }>;

  // Who earned each find. Folded separately because it is the one number with a
  // definition worth arguing about, and it has its own tests - inline here it
  // was unreachable by any of them.
  const finds = foldAttempts(
    rows.map((a) => ({ endpoint_id: a.endpoint_id, hit: Boolean(a.hit), row_id: a.row_id })),
  );

  for (const a of rows) {
    const cur = acc.get(a.endpoint_id) ?? {
      attempts: 0, hits: 0, costUsd: 0, firstToFind: 0, runs: new Set<string>(), rows: new Set<string>(),
    };
    cur.attempts++;
    cur.hits += a.hit ? 1 : 0;
    cur.costUsd += num(a.cost_usd);
    cur.runs.add(String(a.run_id));
    if (a.row_id) cur.rows.add(String(a.row_id));
    cur.firstToFind = finds.get(a.endpoint_id)?.firstToFind ?? 0;

    acc.set(a.endpoint_id, cur);
  }

  // Every endpoint registered for THIS step, whether or not it has ever been
  // called. A provider that has never run is information: it is in the waterfall
  // and costing nothing, and hiding it makes the list look shorter than the chain
  // that actually executes.
  //
  // Scoped to the step, which it used not to be. The union was the whole
  // registry, which was harmless while the lab only had one tab - every endpoint
  // the user could see belonged to the step they were looking at. With a tab per
  // step it is not: the enrich tab listed twenty-four providers of which one was
  // an enrich provider, and the "Your spend" figures above the list, summed over
  // all of them, reported the entire workspace's spend on a step that had spent
  // nothing.
  const ids = new Set<string>([
    ...Object.keys(REGISTRY).filter((id) => REGISTRY[id]?.step === step),
    // Endpoints that have history but are no longer in the registry, so their
    // cost is still attributed somewhere rather than vanishing from the totals.
    ...acc.keys(),
  ]);

  const providers = [...ids].map((id) => {
    const s = acc.get(id);
    const entry = REGISTRY[id];
    const attempts_ = s?.attempts ?? 0;
    const finds = s?.firstToFind ?? 0;
    const cost = s?.costUsd ?? 0;

    return {
      endpoint_id: id,
      label: entry?.label ?? id,
      step: entry?.step ?? step,
      price_usd: num(entry?.priceUsd),
      verified: entry?.verified ?? false,
      in_order: (DEFAULT_ORDER[step] ?? []).includes(id),
      attempts: attempts_,
      hits: s?.hits ?? 0,
      first_to_find: finds,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      runs: s?.runs.size ?? 0,
      rows: s?.rows.size ?? 0,
      // Null rather than 0 for a provider with no history. A zero hit rate for a
      // provider that has never been asked is a claim, and the lab would rank on
      // it.
      hit_rate: attempts_ > 0 ? Math.round(((s?.hits ?? 0) / attempts_) * 1000) / 1000 : null,
      // What one successful independent find actually cost. Null until there has
      // been at least one, because dividing by zero is infinity and rendering
      // "infinite" next to a price is worse than rendering nothing.
      cost_per_find: finds > 0 ? Math.round((cost / finds) * 1e6) / 1e6 : null,
      cost_per_attempt: attempts_ > 0 ? Math.round((cost / attempts_) * 1e6) / 1e6 : null,
    };
  });

  return {
    ok: true,
    step,
    providers,
    total_attempts: providers.reduce((n, p) => n + p.attempts, 0),
    total_cost_usd: Math.round(providers.reduce((n, p) => n + p.cost_usd, 0) * 1e6) / 1e6,
  };
}

async function labResults(db: any, userId: string, body: any) {
  if (!isUuid(body?.run_id)) return { ok: false, error: 'bad_run_id' };

  const { data: attempts, error } = await db
    .from('lead_attempts')
    .select('endpoint_id, hit, cost_usd')
    .eq('user_id', userId)
    .eq('run_id', body.run_id)
    .eq('step', 'email');

  if (error) throw error;

  const byProvider = new Map<string, { attempts: number; hits: number; cost: number; rows: Set<string> }>();
  for (const a of attempts ?? []) {
    const cur = byProvider.get(a.endpoint_id) ?? { attempts: 0, hits: 0, cost: 0, rows: new Set<string>() };
    cur.attempts++;
    cur.hits += a.hit ? 1 : 0;
    cur.cost += num(a.cost_usd);
    byProvider.set(a.endpoint_id, cur);
  }

  // Who each provider was the first to find. A provider that repeats an address
  // another already had is not an independent find, and counting it as one is
  // how a lab ends up recommending an expensive provider for nothing.
  const { data: rows } = await db
    .from('lead_rows')
    .select('id, email, email_provider')
    .eq('user_id', userId)
    .eq('run_id', body.run_id)
    .not('email', 'is', null);

  const foundBy = new Map<string, string>();
  for (const r of rows ?? []) {
    if (r.email && r.email_provider) foundBy.set(r.email, r.email_provider);
  }

  const providers = [...byProvider.entries()]
    .map(([endpointId, s]) => ({
      endpoint_id: endpointId,
      label: REGISTRY[endpointId]?.label ?? endpointId,
      attempts: s.attempts,
      hits: s.hits,
      hit_rate: s.attempts ? Math.round((s.hits / s.attempts) * 1000) / 1000 : 0,
      cost_usd: Math.round(s.cost * 1e6) / 1e6,
      cost_per_hit: s.hits ? Math.round((s.cost / s.hits) * 1e6) / 1e6 : null,
      unique_finds: [...foundBy.values()].filter((p) => p === endpointId).length,
    }))
    .sort((a, b) => (a.cost_per_hit ?? Infinity) - (b.cost_per_hit ?? Infinity));

  const best = providers.reduce<number>((n, p) => Math.max(n, p.unique_finds), 0);

  return {
    ok: true,
    providers,
    waterfall_finds: foundBy.size,
    // Both numbers are real and may be close. The lab's job is to show that the
    // waterfall's cost is the sum of what its providers found, not a premium on
    // top of the best single one.
    headline: `The best single provider found ${best}. The waterfall found ${foundBy.size}.`,
  };
}

// ===========================================================================
// The ICP
// ===========================================================================

async function saveIcp(db: any, userId: string, body: any) {
  const id = isUuid(body?.id) ? body.id : null;
  const json_ = body?.icp ?? {};

  const payload = {
    user_id: userId,
    website: asString(body?.website, 300) || null,
    offer: asString(body?.offer, 400) || null,
    inputs: (body?.inputs ?? {}) as Record<string, unknown>,
    pages: Array.isArray(body?.pages) ? body.pages : [],
    brand: (body?.brand ?? null) as Record<string, unknown> | null,
    json: json_,
    note: asString(body?.note, 200) || null,
    approved_at: body?.approved ? new Date().toISOString() : null,
  };

  if (id) {
    // Checked, and not thrown on.
    //
    // An update that matches no rows is not an error in Postgres, so the old
    // `const { error } = await ...update(...)` returned ok with nothing written
    // whenever the id belonged to someone else or had been deleted. The form
    // then started a run against an ICP that was never saved, and the profile
    // the user had just spent five minutes editing was gone with no message.
    //
    // Refused rather than thrown: this is a bad request, not a broken system,
    // and the caller turns it into a message on the form.
    const { data: updated, error } = await db
      .from('lead_icps')
      .update(payload)
      .eq('user_id', userId)
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!updated) return { ok: false, error: 'icp_not_found' };

    return { ok: true, id: updated.id };
  }

  // Version 1 of a new ICP. A previous approved ICP is kept rather than
  // overwritten, because "find more" on an old segment has to be able to refer
  // back to the segment that produced it.
  const { data, error } = await db
    .from('lead_icps')
    .insert({ ...payload, version: 1 })
    .select('id, version')
    .single();

  if (error) throw error;
  return { ok: true, id: data.id, version: data.version };
}

// ===========================================================================
// Run lifecycle
// ===========================================================================

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

async function startRun(db: any, userId: string, body: any) {
  const kind = ['find', 'clean', 'lab'].includes(body?.kind) ? body.kind : 'find';
  const target = Math.max(1, Math.min(2000, num(body?.target, 50)));

  // The titles this run is chasing, snapshotted onto the run so editing the
  // profile mid-run does not change what the remaining rows look for.
  //
  // Scoped to the caller. This read used the service role with no user filter,
  // so any ICP id - including another workspace's - was accepted, its titles
  // copied onto the run, and its segment searched with this user's credits.
  let targetTitles: string[] = [];
  let icpId: string | null = null;
  if (body?.icp_id != null) {
    if (!isUuid(body.icp_id)) return { ok: false, error: 'bad_icp_id' };
    const { data: icp } = await db
      .from('lead_icps')
      .select('id, json')
      .eq('user_id', userId)
      .eq('id', body.icp_id)
      .maybeSingle();
    if (!icp) return { ok: false, error: 'icp_not_found' };
    icpId = icp.id;
    const seg = primarySegmentOf(icp.json);
    targetTitles = (seg?.targetTitles ?? []).filter((t: unknown) => typeof t === 'string' && String(t).trim() !== '');
  }

  return createRun(db, userId, {
    kind,
    target,
    mode: asString(body?.mode, 40) || null,
    phone: asBool(body?.phone),
    icpId,
    name: asString(body?.name, 120) || null,
    rowCapUsd: body?.row_cap_usd,
    targetTitles,
    // A clean run's rows arrive after it is created, in batches. Held until the
    // last batch is in, or the worker finds an empty run and finishes it.
    hold: kind === 'clean' ? 'importing' : null,
  });
}

/**
 * Prices a run, checks the wallet can cover its worst case, creates it, and
 * starts the worker unless the run is being held for rows still to arrive.
 */
async function createRun(
  db: any,
  userId: string,
  o: {
    kind: string;
    target: number;
    mode: string | null;
    phone: boolean;
    icpId: string | null;
    name: string | null;
    rowCapUsd?: unknown;
    targetTitles?: string[];
    hold: string | null;
    extraOptions?: Record<string, unknown>;
    ceilingCredits?: number;
  },
) {
  // No run starts without a price on screen, recomputed here rather than
  // trusted from the client.
  const { data: est, error: estErr } = await db.rpc('estimate_lead_run', {
    p_target: o.target,
    p_mode: o.mode,
    p_phone: o.phone,
    p_hit_rate: null,
    p_user: userId,
  });
  if (estErr) throw estErr;
  if (!est || (est as any).ok !== true) {
    return { ok: false, error: (est as any)?.error ?? 'cannot_price_run' };
  }

  const maxCredits = num((est as any).max_credits);

  // An automation's budget: refused before anything is inserted. The insert
  // trigger from 20261120 checks the automation's caps again under a lock.
  if (o.ceilingCredits !== undefined && !(maxCredits <= o.ceilingCredits)) {
    return {
      ok: false,
      error: 'over_cap',
      max_credits: maxCredits,
      ceiling: round6(o.ceilingCredits),
      message: 'The most this run could cost is over the budget it was allowed.',
    };
  }

  // A run that cannot be paid for in full must not start, so this is checked
  // against the maximum, not the expected figure.
  const { data: wallet } = await db
    .from('wallet')
    .select('balance, reserved')
    .eq('user_id', userId)
    .maybeSingle();

  const available = Math.max(0, num(wallet?.balance) - num(wallet?.reserved));
  if (available < maxCredits) {
    return {
      ok: false,
      error: 'insufficient_credits',
      available: round6(available),
      shortfall: round6(maxCredits - available),
      max_credits: maxCredits,
      message: 'Not enough credits for the worst case. Top up to run this.',
    };
  }

  const phone = o.phone || o.mode === 'phone_only';
  // Clamped server-side; see rowCapOf.
  const cap = Math.min(0.5, Math.max(0.01, num(o.rowCapUsd, phone ? 0.25 : 0.05)));

  const { data: run, error } = await db
    .from('lead_runs')
    .insert({
      user_id: userId,
      icp_id: o.icpId,
      name: o.name,
      kind: o.kind,
      target: o.target,
      mode: o.mode,
      options: {
        phone,
        row_cap_usd: cap,
        target_titles: o.targetTitles ?? [],
        ...(o.extraOptions ?? {}),
      },
      status: o.hold ? 'paused' : 'queued',
      pause_reason: o.hold,
      est_credits: num((est as any).expected_credits),
      max_credits: maxCredits,
    })
    .select('*')
    .single();

  if (error) {
    // The same paid request arriving twice at once: the unique index on the
    // request id refused the second insert, so return the run the first made.
    const requestId = o.extraOptions?.request_id;
    if (error.code === '23505' && typeof requestId === 'string') {
      const { data: prior } = await db
        .from('lead_runs')
        .select('*')
        .eq('user_id', userId)
        .eq('options->>request_id', requestId)
        .maybeSingle();
      if (prior) return { ok: true, run: prior, replayed: true };
    }
    throw error;
  }

  if (!o.hold) kickWorker(run.id);

  return { ok: true, run, estimate: est };
}

/** Starts a chunk now rather than at the next cron tick. Not awaited. */
function kickWorker(runId: string): void {
  void fetch(SUPABASE_URL + '/functions/v1/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-leads-worker-secret': WORKER_SECRET ?? '',
    },
    body: JSON.stringify({ action: 'work', run_id: runId }),
  }).catch(() => {
    /* the cron tick picks it up */
  });
}

/** Runs the automations tick now rather than at the next cron tick. Not awaited. */
function kickAutomations(): void {
  void fetch(SUPABASE_URL + '/functions/v1/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-leads-worker-secret': WORKER_SECRET ?? '',
    },
    body: JSON.stringify({ action: 'automations_tick' }),
  }).catch(() => {
    /* the cron tick picks it up */
  });
}

async function controlRun(db: any, userId: string, action: string, body: any) {
  if (!isUuid(body?.run_id)) return { ok: false, error: 'bad_run_id' };

  const { data: run, error } = await db
    .from('lead_runs')
    .select('id, status')
    .eq('user_id', userId)
    .eq('id', body.run_id)
    .maybeSingle();

  if (error) throw error;
  if (!run) return { ok: false, error: 'run_not_found' };

  if (TERMINAL.has(run.status)) {
    return { ok: false, error: 'run_already_finished', status: run.status };
  }

  const next =
    action === 'pause' ? 'paused' : action === 'resume' ? 'queued' : 'cancelled';

  const { error: upErr } = await db
    .from('lead_runs')
    .update({
      status: next,
      pause_reason: next === 'paused' ? asString(body?.reason, 200) || 'user_paused' : null,
      finished_at: next === 'cancelled' ? new Date().toISOString() : null,
    })
    .eq('id', run.id);

  if (upErr) throw upErr;
  return { ok: true, status: next };
}

// ===========================================================================
// The worker
// ===========================================================================

const CHUNK_ROWS = 5;
const TIME_BUDGET_MS = 50_000;

/**
 * Processes runs in chunks, spending from a held balance.
 *
 * The chunk shape is deliberate. It reserves the worst case for the rows it is
 * about to touch, works five rows, then settles what those rows actually earned
 * and releases the rest. So the hold is short, bounded by the wall-clock budget
 * rather than by the run, and it is closed by the same code that opened it.
 */
/**
 * The segment a document's searches are run from.
 *
 * A document can hold several, but a run is started from one and the others are
 * kept for "find more" on an earlier one. Falls back to the first segment rather
 * than refusing, because a document written by an older version of the generator
 * has no primarySegment at all and the alternative is a run that cannot start
 * against a perfectly good profile.
 */
function primarySegmentOf(doc: any): SearchableSegment | null {
  const segments = Array.isArray(doc?.segments) ? doc.segments : [];
  if (segments.length === 0) return null;
  const i = Number(doc?.primarySegment ?? 0);
  const seg = segments[Number.isFinite(i) ? i : 0] ?? segments[0];
  return (seg ?? null) as SearchableSegment | null;
}

/**
 * Creates the rows a find run is going to work.
 *
 * This is the step that did not exist. A find run was inserted with no rows, the
 * comment in startRun said "the first chunk has to make them", and no chunk did:
 * claimRows returned nothing, finishRun marked the run done, and the user
 * pressed Find 50 leads and watched a completed run with zero leads and no error
 * message. Nothing below this point was ever reached by a find.
 *
 * Called before any rows are claimed, and again whenever the run still has fewer
 * rows than its target - so a provider that returns twenty companies for a
 * fifty-row target gets a second call rather than a run that stops at twenty.
 *
 * Deliberately charges no credits. The company credit is charged by processRow,
 * once per row, through the same creditsForRow call that prices every other line
 * on the row. Charging it here as well would bill it twice, and splitting it
 * across two places would mean the row's own credits column no longer adds up to
 * what the user was quoted on the New search screen. The provider spend here is
 * bounded by the ceiling in discoverCompanies.
 */
async function seedRunRows(
  db: any,
  callCfg: TregConfig,
  run: any,
): Promise<{ inserted: number; costUsd: number; error: string | null }> {
  if (run.kind !== 'find') return { inserted: 0, costUsd: 0, error: null };

  const target = Math.max(1, num(run.target, 50));

  const { count } = await db
    .from('lead_rows')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', run.id);

  const have = num(count);
  if (have >= target) return { inserted: 0, costUsd: 0, error: null };

  const want = target - have;

  if (!isUuid(run.icp_id)) {
    return { inserted: 0, costUsd: 0, error: seedFailureMessage('no_icp') };
  }

  const { data: icp } = await db.from('lead_icps').select('json').eq('id', run.icp_id).maybeSingle();
  const seg = primarySegmentOf(icp?.json);

  // Reported separately from "nothing to search for". The difference is whether
  // the user can fix it: a profile with no keywords needs input, a profile with
  // a company size that is not a number needs the form to stop writing NaN, and
  // telling someone to add a keyword when the real problem is a chip in their own
  // UI sends them away to fill in a field that was never the issue.
  if (hasJunkRange(seg)) {
    return { inserted: 0, costUsd: 0, error: seedFailureMessage('bad_range') };
  }

  if (!isSearchable(seg)) {
    // A profile with no name, no industry and no keyword cannot be searched.
    // Said plainly rather than marked done, because a run that finishes having
    // found nothing and a run that could never have started look identical from
    // the list.
    return { inserted: 0, costUsd: 0, error: seedFailureMessage('no_query') };
  }

  // Domains already on this run. The providers overlap heavily and two rows for
  // one company is one row's worth of people and email lookups spent for
  // nothing - and worse, two rows in the export that look like two leads.
  const { data: existing } = await db.from('lead_rows').select('domain').eq('run_id', run.id);
  const seen = new Set<string>(
    (existing ?? [])
      .map((r: any) => String(r.domain ?? '').trim().toLowerCase())
      .filter((d: string) => d !== ''),
  );

  // The user's own order for the company step, ranked by their hit rates. The
  // same chain every other step gets, and the reason discovery stops reading
  // DEFAULT_ORDER directly: a saved company order was silently ignored, which
  // made the lab's company tab a control that did nothing.
  const chain = await stepChain(db, run, 'company');
  const { companies, costUsd, attempts } = await discoverCompanies(
    callCfg, run.id, seg!, want, seen, chain,
  );

  // Each provider call is logged against the run rather than against a row,
  // because there is no row yet. api_usage is written directly for the same
  // reason - without it these calls are invisible to every margin report, and
  // the discovery phase is where a find run's cost is actually incurred.
  for (const a of attempts) {
    await logRunAttempt(db, run, a);
  }

  if (companies.length === 0) {
    return { inserted: 0, costUsd, error: null };
  }

  const now = new Date().toISOString();
  const { error: insertError } = await db.from('lead_rows').insert(
    companies.slice(0, want).map((c) => ({
      user_id: run.user_id,
      run_id: run.id,
      company_name: c.name,
      domain: c.domain,
      logo_url: c.logoUrl,
      // Not found, because nothing has looked. A row created with a status of
      // 'unknown' would show in the table as an address that exists and has
      // never been checked, which is a different and much worse claim.
      email: null,
      email_status: 'not_found',
      company_data: {},
      extra: {},
      credits: 0,
      state: 'queued',
      created_at: now,
      updated_at: now,
    })),
  );

  if (insertError) throw new Error('row_seed_failed: ' + insertError.message);

  return { inserted: Math.min(companies.length, want), costUsd, error: null };
}

/**
 * An attempt that belongs to the run rather than to a row.
 *
 * Discovery happens before any row exists, so there is no row_id to hang a
 * lead_attempts row on - and lead_attempts.row_id is not nullable. api_usage is
 * the table that matters for cost, so that is what gets written; the attempt row
 * is left out rather than written with a fake row id, which would point a
 * provider's cost at a company it never touched.
 */
async function logRunAttempt(db: any, run: any, a: DiscoveryAttempt) {
  const { error } = await db
    .from('api_usage')
    .upsert(
      {
        user_id: run.user_id,
        provider: 'treg',
        provider_call_id: a.callId,
        operation: 'leads.company.found',
        idempotency_key: a.idempotencyKey,
        provider_cost_usd: a.costUsd,
        outcome: billingOutcome(a),
        http_status: a.httpStatus ?? null,
        error_code: errorCodeFor(a),
        // row_id is null on purpose, and that is the honest record: this call
        // found companies rather than working one. The rows it created each
        // carry their own margin entries when they are worked.
        metadata: { endpoint: a.endpointId, step: 'company', run_id: run.id, discovery: true },
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();

  if (error) {
    // Not fatal. The rows are in the database and will be worked; losing this one
    // margin row costs a line in a report, and throwing here would leave the run
    // paused with rows it could have worked.
    console.error(
      'leads: a discovery call was not recorded against api_usage - the run will under-report its ' +
        'provider cost. run=' + run.id + ' endpoint=' + a.endpointId + ' error=' + error.message,
    );
  }
}

async function workRun(db: any, body: any) {
  const cfg = tregConfig({ user: 'worker' }, await resolveToken(db));

  // A worker with no provider token cannot spend anything, so it refuses rather
  // than creating rows it cannot fill.
  if (!cfg) {
    return {
      ok: false,
      error: 'provider_not_configured',
      message: 'The data provider is not configured, so no run can be worked right now.',
    };
  }

  // Queued and running, both. This used to filter `.eq('status', 'queued')` on
  // top of the `.in(...)`, and the first chunk sets a run to 'running' - so every
  // run worked exactly one chunk of five rows and was never selected again. A
  // paused run is never worked: pausing is the user's decision and only resume
  // (which re-queues) undoes it.
  let query = db
    .from('lead_runs')
    .select('*')
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: true })
    .limit(5);
  if (isUuid(body?.run_id)) query = query.eq('id', body.run_id);

  const { data: runs, error } = await query;

  if (error) throw error;
  if (!runs || runs.length === 0) return { ok: true, runs: 0, note: 'nothing queued' };

  const prices = await loadLeadPrices(db);
  if (!prices) {
    return { ok: false, error: 'leads_not_priced', message: 'Leads prices are missing or disabled.' };
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  let worked = 0;
  const more: string[] = [];

  for (const run of runs) {
    if (Date.now() > deadline) break;

    // One worker per run. The self re-invocation and the cron tick overlap all
    // the time, and two workers on one run used to reserve under the same chunk
    // key - the second hold was a replay of the first, so its rows were never
    // charged. Fail closed: without the lease function nothing is worked.
    const { data: leased, error: leaseError } = await db.rpc('lead_claim_run', {
      p_run_id: run.id,
      p_seconds: Math.ceil(TIME_BUDGET_MS / 1000) + 30,
    });
    if (leaseError) {
      console.error('leads: lead_claim_run failed - is migration 20261116 applied? ' + leaseError.message);
      return { ok: false, error: 'lease_unavailable' };
    }
    if (leased !== true) continue;

    try {
      // Re-read under the lease. The copy selected above can be a chunk or more
      // out of date by now - another worker may have settled in between - and
      // the status may have been changed by the user.
      const { data: fresh } = await db.from('lead_runs').select('*').eq('id', run.id).maybeSingle();
      if (!fresh || !['queued', 'running'].includes(fresh.status)) continue;
      const r = await workOneRun(db, cfg, fresh, prices, deadline);
      worked += r.worked;
      if (r.more) more.push(run.id);
    } finally {
      await db.rpc('lead_release_run', { p_run_id: run.id });
    }
  }

  // Re-invoke after the leases are released, or the next worker finds the run
  // still held and skips it, and the run waits for the cron tick.
  for (const runId of more) {
    void fetch(SUPABASE_URL + '/functions/v1/leads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-leads-worker-secret': WORKER_SECRET ?? '',
      },
      body: JSON.stringify({ action: 'work', run_id: runId }),
    }).catch(() => {
      /* cron safety net */
    });
  }

  return { ok: true, runs: runs.length, rows_worked: worked };
}

/**
 * Works one chunk of one run, under that run's lease.
 *
 * Returns whether the run has more to do, so the caller can re-invoke once the
 * lease is released.
 */
async function workOneRun(
  db: any,
  cfg: TregConfig,
  run: any,
  prices: LeadPrices,
  deadline: number,
): Promise<{ worked: number; more: boolean }> {
  let worked = 0;
  {

    // --- the rows, before any of them are claimed -------------------------
    //
    // This runs first and unconditionally, because a find run is created with no
    // rows at all. It used to be skipped on the assumption that something else
    // made them, and nothing did: claimRows returned an empty list, the
    // `claimed.length === 0` branch below called finishRun, and the run the user
    // had just pressed a button on finished instantly with zero leads and no
    // error. Every other fix in this file was correct and unreachable.
    //
    // It also tops the run back up when the queue runs dry, so a provider that
    // returns twenty companies for a fifty-row target gets asked again rather
    // than leaving the run permanently short.
    let seeded = { inserted: 0, costUsd: 0, error: null as string | null };

    // Only when there is nothing to work.
    //
    // The first version of this called seedRunRows on every chunk, and that is
    // the same class of mistake as the bug it was fixing: the worker re-invokes
    // itself per chunk, so a 2000-row run ran 400 chunks, and each one called the
    // company waterfall asking for the ~1995 rows it had not created yet. Paid
    // calls, four hundred times over, for one search.
    //
    // Discovery is for an empty queue. That covers both cases it needs to: a run
    // with no rows at all, and a run whose queue has drained and still has rows
    // to find. Everything in between already has work to do.
    if (run.kind === 'find') {
      const { count: waiting } = await db
        .from('lead_rows')
        .select('id', { count: 'exact', head: true })
        .eq('run_id', run.id)
        .in('state', ['queued', 'trying']);

      const { count: have } = await db
        .from('lead_rows')
        .select('id', { count: 'exact', head: true })
        .eq('run_id', run.id);

      if (shouldDiscover({ kind: run.kind, have: num(have), waiting: num(waiting), target: num(run.target, 50) })) {
        try {
          seeded = await seedRunRows(db, cfg, run);
        } catch (seedErr) {
          // A discovery failure is not a row failure. Pausing the run is right:
          // the wallet was checked for a search that never happened and retrying
          // it blindly would spend that money twice if the error was after the
          // insert.
          console.error('leads: discovery failed, run paused. run=' + run.id + ' error=' + String(seedErr));
          await db
            .from('lead_runs')
            .update({ status: 'paused', pause_reason: 'discovery_failed', last_error: String(seedErr) })
            .eq('id', run.id)
            .in('status', ['queued', 'running']);
          return { worked, more: false };
        }
      }
    }

    // Discovery spend is not held against the wallet. The company credit is
    // charged per row by processRow through the same pricing call as every other
    // line, so there is no unreserved *credit* exposure here - only provider
    // cost, which discoverCompanies bounds before it starts calling.
    if (seeded.costUsd > 0) {
      await db.rpc('lead_run_add_totals', { p_run_id: run.id, p_credits: 0, p_cost_usd: seeded.costUsd, p_chunks: 0 });
    }

    const chunkIndex = Number(run.counters?.chunk ?? 0);
    // Exactly one chunk's worth. Claiming 25 to work 5 left 20 rows locked for
    // five minutes and sized the credit hold for all 25, so a user who could pay
    // for five rows was paused for "insufficient credits".
    const claimed = await claimRows(db, run, CHUNK_ROWS);

    if (claimed.length === 0) {
      // No rows, and none made. Either the search genuinely found nothing, or it
      // could not be run - and those two look identical from the run list unless
      // the reason is recorded.
      //
      // finishRun marks it done, so the failure reason has to be written before
      // that, or a run that was never searchable ends up 'done' with nothing
      // explaining the empty result.
      if (seeded.error) {
        await db
          .from('lead_runs')
          .update({ last_error: seeded.error, status: 'failed' })
          .eq('id', run.id)
          .in('status', ['queued', 'running']);
        return { worked, more: false };
      }

      await finishRun(db, run.id);
      return { worked, more: false };
    }

    // Worst case for this chunk, from the run's own plan rather than a fixed
    // assumption that every row finds a verified address and a phone.
    //
    // The fixed version reserved 1.10 credits for every row regardless of mode.
    // For a verify_only row the ceiling is 0.10, so the wallet was asked to hold
    // eleven times what the run would spend and a user who could comfortably
    // afford the work was refused at the first chunk with insufficient_credits.
    // It also reserved the phone price for runs that never ticked the box.
    const plan = planSteps(run.mode, { phone: run.options?.phone === true });
    const perRowWorst = worstCasePerRow(plan, prices);
    const maxForChunk = claimed.length * perRowWorst;

    // The hold key carries a per-chunk nonce as well as the index. The index
    // alone repeats whenever the totals write below fails, and a repeated key is
    // an idempotent replay of a hold that is already settled - the new rows
    // would be worked and never charged. Nothing retries a reserve, so the nonce
    // costs no protection.
    // Never hold past what the user approved. Rows are capped at the target, so
    // this should not trigger; it is the last stop if something adds rows the
    // estimate did not cover.
    if (num(run.max_credits) > 0 && num(run.charged_credits) + maxForChunk > num(run.max_credits) + 1e-6) {
      await unlockRows(db, claimed.map((r: any) => r.id));
      await db
        .from('lead_runs')
        .update({ status: 'paused', pause_reason: 'approved_maximum_reached' })
        .eq('id', run.id)
        .in('status', ['queued', 'running']);
      return { worked, more: false };
    }

    const holdNonce = crypto.randomUUID().slice(0, 8);
    const hold = await reserveChunk(db, run.user_id, run.id, chunkIndex, maxForChunk, holdNonce);

    if (!hold.ok) {
      await unlockRows(db, claimed.map((r: any) => r.id));
      // The only refusal that stops a run rather than retrying it.
      if (hold.reason === 'insufficient_credits') {
        // If the write does not land the run stays queued and the reserve is
        // refused again on every cron tick, indefinitely, with nothing to show.
        const { error: pauseError } = await db
          .from('lead_runs')
          .update({ status: 'paused', pause_reason: 'credits' })
          .eq('id', run.id)
          .in('status', ['queued', 'running']);
        if (pauseError) {
          console.error(
            'leads: could not pause a run that ran out of credits — retried every minute. run=' +
              run.id + ' error=' + pauseError.message,
          );
        }
        return { worked, more: false };
      }
      return { worked, more: false };
    }

    let earned = 0;
    let providerCost = 0;

    // Every row already worked in this chunk is credited to the hold even if a
    // later row throws, so the release below can never take credits the user has
    // already been charged for.
    let chunkThrew = false;
    // Loaded once per chunk rather than once per row.
    const blocked = await loadSuppressions(db, run.user_id);

    const processed = new Set<string>();
    try {
      for (const row of claimed) {
        if (Date.now() > deadline) break;

        processed.add(row.id);
        const outcome = await processRow(db, run, row, prices, blocked);
        earned += outcome.credits;
        providerCost += outcome.costUsd;
        worked++;
      }
    } catch (err) {
      chunkThrew = true;
      // Swallowed deliberately, after the hold is closed. The run is marked
      // paused below and the reason is recorded there; letting the error
      // propagate would leave the hold open and the run marked running, which is
      // the two states that look fine and are both wrong.
      console.error('leads: chunk aborted', err);
    }

    // Rows the deadline left untouched go back now, rather than sitting locked
    // until the five-minute stale timeout and holding up the end of the run.
    await unlockRows(db, claimed.filter((r: any) => !processed.has(r.id)).map((r: any) => r.id));

    if (hold.reservationId) {
      // A chunk that threw before completing a single row has delivered nothing,
      // so the hold is given back outright rather than settled for zero.
      //
      // Settle would also close it, and settle handles the mixed case correctly
      // — it charges what was earned and releases the rest in one call. Release
      // exists for the one case settle cannot distinguish: the chunk died, and
      // whether the rows before the failure counted is not something to infer
      // from a run that stopped mid-way.
      //
      // Without this the hold sat on the wallet until the hourly reaper closed
      // it, so a single malformed provider response would show a user an hour of
      // their credits as reserved for work that never happened.
      if (chunkThrew && earned === 0 && providerCost === 0) {
        await releaseChunk(db, hold.reservationId, run.id, 'chunk aborted before any row completed');
        await db
          .from('lead_runs')
          .update({ status: 'paused', pause_reason: 'row_error' })
          .eq('id', run.id)
          .in('status', ['queued', 'running']);
        return { worked, more: false };
      }

      const settled = await settleChunk(db, hold.reservationId, earned, providerCost, run.id, chunkIndex, holdNonce);
      if (!settled.ok) {
        // A failed settle is left to the reaper rather than guessed at. The rows
        // are done and their cost is known, so the honest thing is to say so
        // loudly rather than report a charge that may not have happened. Releasing
        // here instead would hand back credits the user has genuinely been
        // charged for, which is worse than waiting.
        //
        // Checked, because this write is the only thing between a failed settle and
        // the next cron tick claiming the same run and working it again against a
        // hold that is already spent.
        const { error: settlePauseError } = await db
          .from('lead_runs')
          .update({ status: 'paused', pause_reason: 'settlement_failed' })
          .eq('id', run.id)
          .in('status', ['queued', 'running']);
        if (settlePauseError) {
          console.error(
            'leads: a settlement failed AND the run could not be paused — it will be claimed again ' +
              'next minute against a hold that is already spent. run=' +
              run.id + ' error=' + settlePauseError.message,
          );
        }
        return { worked, more: false };
      }

      // Totals and status are two writes on purpose. They used to be one, which
      // set status back to 'running' at the end of every chunk - so a user who
      // pressed Pause or Cancel mid-chunk had it silently undone. The totals are
      // always true; the status only moves if the user has not moved it.
      // An increment in SQL, not snapshot + amount: see lead_run_add_totals.
      const { error: totalsError } = await db.rpc('lead_run_add_totals', {
        p_run_id: run.id,
        p_credits: settled.charged,
        p_cost_usd: providerCost,
        p_chunks: 1,
      });

      if (totalsError) {
        console.error(
          'leads: chunk settled but the run totals were not written — the wallet is correct and ' +
            'the run will under-report from here. run=' + run.id + ' error=' + totalsError.message,
        );
      }

      await db
        .from('lead_runs')
        .update({
          status: chunkThrew ? 'paused' : 'running',
          pause_reason: chunkThrew ? 'row_error' : null,
        })
        .eq('id', run.id)
        .in('status', ['queued', 'running']);
    }

    return { worked, more: Date.now() < deadline };
  }
}

/**
 * Takes rows that are not already held.
 *
 * skip locked rather than a plain select, so a second worker or the cron safety
 * net skips a row another is holding instead of processing the same row twice.
 */
async function claimRows(db: any, run: any, limit: number) {
  // FOR UPDATE SKIP LOCKED, in SQL. The PostgREST version was an UPDATE with a
  // LIMIT and no ORDER BY, which is not a limited update PostgREST supports.
  const { data, error } = await db.rpc('lead_claim_rows', {
    p_run_id: run.id,
    p_limit: limit,
    p_stale_seconds: 300,
  });

  if (error) throw error;
  return (data ?? []) as any[];
}

/** Releases claimed rows that were not worked, so the next chunk can take them. */
async function unlockRows(db: any, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.from('lead_rows').update({ locked_at: null, locked_by: null }).in('id', ids);
}

/** The user's opt-out values, lower-cased, for one chunk. */
async function loadSuppressions(db: any, userId: string): Promise<Set<string>> {
  const { data } = await db.from('lead_suppressions').select('value').eq('user_id', userId);
  return new Set((data ?? []).map((s: any) => String(s.value).toLowerCase()));
}

async function finishRun(db: any, runId: string) {
  // `count`, not `data`. With head: true the body is empty, so `data` was always
  // null, num(null) was 0, and every run with an empty claim was marked done -
  // including runs whose rows were still locked by another worker.
  const { count: remaining, error: countError } = await db
    .from('lead_rows')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .in('state', ['queued', 'trying', 'miss']);

  if (countError) return;

  if (num(remaining) === 0) {
    // Self-healing rather than fatal — cron picks the run up again next minute
    // and calls this again. But it is a write that silently did nothing for as
    // long as the worker has been running, and a run stuck short of 'done' is a
    // run whose rows count towards the sidebar badge indefinitely.
    const { error } = await db
      .from('lead_runs')
      .update({ status: 'done', finished_at: new Date().toISOString() })
      .eq('id', runId)
      .in('status', ['queued', 'running']);
    if (error) {
      console.error(
        'leads: could not mark a finished run as done — retried every minute. run=' +
          runId + ' error=' + error.message,
      );
    }
  }
}


// ===========================================================================
// The two waterfalls
// ===========================================================================

/**
 * Whether a call produced an answer worth reading.
 *
 * 'free' counts. It used to be ignored, and three things arrive as 'free': a
 * genuinely free endpoint (ContactOut's verifier, first in the chain, so every
 * verification paid for the second verifier), an idempotent replay, and a
 * per-hit provider's miss - which simply reads as nothing.
 */
function answered(result: { ok: boolean; outcome: string }): boolean {
  return result.ok && (result.outcome === 'success' || result.outcome === 'free');
}

/** What every step call returns to the loop that drives it. */
interface StepCall {
  result: Awaited<ReturnType<typeof tregCallWithRetry>>;
  stop: boolean;
}

/**
 * One provider call for one row and step: progress marker, the call, the log,
 * and the 402 pause. The step functions differ only in how they build the
 * request and read the answer, which endpoints.ts owns.
 */
async function stepCall(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  step: LeadStep,
  entry: EndpointEntry,
  shape: CallShape,
  hitOf: (body: unknown) => boolean,
): Promise<StepCall & { hit: boolean }> {
  // Progress marker, unchecked on purpose: a missed one only delays the
  // animation by a frame.
  await db.from('lead_rows').update({ state: 'trying', step, current_provider: entry.id }).eq('id', row.id);

  const result = await tregCallWithRetry(callCfg, {
    endpointId: entry.id,
    method: shape.method,
    params: shape.params,
    // The generation is part of the key so a deliberate re-check of a row is a
    // new call rather than a 24-hour replay of the old answer.
    idempotencyKey: `leads:${run.id}:${row.id}:${step}:${entry.id}:${num(row.generation)}`,
    maxCostUsd: entry.maxCallUsd,
  });

  const hit = answered(result) && hitOf(result.body);
  await logAttempt(db, run, row, entry.id, step, result, hit);

  const stop = result.outcome === 'error' && result.error === 'route_max_cost_or_balance';
  if (stop) await pauseForProvider(db, run.id);
  return { result, stop, hit };
}

/** Row fields an endpoint can be asked with, including a carried LeadsForge id. */
function rowInput(row: any): RowInput {
  return {
    person_name: row.person_name,
    title: row.title,
    company_name: row.company_name,
    domain: row.domain,
    linkedin_url: row.linkedin_url,
    email: row.email,
    phone: row.phone,
    leadsforge_id: typeof row.extra?.leadsforge_id === 'string' ? row.extra.leadsforge_id : null,
  };
}

/**
 * The email waterfall.
 *
 * A finder that also checks the address (Kitt, Tomba, AI Ark) hands back its
 * verdict with the email. An address its own finder calls undeliverable is
 * treated as a miss and the next provider is tried; the per-hit price on these
 * endpoints means it was not charged for anyway.
 */
async function runEmailStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  rowCapUsd: number,
): Promise<{ email: string | null; provider: string | null; verdict: Verdict | null; costUsd: number }> {
  const chain = await stepChain(db, run, 'email');
  const input = rowInput(row);

  let costUsd = 0;

  for (const entry of chain) {
    const shape = emailFindRequest(entry.id, input);
    if (!shape) continue;
    if (costUsd + entry.maxCallUsd > rowCapUsd) break;

    let hit: EmailHit | null = null;
    const c = await stepCall(db, callCfg, run, row, 'email', entry, shape, (b) => {
      hit = readEmailHit(entry.id, b);
      return Boolean(hit && hit.verdict !== 'undeliverable' && hit.verdict !== 'disposable');
    });
    costUsd += c.result.costUsd;
    if (c.stop) return { email: null, provider: null, verdict: null, costUsd };

    const h = hit as EmailHit | null;
    if (c.hit && h) return { email: h.email, provider: entry.id, verdict: h.verdict, costUsd };

    await db.from('lead_rows').update({ state: 'miss' }).eq('id', row.id);
  }

  return { email: null, provider: null, verdict: null, costUsd };
}

/**
 * The verification waterfall.
 *
 * The first verifier with a definite verdict is believed. 'unknown' is an answer
 * but not a definite one, so the next verifier is asked; if none is definite the
 * row keeps 'unknown'. Silence from every verifier is null - not checked - and is
 * never charged.
 */
async function runVerifyStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  target: { email: string },
  rowCapUsd: number,
): Promise<{ verdict: Verdict | null; provider: string | null; costUsd: number; answered: boolean }> {
  const chain = await stepChain(db, run, 'verify');

  let costUsd = 0;
  let fallback: { verdict: Verdict; provider: string } | null = null;

  for (const entry of chain) {
    const shape = verifyRequest(entry.id, target.email);
    if (!shape) continue;
    if (costUsd + entry.maxCallUsd > rowCapUsd) break;

    let verdict: Verdict | null = null;
    // A hit for the lab means a real mailbox: a 200 that says "invalid" is a
    // successful call and a failed lead.
    const c = await stepCall(db, callCfg, run, row, 'verify', entry, shape, (b) => {
      verdict = readVerifyVerdict(entry.id, b);
      return verdict === 'deliverable' || verdict === 'catch_all';
    });
    costUsd += c.result.costUsd;
    if (c.stop) return { verdict: null, provider: null, costUsd, answered: false };

    const v = answered(c.result) ? (verdict as Verdict | null) : null;
    if (v && v !== 'unknown') return { verdict: v, provider: entry.id, costUsd, answered: true };
    if (v === 'unknown' && !fallback) fallback = { verdict: v, provider: entry.id };

    await db.from('lead_rows').update({ state: 'miss' }).eq('id', row.id);
  }

  if (fallback) return { ...fallback, costUsd, answered: true };
  return { verdict: null, provider: null, costUsd, answered: false };
}

/**
 * The decision-maker waterfall, for a find row that has a domain and no person.
 *
 * Half the row cap: a people miss cannot be recovered from, so it is not worth
 * the whole budget. Every provider here bills per person returned and none bills
 * an empty answer.
 */
async function runPersonStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  rowCapUsd: number,
): Promise<{ person: PersonHit | null; provider: string | null; costUsd: number; considered: number }> {
  if (!row.domain) return { person: null, provider: null, costUsd: 0, considered: 0 };

  const chain = await stepChain(db, run, 'person');
  const cap = Math.max(0.01, rowCapUsd * 0.5);
  const wanted = targetTitlesOf(run);

  let costUsd = 0;
  let best: { hit: PersonHit; provider: string } | null = null;
  let considered = 0;

  for (const entry of chain) {
    const shape = personAtCompanyRequest(entry.id, row.domain, wanted);
    if (!shape) continue;
    if (costUsd + entry.maxCallUsd > cap) break;

    let people: PersonHit[] = [];
    const c = await stepCall(db, callCfg, run, row, 'person', entry, shape, (b) => {
      people = readPeopleAtCompany(entry.id, b);
      return people.length > 0;
    });
    costUsd += c.result.costUsd;
    if (c.stop) return { person: null, provider: null, costUsd, considered: 0 };
    if (!answered(c.result)) continue;

    considered = Math.max(considered, people.length);
    for (const p of people) {
      const incumbent = best ? scoreTitle(best.hit.title, wanted) : -Infinity;
      if (scoreTitle(p.title, wanted) > incumbent) best = { hit: p, provider: entry.id };
    }
    if (best) break;
  }

  return { person: best?.hit ?? null, provider: best?.provider ?? null, costUsd, considered };
}

/** The phone waterfall. Opt-in per run; every finder bills only a found number. */
async function runPhoneStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  rowCapUsd: number,
): Promise<{ phone: string | null; provider: string | null; costUsd: number }> {
  const chain = await stepChain(db, run, 'phone');
  const input = rowInput(row);

  let costUsd = 0;

  for (const entry of chain) {
    const shape = phoneRequest(entry.id, input);
    if (!shape) continue;
    if (costUsd + entry.maxCallUsd > rowCapUsd) break;

    let phone: string | null = null;
    const c = await stepCall(db, callCfg, run, row, 'phone', entry, shape, (b) => {
      phone = readPhoneHit(entry.id, b);
      return Boolean(phone);
    });
    costUsd += c.result.costUsd;
    if (c.stop) return { phone: null, provider: null, costUsd };
    if (c.hit && phone) return { phone, provider: entry.id, costUsd };

    await db.from('lead_rows').update({ state: 'miss' }).eq('id', row.id);
  }

  return { phone: null, provider: null, costUsd };
}

/**
 * The company's own details. Skipped when the row already carries them and they
 * are fresh, so nothing is paid for twice.
 */
async function runEnrichStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  rowCapUsd: number,
): Promise<{ companyData: Record<string, unknown> | null; provider: string | null; costUsd: number }> {
  const chain = await stepChain(db, run, 'enrich');
  const input = rowInput(row);

  let costUsd = 0;

  for (const entry of chain) {
    const shape = companyEnrichRequest(entry.id, input);
    if (!shape) continue;
    if (costUsd + entry.maxCallUsd > rowCapUsd) break;

    let data: Record<string, unknown> | null = null;
    const c = await stepCall(db, callCfg, run, row, 'enrich', entry, shape, (b) => {
      data = readCompanyEnrich(entry.id, b);
      return Boolean(data);
    });
    costUsd += c.result.costUsd;
    if (c.stop) return { companyData: null, provider: null, costUsd };
    if (c.hit && data) {
      return { companyData: { ...(data as Record<string, unknown>), enriched_at: new Date().toISOString() }, provider: entry.id, costUsd };
    }

    await db.from('lead_rows').update({ state: 'miss' }).eq('id', row.id);
  }

  return { companyData: null, provider: null, costUsd };
}

/**
 * The provider chain for a step, in this user's order.
 *
 * One function for all four steps rather than the copy that used to sit inline in
 * the email and verify waterfalls. The copies were the reason a user could set a
 * custom order for the email step and have it silently ignored for people: the
 * third copy was written without the saved-order lookup and nobody noticed,
 * because there was no third step to exercise it.
 */
async function stepChain(
  db: any,
  run: any,
  step: LeadStep,
): Promise<ReturnType<typeof orderFor>> {
  const { data: saved } = await db
    .from('lead_waterfall_orders')
    .select('endpoint_ids')
    .eq('user_id', run.user_id)
    .eq('step', step)
    .maybeSingle();

  const { data: stats } = await db
    .from('lead_attempts')
    .select('endpoint_id, hit')
    .eq('user_id', run.user_id)
    .eq('step', step);

  const statMap: Record<string, { hits: number; attempts: number }> = {};
  for (const a of stats ?? []) {
    const s = statMap[a.endpoint_id] ?? { hits: 0, attempts: 0 };
    s.attempts++;
    s.hits += a.hit ? 1 : 0;
    statMap[a.endpoint_id] = s;
  }

  return orderFor(step, statMap, (saved?.endpoint_ids as string[]) ?? null);
}

/**
 * The titles this run is looking for.
 *
 * Read from the run's options rather than the ICP on every row. The options are
 * a snapshot taken when the run started, so a user editing their profile
 * mid-run does not change what the run is chasing - the row set was already
 * built from the old one.
 */
function targetTitlesOf(run: any): string[] {
  const raw = run.options?.target_titles;
  if (Array.isArray(raw)) return raw.filter((t: unknown) => typeof t === 'string' && t.trim() !== '') as string[];
  return [];
}

/**
 * Stops a run whose provider account has run out of credit.
 *
 * Logged rather than ignored. This is the only thing between a 402 and a worker
 * that keeps calling a provider which has already refused, so a silent failure
 * means the run keeps spending against a balance that is gone.
 */
async function pauseForProvider(db: any, runId: string): Promise<void> {
  const { error } = await db
    .from('lead_runs')
    .update({ status: 'paused', pause_reason: 'provider_balance' })
    .eq('id', runId)
    .in('status', ['queued', 'running']);
  if (error) {
    console.error(
      'leads: could not pause a run whose provider balance is exhausted — it will keep calling. run=' +
        runId + ' error=' + error.message,
    );
  }
}

// ===========================================================================
// One row, through whatever steps its plan calls for
// ===========================================================================

/**
 * The per-row spend cap, from the run's options, clamped.
 *
 * It was taken from the request body as-is, so a client could send any number
 * and the waterfall would keep going as long as it fit.
 */
function rowCapOf(run: any): number {
  const fallback = run.options?.phone ? 0.25 : 0.05;
  const n = num(run.options?.row_cap_usd, fallback);
  return Math.min(0.5, Math.max(0.01, n));
}

/**
 * Works one row through whatever its plan calls for.
 *
 * Order: decision maker (find runs), verify what the row carries (clean modes),
 * find an address when the plan allows and the verdict permits, check a found
 * address unless its finder already gave a definite verdict, then phone and
 * company details when asked for.
 */
async function processRow(
  db: any,
  run: any,
  row: any,
  prices: LeadPrices,
  blocked: Set<string>,
): Promise<{ credits: number; costUsd: number }> {
  const plan = planSteps(run.mode, { phone: run.options?.phone === true });

  const callCfg = tregConfig({ user: run.user_id, run: run.id, row: row.id }, await resolveToken(db));
  if (!callCfg) return { credits: 0, costUsd: 0 };

  // Opt-outs before any paid call, by domain and by address.
  const isBlocked = (v: unknown) => typeof v === 'string' && v !== '' && blocked.has(v.toLowerCase());
  if (isBlocked(row.domain) || isBlocked(row.email)) {
    // Thrown when it cannot be written: a suppressed row that stays queued is
    // claimed and skipped forever and the run never finishes.
    const { error: skipError } = await db
      .from('lead_rows')
      .update({ state: 'skipped', step: null, locked_at: null })
      .eq('id', row.id);
    if (skipError) throw new Error('suppression_write_failed: ' + skipError.message);
    return { credits: 0, costUsd: 0 };
  }

  const rowCapUsd = rowCapOf(run);

  let costUsd = 0;
  let email: string | null = row.email ?? null;
  let emailProvider: string | null = row.email_provider ?? null;
  let emailFound = false;

  let verdict: Verdict | null = null;
  let verdictProvider: string | null = null;
  let answered = false;
  // Whether a verifier - not a finder grading its own answer - gave a verdict.
  // Only that is charged as a verification.
  let verifierAnswered = false;
  let lastStep: LeadStep | null = null;

  // --- 0. the decision maker ----------------------------------------------
  let personName: string | null = row.person_name ?? null;
  let personTitle: string | null = row.title ?? null;
  let linkedinUrl: string | null = row.linkedin_url ?? null;
  let personFound = false;
  let personProvider: string | null = null;
  let peopleConsidered = 0;

  if (plan.findCompany && !personName && !linkedinUrl && row.domain) {
    const p = await runPersonStep(db, callCfg, run, row, rowCapUsd);
    costUsd += p.costUsd;
    peopleConsidered = p.considered;
    if (p.person) {
      personName = p.person.name;
      personTitle = p.person.title;
      linkedinUrl = p.person.linkedinUrl ?? linkedinUrl;
      personFound = true;
      personProvider = p.provider;
      lastStep = 'person';
    }
  }

  const workRow = { ...row, person_name: personName, title: personTitle, linkedin_url: linkedinUrl };

  // --- 1. verify what the row already carries -----------------------------
  if (plan.verifyExisting && email) {
    const v = await runVerifyStep(db, callCfg, run, row, { email }, rowCapUsd - costUsd);
    costUsd += v.costUsd;
    if (v.answered) {
      verdict = v.verdict;
      verdictProvider = v.provider;
      answered = true;
      verifierAnswered = true;
      lastStep = 'verify';
    }
  }

  // --- 2. find, when the plan allows and the verdict permits --------------
  const passed = verdict === 'deliverable' || verdict === 'catch_all';

  if (shouldFindEmail(plan, answered && verdict !== 'unknown' ? passed : null)) {
    const f = await runEmailStep(db, callCfg, run, workRow, rowCapUsd - costUsd);
    costUsd += f.costUsd;

    if (f.email && isBlocked(f.email)) {
      // Found, and on the opt-out list. Not kept and not charged; the provider
      // cost stays recorded against the row.
    } else if (f.email) {
      email = f.email;
      emailProvider = f.provider;
      emailFound = true;
      lastStep = 'email';
      verdict = f.verdict;
      verdictProvider = f.verdict ? f.provider : null;
      answered = f.verdict !== null;

      // --- 3. check the address, unless its finder already did ------------
      // A find run used to skip this, so every address it found was stored as
      // 'unknown' and billed at the verified price.
      if (!f.verdict || f.verdict === 'unknown') {
        const v2 = await runVerifyStep(db, callCfg, run, workRow, { email: f.email }, rowCapUsd - costUsd);
        costUsd += v2.costUsd;
        if (v2.answered) {
          verdict = v2.verdict;
          verdictProvider = v2.provider;
          answered = true;
          verifierAnswered = true;
          lastStep = 'verify';
        }
      }
    }
  }

  // --- 4. phone, only when the run asked for it ---------------------------
  let phone: string | null = row.phone ?? null;
  let phoneProvider: string | null = row.phone_provider ?? null;
  let phoneFound = false;

  if (plan.phone && !phone && (personName || linkedinUrl)) {
    const ph = await runPhoneStep(db, callCfg, run, { ...workRow, email }, Math.max(rowCapUsd - costUsd, 0));
    costUsd += ph.costUsd;
    if (ph.phone) {
      phone = ph.phone;
      phoneProvider = ph.provider;
      phoneFound = true;
      lastStep = 'phone';
    }
  }

  // --- 5. company details, for the modes that asked -----------------------
  let companyData = row.company_data ?? null;
  let companyEnriched = false;

  if (plan.enrich && (row.domain || row.company_name) && !freshCompanyData(companyData)) {
    const en = await runEnrichStep(db, callCfg, run, row, Math.max(rowCapUsd - costUsd, 0));
    costUsd += en.costUsd;
    if (en.companyData) {
      companyData = en.companyData;
      companyEnriched = true;
      lastStep = 'enrich';
    }
  }

  // --- 6. the status, and what it is worth --------------------------------
  const status = statusFor(email, email ? verdict : null);

  const credits = creditsForRow(
    {
      companyFound: plan.findCompany && Boolean(row.domain),
      personFound,
      emailFound,
      verified: verdict === 'deliverable',
      catchAll: verdict === 'catch_all',
      invalid: verdict === 'undeliverable',
      disposable: verdict === 'disposable',
      unreadable: plan.verifyExisting && !verifierAnswered,
      phoneFound,
      companyEnriched,
    },
    prices,
    plan,
  );

  // One write, so credits and cost cannot disagree. Thrown on failure: a row
  // left 'trying' is claimed again and charged again.
  const now = new Date().toISOString();
  const { error: doneError } = await db
    .from('lead_rows')
    .update({
      state: 'done',
      step: lastStep,
      current_provider: verdictProvider ?? emailProvider ?? personProvider ?? phoneProvider ?? null,
      email,
      email_provider: emailFound ? emailProvider : (row.email_provider ?? null),
      email_status: status,
      email_checked_at: answered && email ? now : (row.email_checked_at ?? null),
      email_verifier: answered && email ? verdictProvider : (row.email_verifier ?? null),
      person_name: personFound ? personName : (row.person_name ?? null),
      title: personFound ? personTitle : (row.title ?? null),
      linkedin_url: linkedinUrl ?? row.linkedin_url ?? null,
      phone: phoneFound ? phone : (row.phone ?? null),
      phone_provider: phoneFound ? phoneProvider : (row.phone_provider ?? null),
      company_data: companyEnriched ? companyData : (row.company_data ?? {}),
      extra: personFound
        ? {
            ...(row.extra ?? {}),
            person_choice: describeChoice({ name: personName, title: personTitle }, peopleConsidered, targetTitlesOf(run)),
          }
        : (row.extra ?? {}),
      credits,
      treg_cost_usd: round6(costUsd),
      locked_at: null,
    })
    .eq('id', row.id);

  if (doneError) {
    throw new Error(`row_write_failed: ${doneError.message}`);
  }

  // Into the workspace's lead database. Not thrown: the row and its charge are
  // already right, and a missed merge is repaired by the next run that touches
  // the same person, or by the backfill.
  const { data: merged, error: mergeError } = await db.rpc('lead_contact_upsert_from_row', { p_row_id: row.id });
  if (mergeError) {
    console.error('leads: contact merge failed. row=' + row.id + ' error=' + mergeError.message);
  } else if (merged) {
    await ws.scoreMerged(db, merged).catch((e: unknown) => console.error('leads: scoring failed', e));
  }

  return { credits, costUsd };
}

/** Company details count as fresh for 90 days; older ones may be refreshed. */
function freshCompanyData(d: unknown): boolean {
  if (!d || typeof d !== 'object' || Object.keys(d as object).length === 0) return false;
  const at = Date.parse(String((d as Record<string, unknown>).enriched_at ?? ''));
  // Imported company data with no date is the user's own and is kept.
  if (!Number.isFinite(at)) return true;
  return Date.now() - at < 90 * 24 * 3600 * 1000;
}

/**
 * Writes the attempt and the api_usage row together.
 *
 * One attempt, one api_usage row, same charge. api_usage is what the margin
 * views read, so writing the attempt without it would make a provider look free
 * in every report — which is the specific mistake the whole cost-tracking design
 * exists to prevent.
 */
/**
 * Records the attempt and the api_usage row together.
 *
 * `hit` is passed in rather than derived from the outcome, because "the provider
 * answered" and "the provider was useful" are different questions and only the
 * first is visible in an HTTP status. A verifier that returns 200 and says the
 * mailbox does not exist has answered and has not hit, and counting that as a
 * hit feeds both smart order and the hit rate that prices the waterfall.
 */
async function logAttempt(
  db: any,
  run: any,
  row: any,
  endpointId: string,
  step: LeadStep,
  result: any,
  hit: boolean,
) {
  const apiUsageKey = `leads:${run.id}:${row.id}:${step}:${endpointId}`;

  // The operation recorded is the leads step, not the provider id, so the margin
  // view groups by what was sold rather than by who served it. Verification is
  // priced per check rather than per find, and there is no leads.verify.found in
  // pricing_config — composing one would write margin rows against an operation
  // that is not being sold.
  const operation =
    step === 'verify'
      ? 'leads.verify.only'
      : step === 'email'
        ? 'leads.email.verified'
        : // Enrichment is the one step whose operation is not a straight read of
          // its name. The template below produces `leads.enrich.found`, which is
          // not in pricing_config - the seeded operation is `leads.company.enrich`
          // - so the margin write would have failed its foreign key on every
          // enriched row of every full_enrich run. It sat unnoticed because this
          // function had never been called with a non-verify, non-email step.
          step === 'enrich'
          ? 'leads.company.enrich'
          : `leads.${step}.found`;

  // api_usage first, then the attempt, then link them.
  //
  // The order used to be the other way round and neither write was checked. That
  // combination is how this table stayed empty: api_usage's CHECK constraint
  // accepts five billing outcomes and treg reports six, so every 402 and every 429
  // raised a check violation which nobody read, and the row vanished. api_usage is
  // what the margin views read, so those failures were invisible in every report —
  // and the attempt history could not show an HTTP status because there was no row
  // to read it from. It looked like a feature that had not been built.
  //
  // Writing api_usage first also means the link can be filled in: the id only
  // exists once that row does. The old order left api_usage_id permanently null,
  // so the column was dead and the two tables could only be related by a
  // convention that nothing enforced.
  const { data: usage, error: usageError } = await db
    .from('api_usage')
    .upsert(
      {
        user_id: run.user_id,
        provider: 'treg',
        provider_call_id: result.callId,
        operation,
        idempotency_key: apiUsageKey,
        provider_cost_usd: result.costUsd,
        outcome: billingOutcome(result),
        http_status: result.httpStatus ?? null,
        error_code: errorCodeFor(result),
        metadata: { endpoint: endpointId, step, run_id: run.id, row_id: row.id },
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();

  if (usageError) {
    // Not thrown. Throwing here would fail the whole row and lose the lead, and
    // the lead is worth more than the margin entry — the credits have already
    // settled through the wallet, which is a separate path and unaffected. What
    // is lost is one row of cost reporting, so it is logged loudly and the work
    // continues.
    //
    // It was silent for the length of a whole development cycle, so the message
    // says what to do about it rather than only what happened.
    console.error(
      'leads: api_usage write failed — the provider cost for this call will be missing from ' +
        'every margin report. row=' + row.id + ' endpoint=' + endpointId + ' error=' + usageError.message,
    );
  }

  const { error: attemptError } = await db.from('lead_attempts').insert({
    user_id: run.user_id,
    run_id: run.id,
    row_id: row.id,
    step,
    endpoint_id: endpointId,
    hit,
    cost_usd: result.costUsd,
    ms: result.ms ?? null,
    treg_call_id: result.callId,
    api_usage_id: usage?.id ?? null,
  });

  if (attemptError) {
    // Also not thrown, and for the opposite reason. The attempt is what the hit
    // rates are computed from and what the row receipt is drawn from; losing it
    // costs a data point rather than a lead. Throwing would discard a found
    // address to preserve a record of having found it.
    console.error(
      'leads: lead_attempts write failed — this call will not count towards the hit rate or ' +
        'the row receipt. row=' + row.id + ' endpoint=' + endpointId + ' error=' + attemptError.message,
    );
  }
}


// ===========================================================================
// Import, bulk
// ===========================================================================

async function importRows(db: any, userId: string, body: any) {
  if (!isUuid(body?.run_id)) return { ok: false, error: 'bad_run_id' };
  if (!Array.isArray(body?.rows)) return { ok: false, error: 'no_rows' };

  const { data: run } = await db
    .from('lead_runs')
    .select('id, status, pause_reason, target')
    .eq('user_id', userId)
    .eq('id', body.run_id)
    .maybeSingle();
  if (!run) return { ok: false, error: 'run_not_found' };
  if (TERMINAL.has(run.status)) return { ok: false, error: 'run_already_finished' };

  // No more rows than the run was priced for. The estimate and the wallet check
  // covered `target` rows; rows past it would be worked and charged beyond what
  // the user approved.
  const { count: existing } = await db
    .from('lead_rows')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', run.id);
  const room = Math.max(0, num(run.target) - num(existing));

  const { data: suppressed } = await db.from('lead_suppressions').select('value').eq('user_id', userId);
  const blocked = new Set((suppressed ?? []).map((s: any) => String(s.value).toLowerCase()));

  const inserted: unknown[] = [];
  let skipped = 0;

  const offered = (body.rows as any[]).slice(0, 1000);
  const overTarget = Math.max(0, offered.length - room);
  for (const raw of offered.slice(0, room)) {
    const email = asString(raw?.email, 200).toLowerCase();
    const domain = asString(raw?.domain, 200).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    // Suppression is applied here rather than in the worker, so a suppressed row
    // is never written and never has to be deleted.
    if ((email && blocked.has(email)) || (domain && blocked.has(domain))) {
      skipped++;
      continue;
    }

    inserted.push({
      user_id: userId,
      run_id: body.run_id,
      company_name: asString(raw?.company_name, 200) || null,
      domain: domain || null,
      person_name: asString(raw?.person_name, 200) || null,
      title: asString(raw?.title, 200) || null,
      linkedin_url: asString(raw?.linkedin_url, 300) || null,
      email: email || null,
      // Not checked yet - which is a different claim from 'unknown', the answer
      // a verifier gives when it tried and could not tell.
      email_status: email ? 'unchecked' : 'not_found',
      extra: passthrough(raw?.extra),
      state: 'queued',
    });
  }

  if (inserted.length > 0) {
    const { error } = await db.from('lead_rows').insert(inserted);
    if (error) throw error;
  }

  // The last batch releases a run created on hold for its import.
  if (body?.last === true && run.status === 'paused' && run.pause_reason === 'importing') {
    await db
      .from('lead_runs')
      .update({ status: 'queued', pause_reason: null })
      .eq('id', run.id)
      .eq('status', 'paused');
    kickWorker(run.id);
  }

  return { ok: true, inserted: inserted.length, skipped, over_target: overTarget };
}

/**
 * A CSV's extra columns, minus the keys Leads itself reads from `extra`. A
 * file with its own "contact_id" column would otherwise be read as a pointer to
 * a lead in this workspace.
 */
function passthrough(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
    if (['contact_id', 'company_id', 'leadsforge_id', 'person_choice'].includes(k)) out['csv_' + k] = val;
    else out[k] = val;
  }
  return out;
}

async function bulkAction(db: any, userId: string, body: any) {
  if (!Array.isArray(body?.row_ids)) return { ok: false, error: 'no_rows' };
  const ids = (body.row_ids as unknown[]).filter(isUuid) as string[];
  if (ids.length === 0) return { ok: false, error: 'no_valid_rows' };

  const action = String(body?.bulk ?? '');

  if (action === 'delete') {
    const { error } = await db.from('lead_rows').delete().eq('user_id', userId).in('id', ids);
    if (error) throw error;
    return { ok: true, deleted: ids.length };
  }

  if (action === 'reverify' || action === 'find_phone') {
    // A new, priced run over copies of the selected rows - not the old run.
    //
    // This used to flag the rows 'queued' on their finished run. A finished run
    // is never worked, so nothing happened; and had it been worked, the run's
    // own plan would have run again and charged the company and the address a
    // second time without verifying anything. It also could not have been
    // charged at all past the run's approved maximum.
    const requestId = asString(body?.request_id, 64);
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(requestId)) return { ok: false, error: 'request_id_required' };
    const prior = await ws.priorRequest(db, userId, requestId);
    if (prior) return { ok: true, run: prior, replayed: true };

    const { data: src, error } = await db
      .from('lead_rows')
      .select('person_name, title, linkedin_url, company_name, domain, email, phone, extra')
      .eq('user_id', userId)
      .in('id', ids);
    if (error) throw error;

    const rows = (src ?? [])
      .filter((r: any) => (action === 'reverify' ? Boolean(r.email) : !r.phone && (r.person_name || r.linkedin_url)))
      .map((r: any) => ({
        ...r,
        extra: r.extra?.leadsforge_id ? { leadsforge_id: r.extra.leadsforge_id } : {},
      }));
    if (!rows.length) return { ok: false, error: 'nothing_to_do' };

    if (body?.estimate_only === true) {
      const mode = action === 'reverify' ? 'verify_only' : 'phone_only';
      const { data: est, error: estErr } = await db.rpc('estimate_lead_run', {
        p_target: rows.length, p_mode: mode, p_phone: mode === 'phone_only', p_hit_rate: null, p_user: userId,
      });
      if (estErr) throw estErr;
      return { ok: true, eligible: rows.length, selected: ids.length, estimate: est };
    }

    return ws.runFromRows(
      db, wsCtx(db), userId,
      action === 'reverify' ? 'verify' : 'phone',
      action === 'reverify' ? 'verify_only' : 'phone_only',
      rows, requestId,
    );
  }

  return { ok: false, error: 'unknown_bulk_action' };
}
