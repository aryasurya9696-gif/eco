/**
 * Echo Leads — the lead database actions
 * ----------------------------------------------------------------------------
 * Everything the People, Companies, Lists and Search screens do, kept out of
 * index.ts so the worker stays readable. Every function takes the caller's user
 * id, already resolved from a verified JWT, and every query is filtered by it:
 * the client is the service role here, so RLS does not apply and the filter is
 * the only tenancy check. A function that reads or writes by id without
 * `.eq('user_id', userId)` is a cross-workspace bug.
 *
 * What costs money is not here. Paid work is always a run, created through the
 * same estimate, wallet check and chunked billing as every other run; this
 * module only decides which leads go into it.
 */

import { tregCallWithRetry, type TregConfig } from './treg.ts';
import {
  cleanPeopleFilters,
  hasAnyPeopleFilter,
  leadsforgePeopleBody,
  readLeadsforgePeople,
  readLeadsforgeCount,
  readVocab,
  FILTER_VOCAB,
  bareDomain,
  type SearchPerson,
} from './endpoints.ts';
import { cleanRules, rulesFromSegment, scoreLead, type ScoringRules } from './scoring.ts';

type Db = any;

export interface WorkspaceCtx {
  tregCfg: () => Promise<TregConfig | null>;
  /** Prices, checks the wallet and inserts a run. See createRun in index.ts. */
  createRun: (userId: string, o: CreateRunInput) => Promise<any>;
  kickWorker: (runId: string) => void;
}

export interface CreateRunInput {
  kind: string;
  target: number;
  mode: string | null;
  phone: boolean;
  icpId: string | null;
  name: string | null;
  hold: string | null;
  extraOptions?: Record<string, unknown>;
}

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const uuids = (v: unknown, max = 1000): string[] => (Array.isArray(v) ? v.filter(isUuid).slice(0, max) : []);
const strs = (v: unknown, max = 50, len = 60): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => str(x, len)).filter(Boolean))].slice(0, max) : [];

/**
 * Two PostgREST limits shape the helpers below. Reads return at most
 * db-max-rows (1000 by default) whatever .limit() asks for, so anything that
 * may be larger is paged. And `.in()` puts every id in the URL, so long id
 * lists go in batches rather than as one request a gateway may refuse.
 */
const BATCH = 200;
const batches = <T>(xs: T[], n = BATCH): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Every row a query returns, up to `max`, a page of 1000 at a time. */
async function allRows<T = any>(build: () => any, max: number): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build().range(from, Math.min(from + 999, max - 1));
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Runs `run` over ids in batches and concatenates what each batch returns. */
async function inBatches<T = any>(ids: string[], run: (batch: string[]) => Promise<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = [];
  for (const b of batches(ids)) {
    const { data, error } = await run(b);
    if (error) throw error;
    out.push(...(data ?? []));
  }
  return out;
}

