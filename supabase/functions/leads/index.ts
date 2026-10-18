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
import { orderFor, canRunWith, REGISTRY, DEFAULT_ORDER, type LeadStep } from './registry.ts';
import {
  reserveChunk,
  settleChunk,
  releaseChunk,
  loadLeadPrices,
  type LeadPrices,
} from './billing.ts';
import { planSteps, shouldFindEmail, worstCasePerRow, shouldDiscover } from './steps.ts';
import { creditsForRow, round6 } from './pricing-row.ts';
import { readEmail, readVerdict, type Verdict } from './read-response.ts';
import { foldAttempts } from './attribution.ts';
import { readPeople, readPhone, readCompanyRecord, type PersonHit } from './read-lists.ts';
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

  // ---- everything else needs a user --------------------------------------
  const userId = await requireUserId(req);
  if (!userId) return fail('Unauthorized', 401);

  // 60 leads calls / hour / user. Generous enough for a provider lab and a clean,
  // tight enough that a leaked session cannot run the wallet dry.
  if (!rateLimit('leads:' + userId, 60, 60 * 60 * 1000)) {
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
      'id, company_name, domain, logo_url, person_name, title, linkedin_url, email, email_status, email_provider, phone, phone_provider, credits, state, step, current_provider, company_data, extra',
    )
    .eq('user_id', userId)
    .eq('run_id', runId)
    .order('created_at', { ascending: true })
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

  // No run starts without a price on screen. The estimate is recomputed here
  // rather than trusted from the client, so what was shown and what is checked
  // are the same call against the same prices.
  const { data: est, error: estErr } = await db.rpc('estimate_lead_run', {
    p_target: target,
    p_mode: asString(body?.mode, 40) || null,
    p_phone: asBool(body?.phone),
  });
  if (estErr) throw estErr;
  if (!est || (est as any).ok !== true) {
    return { ok: false, error: (est as any)?.error ?? 'cannot_price_run' };
  }

  const maxCredits = num((est as any).max_credits);

  // The titles this run is chasing, snapshotted onto the run.
  //
  // The people waterfall needs them once per row, and reading them from the ICP
  // each time would be one query per row for a value that cannot change while the
  // run is going. Snapshotting also fixes the meaning: a run chases the profile
  // as it was when they pressed the button, so editing the profile mid-run does
  // not quietly change what the remaining rows are looking for - which would
  // leave a run that is half one search and half another.
  let targetTitles: string[] = [];
  if (isUuid(body?.icp_id)) {
    const { data: icp } = await db.from('lead_icps').select('json').eq('id', body.icp_id).maybeSingle();
    const seg = primarySegmentOf(icp?.json);
    targetTitles = (seg?.targetTitles ?? []).filter((t: unknown) => typeof t === 'string' && String(t).trim() !== '');
  }

  // Can they actually pay the worst case? A run that cannot be paid for in full
  // must not start, which is why this is checked against max and not expected.
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
      shortfall: Math.round((maxCredits - available) * 1e6) / 1e6,
      max_credits: maxCredits,
      message: 'Not enough credits for the worst case. Top up to run this search.',
    };
  }

  const { data: run, error } = await db
    .from('lead_runs')
    .insert({
      user_id: userId,
      icp_id: isUuid(body?.icp_id) ? body.icp_id : null,
      name: asString(body?.name, 120) || null,
      kind,
      target,
      mode: asString(body?.mode, 40) || null,
      options: {
        phone: asBool(body?.phone),
        company_data: asBool(body?.company_data),
        row_cap_usd: num(body?.row_cap_usd, 0.05),
        target_titles: targetTitles,
      },
      status: 'queued',
      est_credits: num((est as any).expected_credits),
      max_credits: maxCredits,
    })
    .select('*')
    .single();

  if (error) throw error;

  // The worker is kicked without awaiting it. A find run has no rows yet, so the
  // first chunk has to make them; the cron safety net would otherwise leave the
  // user looking at a queued run for up to a minute after pressing the button.
  void fetch(SUPABASE_URL + '/functions/v1/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-leads-worker-secret': WORKER_SECRET ?? '',
    },
    body: JSON.stringify({ action: 'work', run_id: run.id }),
  }).catch(() => {
    /* the cron tick picks it up */
  });

  return { ok: true, run, estimate: est };
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
const CLAIM_ROWS = 25;

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

  const { data: runs, error } = await db
    .from('lead_runs')
    .select('*')
    .in('status', body?.run_id ? ['queued', 'running', 'paused'] : ['queued', 'running'])
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(5);

  if (error) throw error;
  if (!runs || runs.length === 0) return { ok: true, runs: 0, note: 'nothing queued' };

  const prices = await loadLeadPrices(db);
  if (!prices) {
    return { ok: false, error: 'leads_not_priced', message: 'Leads prices are missing or disabled.' };
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  let worked = 0;

  for (const run of runs) {
    if (Date.now() > deadline) break;

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
            .eq('id', run.id);
          continue;
        }
      }
    }

    // Discovery spend is not held against the wallet. The company credit is
    // charged per row by processRow through the same pricing call as every other
    // line, so there is no unreserved *credit* exposure here - only provider
    // cost, which discoverCompanies bounds before it starts calling.
    if (seeded.costUsd > 0) {
      await db
        .from('lead_runs')
        .update({ treg_cost_usd: num(run.treg_cost_usd) + seeded.costUsd })
        .eq('id', run.id);
      run.treg_cost_usd = num(run.treg_cost_usd) + seeded.costUsd;
    }

    const chunkIndex = Number(run.counters?.chunk ?? 0);
    const claimed = await claimRows(db, run, CLAIM_ROWS);

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
          .eq('id', run.id);
        continue;
      }

      await finishRun(db, run.id);
      continue;
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

    const hold = await reserveChunk(db, run.user_id, run.id, chunkIndex, maxForChunk);

    if (!hold.ok) {
      // The only refusal that stops a run rather than retrying it.
      if (hold.reason === 'insufficient_credits') {
        // If the write does not land the run stays queued and the reserve is
        // refused again on every cron tick, indefinitely, with nothing to show.
        const { error: pauseError } = await db
          .from('lead_runs')
          .update({ status: 'paused', pause_reason: 'credits' })
          .eq('id', run.id);
        if (pauseError) {
          console.error(
            'leads: could not pause a run that ran out of credits — retried every minute. run=' +
              run.id + ' error=' + pauseError.message,
          );
        }
        continue;
      }
      continue;
    }

    let earned = 0;
    let providerCost = 0;

    // Every row already worked in this chunk is credited to the hold even if a
    // later row throws, so the release below can never take credits the user has
    // already been charged for.
    let chunkThrew = false;
    try {
      for (const row of claimed.slice(0, CHUNK_ROWS)) {
        if (Date.now() > deadline) break;

        const outcome = await processRow(db, run, row, prices);
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
          .eq('id', run.id);
        continue;
      }

      const settled = await settleChunk(db, hold.reservationId, earned, providerCost, run.id, chunkIndex);
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
          .eq('id', run.id);
        if (settlePauseError) {
          console.error(
            'leads: a settlement failed AND the run could not be paused — it will be claimed again ' +
              'next minute against a hold that is already spent. run=' +
              run.id + ' error=' + settlePauseError.message,
          );
        }
        continue;
      }

      const { error: totalsError } = await db
        .from('lead_runs')
        .update({
          status: chunkThrew ? 'paused' : 'running',
          pause_reason: chunkThrew ? 'row_error' : null,
          started_at: run.started_at ?? new Date().toISOString(),
          charged_credits: num(run.charged_credits) + settled.charged,
          treg_cost_usd: num(run.treg_cost_usd) + providerCost,
          counters: { ...(run.counters ?? {}), chunk: chunkIndex + 1 },
        })
        .eq('id', run.id);

      if (totalsError) {
        console.error(
          'leads: chunk settled but the run totals were not written — the wallet is correct and ' +
            'the run will under-report from here. run=' + run.id + ' error=' + totalsError.message,
        );
      }
    }

    // Re-invoke for the next chunk, so a long run does not wait for cron.
    if (Date.now() < deadline) {
      void fetch(SUPABASE_URL + '/functions/v1/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-leads-worker-secret': WORKER_SECRET ?? '',
        },
        body: JSON.stringify({ action: 'work', run_id: run.id }),
      }).catch(() => {
        /* cron safety net */
      });
    }
  }

  return { ok: true, runs: runs.length, rows_worked: worked };
}

