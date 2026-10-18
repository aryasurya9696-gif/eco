// Tests the automation rules: validation, schedules, the budget, dedupe.
//
//   node supabase/tests/lead-automation-rules-tests.cjs
//
// The promise these hold the code to: no automation spends without a cap per
// run and a cap per month, and none starts a run whose estimated maximum is over
// either. budgetDecision is that promise, so it is tested case by case and then
// against a few thousand random inputs.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-automation-rules-test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'supabase', 'functions', 'leads', 'automation-rules.ts'), path.join(OUT, 'automation-rules.ts'));
fs.writeFileSync(path.join(OUT, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'ES2022', lib: ['ES2022'], module: 'commonjs', strict: true, noEmitOnError: true, outDir: path.join(OUT, 'dist') },
  files: ['automation-rules.ts'],
}));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(OUT, 'tsconfig.json')], { stdio: 'pipe', cwd: ROOT });
} catch (e) {
  console.error(String(e.stdout || e.message).split('\n').slice(0, 20).join('\n'));
  process.exit(1);
}
const R = require(path.join(OUT, 'dist', 'automation-rules.js'));

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
};

const SS = '11111111-1111-4111-8111-111111111111';
const LIST = '22222222-2222-4222-8222-222222222222';
const base = (over = {}) => ({
  name: 'Weekly refresh',
  kind: 'saved_search_refresh',
  config: { saved_search_id: SS, max_people: 40, enrich: 'find_email' },
  schedule: { frequency: 'daily', hour: 6 },
  max_credits_per_run: 20,
  max_credits_per_month: 100,
  ...over,
});

// --- validation: caps --------------------------------------------------------
{
  const ok = R.cleanAutomation(base());
  check('a valid paid automation is accepted', ok.ok, ok);
  check('caps are kept on a paid automation', ok.ok && ok.value.max_credits_per_run === 20 && ok.value.max_credits_per_month === 100);

  check('paid with no caps is refused', R.cleanAutomation(base({ max_credits_per_run: 0, max_credits_per_month: 0 })).error === 'cap_required');
  check('paid with no run cap is refused', R.cleanAutomation(base({ max_credits_per_run: 0 })).error === 'cap_required');
  check('paid with no month cap is refused', R.cleanAutomation(base({ max_credits_per_month: undefined })).error === 'cap_required');
  check('paid with caps missing entirely is refused', R.cleanAutomation(base({ max_credits_per_run: undefined, max_credits_per_month: undefined })).error === 'cap_required');
  check('negative cap is refused', R.cleanAutomation(base({ max_credits_per_run: -1 })).error === 'bad_cap');
  check('NaN cap is refused', R.cleanAutomation(base({ max_credits_per_run: 'lots' })).error === 'bad_cap');
  check('Infinity cap is refused', R.cleanAutomation(base({ max_credits_per_month: Infinity })).error === 'bad_cap');
  check('absurd cap is refused', R.cleanAutomation(base({ max_credits_per_month: 1e9 })).error === 'bad_cap');
  check('run cap over month cap is refused', R.cleanAutomation(base({ max_credits_per_run: 101 })).error === 'run_cap_over_month_cap');
  check('run cap equal to month cap is fine', R.cleanAutomation(base({ max_credits_per_run: 100 })).ok);

  const auto = R.cleanAutomation(base({ kind: 'auto_enrich', config: { saved_search_id: SS, enrich: 'verify' }, max_credits_per_run: 0 }));
  check('auto_enrich is always paid, so needs caps', auto.error === 'cap_required');

  const free = R.cleanAutomation(base({ config: { saved_search_id: SS, enrich: 'none' }, max_credits_per_run: 5, max_credits_per_month: 9 }));
  check('a free refresh is accepted without caps', R.cleanAutomation(base({ config: { saved_search_id: SS }, max_credits_per_run: 0, max_credits_per_month: 0 })).ok);
  check('a free automation stores zero caps (may not spend)', free.ok && free.value.max_credits_per_run === 0 && free.value.max_credits_per_month === 0);
  const tag = R.cleanAutomation(base({ kind: 'auto_tag', config: { saved_search_id: SS, add_tags: ['ICP', ' icp ', 'q4'] }, max_credits_per_run: 0, max_credits_per_month: 0 }));
  check('auto_tag needs no caps', tag.ok, tag);
  check('tags are lower-cased and deduped', tag.ok && JSON.stringify(tag.value.config.add_tags) === '["icp","q4"]');
}