/** PostgREST `or` filters are a mini-language; strip what could break out of it. */
const safeTerm = (v: string) => v.replace(/[,()*%\\:"']/g, ' ').trim();

const EMAIL_STATUSES = ['verified', 'catch_all', 'invalid', 'unknown', 'not_found', 'unchecked', 'disposable'];
const LEAD_STATUSES = ['new', 'qualified', 'contacted', 'nurture', 'disqualified'];

// ===========================================================================
// Search (LeadsForge: free search, free count)
// ===========================================================================

export async function searchPeople(db: Db, ctx: WorkspaceCtx, userId: string, body: any) {
  const filters = cleanPeopleFilters(body?.filters);
  if (!hasAnyPeopleFilter(filters)) return { ok: false, error: 'no_filters' };

  const cfg = await ctx.tregCfg();
  if (!cfg) return { ok: false, error: 'provider_not_configured' };

  // Opt-outs are sent as the provider's own exclusion lists, so a suppressed
  // person is never even returned.
  const { data: sup } = await db.from('lead_suppressions').select('value, kind').eq('user_id', userId).limit(5000);
  const excludeEmails = (sup ?? []).filter((s: any) => s.kind === 'email').map((s: any) => s.value);
  const excludeDomains = (sup ?? []).filter((s: any) => s.kind === 'domain').map((s: any) => s.value);

  const limit = Math.max(1, Math.min(50, num(body?.limit, 25)));
  const cursor = str(body?.cursor, 500) || undefined;

  const result = await tregCallWithRetry(cfg, {
    endpointId: 'leadsforge.people.search',
    method: 'POST',
    params: leadsforgePeopleBody(filters, { limit, excludeEmails, excludeDomains }),
    query: cursor ? { cursor } : undefined,
    // A search is free, and a fresh key per request: the same filters asked
    // twice should return the provider's current answer, not a 24h replay.
    idempotencyKey: `leads:search:${userId}:${crypto.randomUUID()}`,
    maxCostUsd: 0.001,
  });

  await logUsage(db, userId, 'leadsforge.people.search', result);

  if (!result.ok || (result.outcome !== 'success' && result.outcome !== 'free')) {
    return { ok: false, error: 'search_failed', status: result.httpStatus, detail: result.error ?? null };
  }

  const { people, cursor: next } = readLeadsforgePeople(result.body);

  // Which of these are already in the database, so the screen can say so and
  // nobody saves the same person twice.
  const ids = people.map((p) => p.leadsforge_id);
  const known = new Map<string, string>();
  if (ids.length) {
    const { data: existing } = await db
      .from('lead_contacts')
      .select('id, attributes')
      .eq('user_id', userId)
      .in('attributes->>leadsforge_id', ids);
    for (const c of existing ?? []) {
      const lf = c.attributes?.leadsforge_id;
      if (typeof lf === 'string') known.set(lf, c.id);
    }
  }

  if (!cursor) {
    await db.from('lead_search_log').insert({ user_id: userId, filters, total: null });
  }

  return {
    ok: true,
    people: people.map((p) => ({ ...p, contact_id: known.get(p.leadsforge_id) ?? null })),
    cursor: next,
    provider: 'leadsforge.people.search',
  };
}

export async function countPeople(db: Db, ctx: WorkspaceCtx, userId: string, body: any) {
  const filters = cleanPeopleFilters(body?.filters);
  if (!hasAnyPeopleFilter(filters)) return { ok: true, total: null };
  const cfg = await ctx.tregCfg();
  if (!cfg) return { ok: false, error: 'provider_not_configured' };

  const result = await tregCallWithRetry(cfg, {
    endpointId: 'leadsforge.people.search.count',
    method: 'POST',
    params: leadsforgePeopleBody(filters),
    idempotencyKey: `leads:count:${userId}:${crypto.randomUUID()}`,
    maxCostUsd: 0.001,
  });
  await logUsage(db, userId, 'leadsforge.people.search.count', result);

  const total = result.ok ? readLeadsforgeCount(result.body) : null;
  if (total === null) return { ok: false, error: 'count_failed', status: result.httpStatus };
  return { ok: true, total };
}

/** Filter vocabularies, cached for a week in the shared lead_filter_cache. */
export async function filterValues(db: Db, ctx: WorkspaceCtx, body: any) {
  const kind = str(body?.kind, 30);
  const spec = FILTER_VOCAB[kind];
  if (!spec) return { ok: false, error: 'unknown_filter' };

  const { data: cached } = await db
    .from('lead_filter_cache')
    .select('values, fetched_at')
    .eq('provider', 'leadsforge')
    .eq('filter_type', kind)
    .maybeSingle();

  const fresh = cached && Date.now() - Date.parse(cached.fetched_at) < 7 * 24 * 3600 * 1000;
  if (fresh && Array.isArray(cached.values) && cached.values.length) {
    return { ok: true, values: cached.values, cached: true };
  }

  const cfg = await ctx.tregCfg();
  if (!cfg) return { ok: true, values: cached?.values ?? [], cached: Boolean(cached) };

  const result = await tregCallWithRetry(cfg, {
    endpointId: spec.endpoint,
    method: 'GET',
    params: spec.params ?? {},
    idempotencyKey: `leads:vocab:${kind}:${new Date().toISOString().slice(0, 10)}`,
    maxCostUsd: 0.001,
  });

  const values = result.ok ? readVocab(kind, result.body) : [];
  if (values.length) {
    await db
      .from('lead_filter_cache')
      .upsert({ provider: 'leadsforge', filter_type: kind, values, fetched_at: new Date().toISOString() }, { onConflict: 'provider,filter_type' });
    return { ok: true, values, cached: false };
  }
  // A stale list beats an empty one; the screen falls back to free text either way.
  return { ok: true, values: cached?.values ?? [], cached: Boolean(cached) };
}

/** One api_usage row for a free call, so the provider traffic is still visible. */
async function logUsage(db: Db, userId: string, endpoint: string, r: any) {
  const outcome = r.outcome === 'success' || r.outcome === 'free'
    ? (r.costUsd > 0 ? 'success' : 'free')
    : r.outcome === 'uncertain' ? 'uncertain' : 'upstream_failed';
  const { error } = await db.from('api_usage').insert({
    user_id: userId,
    provider: 'treg',
    provider_call_id: r.callId,
    operation: 'leads.search',
    idempotency_key: `leads:usage:${crypto.randomUUID()}`,
    provider_cost_usd: r.costUsd,
    outcome,
    http_status: r.httpStatus || null,
    metadata: { endpoint },
  });
  if (error) console.error('leads: search usage not recorded - ' + error.message);
}

export async function searchHistory(db: Db, userId: string) {
  const { data, error } = await db
    .from('lead_search_log')
    .select('id, filters, total, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return { ok: true, history: data ?? [] };
}

/**
 * Saves search results into the database (free), optionally into a list.
 *
 * The person fields come back from the client, which received them from the
 * provider a moment earlier. They are re-cleaned here and can only ever land in
 * the caller's own workspace, so the worst a forged entry can do is put a wrong
 * name in your own list - the same as importing a CSV.
 */
export async function saveSearchResults(db: Db, userId: string, body: any) {
  const people = (Array.isArray(body?.people) ? body.people : []).slice(0, 200) as SearchPerson[];
  const listId = isUuid(body?.list_id) ? body.list_id : null;
  if (listId && !(await ownsList(db, userId, listId, 'people'))) return { ok: false, error: 'list_not_found' };

  const rules = await rulesFor(db, userId);
  const saved: string[] = [];
  let skipped = 0;

  for (const p of people) {
    const name = str(p?.person_name, 200);
    const domain = bareDomain(p?.domain);
    if (!name || !domain) {
      skipped++;
      continue;
    }
    const c = p?.company ?? ({} as SearchPerson['company']);
    const { data: contact, error } = await db.rpc('lead_contact_merge', {
      p_user: userId,
      p_fields: {
        person_name: name,
        title: str(p?.title, 200) || null,
        location: str(p?.person_location, 200) || null,
        company_name: str(p?.company_name, 200) || null,
        domain,
        source: 'search',
        attributes: {
          leadsforge_id: str(p?.leadsforge_id, 80) || undefined,
          company: {
            employee_count: Number.isFinite(Number(c?.employee_count)) ? Number(c.employee_count) : undefined,
            industry: str(c?.industry, 120) || undefined,
            location: str(c?.location, 200) || undefined,
            revenue_min: Number.isFinite(Number(c?.revenue_min)) ? Number(c.revenue_min) : undefined,
            revenue_max: Number.isFinite(Number(c?.revenue_max)) ? Number(c.revenue_max) : undefined,
          },
          found_by: 'leadsforge.people.search',
          found_at: new Date().toISOString(),
        },
      },
    });
    if (error || !contact?.id) {
      skipped++;
      continue;
    }
    await applyScore(db, contact, rules);
    saved.push(contact.id);
  }

  if (listId && saved.length) await addToList(db, userId, listId, saved, 'people');

  return { ok: true, saved: saved.length, skipped, contact_ids: saved };
}

// ===========================================================================
// People (lead_contacts)
// ===========================================================================

const CONTACT_COLUMNS =
  'id, person_name, title, linkedin_url, location, company_name, domain, company_id, email, email_status, ' +
  'email_checked_at, email_verifier, email_provider, phone, phone_provider, tags, status, score, score_label, ' +
  'source, last_run_id, last_enriched_at, created_at, updated_at, attributes';

const SORTABLE: Record<string, string> = {
  updated: 'updated_at',
  created: 'created_at',
  name: 'person_name',
  company: 'company_name',
  score: 'score',
  email_status: 'email_status',
};

/**
 * Filters a contacts query by the database view's filters. Shared by the list
 * and by "select all matching" for bulk actions, so the two cannot disagree.
 */
// Synchronous on purpose. A PostgREST builder is a thenable, so returning it
// from an async function (or awaiting it) runs the query and hands back the
// result instead of the builder - .order() on that throws.
function contactsFilter(db: Db, userId: string, f: any, select: string, opts?: { count?: boolean }): any {
  // A list is an inner join on its members rather than a list of ids in the
  // URL, so a list of any size filters the same way.
  const listId = isUuid(f?.list_id) ? f.list_id : null;
  const cols = listId ? `${select}, lead_list_members!inner(list_id)` : select;
  let q = db.from('lead_contacts').select(cols, opts?.count ? { count: 'exact' } : undefined).eq('user_id', userId);
  if (listId) q = q.eq('lead_list_members.list_id', listId);

  const term = safeTerm(str(f?.q, 100));
  if (term) {
    q = q.or(
      ['person_name', 'title', 'company_name', 'domain', 'email'].map((c) => `${c}.ilike.*${term}*`).join(','),
    );
  }
  const es = strs(f?.email_status, 10).filter((s) => EMAIL_STATUSES.includes(s));
  if (es.length) q = q.in('email_status', es);
  if (f?.has_email === true) q = q.not('email', 'is', null);
  if (f?.has_email === false) q = q.is('email', null);
  if (f?.has_phone === true) q = q.not('phone', 'is', null);
  if (f?.has_phone === false) q = q.is('phone', null);
  const st = strs(f?.status, 10).filter((s) => LEAD_STATUSES.includes(s));
  if (st.length) q = q.in('status', st);
  const tags = strs(f?.tags, 20, 40);
  if (tags.length) q = q.contains('tags', tags);
  if (isUuid(f?.company_id)) q = q.eq('company_id', f.company_id);
  const domain = bareDomain(f?.domain);
  if (domain) q = q.eq('domain', domain);
  if (Number.isFinite(Number(f?.score_min)) && f?.score_min !== null && f?.score_min !== '') q = q.gte('score', Number(f.score_min));
  if (Number.isFinite(Number(f?.score_max)) && f?.score_max !== null && f?.score_max !== '') q = q.lte('score', Number(f.score_max));
  if (['run', 'search', 'import'].includes(f?.source)) q = q.eq('source', f.source);
  if (f?.stale_days && Number(f.stale_days) > 0) {
    const cutoff = new Date(Date.now() - Number(f.stale_days) * 86400_000).toISOString();
    q = q.or(`email_checked_at.is.null,email_checked_at.lt.${cutoff}`);
  }

  return q;
}

export async function queryContacts(db: Db, userId: string, body: any) {
  const pageSize = Math.max(1, Math.min(500, num(body?.page_size, 50)));
  const page = Math.max(0, Math.floor(num(body?.page, 0)));
  const sortKey = SORTABLE[str(body?.sort?.field, 20)] ?? 'updated_at';
  const asc = body?.sort?.dir === 'asc';

  let q = contactsFilter(db, userId, body?.filters ?? {}, CONTACT_COLUMNS, { count: true });
  // The id tiebreak is what keeps pages from repeating or skipping rows that
  // share a sort value.
  q = q.order(sortKey, { ascending: asc, nullsFirst: false }).order('id', { ascending: true });
  const { data, error, count } = await q.range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw error;
  return { ok: true, contacts: data ?? [], total: count ?? 0, page, page_size: pageSize };
}

export async function getContact(db: Db, userId: string, body: any) {
  if (!isUuid(body?.id)) return { ok: false, error: 'bad_id' };
  const { data: contact, error } = await db
    .from('lead_contacts')
    .select('*')
    .eq('user_id', userId)
    .eq('id', body.id)
    .maybeSingle();
  if (error) throw error;
  if (!contact) return { ok: false, error: 'not_found' };

  const [company, lists, row] = await Promise.all([
    contact.company_id
      ? db.from('lead_companies').select('*').eq('user_id', userId).eq('id', contact.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from('lead_list_members').select('list_id, lead_lists(id, name)').eq('user_id', userId).eq('contact_id', contact.id),
    contact.last_row_id
      ? db.from('lead_rows').select('id, run_id, email_provider, phone_provider, current_provider, updated_at, extra')
          .eq('user_id', userId).eq('id', contact.last_row_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    ok: true,
    contact,
    company: company.data ?? null,
    lists: (lists.data ?? []).map((m: any) => m.lead_lists).filter(Boolean),
    last_row: row.data ?? null,
  };
}

export async function updateContacts(db: Db, userId: string, body: any) {
  const ids = uuids(body?.ids, 1000);
  if (!ids.length) return { ok: false, error: 'no_contacts' };
  const p = body?.patch ?? {};
  const set: Record<string, unknown> = {};

  if (p.status !== undefined) {
    if (!LEAD_STATUSES.includes(p.status)) return { ok: false, error: 'bad_status' };
    set.status = p.status;
  }
  // Notes and custom fields are per-record; refuse them on a bulk edit rather
  // than overwrite a hundred people's notes with one.
  if (p.notes !== undefined) {
    if (ids.length !== 1) return { ok: false, error: 'notes_single_only' };
    set.notes = str(p.notes, 5000) || null;
  }
  if (p.custom !== undefined) {
    if (ids.length !== 1) return { ok: false, error: 'custom_single_only' };
    const c: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.custom ?? {}).slice(0, 30)) {
      const key = str(k, 40);
      if (key) c[key] = str(v, 500);
    }
    set.custom = c;
  }

  const add = strs(p.add_tags, 20, 40).map((t) => t.toLowerCase());
  const remove = strs(p.remove_tags, 20, 40).map((t) => t.toLowerCase());

  if (Object.keys(set).length) {
    for (const b of batches(ids)) {
      const { error } = await db.from('lead_contacts').update(set).eq('user_id', userId).in('id', b);
      if (error) throw error;
    }
  }

  if (add.length || remove.length) {
    const rows = await inBatches<any>(ids, (b) => db.from('lead_contacts').select('id, tags').eq('user_id', userId).in('id', b));
    for (const r of rows) {
      const next = [...new Set([...(r.tags ?? []), ...add])].filter((t) => !remove.includes(t));
      await db.from('lead_contacts').update({ tags: next }).eq('user_id', userId).eq('id', r.id);
    }
  }

  return { ok: true, updated: ids.length };
}

export async function deleteContacts(db: Db, userId: string, body: any) {
  const ids = uuids(body?.ids, 1000);
  if (!ids.length) return { ok: false, error: 'no_contacts' };
  const gone = await inBatches<any>(ids, (b) => db.from('lead_contacts').delete().eq('user_id', userId).in('id', b).select('id'));
  return { ok: true, deleted: gone.length };
}

/**
 * Groups of contacts that look like the same person: same address, same
 * profile URL, or same name at the same domain.
 */
export async function findDuplicates(db: Db, userId: string) {
  const data = await allRows<any>(
    () => db
      .from('lead_contacts')
      .select('id, person_name, title, company_name, domain, email, email_status, email_norm, linkedin_norm, name_norm, updated_at')
      .eq('user_id', userId)
      .order('id'),
    20000,
  );

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const c of data ?? []) parent.set(c.id, c.id);

  const byKey = new Map<string, string>();
  for (const c of data ?? []) {
    const keys = [
      c.email_norm && `e:${c.email_norm}`,
      c.linkedin_norm && `l:${c.linkedin_norm}`,
      c.name_norm && c.domain && `n:${c.name_norm}@${c.domain}`,
    ].filter(Boolean) as string[];
    for (const k of keys) {
      const seen = byKey.get(k);
      if (seen) union(c.id, seen);
      else byKey.set(k, c.id);
    }
  }

  const groups = new Map<string, any[]>();
  for (const c of data ?? []) {
    const root = find(c.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(c);
  }
  const out = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.map(({ email_norm: _e, linkedin_norm: _l, name_norm: _n, ...rest }) => rest));
  return { ok: true, groups: out.slice(0, 200), total_groups: out.length };
}

export async function mergeContacts(db: Db, userId: string, body: any) {
  if (!isUuid(body?.keep)) return { ok: false, error: 'bad_keep' };
  const drop = uuids(body?.drop, 50).filter((id) => id !== body.keep);
  if (!drop.length) return { ok: false, error: 'nothing_to_merge' };
  const { data, error } = await db.rpc('lead_contacts_merge', { p_user: userId, p_keep: body.keep, p_drop: drop });
  if (error) {
    if (String(error.message).includes('keep_not_found')) return { ok: false, error: 'not_found' };
    throw error;
  }
  const rules = await rulesFor(db, userId);
  await rescore(db, userId, rules, [body.keep]);
  return { ok: true, merged: Number(data ?? 0) };
}

// ===========================================================================
// Companies
// ===========================================================================

const COMPANY_SORT: Record<string, string> = {
  updated: 'updated_at',
  name: 'name',
  contacts: 'contacts',
  verified: 'verified_emails',
  score: 'best_score',
};

export async function queryCompanies(db: Db, userId: string, body: any) {
  const f = body?.filters ?? {};
  const pageSize = Math.max(1, Math.min(200, num(body?.page_size, 50)));
  const page = Math.max(0, Math.floor(num(body?.page, 0)));
  const sortKey = COMPANY_SORT[str(body?.sort?.field, 20)] ?? 'updated_at';
  const asc = body?.sort?.dir === 'asc';

  let q = db
    .from('lead_companies_summary')
    .select('id, domain, name, logo_url, data, enriched_at, tags, contacts, verified_emails, missing_emails, strong_fits, best_score, updated_at', { count: 'exact' })
    .eq('user_id', userId);

  const term = safeTerm(str(f.q, 100));
  if (term) q = q.or(`name.ilike.*${term}*,domain.ilike.*${term}*`);
  if (f.enriched === true) q = q.not('enriched_at', 'is', null);
  if (f.enriched === false) q = q.is('enriched_at', null);
  if (f.missing_contacts === true) q = q.eq('contacts', 0);
  if (f.missing_emails === true) q = q.gt('missing_emails', 0);
  const tags = strs(f.tags, 20, 40);
  if (tags.length) q = q.contains('tags', tags);
  if (isUuid(f.list_id)) {
    // Target-account lists are filtered by id: the summary is a view, and an
    // embedded join through it is not something PostgREST can be relied on for.
    // Capped at the first 1000 members, which is noted in docs/LEADS_UPGRADE.md.
    const { data: members } = await db
      .from('lead_list_members')
      .select('company_id')
      .eq('user_id', userId)
      .eq('list_id', f.list_id)
      .not('company_id', 'is', null)
      .order('added_at')
      .limit(1000);
    const ids = (members ?? []).map((m: any) => m.company_id);
    q = q.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  }

  q = q.order(sortKey, { ascending: asc, nullsFirst: false }).order('id', { ascending: true });
  const { data, error, count } = await q.range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw error;
  return { ok: true, companies: data ?? [], total: count ?? 0, page, page_size: pageSize };
}

export async function getCompany(db: Db, userId: string, body: any) {
  if (!isUuid(body?.id)) return { ok: false, error: 'bad_id' };
  const { data: company, error } = await db
    .from('lead_companies_summary')
    .select('*')
    .eq('user_id', userId)
    .eq('id', body.id)
    .maybeSingle();
  if (error) throw error;
  if (!company) return { ok: false, error: 'not_found' };

  const [people, lists] = await Promise.all([
    db.from('lead_contacts')
      .select('id, person_name, title, email, email_status, phone, score, score_label, status, linkedin_url')
      .eq('user_id', userId).eq('company_id', company.id)
      .order('score', { ascending: false, nullsFirst: false }).order('id').limit(200),
    db.from('lead_list_members').select('list_id, lead_lists(id, name)').eq('user_id', userId).eq('company_id', company.id),
  ]);

  return {
    ok: true,
    company,
    people: people.data ?? [],
    lists: (lists.data ?? []).map((m: any) => m.lead_lists).filter(Boolean),
  };
}

export async function updateCompanies(db: Db, userId: string, body: any) {
  const ids = uuids(body?.ids, 1000);
  if (!ids.length) return { ok: false, error: 'no_companies' };
  const p = body?.patch ?? {};
  if (p.notes !== undefined) {
    if (ids.length !== 1) return { ok: false, error: 'notes_single_only' };
    const { error } = await db.from('lead_companies').update({ notes: str(p.notes, 5000) || null })
      .eq('user_id', userId).eq('id', ids[0]);
    if (error) throw error;
  }
  const add = strs(p.add_tags, 20, 40).map((t) => t.toLowerCase());
  const remove = strs(p.remove_tags, 20, 40).map((t) => t.toLowerCase());
  if (add.length || remove.length) {
    const rows = await inBatches<any>(ids, (b) => db.from('lead_companies').select('id, tags').eq('user_id', userId).in('id', b));
    for (const r of rows) {
      const next = [...new Set([...(r.tags ?? []), ...add])].filter((t) => !remove.includes(t));
      await db.from('lead_companies').update({ tags: next }).eq('user_id', userId).eq('id', r.id);
    }
  }
  return { ok: true, updated: ids.length };
}

// ===========================================================================
// Lists
// ===========================================================================

async function ownsList(db: Db, userId: string, listId: string, kind?: string): Promise<boolean> {
  let q = db.from('lead_lists').select('id').eq('user_id', userId).eq('id', listId);
  if (kind) q = q.eq('kind', kind);
  const { data } = await q.maybeSingle();
  return Boolean(data);
}

async function addToList(db: Db, userId: string, listId: string, ids: string[], kind: 'people' | 'companies') {
  // Only the caller's own records, re-checked here rather than trusted.
  const table = kind === 'people' ? 'lead_contacts' : 'lead_companies';
  const owned = await inBatches<any>(ids, (b) => db.from(table).select('id').eq('user_id', userId).in('id', b));
  const rows = owned.map((r: any) => ({
    user_id: userId,
    list_id: listId,
    contact_id: kind === 'people' ? r.id : null,
    company_id: kind === 'companies' ? r.id : null,
  }));
  let added = 0;
  // Inserted one at a time with conflicts ignored: the unique indexes are
  // partial, which PostgREST's on_conflict cannot name.
  for (const r of rows) {
    const { error } = await db.from('lead_list_members').insert(r);
    if (!error) added++;
    else if (!String(error.code).startsWith('23505')) throw error;
  }
  await db.from('lead_lists').update({ updated_at: new Date().toISOString() }).eq('id', listId).eq('user_id', userId);
  return added;
}

export async function listLists(db: Db, userId: string) {
  const { data, error } = await db
    .from('lead_lists')
    .select('id, name, kind, description, created_at, updated_at, lead_list_members(count)')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return {
    ok: true,
    lists: (data ?? []).map((l: any) => ({
      ...l,
      members: Number(l.lead_list_members?.[0]?.count ?? 0),
      lead_list_members: undefined,
    })),
  };
}

export async function createList(db: Db, userId: string, body: any) {
  const name = str(body?.name, 80);
  const kind = body?.kind === 'companies' ? 'companies' : 'people';
  if (!name) return { ok: false, error: 'name_required' };
  const { data, error } = await db
    .from('lead_lists')
    .insert({ user_id: userId, name, kind, description: str(body?.description, 300) || null })
    .select('id, name, kind')
    .single();
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'name_taken' };
    throw error;
  }
  return { ok: true, list: data };
}

export async function updateList(db: Db, userId: string, body: any) {
  if (!isUuid(body?.id)) return { ok: false, error: 'bad_id' };
  const set: Record<string, unknown> = {};
  if (body?.name !== undefined) {
    const name = str(body.name, 80);
    if (!name) return { ok: false, error: 'name_required' };
    set.name = name;
  }
  if (body?.description !== undefined) set.description = str(body.description, 300) || null;
  const { data, error } = await db.from('lead_lists').update(set).eq('user_id', userId).eq('id', body.id).select('id').maybeSingle();
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'name_taken' };
    throw error;
  }
  return data ? { ok: true } : { ok: false, error: 'not_found' };
}

