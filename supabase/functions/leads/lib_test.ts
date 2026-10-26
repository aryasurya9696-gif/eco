import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  acceptNameOnlyMatch,
  affordableSearchLimit,
  allowedOrigins,
  cachedCompanyState,
  cachedNewsState,
  COMPANY_HIT_TTL_MS,
  COMPANY_MISS_TTL_MS,
  classifyEmail,
  corsOriginFor,
  dedupeLeads,
  enrichmentPatch,
  DEV_ORIGINS,
  hasRevealedEmail,
  hasUsableEmail,
  mapCompanyOutput,
  mapNewsOutput,
  mapPersonOutput,
  maxSearchProviderCalls,
  mergeLeadRecord,
  UsageLog,
} from './lib.ts';

const verdict = (v: unknown) => ({ _treg: { verification: v } });

Deno.test('classifyEmail: only valid is charged; unknown/pending/missing are not usable (H3)', () => {
  assertEquals(classifyEmail(verdict({ verdict: 'valid' })), { status: 'valid', charge: true, usable: true });
  assertEquals(classifyEmail(verdict({ verdict: 'catch_all' })).usable, true);
  assertEquals(classifyEmail(verdict({ verdict: 'risky' })).charge, false);
  assertEquals(classifyEmail(verdict({ verdict: 'invalid' })).usable, false);
  assertEquals(classifyEmail(verdict({ verdict: 'unknown' })), { status: 'unknown', charge: false, usable: false });
  assertEquals(classifyEmail(verdict({ pending: true })), { status: 'pending', charge: false, usable: false });
  assertEquals(classifyEmail({}), { status: 'unknown', charge: false, usable: false });
});

Deno.test('hasRevealedEmail: only a verified address counts as bought (M2)', () => {
  assert(hasRevealedEmail({ work_email: 'a@b.com', email_status: 'valid' }));
  for (const s of ['unknown', 'risky', 'accept_all', 'pending', 'preview', 'invalid', null]) {
    assert(!hasRevealedEmail({ work_email: 'a@b.com', email_status: s }), String(s));
  }
  assert(!hasRevealedEmail({ work_email: 'N/A', email_status: 'valid' }));
});

Deno.test('hasUsableEmail: valid, catch-all and risky are shown; unknown is not', () => {
  assert(hasUsableEmail({ work_email: 'a@b.com', email_status: 'risky' }));
  assert(hasUsableEmail({ work_email: 'a@b.com', email_status: 'accept_all' }));
  assert(!hasUsableEmail({ work_email: 'a@b.com', email_status: 'unknown' }));
  assert(!hasUsableEmail({ work_email: 'a@b.com', email_status: null }));
});

Deno.test('dedupeLeads: one entry per (domain, name), all client keys kept (H5)', () => {
  const out = dedupeLeads([
    { company_domain: 'Acme.com', full_name: 'Ann Lee', client_key: 'acme.com::ann lee' },
    { company_domain: 'https://www.acme.com/', full_name: ' ann lee ', client_key: 'x' },
    { company_domain: 'acme.com', full_name: 'Bob Ray', client_key: 'acme.com::bob ray' },
    { company_domain: 'acme.com', full_name: 'Ann Lee', client_key: 'acme.com::ann lee' },
  ]);
  assertEquals(out.length, 2);
  assertEquals(out[0].client_keys, ['acme.com::ann lee', 'x']);
  assertEquals(out[1].client_keys, ['acme.com::bob ray']);
});

Deno.test('acceptNameOnlyMatch: needs an agreeing slug and no conflicting domain (M2)', () => {
  const row = { full_name: 'John Smith', company_domain: 'a.com', linkedin_url: 'https://linkedin.com/in/jsmith' };
  assert(!acceptNameOnlyMatch(row, null, ''));
  assert(!acceptNameOnlyMatch(row, 'other', ''));
  assert(!acceptNameOnlyMatch(row, 'jsmith', 'b.com'));
  assert(acceptNameOnlyMatch(row, 'jsmith', 'a.com'));
  assert(acceptNameOnlyMatch({ ...row, company_domain: '' }, 'jsmith', 'b.com'));
});

Deno.test('mergeLeadRecord: blanks and placeholders keep stored values (M2)', () => {
  const existing = {
    full_name: 'Ann Lee', company_domain: 'acme.com', title: 'CTO', company_name: 'Acme',
    linkedin_url: 'https://linkedin.com/in/ann', status: 'replied', location: 'Berlin',
  };
  const out = mergeLeadRecord(existing, {
    full_name: 'ann lee', company_domain: 'acme.com', title: 'Executive', company_name: 'Enterprise',
    linkedin_url: null, location: '', status: null, phone_number: '+1',
  });
  assertEquals(out.title, 'CTO');
  assertEquals(out.company_name, 'Acme');
  assertEquals(out.linkedin_url, 'https://linkedin.com/in/ann');
  assertEquals(out.location, 'Berlin');
  assertEquals(out.status, 'replied');
  assertEquals(out.full_name, 'Ann Lee'); // stored key casing, so the upsert hits that row
  assertEquals(out.phone_number, '+1');
  assertEquals(Object.keys(out).sort(), ['company_domain', 'company_name', 'full_name', 'linkedin_url', 'location', 'phone_number', 'status', 'title']);
  // New row: explicit values pass through, blank status defaults to 'new'.
  assertEquals(mergeLeadRecord(null, { title: 'Executive', status: null }), { title: 'Executive', status: 'new' });
  assertEquals(mergeLeadRecord(existing, { status: 'contacted' }).status, 'contacted');
});