/**
 * Takes rows that are not already held.
 *
 * skip locked rather than a plain select, so a second worker or the cron safety
 * net skips a row another is holding instead of processing the same row twice.
 */
async function claimRows(db: any, run: any, limit: number) {
  const { data, error } = await db
    .from('lead_rows')
    .update({ locked_at: new Date().toISOString(), locked_by: 'worker' })
    .eq('run_id', run.id)
    .in('state', ['queued', 'miss'])
    .or('locked_at.is.null,locked_at.lt.' + new Date(Date.now() - 5 * 60_000).toISOString())
    .select('*')
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

async function finishRun(db: any, runId: string) {
  const { data: remaining } = await db
    .from('lead_rows')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .in('state', ['queued', 'trying', 'miss']);

  if (num(remaining) === 0) {
    // Self-healing rather than fatal — cron picks the run up again next minute
    // and calls this again. But it is a write that silently did nothing for as
    // long as the worker has been running, and a run stuck short of 'done' is a
    // run whose rows count towards the sidebar badge indefinitely.
    const { error } = await db
      .from('lead_runs')
      .update({ status: 'done', finished_at: new Date().toISOString() })
      .eq('id', runId);
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
 * The email waterfall, unchanged in shape from the version that has been running.
 *
 * Split out of processRow so the verify step can sit beside it rather than being
 * threaded through the same loop with a flag. A loop that can do two unrelated
 * things is a loop whose price is only correct for one of them, which is how the
 * clean modes came to cost the find price.
 */
async function runEmailStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  rowCapUsd: number,
): Promise<{ email: string | null; provider: string | null; costUsd: number }> {
  // Entries, not ids. orderFor resolves the ids itself so it can rank by this
  // user's own hit rates, and what it hands back is the registry entries.
  const chain = await stepChain(db, run, 'email');

  let costUsd = 0;

  for (const entry of chain) {
    const id = entry.id;
    if (!canRunWith(row, entry)) continue;
    if (costUsd + entry.priceUsd > rowCapUsd) break;

    // Progress markers, unchecked on purpose. These are what the table animates
    // while a row is being worked; if one is missed the row shows the previous
    // state for a moment and nothing else changes. Every other write in this file
    // is checked, and the one that matters most throws.
    await db.from('lead_rows').update({ state: 'trying', step: 'email', current_provider: id }).eq('id', row.id);

    const result = await tregCallWithRetry(callCfg, {
      endpointId: id,
      params: {
        full_name: row.person_name ?? undefined,
        domain: row.domain ?? undefined,
        linkedin_url: row.linkedin_url ?? undefined,
      },
      idempotencyKey: `leads:${run.id}:${row.id}:email:${id}`,
      maxCostUsd: entry.priceUsd,
    });

    costUsd += result.costUsd;

    const email = result.outcome === 'success' ? readEmail(result.body, entry.readHit) : null;
    await logAttempt(db, run, row, id, 'email', result, Boolean(email));

    if (result.outcome === 'error' && result.error === 'route_max_cost_or_balance') {
      await pauseForProvider(db, run.id);
      return { email: null, provider: null, costUsd };
    }

    if (email) return { email, provider: id, costUsd };

    await db.from('lead_rows').update({ state: 'miss' }).eq('id', row.id);
  }

  return { email: null, provider: null, costUsd };
}

/**
 * The verification waterfall.
 *
 * Three verifiers, cheapest first. The first one that answers is believed; the
 * rest are not asked, because a second opinion on an address the user is about to
 * email costs money to produce a less useful answer than the first.
 *
 * `answered` is separate from `verdict` on purpose. A provider that returns
 * something unreadable is not an "invalid" — it is silence, and it earns nothing.
 */
async function runVerifyStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  target: { email: string },
  rowCapUsd: number,
): Promise<{
  verdict: Verdict | null;
  provider: string | null;
  costUsd: number;
  answered: boolean;
}> {
  const chain = await stepChain(db, run, 'verify');

  let costUsd = 0;

  for (const entry of chain) {
    const id = entry.id;
    if (!canRunWith(target, entry)) continue;
    if (costUsd + entry.priceUsd > rowCapUsd) break;

    await db.from('lead_rows').update({ state: 'trying', step: 'verify', current_provider: id }).eq('id', row.id);

    const result = await tregCallWithRetry(callCfg, {
      endpointId: id,
      params: { email: target.email },
      idempotencyKey: `leads:${run.id}:${row.id}:verify:${id}`,
      maxCostUsd: entry.priceUsd,
    });

    costUsd += result.costUsd;

    const verdict = result.outcome === 'success' ? readVerdict(result.body) : null;

    // A hit here means the verifier said the address is a real mailbox. A 200
    // carrying "invalid" is a successful call and a failed lead, and counting it
    // as a hit would rank this provider above one that actually finds addresses.
    await logAttempt(
      db,
      run,
      row,
      id,
      'verify',
      result,
      verdict === 'deliverable' || verdict === 'catch_all',
    );

    if (result.outcome === 'error' && result.error === 'route_max_cost_or_balance') {
      await pauseForProvider(db, run.id);
      return { verdict: null, provider: null, costUsd, answered: false };
    }

    if (verdict) {
      return { verdict, provider: id, costUsd, answered: true };
    }

    await db.from('lead_rows').update({ state: 'miss' }).eq('id', row.id);
  }

  return { verdict: null, provider: null, costUsd, answered: false };
}

/**
 * The decision-maker waterfall.
 *
 * Runs before the email step, because every email endpoint in the registry is
 * keyed on a name or a profile URL. A find row created by the company search has
 * a domain and nothing else, so without this step the email waterfall is asked
 * for an address for a person who does not exist yet, and every provider in the
 * chain answers with a miss that was never a miss - it was a malformed request.
 *
 * The row cap is deliberately tighter than the email step's share. A people
 * search that returns nothing costs a fraction of what the next waterfall costs
 * and has no way to recover, so it is worth two attempts and not five.
 */
async function runPersonStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  rowCapUsd: number,
): Promise<{ person: PersonHit | null; provider: string | null; costUsd: number; considered: number }> {
  // Nothing to search for. A row with no domain cannot be searched for staff,
  // and asking anyway would spend a call to learn that.
  if (!row.domain) return { person: null, provider: null, costUsd: 0, considered: 0 };

  const chain = await stepChain(db, run, 'person');
  if (chain.length === 0) return { person: null, provider: null, costUsd: 0, considered: 0 };

  // Half the email step's budget. See above: a people miss cannot be recovered
  // from, so spending the whole cap on it would be spending the row's budget on
  // the step with the least to gain.
  const cap = Math.max(0.01, rowCapUsd * 0.5);

  let costUsd = 0;
  let best: { hit: PersonHit; provider: string } | null = null;
  // How many people the best answer came from. Not the total seen across
  // providers - that number is not meaningful to anyone - but the size of the
  // list the chosen person was picked out of, which is what makes the choice
  // explicable.
  let considered = 0;

  for (const entry of chain) {
    if (costUsd + entry.priceUsd > cap) break;
    if (!canRunWith(row, entry)) continue;

    await db
      .from('lead_rows')
      .update({ state: 'trying', step: 'person', current_provider: entry.id })
      .eq('id', row.id);

    const result = await tregCallWithRetry(callCfg, {
      endpointId: entry.id,
      params: {
        domain: row.domain,
        company: row.company_name ?? undefined,
        limit: 25,
      },
      idempotencyKey: `leads:${run.id}:${row.id}:person:${entry.id}`,
      maxCostUsd: entry.priceUsd,
    });

    costUsd += result.costUsd;

    const people = result.outcome === 'success' ? readPeople(result.body) : [];
    await logAttempt(db, run, row, entry.id, 'person', result, people.length > 0);

    if (result.outcome === 'error' && result.error === 'route_max_cost_or_balance') {
      await pauseForProvider(db, run.id);
      return { person: null, provider: null, costUsd, considered: 0 };
    }

    // Keep the best from every provider, not just the first that answered.
    // Providers rank people differently and two of them disagreeing is the only
    // signal available about which one is right.
    const wanted = targetTitlesOf(run);
    considered = Math.max(considered, people.length);
    for (const p of people) {
      const incumbent = best ? scoreTitle(best.hit.title, wanted) : -Infinity;
      if (scoreTitle(p.title, wanted) > incumbent) best = { hit: p, provider: entry.id };
    }

    if (best) break;
  }

  return {
    person: best?.hit ?? null,
    provider: best?.provider ?? null,
    costUsd,
    considered,
  };
}