export async function deleteList(db: Db, userId: string, body: any) {
  if (!isUuid(body?.id)) return { ok: false, error: 'bad_id' };
  // Deletes the list and its memberships, never the leads in it.
  const { data, error } = await db.from('lead_lists').delete().eq('user_id', userId).eq('id', body.id).select('id');
  if (error) throw error;
  return (data ?? []).length ? { ok: true } : { ok: false, error: 'not_found' };
}

export async function listMembers(db: Db, userId: string, body: any, remove: boolean) {
  if (!isUuid(body?.list_id)) return { ok: false, error: 'bad_list' };
  const { data: list } = await db.from('lead_lists').select('id, kind').eq('user_id', userId).eq('id', body.list_id).maybeSingle();
  if (!list) return { ok: false, error: 'list_not_found' };

  let ids = uuids(body?.ids, 5000);
  // "Everything matching these filters", resolved server-side so a bulk add is
  // exactly what the view shows rather than only the loaded page.
  if (!ids.length && body?.filters && list.kind === 'people' && !remove) {
    const rows = await allRows<any>(() => contactsFilter(db, userId, body.filters, 'id').order('id'), 5000);
    ids = rows.map((r: any) => r.id);
  }
  if (!ids.length) return { ok: false, error: 'nothing_selected' };

  if (remove) {
    const col = list.kind === 'people' ? 'contact_id' : 'company_id';
    const removed = await inBatches<any>(ids, (b) => db.from('lead_list_members').delete()
      .eq('user_id', userId).eq('list_id', list.id).in(col, b).select('id'));
    return { ok: true, removed: removed.length };
  }
  const added = await addToList(db, userId, list.id, ids, list.kind);
  return { ok: true, added, already: ids.length - added };
}