// --- validation: everything else --------------------------------------------
{
  check('name required', R.cleanAutomation(base({ name: '  ' })).error === 'name_required');
  check('unknown kind refused', R.cleanAutomation(base({ kind: 'auto_spend' })).error === 'bad_kind');
  check('saved search required', R.cleanAutomation(base({ config: { enrich: 'none' } })).error === 'saved_search_required');
  check('saved search must be a uuid', R.cleanAutomation(base({ config: { saved_search_id: '1; drop table' } })).error === 'saved_search_required');
  check('bad list refused', R.cleanAutomation(base({ config: { saved_search_id: SS, list_id: 'x' } })).error === 'bad_list');
  const listed = R.cleanAutomation(base({ config: { saved_search_id: SS, list_id: LIST } }));
  check('list kept', listed.ok && listed.value.config.list_id === LIST);
  check('unknown enrich on refresh refused', R.cleanAutomation(base({ config: { saved_search_id: SS, enrich: 'phone' } })).error === 'bad_enrich');
  check('unknown enrich on auto_enrich refused', R.cleanAutomation(base({ kind: 'auto_enrich', config: { saved_search_id: SS, enrich: 'company' } })).error === 'bad_enrich');
  const big = R.cleanAutomation(base({ config: { saved_search_id: SS, max_people: 100000 } }));
  check('max_people clamped', big.ok && big.value.config.max_people === R.LIMITS.maxPeople);
  const rows = R.cleanAutomation(base({ kind: 'auto_enrich', config: { saved_search_id: SS, enrich: 'find_email', max_rows: 9999, skip_recent_days: 0 } }));
  check('max_rows clamped', rows.ok && rows.value.config.max_rows === R.LIMITS.maxRows);
  check('skip_recent_days at least 1', rows.ok && rows.value.config.skip_recent_days === 1);
  check('auto_tag with no tags refused', R.cleanAutomation(base({ kind: 'auto_tag', config: { saved_search_id: SS, add_tags: [] } })).error === 'tags_required');
  const both = R.cleanAutomation(base({ kind: 'auto_tag', config: { saved_search_id: SS, add_tags: ['a'], remove_tags: ['a', 'b'] }, max_credits_per_run: 0, max_credits_per_month: 0 }));
  check('a tag is not both added and removed', both.ok && JSON.stringify(both.value.config.remove_tags) === '["b"]');
  check('hour out of range refused', R.cleanAutomation(base({ schedule: { frequency: 'daily', hour: 24 } })).error === 'bad_hour');
  check('fractional hour refused', R.cleanAutomation(base({ schedule: { frequency: 'daily', hour: 6.5 } })).error === 'bad_hour');
  check('weekly needs a weekday', R.cleanAutomation(base({ schedule: { frequency: 'weekly', hour: 6 } })).error === 'bad_weekday');
  check('unknown frequency refused', R.cleanAutomation(base({ schedule: { frequency: 'hourly', hour: 6 } })).error === 'bad_frequency');
  const daily = R.cleanAutomation(base({ schedule: { frequency: 'daily', hour: 6, weekday: 3 } }));
  check('daily drops a weekday (the table requires null)', daily.ok && daily.value.schedule.weekday === null);
}

// --- schedules ---------------------------------------------------------------
{
  const at = (iso) => new Date(iso);
  const daily6 = { frequency: 'daily', hour: 6, weekday: null };
  check('daily, before the hour -> today', R.nextRunAt(daily6, at('2026-10-18T05:59:00Z')).toISOString() === '2026-10-18T06:00:00.000Z');
  check('daily, at the hour -> tomorrow (strictly after)', R.nextRunAt(daily6, at('2026-10-18T06:00:00Z')).toISOString() === '2026-10-19T06:00:00.000Z');
  check('daily, after the hour -> tomorrow', R.nextRunAt(daily6, at('2026-10-18T13:00:00Z')).toISOString() === '2026-10-19T06:00:00.000Z');
  check('daily rolls over a month', R.nextRunAt(daily6, at('2026-10-31T23:00:00Z')).toISOString() === '2026-11-01T06:00:00.000Z');
  check('daily rolls over a year', R.nextRunAt({ ...daily6, hour: 0 }, at('2026-12-31T00:30:00Z')).toISOString() === '2027-01-01T00:00:00.000Z');

  // 2026-10-18 is a Sunday.
  check('fixture: 2026-10-18 is a Sunday', at('2026-10-18T00:00:00Z').getUTCDay() === 0);
  const mon9 = { frequency: 'weekly', hour: 9, weekday: 1 };
  check('weekly -> next Monday', R.nextRunAt(mon9, at('2026-10-18T12:00:00Z')).toISOString() === '2026-10-19T09:00:00.000Z');
  check('weekly, on the day before the hour -> today', R.nextRunAt(mon9, at('2026-10-19T08:00:00Z')).toISOString() === '2026-10-19T09:00:00.000Z');
  check('weekly, on the day at the hour -> a week later', R.nextRunAt(mon9, at('2026-10-19T09:00:00Z')).toISOString() === '2026-10-26T09:00:00.000Z');
  check('weekly, Sunday', R.nextRunAt({ frequency: 'weekly', hour: 9, weekday: 0 }, at('2026-10-19T09:00:00Z')).toISOString() === '2026-10-25T09:00:00.000Z');
  let monotone = true;
  let t = at('2026-01-01T00:00:00Z');
  for (let i = 0; i < 400; i++) {
    const n = R.nextRunAt(mon9, t);
    if (!(n > t) || n.getUTCDay() !== 1 || n.getUTCHours() !== 9 || n - t > 7 * 86400_000) monotone = false;
    t = n;
  }
  check('weekly: always after, always Monday 09:00, never more than a week', monotone);

  check('month start', R.monthStartUtc(at('2026-10-18T13:14:15Z')).toISOString() === '2026-10-01T00:00:00.000Z');
  check('month start on the first', R.monthStartUtc(at('2026-11-01T00:00:00Z')).toISOString() === '2026-11-01T00:00:00.000Z');
}