Deno.test('maxSearchProviderCalls mirrors the search code: 11 single, 12 multi (H4)', () => {
  assertEquals(maxSearchProviderCalls(0, 50), 1);
  assertEquals(maxSearchProviderCalls(1, 100), 1);
  assertEquals(maxSearchProviderCalls(1, 150), 3);
  assertEquals(maxSearchProviderCalls(1, 1000), 11);
  assertEquals(maxSearchProviderCalls(3, 1000), 12);
  assertEquals(maxSearchProviderCalls(2, 1000), 10);
  assertEquals(maxSearchProviderCalls(10, 1000), 10);
  assertEquals(maxSearchProviderCalls(25, 1000), 10);
  let worst = 0;
  for (let d = 0; d <= 12; d++) for (let l = 5; l <= 1000; l++) worst = Math.max(worst, maxSearchProviderCalls(d, l));
  assertEquals(worst, 12);
});

Deno.test('affordableSearchLimit', () => {
  assertEquals(affordableSearchLimit(1000, 1, 0, 1), 0);
  assertEquals(affordableSearchLimit(1000, 1, 1, 1), 100);
  assertEquals(affordableSearchLimit(1000, 1, 3, 1), 200);
  assertEquals(affordableSearchLimit(1000, 1, 11, 1), 1000);
});

Deno.test('UsageLog: reservation_id on rows, billed-call count, flush keeps indices (H6)', async () => {
  const log = new UsageLog('u1');
  const billed = new Response('{}', { status: 200, headers: { 'x-treg-cost-micro': '2600' } });
  const free = new Response('{}', { status: 200, headers: { 'x-treg-cost-micro': '0' } });
  const noHeader = new Response('{}', { status: 200 });
  const failed = new Response('{}', { status: 502, headers: { 'x-treg-cost-micro': '1000' } });
  log.track('treg.people.search', billed, {}, 'res-1');
  log.track('treg.people.search', free, {}, 'res-1');
  log.track('treg.people.search', noHeader, {}, 'res-1');
  log.track('treg.people.search', failed, {}, 'res-1');
  log.track('treg.people.search', null, {}, 'res-1');
  assert(log.rows.every((r) => r.reservation_id === 'res-1'));
  assertEquals(log.billedCallsSince(0, 'treg.people.search').length, 2); // billed + missing header
  assertEquals(log.costSince(0, 'treg.people.search'), 0.0036);

  const written: any[][] = [];
  const admin = { from: () => ({ upsert: (rows: any[]) => (written.push(rows), Promise.resolve({ error: null })) }) };
  await log.flush(admin);
  await log.flush(admin); // nothing new
  log.track('treg.people.email.find', billed, {}, 'res-2');
  await log.flush(admin);
  assertEquals(written.map((w) => w.length), [5, 1]);
  assertEquals(written[1][0].reservation_id, 'res-2');
  assertEquals(log.rows.length, 6); // not dropped, so costSince indices stay valid
});

Deno.test('CORS allow-list', () => {
  assertEquals(allowedOrigins(undefined, undefined), [...DEV_ORIGINS]);
  const list = allowedOrigins('https://app.example.com, https://b.example.com/', undefined);
  assertEquals(corsOriginFor('https://b.example.com', list), 'https://b.example.com');
  assertEquals(corsOriginFor('https://evil.example', list), 'https://app.example.com');
  assertEquals(corsOriginFor('https://x', allowedOrigins('*', undefined)), '*');
});

Deno.test('mapCompanyOutput: a hit maps the contract, a null name is a miss', () => {
  const row = mapCompanyOutput({
    output: {
      name: ' Stripe ',
      description: 'Payments infrastructure',
      industry: 'Financial Services',
      employees: '5001-10000',
      founded: 2010,
      location: 'South San Francisco, CA',
      linkedin_url: 'linkedin.com/company/stripe/',
      website: 'http://stripe.com',
    },
    raw: { logo_url: 'https://logo.example/stripe.png' },
    _treg: { served_by: 'hunter.companies.enrich' },
  }, 'stripe.com');
  assertEquals(row, {
    domain: 'stripe.com',
    name: 'Stripe',
    description: 'Payments infrastructure',
    industry: 'Financial Services',
    employees: '5001-10000',
    founded_year: 2010,
    location: 'South San Francisco, CA',
    linkedin_url: 'https://linkedin.com/company/stripe',
    website: 'https://stripe.com',
    logo_url: 'https://logo.example/stripe.png',
    served_by: 'hunter.companies.enrich',
  });
  assertEquals(mapCompanyOutput({ output: { name: null } }, 'x.com'), null);
  assertEquals(mapCompanyOutput({}, 'x.com'), null);
});