// ===========================================================================
// Saved searches
// ===========================================================================

export async function listSavedSearches(db: Db, userId: string, body: any) {
  let q = db.from('lead_saved_searches').select('id, name, kind, filters, last_total, last_run_at, updated_at')
    .eq('user_id', userId).order('updated_at', { ascending: false });
  if (['people_search', 'people_view', 'companies_view'].includes(body?.kind)) q = q.eq('kind', body.kind);
  const { data, error } = await q;
  if (error) throw error;
  return { ok: true, searches: data ?? [] };
}

export async function saveSearch(db: Db, userId: string, body: any) {
  const name = str(body?.name, 80);
  const kind = ['people_search', 'people_view', 'companies_view'].includes(body?.kind) ? body.kind : null;
  if (!name) return { ok: false, error: 'name_required' };
  if (!kind) return { ok: false, error: 'bad_kind' };
  const filters = kind === 'people_search' ? cleanPeopleFilters(body?.filters) : (body?.filters ?? {});
  if (JSON.stringify(filters).length > 20000) return { ok: false, error: 'filters_too_large' };

  const row = {
    user_id: userId, name, kind, filters,
    last_total: Number.isFinite(Number(body?.last_total)) ? Number(body.last_total) : null,
  };
  const res = isUuid(body?.id)
    ? await db.from('lead_saved_searches').update(row).eq('user_id', userId).eq('id', body.id).select('id').maybeSingle()
    : await db.from('lead_saved_searches').insert(row).select('id').single();
  if (res.error) {
    if (res.error.code === '23505') return { ok: false, error: 'name_taken' };
    throw res.error;
  }
  if (!res.data) return { ok: false, error: 'not_found' };
  return { ok: true, id: res.data.id };
}

