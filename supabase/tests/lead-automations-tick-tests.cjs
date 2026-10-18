// Runs the automations tick end to end against an in-memory database.
//
//   node supabase/tests/lead-automations-tick-tests.cjs
//
// automations.ts, workspace.ts and their imports are compiled as written. The
// database is a small fake of the PostgREST builder (only what these paths
// call), the provider is a stubbed fetch, and createRun is a stand-in with the
// same contract as index.ts: price, refuse a maximum over the ceiling, insert.
//
// What it holds the tick to:
//   - a run over the per-run cap is refused and nothing is inserted;
//   - a run over what is left of the month is refused, counting runs still
//     working at their maximum and ignoring last month;
//   - an automation with no caps never starts a run;
//   - a run that fits is created with the automation's id and a ceiling no
//     higher than either cap;
//   - the same slot never starts a second run, and an enrichment waits for its
//     previous run instead of paying for the same people twice;
//   - a refresh saves only people not already held and not opted out;
//   - a deleted saved search pauses the automation; three failures pause it.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'supabase', 'functions', 'leads');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-automations-tick-test');
const MODULES = ['automations.ts', 'automation-rules.ts', 'workspace.ts', 'endpoints.ts', 'scoring.ts', 'treg.ts', 'registry.ts'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const m of MODULES) {
  const src = fs.readFileSync(path.join(SRC, m), 'utf8').replace(/from '(\.\/[^']+)\.ts'/g, "from '$1.js'");
  fs.writeFileSync(path.join(OUT, m), src);
}
fs.writeFileSync(path.join(OUT, 'deno-shim.d.ts'), 'declare const Deno: { env: { get(key: string): string | undefined } };\n');
fs.writeFileSync(path.join(OUT, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'preserve', moduleResolution: 'bundler', strict: true, skipLibCheck: true, noEmitOnError: true, outDir: path.join(OUT, 'dist'), types: [] },
  files: [...MODULES, 'deno-shim.d.ts'],
}));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(OUT, 'tsconfig.json')], { stdio: 'pipe', cwd: ROOT });
} catch (e) {
  console.error(String(e.stdout || e.message).split('\n').slice(0, 30).join('\n'));
  process.exit(1);
}
globalThis.Deno = { env: { get: () => undefined } };
const A = require(path.join(OUT, 'dist', 'automations.js'));
const T = require(path.join(OUT, 'dist', 'treg.js'));

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
};

// ---------------------------------------------------------------------------
// The fake database
// ---------------------------------------------------------------------------

let seq = 0;
const uuid = () => {
  const h = (++seq).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
};
const nowIso = () => new Date().toISOString();