// --- the budget --------------------------------------------------------------
{
  const d = (o) => R.budgetDecision({ estimateMax: 5, perRunCap: 10, perMonthCap: 50, committedThisMonth: 0, ...o });
  check('fits both caps', d({}).ok === true);
  check('remaining reported', d({ committedThisMonth: 12 }).remaining_month === 38);
  check('no run cap -> refused', d({ perRunCap: 0 }).reason === 'no_cap');
  check('no month cap -> refused', d({ perMonthCap: 0 }).reason === 'no_cap');
  check('missing caps -> refused', R.budgetDecision({ estimateMax: 1 }).reason === 'no_cap');
  check('NaN cap -> refused', d({ perRunCap: NaN }).reason === 'no_cap');
  check('unpriced run -> refused', d({ estimateMax: NaN }).reason === 'bad_estimate');
  check('negative estimate -> refused', d({ estimateMax: -1 }).reason === 'bad_estimate');
  check('over the run cap -> refused', d({ estimateMax: 10.000001 }).reason === 'over_run_cap');
  check('exactly the run cap -> fits', d({ estimateMax: 10 }).ok);
  check('over what is left this month -> refused', d({ committedThisMonth: 45.5 }).reason === 'over_month_cap');
  check('exactly what is left -> fits', d({ committedThisMonth: 45 }).ok);
  check('month already spent -> refused', d({ committedThisMonth: 50, estimateMax: 0.01 }).reason === 'over_month_cap');
  check('month overspent (cap lowered) -> refused, remaining 0', d({ committedThisMonth: 80 }).remaining_month === 0 && !d({ committedThisMonth: 80 }).ok);
  check('a zero-cost run fits a spent month', d({ committedThisMonth: 50, estimateMax: 0 }).ok);
  check('refusals explain themselves', /cap of 10 per run/.test(d({ estimateMax: 11 }).message) && /only 4.5 of/.test(d({ committedThisMonth: 45.5 }).message));
  check('float sums do not refuse a run that fits', d({ estimateMax: 0.3, committedThisMonth: 0.1 + 0.2, perMonthCap: 0.6 }).ok);

  // Random inputs: an ok is only ever given when both caps exist and hold.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = () => {
    const r = rnd();
    return r < 0.05 ? 0 : r < 0.08 ? NaN : r < 0.1 ? -1 : Math.round(rnd() * 100 * 1e4) / 1e4;
  };
  let bad = null;
  let oks = 0;
  for (let i = 0; i < 5000; i++) {
    const o = { estimateMax: pick(), perRunCap: pick(), perMonthCap: pick(), committedThisMonth: pick() };
    const r = R.budgetDecision(o);
    if (r.ok) {
      oks++;
      const committed = Math.max(0, Number.isFinite(o.committedThisMonth) ? o.committedThisMonth : 0);
      const holds = o.perRunCap > 0 && o.perMonthCap > 0 && o.estimateMax >= 0 && o.estimateMax <= o.perRunCap
        && committed + o.estimateMax <= o.perMonthCap + 1e-6;
      if (!holds) { bad = o; break; }
    }
  }
  check('random: every ok fits both caps', bad === null, bad);
  check('random: some inputs were ok (the test is not vacuous)', oks > 500, oks);
}