export async function deleteSavedSearch(db: Db, userId: string, body: any) {
  if (!isUuid(body?.id)) return { ok: false, error: 'bad_id' };
  const { error } = await db.from('lead_saved_searches').delete().eq('user_id', userId).eq('id', body.id);
  if (error) throw error;
  return { ok: true };
}

// ===========================================================================
// Scoring
// ===========================================================================

export async function rulesFor(db: Db, userId: string): Promise<ScoringRules> {
  const { data } = await db.from('lead_scoring').select('rules').eq('user_id', userId).maybeSingle();
  if (data?.rules) return cleanRules(data.rules);
  // No saved rules: seed from the approved ICP's primary segment.
  const { data: icp } = await db
    .from('lead_icps')
    .select('json')
    .eq('user_id', userId)
    .order('approved_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const segs = Array.isArray(icp?.json?.segments) ? icp.json.segments : [];
  const seg = segs[Number(icp?.json?.primarySegment ?? 0)] ?? segs[0] ?? null;
  return rulesFromSegment(seg);
}

export async function applyScore(db: Db, contact: any, rules: ScoringRules) {
  const r = scoreLead(contact, rules);
  await db
    .from('lead_contacts')
    .update({ score: r.score, score_label: r.label, score_reasons: r.reasons, scored_at: new Date().toISOString() })
    .eq('id', contact.id)
    .eq('user_id', contact.user_id);
  return r;
}

/** Rescores the workspace (or just `only`), in pages. */
async function rescore(db: Db, userId: string, rules: ScoringRules, only?: string[]) {
  let done = 0;
  for (let page = 0; page < 40; page++) {
    let q = db
      .from('lead_contacts')
      .select('id, user_id, title, location, email_status, phone, attributes, company:lead_companies(data)')
      .eq('user_id', userId)
      .order('id')
      .range(page * 500, page * 500 + 499);
    if (only) q = q.in('id', only);
    const { data, error } = await q;
    if (error) throw error;
    for (const c of data ?? []) {
      await applyScore(db, { ...c, company: c.company?.data ?? {} }, rules);
      done++;
    }
    if (!data || data.length < 500) break;
  }
  return done;
}

export async function getScoring(db: Db, userId: string) {
  const { data } = await db.from('lead_scoring').select('rules, updated_at').eq('user_id', userId).maybeSingle();
  const rules = await rulesFor(db, userId);
  return { ok: true, rules, saved: Boolean(data), updated_at: data?.updated_at ?? null };
}

export async function putScoring(db: Db, userId: string, body: any) {
  const rules = cleanRules(body?.rules);
  const { error } = await db.from('lead_scoring').upsert({ user_id: userId, rules, updated_at: new Date().toISOString() });
  if (error) throw error;
  const rescored = await rescore(db, userId, rules);
  return { ok: true, rules, rescored };
}

/** Called by the worker after a row merges into a contact. */
export async function scoreMerged(db: Db, contact: any) {
  if (!contact?.id || !contact?.user_id) return;
  const rules = await rulesFor(db, contact.user_id);
  await applyScore(db, contact, rules);
}

// ===========================================================================
// Enrichment of saved leads: a priced run built from the database
// ===========================================================================

export type EnrichAction = 'verify' | 'find_email' | 'phone' | 'company';

const ACTION_MODE: Record<EnrichAction, string> = {
  verify: 'verify_only',
  find_email: 'verify_refind',
  phone: 'phone_only',
  company: 'enrich_only',
};

const STALE_EMAIL_DAYS = 30;
const STALE_COMPANY_DAYS = 90;

/**
 * Which of the selected leads this action would actually work, and why the
 * others are skipped. Shared by the estimate and the start, so the price shown
 * is the price for exactly the rows that will run.
 */
async function enrichPlan(db: Db, userId: string, body: any) {
  // `enrich`, not `action`: `action` is the route this request arrived on.
  const action = str(body?.enrich, 20) as EnrichAction;
  if (!ACTION_MODE[action]) return { error: 'bad_action' as const };
  const refresh = body?.refresh_stale === true;

  let ids = uuids(body?.contact_ids, 2000);
  if (!ids.length && body?.filters) {
    const found = await allRows<any>(() => contactsFilter(db, userId, body.filters, 'id').order('id'), 2000);
    ids = found.map((r: any) => r.id);
  }
  const companyIds = uuids(body?.company_ids, 2000);

  const skipped = { fresh: 0, no_input: 0, already_has: 0 };
  const rows: any[] = [];
  const now = Date.now();
  const olderThan = (iso: string | null, days: number) => !iso || now - Date.parse(iso) > days * 86400_000;

  if (action === 'company') {
    // Companies directly, or the companies of the selected people.
    let cids = companyIds;
    if (!cids.length && ids.length) {
      const cs = await inBatches<any>(ids, (b) => db.from('lead_contacts').select('company_id').eq('user_id', userId).in('id', b));
      cids = [...new Set(cs.map((c: any) => c.company_id).filter(Boolean))] as string[];
    }
    if (!cids.length) return { error: 'nothing_selected' as const };
    const companies = await inBatches<any>(cids, (b) =>
      db.from('lead_companies').select('id, domain, name, enriched_at').eq('user_id', userId).in('id', b));
    for (const c of companies) {
      if (!refresh && !olderThan(c.enriched_at, STALE_COMPANY_DAYS)) { skipped.fresh++; continue; }
      rows.push({ company_name: c.name, domain: c.domain, extra: { company_id: c.id } });
    }
    return { action, mode: ACTION_MODE[action], rows, skipped, selected: companies.length };
  }

  if (!ids.length) return { error: 'nothing_selected' as const };
  const contacts = await inBatches<any>(ids, (b) => db
    .from('lead_contacts')
    .select('id, person_name, title, linkedin_url, company_name, domain, email, email_status, email_checked_at, phone, attributes')
    .eq('user_id', userId)
    .in('id', b));

  for (const c of contacts ?? []) {
    const base = {
      person_name: c.person_name, title: c.title, linkedin_url: c.linkedin_url,
      company_name: c.company_name, domain: c.domain,
      extra: { contact_id: c.id, ...(c.attributes?.leadsforge_id ? { leadsforge_id: c.attributes.leadsforge_id } : {}) },
    };
    if (action === 'verify') {
      if (!c.email) { skipped.no_input++; continue; }
      if (!refresh && c.email_checked_at && !olderThan(c.email_checked_at, STALE_EMAIL_DAYS)) { skipped.fresh++; continue; }
      rows.push({ ...base, email: c.email });
    } else if (action === 'find_email') {
      if (c.email_status === 'verified' && !refresh && !olderThan(c.email_checked_at, STALE_EMAIL_DAYS)) { skipped.already_has++; continue; }
      if (!c.email && !(c.person_name && c.domain) && !c.linkedin_url && !c.attributes?.leadsforge_id) { skipped.no_input++; continue; }
      rows.push({ ...base, email: c.email });
    } else if (action === 'phone') {
      if (c.phone) { skipped.already_has++; continue; }
      // Same rule as the worker's phone step: a name or a profile URL. An address
      // alone is not enough for it to look anyone up.
      if (!c.linkedin_url && !c.person_name) { skipped.no_input++; continue; }
      rows.push({ ...base, email: c.email });
    }
  }
  return { action, mode: ACTION_MODE[action], rows, skipped, selected: (contacts ?? []).length };
}

export async function enrichEstimate(db: Db, userId: string, body: any) {
  const plan = await enrichPlan(db, userId, body);
  if ('error' in plan) return { ok: false, error: plan.error };

  const { data: wallet } = await db.from('wallet').select('balance, reserved').eq('user_id', userId).maybeSingle();
  const available = Math.max(0, num(wallet?.balance) - num(wallet?.reserved));

  if (!plan.rows.length) {
    return { ok: true, eligible: 0, selected: plan.selected, skipped: plan.skipped, estimate: null, available };
  }
  const { data: est, error } = await db.rpc('estimate_lead_run', {
    p_target: plan.rows.length, p_mode: plan.mode, p_phone: plan.mode === 'phone_only', p_hit_rate: null, p_user: userId,
  });
  if (error) throw error;
  return { ok: true, eligible: plan.rows.length, selected: plan.selected, skipped: plan.skipped, estimate: est, available };
}

export async function enrichStart(db: Db, ctx: WorkspaceCtx, userId: string, body: any) {
  // A double click or a retried request is the same request, so it gets the
  // same run rather than a second charge.
  const requestId = str(body?.request_id, 64);
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(requestId)) return { ok: false, error: 'request_id_required' };
  const prior = await priorRequest(db, userId, requestId);
  if (prior) return { ok: true, run: prior, replayed: true };

  const plan = await enrichPlan(db, userId, body);
  if ('error' in plan) return { ok: false, error: plan.error };
  if (!plan.rows.length) return { ok: false, error: 'nothing_to_do', skipped: plan.skipped };

  return runFromRows(db, ctx, userId, plan.action, plan.mode, plan.rows, requestId, plan.skipped);
}