Deno.test('mapCompanyOutput: unsafe links and impossible years are dropped', () => {
  const row = mapCompanyOutput({
    output: { name: 'Acme', linkedin_url: 'https://evil.example/company/acme', website: 'javascript:alert(1)', founded: 3000 },
    raw: { logo: 'data:image/png;base64,xx' },
  }, 'acme.com')!;
  assertEquals(row.linkedin_url, null);
  assertEquals(row.website, null);
  assertEquals(row.founded_year, null);
  assertEquals(row.logo_url, null);
});

Deno.test('cachedCompanyState: fresh hit, recent miss, stale; the newer lookup wins', () => {
  const now = Date.parse('2026-10-26T00:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assertEquals(cachedCompanyState(null, now), 'stale');
  assertEquals(cachedCompanyState({ name: 'A', enriched_at: ago(1000) }, now), 'hit');
  assertEquals(cachedCompanyState({ name: 'A', enriched_at: ago(COMPANY_HIT_TTL_MS + 1) }, now), 'stale');
  assertEquals(cachedCompanyState({ miss_at: ago(1000) }, now), 'miss');
  assertEquals(cachedCompanyState({ miss_at: ago(COMPANY_MISS_TTL_MS + 1) }, now), 'stale');
  // A re-buy that missed after an older hit: the miss is newer.
  assertEquals(cachedCompanyState({ name: 'A', enriched_at: ago(5000), miss_at: ago(1000) }, now), 'miss');
  assertEquals(cachedCompanyState({ name: 'A', enriched_at: ago(1000), miss_at: ago(5000) }, now), 'hit');
});

Deno.test('mapPersonOutput: maps the contract; a missing name is a miss', () => {
  assertEquals(mapPersonOutput({
    output: {
      first_name: 'Jane',
      last_name: 'Doe',
      title: 'VP Marketing',
      company: 'Acme',
      company_domain: 'https://www.Acme.com/about',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      location: 'Austin, TX',
    },
  }), {
    full_name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    title: 'VP Marketing',
    company_name: 'Acme',
    company_domain: 'acme.com',
    linkedin_url: 'https://www.linkedin.com/in/jane-doe',
    location: 'Austin, TX',
  });
  assertEquals(mapPersonOutput({ output: { full_name: null } }), null);
  assertEquals(mapPersonOutput({ output: { full_name: 'A B', company_domain: 'not a domain' } })?.company_domain, null);
});

Deno.test('enrichmentPatch: fills blanks and placeholders only; never renames the lead', () => {
  const found = mapPersonOutput({
    output: { full_name: 'Jane Q. Doe', title: 'VP Marketing', company: 'Acme', company_domain: 'acme.com', location: 'Austin' },
  })!;
  assertEquals(
    enrichmentPatch({ full_name: 'Jane Doe', title: 'Executive', company_name: 'Acme Inc', company_domain: 'acme.com', location: null }, found),
    { title: 'VP Marketing', location: 'Austin' },
  );
  // A LinkedIn-only lead gets its missing domain.
  assertEquals(enrichmentPatch({ full_name: 'Jane Doe', company_domain: '' }, found).company_domain, 'acme.com');
  assert(!('full_name' in enrichmentPatch({ full_name: 'Jane Doe' }, found)));
});

Deno.test('mapNewsOutput: common field spellings; no title or link drops the article', () => {
  assertEquals(
    mapNewsOutput({
      output: {
        articles: [
          { title: 'Acme raises $20M', url: 'https://news.example/a?id=7', published_at: '2026-10-01T00:00:00Z', source: { name: 'TechNews' } },
          { headline: 'Acme hires a CRO', link: 'http://blog.example/b', date: '2026-09-15', publisher: 'Blog' },
          { title: 'No link' },
          { title: 'Bad link', url: 'javascript:alert(1)' },
        ],
      },
    }),
    [
      { title: 'Acme raises $20M', url: 'https://news.example/a?id=7', published_at: '2026-10-01T00:00:00.000Z', source: 'TechNews' },
      { title: 'Acme hires a CRO', url: 'http://blog.example/b', published_at: '2026-09-15T00:00:00.000Z', source: 'Blog' },
    ],
  );
  assertEquals(mapNewsOutput({ output: { articles: [] } }), []);
  assertEquals(mapNewsOutput({}), []);
});

Deno.test('cachedNewsState: 7-day hits, 3-day misses', () => {
  const now = Date.parse('2026-10-26T00:00:00Z');
  const ago = (days: number) => new Date(now - days * 24 * 3600_000).toISOString();
  const article = [{ title: 't', url: 'https://a.example', published_at: null, source: null }];
  assertEquals(cachedNewsState({ news: article, news_at: ago(6) }, now), 'hit');
  assertEquals(cachedNewsState({ news: article, news_at: ago(8) }, now), 'stale');
  assertEquals(cachedNewsState({ news_miss_at: ago(2) }, now), 'miss');
  assertEquals(cachedNewsState({ news_miss_at: ago(4) }, now), 'stale');
  assertEquals(cachedNewsState(null, now), 'stale');
});
