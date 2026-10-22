import assert from 'node:assert/strict';
import {
  canStartBatch,
  CHUNK_BUDGET_MS,
  claimIdFor,
  creditsFor,
  DEFAULT_SWEEP_HOUR_UTC,
  filterDue,
  groupKeywords,
  isOperationAvailable,
  isProfileDue,
  MAX_CHUNKS_PER_SLOT,
  parseChunkRequest,
  shouldTryRedditFallback,
  slotHour,
  slotOf,
  worstCaseUserMs,
} from './sweep-rules.ts';

Deno.test('due: 24h cadence is due only at its own hour', () => {
  const p = { sweep_time_utc: '09:30', sweep_frequency: '24h' };
  assert.equal(isProfileDue(p, 9), true);
  assert.equal(isProfileDue(p, 10), false);
  assert.equal(isProfileDue(p, 21), false);
});

Deno.test('due: 6h and 12h cadences repeat modulo the cadence', () => {
  const six = { sweep_time_utc: '02:00', sweep_frequency: '6h' };
  assert.deepEqual([...Array(24).keys()].filter((h) => isProfileDue(six, h)), [2, 8, 14, 20]);
  const twelve = { sweep_time_utc: '13:00', sweep_frequency: '12h' };
  assert.deepEqual([...Array(24).keys()].filter((h) => isProfileDue(twelve, h)), [1, 13]);
});

Deno.test('due: missing or malformed hour falls back to the default, never "any hour"', () => {
  for (const t of [null, '', 'garbage', '25:00']) {
    const due = [...Array(24).keys()].filter((h) => isProfileDue({ sweep_time_utc: t, sweep_frequency: null }, h));
    assert.deepEqual(due, [DEFAULT_SWEEP_HOUR_UTC]);
  }
});

Deno.test('due filter is applied before any cap', () => {
  // 600 not-due profiles ahead of 3 due ones: capping first (the old bug) would
  // have kept only not-due users.
  const notDue = Array.from({ length: 600 }, (_, i) => ({ id: `a${i}`, sweep_time_utc: '01:00', sweep_frequency: '24h' }));
  const due = Array.from({ length: 3 }, (_, i) => ({ id: `z${i}`, sweep_time_utc: '07:00', sweep_frequency: '24h' }));
  const kept = filterDue([...notDue, ...due], 7).slice(0, 500);
  assert.deepEqual(kept.map((p) => p.id), ['z0', 'z1', 'z2']);
});

Deno.test('slots: hour slot formatting and parsing', () => {
  const d = new Date('2026-10-21T06:59:59.000Z');
  assert.equal(slotOf(d), '2026-10-21T06');
  assert.equal(slotHour('2026-10-21T06'), 6);
});