/**
 * Creates a held clean run, writes its rows, then releases it to the worker.
 *
 * Held while the rows are written so the worker cannot find an empty run and
 * finish it. If the rows cannot be written nothing has been charged - no chunk
 * has reserved - and the run is marked failed.
 */
export async function runFromRows(
  db: Db,
  ctx: WorkspaceCtx,
  userId: string,
  action: EnrichAction,
  mode: string,
  rows: any[],
  requestId: string,
  skipped?: Record<string, number>,
) {
  const label: Record<EnrichAction, string> = {
    verify: 'Verify emails', find_email: 'Find emails', phone: 'Find phones', company: 'Company details',
  };
  const started = await ctx.createRun(userId, {
    kind: 'clean',
    target: rows.length,
    mode,
    phone: mode === 'phone_only',
    icpId: null,
    name: `${label[action]} · ${rows.length} ${action === 'company' ? 'companies' : 'leads'}`,
    hold: 'importing',
    extraOptions: { request_id: requestId, source: 'database', action },
  });
  if (!started?.ok) return started;
  // Lost a race with the same request: the other one is writing the rows.
  if (started.replayed) return started;

  const runId = started.run.id;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r) => ({
      user_id: userId,
      run_id: runId,
      company_name: r.company_name ?? null,
      domain: r.domain ?? null,
      person_name: r.person_name ?? null,
      title: r.title ?? null,
      linkedin_url: r.linkedin_url ?? null,
      email: r.email ?? null,
      email_status: r.email ? 'unchecked' : 'not_found',
      extra: r.extra ?? {},
      state: 'queued',
    }));
    const { error } = await db.from('lead_rows').insert(batch);
    if (error) {
      await db.from('lead_runs').update({ status: 'failed', last_error: 'rows_not_written', finished_at: new Date().toISOString() })
        .eq('id', runId);
      throw error;
    }
  }

  await db.from('lead_runs').update({ status: 'queued', pause_reason: null }).eq('id', runId).eq('status', 'paused');
  ctx.kickWorker(runId);
  return { ok: true, run: { ...started.run, status: 'queued' }, estimate: started.estimate, skipped: skipped ?? {} };
}