function makeDb() {
  const tables = {};
  const t = (name) => (tables[name] = tables[name] ?? []);
  const rpcs = {};
  const get = (row, col) => {
    const m = col.match(/^(\w+)->>(\w+)$/);
    if (m) {
      const v = row[m[1]]?.[m[2]];
      return v === undefined || v === null ? null : String(v);
    }
    return row[col];
  };

  class Q {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.op = 'select';
      this.ret = false;
      this.cnt = false;
      this.lim = null;
      this.rng = null;
      this.one = null;
    }
    select(_cols, opts) {
      if (this.op === 'select') this.cnt = Boolean(opts?.count);
      else this.ret = true;
      return this;
    }
    insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
    update(set) { this.op = 'update'; this.payload = set; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.filters.push((r) => get(r, c) === v || (v !== null && String(get(r, c)) === String(v) && get(r, c) !== null)); return this; }
    in(c, vs) { const s = new Set(vs.map(String)); this.filters.push((r) => get(r, c) !== null && get(r, c) !== undefined && s.has(String(get(r, c)))); return this; }
    is(c, v) { this.filters.push((r) => (get(r, c) ?? null) === v); return this; }
    not(c, op, v) { if (op !== 'is') throw new Error('fake: not.' + op); this.filters.push((r) => (get(r, c) ?? null) !== v); return this; }
    contains(c, vs) { this.filters.push((r) => vs.every((x) => (r[c] ?? []).includes(x))); return this; }
    gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
    lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
    or() { throw new Error('fake: or() is not supported'); }
    order() { return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    single() { this.one = 'single'; return this; }
    run() {
      const rows = t(this.table);
      const match = (r) => this.filters.every((f) => f(r));
      let out;
      if (this.op === 'insert') {
        const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r) => ({
          id: uuid(), created_at: nowIso(), updated_at: nowIso(), ...defaults(this.table), ...structuredClone(r),
        }));
        for (const r of list) {
          const err = unique(this.table, r, rows);
          if (err) return { data: null, error: err };
        }
        rows.push(...list);
        out = list;
      } else if (this.op === 'update') {
        out = rows.filter(match);
        for (const r of out) Object.assign(r, structuredClone(this.payload), { updated_at: nowIso() });
      } else if (this.op === 'delete') {
        out = rows.filter(match);
        tables[this.table] = rows.filter((r) => !match(r));
      } else {
        out = rows.filter(match);
      }
      const count = out.length;
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim !== null) out = out.slice(0, this.lim);
      out = out.map((r) => structuredClone(r));
      if (this.op !== 'select' && !this.ret) return { data: null, error: null };
      if (this.one) {
        if (out.length > 1) return { data: null, error: { message: 'multiple rows' } };
        if (!out.length && this.one === 'single') return { data: null, error: { message: 'no rows' } };
        return { data: out[0] ?? null, error: null };
      }
      return { data: out, error: null, count: this.cnt ? count : undefined };
    }
    then(res, rej) {
      try { return Promise.resolve(this.run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); }
    }
  }

  const defaults = (table) => ({
    lead_automation_runs: { started_at: nowIso(), people_found: 0, people_added: 0, people_skipped: 0, contacts_matched: 0, contacts_tagged: 0, credits_charged: 0, detail: {} },
    lead_contacts: { tags: [], status: 'new', attributes: {} },
    lead_runs: { charged_credits: 0, options: {} },
  }[table] ?? {});

  const unique = (table, r, rows) => {
    if (table === 'lead_runs' && r.options?.request_id) {
      if (rows.some((x) => x.user_id === r.user_id && x.options?.request_id === r.options.request_id)) return { code: '23505', message: 'duplicate request' };
    }
    if (table === 'lead_list_members') {
      if (rows.some((x) => x.list_id === r.list_id && x.contact_id === r.contact_id)) return { code: '23505', message: 'duplicate member' };
    }
    return null;
  };

  return {
    tables,
    t,
    rpcs,
    from: (table) => new Q(table),
    rpc: async (name, args) => {
      if (!rpcs[name]) throw new Error('fake: no rpc ' + name);
      try { return { data: await rpcs[name](args), error: null }; } catch (e) { return { data: null, error: { message: e.message } }; }
    },
  };
}

// The function's RPCs, with the same semantics as the SQL.
const PRICE_PER_ROW = 0.5;
function installRpcs(db) {
  db.rpcs.estimate_lead_run = ({ p_target, p_user }) => {
    if (!p_user) return { ok: false, error: 'unauthenticated' };
    return { ok: true, min_credits: 0, expected_credits: p_target * PRICE_PER_ROW * 0.7, max_credits: p_target * PRICE_PER_ROW };
  };
  db.rpcs.lead_automation_month_committed = ({ p_automation, p_since }) =>
    db.t('lead_runs')
      .filter((r) => r.options?.automation_id === p_automation && r.created_at >= p_since)
      .reduce((s, r) => s + (['done', 'failed', 'cancelled'].includes(r.status) ? r.charged_credits : Math.max(r.max_credits ?? 0, r.charged_credits)), 0);
  db.rpcs.lead_automations_claim_due = ({ p_limit, p_seconds }) => {
    const now = nowIso();
    const due = db.t('lead_automations')
      .filter((a) => a.status === 'active' && a.next_run_at && a.next_run_at <= now && (!a.lease_until || a.lease_until < now))
      .slice(0, p_limit);
    for (const a of due) a.lease_until = new Date(Date.now() + p_seconds * 1000).toISOString();
    return due.map((a) => structuredClone(a));
  };
  db.rpcs.lead_contact_merge = ({ p_user, p_fields }) => {
    const name = String(p_fields.person_name).trim().toLowerCase().replace(/\s+/g, ' ');
    const found = db.t('lead_contacts').find((c) => c.user_id === p_user && c.name_norm === name && c.domain === p_fields.domain);
    if (found) return structuredClone(found);
    const c = { id: uuid(), user_id: p_user, ...p_fields, name_norm: name, tags: [], status: 'new', created_at: nowIso() };
    db.t('lead_contacts').push(c);
    return structuredClone(c);
  };
}