/**
 * The phone waterfall.
 *
 * Opt-in per run, and off by default. It is the most expensive step in the
 * registry by a wide margin - an order of magnitude above the address find - so
 * it is never part of a plan and only ever runs because a run's options asked
 * for it.
 */
async function runPhoneStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  rowCapUsd: number,
): Promise<{ phone: string | null; provider: string | null; costUsd: number }> {
  // Every phone endpoint here is keyed on a person. A domain with no name has
  // nobody to ask for, and a company switchboard is not a lead's phone number.
  if (!row.person_name && !row.linkedin_url) {
    return { phone: null, provider: null, costUsd: 0 };
  }

  const chain = await stepChain(db, run, 'phone');
  if (chain.length === 0) return { phone: null, provider: null, costUsd: 0 };

  let costUsd = 0;

  for (const entry of chain) {
    if (costUsd + entry.priceUsd > rowCapUsd) break;
    if (!canRunWith(row, entry)) continue;

    await db
      .from('lead_rows')
      .update({ state: 'trying', step: 'phone', current_provider: entry.id })
      .eq('id', row.id);

    const result = await tregCallWithRetry(callCfg, {
      endpointId: entry.id,
      params: {
        full_name: row.person_name ?? undefined,
        domain: row.domain ?? undefined,
        linkedin_url: row.linkedin_url ?? undefined,
      },
      idempotencyKey: `leads:${run.id}:${row.id}:phone:${entry.id}`,
      maxCostUsd: entry.priceUsd,
    });

    costUsd += result.costUsd;

    const phone = result.outcome === 'success' ? readPhone(result.body) : null;
    await logAttempt(db, run, row, entry.id, 'phone', result, Boolean(phone));

    if (result.outcome === 'error' && result.error === 'route_max_cost_or_balance') {
      await pauseForProvider(db, run.id);
      return { phone: null, provider: null, costUsd };
    }

    if (phone) return { phone, provider: entry.id, costUsd };

    await db.from('lead_rows').update({ state: 'miss' }).eq('id', row.id);
  }

  return { phone: null, provider: null, costUsd };
}