/** A prior run started under this request id, if there is one. */
export async function priorRequest(db: Db, userId: string, requestId: string) {
  const { data } = await db
    .from('lead_runs')
    .select('*')
    .eq('user_id', userId)
    .eq('options->>request_id', requestId)
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

// ===========================================================================
// Usage
// ===========================================================================

/** Credits by run and by kind, for the usage view. Provider cost is internal and is not returned. */
export async function usageSummary(db: Db, userId: string, body: any) {
  const days = Math.max(1, Math.min(365, num(body?.days, 30)));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: runs, error } = await db
    .from('lead_runs')
    .select('id, name, kind, mode, status, target, est_credits, max_credits, charged_credits, created_at, finished_at, options')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;

  const byType: Record<string, { runs: number; credits: number }> = {};
  let total = 0;
  for (const r of runs ?? []) {
    const type = r.kind === 'find' ? 'Find by profile' : r.options?.action ? `Enrich: ${r.options.action}` : r.mode ? `Clean: ${r.mode}` : r.kind;
    byType[type] = byType[type] ?? { runs: 0, credits: 0 };
    byType[type].runs++;
    byType[type].credits += num(r.charged_credits);
    total += num(r.charged_credits);
  }
  return {
    ok: true,
    days,
    total_credits: Math.round(total * 1e6) / 1e6,
    by_type: Object.entries(byType).map(([type, v]) => ({ type, ...v, credits: Math.round(v.credits * 1e6) / 1e6 })),
    runs: (runs ?? []).map(({ options: _o, ...r }: any) => r),
  };
}