// --- dedupe -------------------------------------------------------------------
{
  check('normName matches lead_norm_name', R.normName('  Ada   LOVELACE ') === 'ada lovelace' && R.normName('  ') === null);
  check('normDomain matches lead_norm_domain', R.normDomain(' https://www.www.Acme.com:443/about ') === 'acme.com' && R.normDomain('') === null);
  check('normDomain keeps subdomains', R.normDomain('eu.acme.com') === 'eu.acme.com');

  const people = [
    { leadsforge_id: 'a', person_name: 'Ada Lovelace', domain: 'acme.com' },          // existing by name@domain
    { leadsforge_id: 'b', person_name: 'Bob', domain: 'acme.com', contact_id: 'x' },  // existing by contact_id
    { leadsforge_id: 'c', person_name: 'Cy', domain: 'beta.io' },                     // existing by provider id
    { leadsforge_id: 'd', person_name: 'Di', domain: 'blocked.com' },                 // opted-out domain
    { leadsforge_id: 'e', person_name: 'Ed', domain: 'gamma.io', email: 'ED@gamma.io' }, // opted-out address
    { leadsforge_id: 'f', person_name: 'Flo', domain: null },                         // incomplete
    { leadsforge_id: 'g', person_name: 'Gus', domain: 'WWW.Delta.com' },              // new
    { leadsforge_id: 'h', person_name: ' gus ', domain: 'delta.com' },                // repeat of g in this batch
    { leadsforge_id: 'i', person_name: 'Ivy', domain: 'delta.com' },                 // new
  ];
  const r = R.dedupePeople(people, {
    leadsforgeIds: new Set(['c']),
    nameDomains: new Set(['ada lovelace@acme.com']),
    suppressed: new Set(['blocked.com', 'ed@gamma.io']),
  });
  check('only new people kept', JSON.stringify(r.fresh.map((p) => p.leadsforge_id)) === '["g","i"]', r.fresh);
  check('existing counted', r.skipped.existing === 4, r.skipped);
  check('suppressed counted', r.skipped.suppressed === 2, r.skipped);
  check('incomplete counted', r.skipped.incomplete === 1, r.skipped);
  check('every person accounted for', r.fresh.length + r.skipped.existing + r.skipped.suppressed + r.skipped.incomplete === people.length);
}

// --- small things -------------------------------------------------------------
{
  check('isPaid: refresh without enrich is free', !R.isPaid('saved_search_refresh', { enrich: 'none' }));
  check('isPaid: refresh with find_email is paid', R.isPaid('saved_search_refresh', { enrich: 'find_email' }));
  check('isPaid: auto_enrich is paid', R.isPaid('auto_enrich', {}));
  check('isPaid: auto_tag is free', !R.isPaid('auto_tag', { enrich: 'find_email' }));
  check('modeFor matches the enrich modes', R.modeFor('auto_enrich', { enrich: 'phone' }) === 'phone_only'
    && R.modeFor('saved_search_refresh', { enrich: 'find_email' }) === 'verify_refind'
    && R.modeFor('auto_enrich', { enrich: 'verify' }) === 'verify_only'
    && R.modeFor('auto_tag', {}) === null);
  check('rowsPerRun is the per-run limit', R.rowsPerRun('saved_search_refresh', { max_people: 40 }) === 40 && R.rowsPerRun('auto_enrich', { max_rows: 70 }) === 70);
  check('savedSearchKindFor', R.savedSearchKindFor('saved_search_refresh') === 'people_search' && R.savedSearchKindFor('auto_tag') === 'people_view');
  check('pauses on the third failure', !R.afterFailure(0).pause && !R.afterFailure(1).pause && R.afterFailure(2).pause && R.afterFailure(2).failure_count === 3);
  const id = R.slotRequestId('33333333-3333-4333-8333-333333333333', new Date('2026-10-19T06:00:00Z'));
  check('slot request id passes the request-id rule', /^[a-zA-Z0-9-]{8,64}$/.test(id), id);
  check('slot request id is stable per slot', id === R.slotRequestId('33333333-3333-4333-8333-333333333333', new Date('2026-10-19T06:00:00Z')));
  check('a run-now slot a second later is its own slot', id !== R.slotRequestId('33333333-3333-4333-8333-333333333333', new Date('2026-10-19T06:00:01Z')));
  check('slot request id differs per slot', id !== R.slotRequestId('33333333-3333-4333-8333-333333333333', new Date('2026-10-20T06:00:00Z')));
  const wsSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'leads', 'workspace.ts'), 'utf8');
  for (const [k, mode] of Object.entries(R.ENRICH_MODE)) {
    check(`ENRICH_MODE.${k} matches workspace ACTION_MODE`, new RegExp(`${k}: '${mode}'`).test(wsSrc));
  }
}

console.log(`${pass}/${pass + fails.length} assertions passed`);
if (fails.length) {
  for (const x of fails) console.log('  FAIL ' + x);
  process.exit(1);
}