/**
 * The enrichment step: the company's own details, keyed on its domain.
 *
 * Runs last, and only for a mode that asked for it. It is the one step whose
 * answer is about the company rather than the contact, so doing it first would
 * spend it on rows that turn out to have no contact at all.
 */
async function runEnrichStep(
  db: any,
  callCfg: TregConfig,
  run: any,
  row: any,
  rowCapUsd: number,
): Promise<{ companyData: Record<string, unknown> | null; provider: string | null; costUsd: number }> {
  // Already enriched. An import may carry a company_data the user paid for
  // elsewhere, and re-fetching it would be billed again for the same fields.
  if (row.company_data && Object.keys(row.company_data).length > 0) {
    return { companyData: null, provider: null, costUsd: 0 };
  }

  if (!row.domain) return { companyData: null, provider: null, costUsd: 0 };

  const chain = await stepChain(db, run, 'enrich');
  if (chain.length === 0) return { companyData: null, provider: null, costUsd: 0 };

  let costUsd = 0;

  for (const entry of chain) {
    if (costUsd + entry.priceUsd > rowCapUsd) break;
    if (!canRunWith(row, entry)) continue;

    await db
      .from('lead_rows')
      .update({ state: 'trying', step: 'enrich', current_provider: entry.id })
      .eq('id', row.id);

    const result = await tregCallWithRetry(callCfg, {
      endpointId: entry.id,
      params: { domain: row.domain },
      idempotencyKey: `leads:${run.id}:${row.id}:enrich:${entry.id}`,
      maxCostUsd: entry.priceUsd,
    });

    costUsd += result.costUsd;

    const companyData = result.outcome === 'success' ? readCompanyRecord(result.body) : null;
    await logAttempt(db, run, row, entry.id, 'enrich', result, Boolean(companyData));

    if (result.outcome === 'error' && result.error === 'route_max_cost_or_balance') {
      await pauseForProvider(db, run.id);
      return { companyData: null, provider: null, costUsd };
    }

    if (companyData) return { companyData, provider: entry.id, costUsd };

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
    .eq('id', runId);
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
 * Works one row to completion.
 *
 * The shape here used to be a single email waterfall with the run's mode ignored,
 * so "check what I have" went out and found replacements for the rows it had
 * promised to leave alone, and every clean run was charged the find price. The
 * mode is now read once, at the top, and turned into a plan by steps.ts — the
 * same function the estimator and the tests use, so the three cannot disagree.
 *
 * Order matters and is not arbitrary. Verification comes first because it is
 * cheaper than a find and because its answer decides whether a find is worth
 * doing: verify_only never finds, verify_refind finds only for the rows that
 * failed, and a find run does not verify at all because an address it finds is
 * verified as part of being found.
 *
 * What a replacement address is worth is settled the same way as the original.
 * Finding one and not checking it is how a row ends up holding an address that
 * nothing ever looked at, which is the precise thing the verified badge exists
 * to rule out.
 */
async function processRow(
  db: any,
  run: any,
  row: any,
  prices: LeadPrices,
): Promise<{ credits: number; costUsd: number }> {
  const plan = planSteps(run.mode, { phone: run.options?.phone === true });

  const meta = { user: run.user_id, run: run.id, step: 'verify', row: row.id };
  const callCfg = tregConfig(meta, await resolveToken(db));

  if (!callCfg) return { credits: 0, costUsd: 0 };

  // Opt-outs are checked before any paid call. A suppressed row is never looked
  // up at all, so suppressing someone costs nothing and means their data is not
  // even fetched.
  const { data: suppressed } = await db
    .from('lead_suppressions')
    .select('value')
    .eq('user_id', run.user_id);

  const blocked = new Set((suppressed ?? []).map((s: any) => String(s.value).toLowerCase()));
  if (row.domain && blocked.has(String(row.domain).toLowerCase())) {
    // Thrown, because a suppressed row that cannot be marked is a row the run can
    // never finish. finishRun counts anything still in queued, trying or miss, so
    // if this write does not land the row is claimed again next chunk, suppressed
    // again, marked again, fails again — and the run stays 'running' with nothing
    // left to do, forever.
    //
    // No money is at stake here so it goes to the chunk handler rather than
    // anywhere sharper: the chunk settles what it earned and the run pauses, which
    // is visible and recoverable.
    const { error: skipError } = await db
      .from('lead_rows')
      .update({ state: 'skipped', step: null, locked_at: null })
      .eq('id', row.id);
    if (skipError) throw new Error('suppression_write_failed: ' + skipError.message);
    return { credits: 0, costUsd: 0 };
  }

  const rowCapUsd = num(run.options?.row_cap_usd, 0.05);

  let costUsd = 0;
  let email: string | null = row.email ?? null;
  let emailProvider: string | null = row.email_provider ?? null;

  // Did the waterfall go and get an address, as opposed to being handed one?
  // The two are priced differently and only the first is charged for finding.
  let emailFound = false;

  let verdict: Verdict | null = null;
  let verdictProvider: string | null = null;
  // Whether any verifier answered at all. Kept apart from verdict because
  // silence is not a verdict, and charging for it would bill the user for our
  // outage.
  let answered = false;
  let lastStep: LeadStep | null = null;

  // --- 0. the decision maker, before anything that needs one ---------------
  //
  // First because everything after it is keyed on it. A find row arrives with a
  // domain and no person, and every email endpoint in the registry takes a name
  // or a profile URL, so running the email waterfall first would ask every
  // provider in the chain the same malformed question and log each answer as a
  // miss.
  //
  // Skipped when the row already carries a person, which is the case for every
  // clean run and for a find row that a previous chunk already gave one to.
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

  // --- 1. verify what the row already carries -----------------------------
  if (plan.verifyExisting && email) {
    const v = await runVerifyStep(db, callCfg, run, row, { email }, rowCapUsd);
    costUsd += v.costUsd;
    if (v.answered) {
      verdict = v.verdict;
      verdictProvider = v.provider;
      answered = true;
      lastStep = 'verify';
    }
  }

  // --- 2. find, when the plan allows and the verdict permits --------------
  //
  // Three outcomes decide this, and each is different:
  //   good address        no find, for verify_refind. The answer is already known.
  //   bad address         find. That is the mode's entire purpose.
  //   no answer           find anyway. An unreachable verifier is a reason to try
  //                       harder, not a reason to hand back a row with nothing.
  const passed = verdict === 'deliverable' || verdict === 'catch_all';

  if (shouldFindEmail(plan, answered ? passed : null)) {
    // The row as it stands now rather than as it was claimed. A find row's person
    // was found in step 0 and is held in a local, so passing the original row
    // would send the email waterfall out with the same null person_name it had
    // before the people search - which is the request that finds nothing, and
    // would have logged every provider as a miss rather than as a bad question.
    const workRow = {
      ...row,
      person_name: personName,
      title: personTitle,
      linkedin_url: linkedinUrl,
    };

    const f = await runEmailStep(db, callCfg, run, workRow, rowCapUsd);
    costUsd += f.costUsd;

    if (f.email) {
      email = f.email;
      emailProvider = f.provider;
      emailFound = true;
      lastStep = 'email';

      // --- 3. check the replacement, on the same terms as the original ----
      // Skipped for a find run, where the find itself returns a deliverable
      // address and a second pass would be charging twice for one piece of work.
      if (plan.verifyExisting) {
        const v2 = await runVerifyStep(db, callCfg, run, row, { email: f.email }, rowCapUsd);
        costUsd += v2.costUsd;
        if (v2.answered) {
          verdict = v2.verdict;
          verdictProvider = v2.provider;
          answered = true;
          lastStep = 'verify';
        }
      }
    }
  }

  // --- 4. phone, when the run's options asked for it ----------------------
  //
  // Not part of any plan, and never will be: at roughly eight times the price of
  // the address find, a step that is on by default would dominate every invoice
  // without being what the user came for. It runs only because the run's options
  // carry the flag, and the estimate quotes it separately for the same reason.
  let phone: string | null = row.phone ?? null;
  let phoneProvider: string | null = row.phone_provider ?? null;
  let phoneFound = false;

  if (run.options?.phone && !phone && (personName || linkedinUrl)) {
    const ph = await runPhoneStep(
      db,
      callCfg,
      run,
      { ...row, person_name: personName, linkedin_url: linkedinUrl },
      rowCapUsd,
    );
    costUsd += ph.costUsd;

    if (ph.phone) {
      phone = ph.phone;
      phoneProvider = ph.provider;
      phoneFound = true;
      lastStep = 'phone';
    }
  }

  // --- 5. the company's own details, for the mode that asked --------------
  let companyData = row.company_data ?? null;
  let companyEnriched = false;

  if (plan.enrich && row.domain && (!companyData || Object.keys(companyData).length === 0)) {
    const en = await runEnrichStep(db, callCfg, run, row, rowCapUsd);
    costUsd += en.costUsd;

    if (en.companyData) {
      companyData = en.companyData;
      companyEnriched = true;
      lastStep = 'enrich';
    }
  }

  // --- 6. the status, and what it is worth -------------------------------
  //
  // Five states and each says something different. 'unknown' is not a hedge: it
  // is the honest label for an address that exists and that nothing has checked,
  // and it is the one a row imported with an email in it starts life as.
  const status: string = !email
    ? 'not_found'
    : verdict === 'deliverable'
      ? 'verified'
      : verdict === 'catch_all'
        ? 'catch_all'
        : verdict === 'undeliverable'
          ? 'invalid'
          : 'unknown';

  const credits = creditsForRow(
    {
      // The company is charged per row because it is true per row: the row exists
      // because a company search returned that domain, and that search is what
      // the price is for. Discovery creates the row and this line is where the
      // credit lands, which is one company one charge however many pages of
      // results it took to find it.
      //
      // The person is different, and this is the line that was wrong. It was
      // `plan.findCompany`, a constant, so it charged the decision-maker price on
      // every row of every find run whether or not a person was ever found - and
      // no person was ever found, because nothing looked for one. The user was
      // billed 440 credits across a 2000-row search for lookups that had not
      // happened. It is now the actual outcome of the people waterfall, and it is
      // zero when the waterfall found nobody.
      companyFound: plan.findCompany && Boolean(row.domain),
      personFound,
      emailFound,
      verified: verdict === 'deliverable',
      catchAll: verdict === 'catch_all',
      invalid: verdict === 'undeliverable',
      // Asked, and got nothing usable back. Not charged, and not reported as a
      // result — otherwise a broken verifier is indistinguishable from a strict
      // one on both the invoice and the row.
      unreadable: plan.verifyExisting && !answered,
      phoneFound,
      companyEnriched,
    },
    prices,
    plan,
  );

  // One write, so credits and cost can never disagree. Two writes would leave a
  // window in which a row is charged but not costed, or costed but not charged,
  // and neither is visible from the outside — the user sees one number and the
  // margin report sees the other.
  // Thrown on failure, deliberately, and this is the only place in the worker
  // where a database error is escalated rather than logged.
  //
  // If this write does not land the row is still 'trying' with locked_at set, and
  // claimRows picks up anything in queued, trying or miss on the next chunk. So
  // the provider is called again, the user is charged again, and the wallet is
  // settled for work that was already done — once per chunk, until the credits
  // run out. Nothing records it: the attempts say the first call happened and the
  // wallet says the user paid, and both are true.
  //
  // Throwing loses the credits for this one row, because the caller adds them to
  // the chunk total only on return. That is the right way round. Under-charging a
  // user by one row is a support ticket; double-charging them until their wallet
  // empties is a company.
  const { error: doneError } = await db
    .from('lead_rows')
    .update({
      state: 'done',
      step: lastStep,
      // The provider that produced the row's headline result, in the order the
      // user cares about: a verified address beats the person who was found, and
      // the person beats the phone nobody asked for.
      current_provider:
        verdictProvider ?? emailProvider ?? personProvider ?? phoneProvider ?? null,
      email,
      email_provider: emailFound ? emailProvider : (row.email_provider ?? null),
      email_status: status,
      // Written only where this run is what put them there. A row that arrived
      // from the user's file keeps its own name, title and LinkedIn URL: they
      // are the user's data, they may be the reason they imported it, and
      // overwriting them with a worse answer from a provider is not this
      // pipeline's job.
      person_name: personFound ? personName : (row.person_name ?? null),
      title: personFound ? personTitle : (row.title ?? null),
      linkedin_url: linkedinUrl ?? row.linkedin_url ?? null,
      phone: phoneFound ? phone : (row.phone ?? null),
      phone_provider: phoneFound ? phoneProvider : (row.phone_provider ?? null),
      company_data: companyEnriched ? companyData : (row.company_data ?? {}),
      // How the decision maker was arrived at, in words. The alternative is a
      // person on the row with no way to tell whether they were chosen or
      // whether they are simply the first the provider returned.
      extra: personFound
        ? {
            ...(row.extra ?? {}),
            person_choice: describeChoice(
              { name: personName, title: personTitle },
              peopleConsidered,
              targetTitlesOf(run),
            ),
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

  return { credits, costUsd };
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
    .select('id')
    .eq('user_id', userId)
    .eq('id', body.run_id)
    .maybeSingle();
  if (!run) return { ok: false, error: 'run_not_found' };

  const { data: suppressed } = await db.from('lead_suppressions').select('value').eq('user_id', userId);
  const blocked = new Set((suppressed ?? []).map((s: any) => String(s.value).toLowerCase()));

  const inserted: unknown[] = [];
  let skipped = 0;

  for (const raw of (body.rows as any[]).slice(0, 1000)) {
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
      // An imported address is unverified until a verifier says otherwise, and
      // the database refuses an address with any other status.
      email_status: email ? 'unknown' : 'not_found',
      extra: (raw?.extra ?? {}) as Record<string, unknown>,
      state: 'queued',
    });
  }

  if (inserted.length > 0) {
    const { error } = await db.from('lead_rows').insert(inserted);
    if (error) throw error;
  }

  return { ok: true, inserted: inserted.length, skipped };
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
    // Re-queued rather than actioned here: the work needs the waterfall and the
    // wallet, which belong to the worker.
    const step = action === 'reverify' ? 'verify' : 'phone';
    const { error } = await db
      .from('lead_rows')
      .update({ state: 'queued', step, locked_at: null, current_provider: null })
      .eq('user_id', userId)
      .in('id', ids);
    if (error) throw error;
    return { ok: true, requeued: ids.length, step };
  }

  return { ok: false, error: 'unknown_bulk_action' };
}