Deno.test('claim ids are deterministic per (slot, chunk) and valid UUIDs', async () => {
  const a = await claimIdFor('2026-10-21T06', 0);
  const b = await claimIdFor('2026-10-21T06', 0);
  const c = await claimIdFor('2026-10-21T06', 1);
  const d = await claimIdFor('2026-10-21T07', 0);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

Deno.test('chunk request: empty body is chunk 0 of the current slot', () => {
  const now = new Date('2026-10-21T06:00:05Z');
  assert.deepEqual(parseChunkRequest({}, now), { slot: '2026-10-21T06', chunk: 0, after: null });
  assert.deepEqual(parseChunkRequest(null, now), { slot: '2026-10-21T06', chunk: 0, after: null });
});

Deno.test('chunk request: chain hop is validated', () => {
  const now = new Date('2026-10-21T07:10:00Z');
  const after = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(
    parseChunkRequest({ slot: '2026-10-21T06', chunk: 3, after }, now),
    { slot: '2026-10-21T06', chunk: 3, after },
  );
  assert.ok('error' in parseChunkRequest({ slot: 'nope', chunk: 1 }, now));
  assert.ok('error' in parseChunkRequest({ slot: '2026-10-21T06', chunk: -1 }, now));
  assert.ok('error' in parseChunkRequest({ slot: '2026-10-21T06', chunk: MAX_CHUNKS_PER_SLOT }, now));
  assert.ok('error' in parseChunkRequest({ slot: '2026-10-21T06', chunk: 1.5 }, now));
  assert.ok('error' in parseChunkRequest({ slot: '2026-10-21T06', chunk: 1, after: "x' or 1=1" }, now));
  // Stale (older than 3h) and future slots are refused.
  assert.ok('error' in parseChunkRequest({ slot: '2026-10-21T02', chunk: 1 }, now));
  assert.ok('error' in parseChunkRequest({ slot: '2026-10-21T09', chunk: 1 }, now));
});

Deno.test('time budget: a batch starts only if its worst case still fits', () => {
  const worst = worstCaseUserMs(8);
  assert.ok(worst < CHUNK_BUDGET_MS);
  assert.ok(CHUNK_BUDGET_MS < 150_000, 'budget stays under the edge wall clock');
  assert.equal(canStartBatch(0, 8), true);
  assert.equal(canStartBatch(CHUNK_BUDGET_MS - worst, 8), true);
  assert.equal(canStartBatch(CHUNK_BUDGET_MS - worst + 1, 8), false);
  // Fewer keywords, fewer waves, later cut-off.
  assert.ok(worstCaseUserMs(2) < worstCaseUserMs(8));
});

Deno.test('keywords: grouped per user in read order, capped per user', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ user_id: 'u1', id: `k${i}`, keyword: `w${i}` })),
    { user_id: 'u2', id: 'x', keyword: 'only' },
  ];
  const g = groupKeywords(rows, 8);
  assert.deepEqual(g.get('u1')!.map((k) => k.id), ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']);
  assert.deepEqual(g.get('u2'), [{ id: 'x', keyword: 'only' }]);
});

Deno.test('billing: news is always free and always available', () => {
  const pricing = new Map([['treg.twitter.search', 2], ['treg.news.search', 1]]);
  assert.equal(creditsFor('treg.news.search', pricing), 0);
  assert.equal(creditsFor('treg.news.search', new Map()), 0);
  assert.equal(isOperationAvailable('treg.news.search', new Map()), true);
  assert.equal(creditsFor('treg.twitter.search', pricing), 2);
  // Unpriced paid operations stay unavailable rather than becoming free.
  assert.equal(isOperationAvailable('treg.reddit.search', pricing), false);
});

Deno.test('reddit fallback only on an unbilled empty primary', () => {
  assert.equal(shouldTryRedditFallback({ billable: 'free' }, 0), true);
  assert.equal(shouldTryRedditFallback({ billable: 'billed' }, 0), false);
  assert.equal(shouldTryRedditFallback({ billable: 'uncertain' }, 0), false);
  assert.equal(shouldTryRedditFallback({ billable: 'free' }, 3), false);
});

import { roundCredits } from './sweep-rules.ts';

Deno.test('fractional credits: 0.1 per keyword is kept, totals rounded to 2 decimals', () => {
  const pricing = new Map([['treg.twitter.search', 0.1], ['treg.reddit.search', 0.1], ['treg.web.search', 0.1], ['treg.news.search', 0]]);
  const perKeyword = ['treg.twitter.search', 'treg.reddit.search', 'treg.web.search', 'treg.news.search']
    .reduce((s, op) => s + creditsFor(op, pricing), 0);
  assert.equal(roundCredits(perKeyword), 0.3);
  assert.equal(roundCredits(perKeyword * 8), 2.4);
  assert.equal(roundCredits(0.1 * 3), 0.3);
  assert.equal(roundCredits(0.1), 0.1, 'never rounded up to a whole credit');
  assert.equal(roundCredits(0), 0);
  assert.equal(roundCredits(-1), 0);
  assert.equal(roundCredits(Number.NaN), 0);
});

Deno.test('automatic sweeps turned off are never due, at any hour', () => {
  const off = { sweep_time_utc: '06:00', sweep_frequency: 'off' };
  for (let h = 0; h < 24; h++) assert.equal(isProfileDue(off, h), false);
  const on = { id: 'b', sweep_time_utc: '06:00', sweep_frequency: '24h' };
  assert.deepEqual(filterDue([{ id: 'a', ...off }, on], 6).map((p) => p.id), ['b']);
});