// createRun with index.ts's contract: price, refuse over the ceiling or the wallet, insert.
function makeCtx(db, calls, opts = {}) {
  return {
    tregCfg: async () => T.tregConfig({ user: 'search' }, 'test-token'),
    kickWorker: () => {},
    createRun: async (userId, o) => {
      calls.push(o);
      if (opts.throwFor && o.name && opts.throwFor()) throw new Error('boom');
      const est = await db.rpcs.estimate_lead_run({ p_target: o.target, p_mode: o.mode, p_user: userId });
      if (o.ceilingCredits !== undefined && !(est.max_credits <= o.ceilingCredits)) return { ok: false, error: 'over_cap' };
      const { data: run, error } = await db.from('lead_runs').insert({
        user_id: userId, kind: o.kind, target: o.target, mode: o.mode, name: o.name,
        options: { ...(o.extraOptions ?? {}) }, status: o.hold ? 'paused' : 'queued', pause_reason: o.hold,
        est_credits: est.expected_credits, max_credits: est.max_credits,
      }).select('*').single();
      if (error) throw new Error(error.message);
      return { ok: true, run, estimate: est };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = '0aaaaaaa-0000-4000-8000-000000000001';
const OTHER = '0bbbbbbb-0000-4000-8000-000000000002';

function seed(db) {
  const view = { id: uuid(), user_id: USER, name: 'Everyone', kind: 'people_view', filters: {} };
  const search = { id: uuid(), user_id: USER, name: 'Marketing leaders', kind: 'people_search', filters: { jobTitles: ['CMO'] } };
  db.t('lead_saved_searches').push(view, search);
  for (let i = 0; i < 10; i++) {
    db.t('lead_contacts').push({
      id: uuid(), user_id: USER, person_name: `Person ${i}`, name_norm: `person ${i}`, domain: `co${i}.com`,
      company_name: `Co ${i}`, email: null, email_status: 'not_found', tags: i < 3 ? ['icp'] : [], status: 'new',
      attributes: {}, last_enriched_at: null, created_at: nowIso(),
    });
  }
  // Someone else's contact: never touched.
  db.t('lead_contacts').push({ id: uuid(), user_id: OTHER, person_name: 'Not mine', name_norm: 'not mine', domain: 'other.com', tags: [], attributes: {} });
  db.t('lead_suppressions').push({ id: uuid(), user_id: USER, value: 'blocked.com', kind: 'domain' });
  const list = { id: uuid(), user_id: USER, name: 'New this week', kind: 'people' };
  db.t('lead_lists').push(list);
  return { view, search, list };
}

const past = () => new Date(Date.now() - 60_000).toISOString();
function addAutomation(db, over) {
  const a = {
    id: uuid(), user_id: USER, name: over.name ?? 'auto', status: 'active', pause_reason: null,
    frequency: 'daily', hour: 6, weekday: null, failure_count: 0, lease_until: null, next_run_at: past(),
    max_credits_per_run: 0, max_credits_per_month: 0, created_at: nowIso(), ...over,
  };
  db.t('lead_automations').push(a);
  return a;
}
const lastLog = (db, a) => db.t('lead_automation_runs').filter((r) => r.automation_id === a.id).at(-1);
const autoRuns = (db, a) => db.t('lead_runs').filter((r) => r.options?.automation_id === a.id);
const row = (db, a) => db.t('lead_automations').find((x) => x.id === a.id);

(async () => {
  // Searches never reach the network: a stubbed provider.
  let searchCalls = 0;
  let searchBody = { leads: [] };
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/call/leadsforge.people.search')) throw new Error('unexpected fetch ' + url);
    searchCalls++;
    return new Response(JSON.stringify(searchBody), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // --- 1. over the per-run cap ---------------------------------------------
  {
    const db = makeDb(); installRpcs(db); const { view } = seed(db); const calls = [];
    // 10 eligible contacts * 0.5 = 5 credits max; cap 4.
    const a = addAutomation(db, { kind: 'auto_enrich', config: { saved_search_id: view.id, enrich: 'find_email', max_rows: 100 }, max_credits_per_run: 4, max_credits_per_month: 100 });
    const r = await A.tick(db, makeCtx(db, calls));
    check('1: tick claimed and ran it', r.ok && r.ran === 1, r);
    check('1: refused over the run cap', lastLog(db, a)?.status === 'refused' && lastLog(db, a)?.error === 'over_run_cap', lastLog(db, a));
    check('1: no run inserted', db.t('lead_runs').length === 0);
    check('1: createRun never called', calls.length === 0);
    check('1: estimate recorded', lastLog(db, a)?.credits_estimated_max === 5);
    check('1: refusal message names the cap', /cap of 4 per run/.test(lastLog(db, a)?.detail?.message ?? ''));
    check('1: rescheduled, lease released, still active', row(db, a).next_run_at > nowIso() && row(db, a).lease_until === null && row(db, a).status === 'active');
    check('1: a refusal is not a failure', row(db, a).failure_count === 0 && row(db, a).last_status === 'refused');
  }

  // --- 2. over what is left of the month -------------------------------------
  {
    const db = makeDb(); installRpcs(db); const { view } = seed(db); const calls = [];
    const a = addAutomation(db, { kind: 'auto_enrich', config: { saved_search_id: view.id, enrich: 'find_email' }, max_credits_per_run: 10, max_credits_per_month: 12 });
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    // Charged 8 this month; 50 last month (does not count).
    db.t('lead_runs').push(
      { id: uuid(), user_id: USER, status: 'done', charged_credits: 8, max_credits: 9, options: { automation_id: a.id }, created_at: new Date(monthStart.getTime() + 1000).toISOString() },
      { id: uuid(), user_id: USER, status: 'done', charged_credits: 50, max_credits: 50, options: { automation_id: a.id }, created_at: new Date(monthStart.getTime() - 1000).toISOString() },
    );
    await A.tick(db, makeCtx(db, calls));
    check('2: refused over the month cap (8 + 5 > 12)', lastLog(db, a)?.status === 'refused' && lastLog(db, a)?.error === 'over_month_cap', lastLog(db, a));
    check('2: no new run', db.t('lead_runs').length === 2 && calls.length === 0);
    check('2: last month ignored, remaining is 4', lastLog(db, a)?.detail?.remaining_month === 4, lastLog(db, a)?.detail);
  }

  // --- 3. no caps (written around the save validation) -----------------------
  {
    const db = makeDb(); installRpcs(db); const { view } = seed(db); const calls = [];
    const a = addAutomation(db, { kind: 'auto_enrich', config: { saved_search_id: view.id, enrich: 'verify' } });
    // Give them addresses so verify has work.
    for (const c of db.t('lead_contacts')) if (c.user_id === USER) c.email = `x@${c.domain}`;
    await A.tick(db, makeCtx(db, calls));
    check('3: no cap -> refused', lastLog(db, a)?.status === 'refused' && lastLog(db, a)?.error === 'no_cap', lastLog(db, a));
    check('3: nothing started', db.t('lead_runs').length === 0 && calls.length === 0);
  }

  // --- 4. fits: started with a ceiling; same slot replays; next slot waits ----
  {
    const db = makeDb(); installRpcs(db); const { view } = seed(db); const calls = [];
    const a = addAutomation(db, { kind: 'auto_enrich', config: { saved_search_id: view.id, enrich: 'find_email' }, max_credits_per_run: 10, max_credits_per_month: 20 });
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    db.t('lead_runs').push({ id: uuid(), user_id: USER, status: 'done', charged_credits: 8, max_credits: 9, options: { automation_id: a.id }, created_at: new Date(monthStart.getTime() + 1000).toISOString() });
    const slot = row(db, a).next_run_at;

    await A.tick(db, makeCtx(db, calls));
    const log = lastLog(db, a);
    const started = autoRuns(db, a).filter((r) => r.status !== 'done');
    check('4: succeeded', log?.status === 'succeeded', log);
    check('4: one run created, tagged with the automation', started.length === 1 && started[0].options.automation_name === a.name, started);
    check('4: history links the run', log?.run_id === started[0]?.id);
    check('4: ceiling is min(run cap, month remaining)', calls.length === 1 && calls[0].ceilingCredits === 10, calls[0]);
    check('4: run max within both caps', started[0].max_credits <= 10 && 8 + started[0].max_credits <= 20);
    check('4: request id is the slot id', /^auto-/.test(started[0].options.request_id ?? ''));
    check('4: rows written for the 10 contacts', db.t('lead_rows').filter((r) => r.run_id === started[0].id).length === 10);
    check('4: run released to the worker', started[0].status === 'queued');

    // The same slot again (a tick that died before rescheduling).
    row(db, a).next_run_at = slot; row(db, a).lease_until = null;
    await A.tick(db, makeCtx(db, calls));
    check('4: same slot -> replay, no second run', autoRuns(db, a).length === 2 && lastLog(db, a)?.detail?.replayed === true, lastLog(db, a));
    check('4: replay did not call createRun', calls.length === 1);

    // The next slot, with the first run still working: waits.
    row(db, a).next_run_at = past(); row(db, a).lease_until = null;
    await A.tick(db, makeCtx(db, calls));
    check('4: next slot waits on the run still working', lastLog(db, a)?.status === 'skipped' && lastLog(db, a)?.detail?.waiting_on_run === started[0].id, lastLog(db, a));
    check('4: still one run', autoRuns(db, a).length === 2 && calls.length === 1);

    // Run finished having charged 3; contacts enriched; next slot: nothing to do.
    Object.assign(db.t('lead_runs').find((r) => r.id === started[0].id), { status: 'done', charged_credits: 3 });
    for (const c of db.t('lead_contacts')) if (c.user_id === USER) c.last_enriched_at = nowIso();
    row(db, a).next_run_at = past(); row(db, a).lease_until = null;
    await A.tick(db, makeCtx(db, calls));
    check('4: recently enriched are skipped', lastLog(db, a)?.status === 'skipped' && lastLog(db, a)?.detail?.skipped?.recent === 10, lastLog(db, a));

    // History reports what the run has charged by now.
    const h = await A.automationHistory(db, USER, { automation_id: a.id });
    const linked = h.runs.find((x) => x.run_id === started[0].id);
    check('4: history shows the run\'s current charge', linked?.credits_charged === 3 && linked?.run_status === 'done', linked);
    const hOther = await A.automationHistory(db, OTHER, { automation_id: a.id });
    check('4: history is per user', hOther.runs.length === 0);

    const list = await A.listAutomations(db, USER);
    check('4: list reports the month committed (8 + 3)', list.automations[0]?.month_committed === 11, list.automations[0]);
  }

  // --- 5. row limit trims the run before it is priced -------------------------
  {
    const db = makeDb(); installRpcs(db); const { view } = seed(db); const calls = [];
    const a = addAutomation(db, { kind: 'auto_enrich', config: { saved_search_id: view.id, enrich: 'find_email', max_rows: 4 }, max_credits_per_run: 2, max_credits_per_month: 10 });
    await A.tick(db, makeCtx(db, calls));
    const r = autoRuns(db, a)[0];
    check('5: 4 rows at 0.5 = 2 fits a cap of 2', lastLog(db, a)?.status === 'succeeded' && r?.target === 4 && r?.max_credits === 2, lastLog(db, a));
    check('5: the rest reported as over the row limit', lastLog(db, a)?.detail?.plan_skipped?.over_row_limit === 6);
  }

  // --- 6. auto_tag ---------------------------------------------------------------
  {
    const db = makeDb(); installRpcs(db); const { view } = seed(db); const calls = [];
    const a = addAutomation(db, { kind: 'auto_tag', config: { saved_search_id: view.id, add_tags: ['icp'], remove_tags: ['cold'] } });
    db.t('lead_contacts')[5].tags = ['cold'];
    await A.tick(db, makeCtx(db, calls));
    const mine = db.t('lead_contacts').filter((c) => c.user_id === USER);
    check('6: every matching contact tagged', mine.every((c) => c.tags.includes('icp')));
    check('6: removed tag removed', !mine.some((c) => c.tags.includes('cold')));
    check('6: counts: 10 matched, 7 needed it', lastLog(db, a)?.contacts_matched === 10 && lastLog(db, a)?.contacts_tagged === 7, lastLog(db, a));
    check('6: another workspace untouched', db.t('lead_contacts').find((c) => c.user_id === OTHER).tags.length === 0);
    check('6: free: no run', db.t('lead_runs').length === 0 && calls.length === 0);
  }

  // --- 7. saved_search_refresh ---------------------------------------------------
  {
    const db = makeDb(); installRpcs(db); const { search, list } = seed(db); const calls = [];
    const a = addAutomation(db, {
      kind: 'saved_search_refresh',
      config: { saved_search_id: search.id, list_id: list.id, max_people: 10, enrich: 'find_email' },
      max_credits_per_run: 5, max_credits_per_month: 50,
    });
    const lead = (id, first, last, domain) => ({ id, firstName: first, lastName: last, jobTitle: 'CMO', company: { name: domain, domain } });
    searchBody = {
      leads: [
        lead('lf1', 'Person', '3', 'co3.com'),     // already held (name at domain)
        lead('lf2', 'Blocked', 'One', 'blocked.com'), // opted out
        lead('lf3', 'New', 'Person', 'fresh.io'),
        lead('lf4', 'Other', 'New', 'fresh.io'),
      ],
    };
    searchCalls = 0;
    await A.tick(db, makeCtx(db, calls));
    const log = lastLog(db, a);
    check('7: searched once (no cursor)', searchCalls === 1);
    check('7: found 4, added 2, skipped 2', log?.people_found === 4 && log?.people_added === 2 && log?.people_skipped === 2, log);
    check('7: the opted-out person was not saved', !db.t('lead_contacts').some((c) => c.domain === 'blocked.com'));
    check('7: new people in the list', db.t('lead_list_members').filter((m) => m.list_id === list.id).length === 2);
    check('7: find-email run over the 2 new people only', autoRuns(db, a).length === 1 && autoRuns(db, a)[0].target === 2, autoRuns(db, a));
    check('7: ceiling passed', calls[0]?.ceilingCredits === 5);
    check('7: automation searches stay out of search history', db.t('lead_search_log').length === 0);
    check('7: saved search stamped', Boolean(db.t('lead_saved_searches').find((s) => s.id === search.id).last_run_at));

    // Next day: the same results are all held now.
    row(db, a).next_run_at = past(); row(db, a).lease_until = null;
    await A.tick(db, makeCtx(db, calls));
    check('7: nothing new -> skipped, no second run', lastLog(db, a)?.status === 'skipped' && autoRuns(db, a).length === 1, lastLog(db, a));

    // A run cap too small for the new people (10 at 0.5 = 5 > 4): people saved, enrichment refused.
    searchBody = { leads: Array.from({ length: 12 }, (_, i) => lead(`n${i}`, 'Batch', String(i), 'batch.io')) };
    row(db, a).next_run_at = past(); row(db, a).lease_until = null; row(db, a).max_credits_per_run = 4;
    await A.tick(db, makeCtx(db, calls));
    check('7: 10 saved (max_people), enrichment refused over the run cap', lastLog(db, a)?.people_added === 10 && lastLog(db, a)?.status === 'refused' && lastLog(db, a)?.error === 'over_run_cap', lastLog(db, a));
    check('7: still one run', autoRuns(db, a).length === 1);
  }

  // --- 8. a deleted saved search pauses; three failures pause ---------------------
  {
    const db = makeDb(); installRpcs(db); const { view } = seed(db); const calls = [];
    const gone = addAutomation(db, { name: 'gone', kind: 'auto_tag', config: { saved_search_id: uuid(), add_tags: ['x'] } });
    await A.tick(db, makeCtx(db, calls));
    check('8: missing saved search -> failed and paused', lastLog(db, gone)?.status === 'failed' && row(db, gone).status === 'paused' && row(db, gone).pause_reason === 'saved_search_not_found');

    const flaky = addAutomation(db, { name: 'flaky', kind: 'auto_enrich', config: { saved_search_id: view.id, enrich: 'find_email' }, max_credits_per_run: 10, max_credits_per_month: 100 });
    const ctx = makeCtx(db, calls, { throwFor: () => true });
    for (let i = 0; i < 3; i++) {
      row(db, flaky).next_run_at = past(); row(db, flaky).lease_until = null;
      await A.tick(db, ctx);
    }
    check('8: three failures -> paused', row(db, flaky).status === 'paused' && row(db, flaky).pause_reason === 'repeated_failures' && row(db, flaky).failure_count === 3, row(db, flaky));
    check('8: failures recorded with the error', db.t('lead_automation_runs').filter((r) => r.automation_id === flaky.id && r.status === 'failed' && r.error === 'boom').length === 3);
    row(db, flaky).next_run_at = past();
    const r = await A.tick(db, ctx);
    check('8: a paused automation is not claimed', r.claimed === 0);
  }

  // --- 9. the screens ------------------------------------------------------------
  {
    const db = makeDb(); installRpcs(db); const { view, search, list } = seed(db);
    const s1 = await A.saveAutomation(db, USER, {
      name: 'Enrich weekly', kind: 'auto_enrich', config: { saved_search_id: view.id, enrich: 'find_email' },
      schedule: { frequency: 'weekly', hour: 9, weekday: 1 }, max_credits_per_run: 0, max_credits_per_month: 0,
    });
    check('9: save refuses a paid automation without caps', s1.ok === false && s1.error === 'cap_required');
    const s2 = await A.saveAutomation(db, USER, {
      name: 'Enrich weekly', kind: 'auto_enrich', config: { saved_search_id: search.id, enrich: 'find_email' },
      schedule: { frequency: 'daily', hour: 9 }, max_credits_per_run: 5, max_credits_per_month: 20,
    });
    check('9: save refuses the wrong kind of saved search', s2.error === 'saved_search_not_found');
    const s3 = await A.saveAutomation(db, OTHER, {
      name: 'Steal', kind: 'auto_tag', config: { saved_search_id: view.id, add_tags: ['x'] }, schedule: { frequency: 'daily', hour: 1 },
    });
    check('9: save refuses another workspace\'s saved search', s3.error === 'saved_search_not_found');
    const s4 = await A.saveAutomation(db, USER, {
      name: 'Refresh', kind: 'saved_search_refresh', config: { saved_search_id: search.id, list_id: list.id },
      schedule: { frequency: 'daily', hour: 9 },
    });
    check('9: save a free refresh', s4.ok && s4.automation.next_run_at > nowIso() && s4.automation.max_credits_per_run === 0, s4);
    const est = await A.automationEstimate(db, USER, { kind: 'auto_enrich', config: { saved_search_id: view.id, enrich: 'find_email', max_rows: 30 }, max_credits_per_run: 10, max_credits_per_month: 100 });
    check('9: estimate prices one run at its limit', est.ok && est.paid && est.rows === 30 && est.estimate.max_credits === 15 && est.fits_run_cap === false, est);
    const free = await A.automationEstimate(db, USER, { kind: 'auto_tag', config: { saved_search_id: view.id, add_tags: ['a'] } });
    check('9: free automations have no estimate', free.ok && free.paid === false);
    const p = await A.setAutomationStatus(db, USER, { id: s4.automation.id }, 'paused');
    check('9: pause', p.ok && db.t('lead_automations')[0].status === 'paused');
    check('9: run now refused while paused', (await A.runAutomationNow(db, USER, { id: s4.automation.id })).error === 'not_active');
    await A.setAutomationStatus(db, USER, { id: s4.automation.id }, 'active');
    check('9: resume reschedules', db.t('lead_automations')[0].status === 'active' && db.t('lead_automations')[0].next_run_at > nowIso());
    check('9: run now makes it due', (await A.runAutomationNow(db, USER, { id: s4.automation.id })).ok && db.t('lead_automations')[0].next_run_at <= nowIso());
    check('9: another user cannot delete it', (await A.deleteAutomation(db, OTHER, { id: s4.automation.id })).error === 'not_found');
    check('9: delete', (await A.deleteAutomation(db, USER, { id: s4.automation.id })).ok && db.t('lead_automations').length === 0);
  }

  // --- 10. static: the paths that matter, in the source -------------------------
  {
    const auto = fs.readFileSync(path.join(SRC, 'automations.ts'), 'utf8');
    const index = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
    const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261120_lead_automations.sql'), 'utf8');
    const runCalls = auto.match(/ws\.runFromRows\(/g) ?? [];
    check('10: one place starts runs', runCalls.length === 1);
    const ps = auto.slice(auto.indexOf('async function paidStep'));
    check('10: budget decided before the run starts', ps.indexOf('budgetDecision(') > 0 && ps.indexOf('budgetDecision(') < ps.indexOf('ws.runFromRows('));
    check('10: the run is given a ceiling', /ceilingCredits:\s*Math\.min\(/.test(ps));
    const cr = index.slice(index.indexOf('async function createRun('));
    check('10: createRun checks the ceiling before inserting', cr.indexOf('o.ceilingCredits') > 0 && cr.indexOf('o.ceilingCredits') < cr.indexOf(".from('lead_runs')"));
    const tickDoor = index.slice(index.indexOf("if (action === 'automations_tick')"), index.indexOf('const userId = await requireUserId(req)'));
    check('10: the tick needs the worker secret', tickDoor.includes('provided !== WORKER_SECRET') && tickDoor.includes("return fail('worker not configured', 503)"));
    check('10: the trigger guards every automation run insert', /before insert on public\.lead_runs/.test(sql) && /over_run_cap/.test(sql) && /over_month_cap/.test(sql) && /no_cap/.test(sql));
    check('10: the trigger locks the automation', /for update;/.test(sql));
    check('10: caps cannot be inverted in the table', /max_credits_per_run <= max_credits_per_month/.test(sql));
    check('10: client roles cannot call the RPCs', /revoke execute on function public\.lead_automations_claim_due[^;]+from public, anon, authenticated/.test(sql)
      && /revoke execute on function public\.lead_automation_month_committed[^;]+from public, anon, authenticated/.test(sql));
    check('10: tables are select-own', /'lead_automations', 'lead_automation_runs'/.test(sql) && /for select to authenticated using/.test(sql));
  }

  console.log(`${pass}/${pass + fails.length} assertions passed`);
  if (fails.length) {
    for (const x of fails) console.log('  FAIL ' + x);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
