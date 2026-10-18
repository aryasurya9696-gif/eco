// Tests the Treg adapters: what each endpoint is sent, and how its answer is read.
//
//   node supabase/tests/lead-endpoints-tests.cjs
//
// Checked against the catalog itself rather than against expectations written
// here. fixtures/treg/catalog-2026-10-18.json holds, per endpoint, the method,
// whether inputs go in the body or the query, which params are required, and the
// catalog's own example response - fetched from GET treg.to/catalog/endpoints/{id}.
//
// So "the request uses only documented params and sends every required one" and
// "the reader finds the answer in the documented example" are both asserted
// against the provider's documentation. Before these adapters existed every
// provider in a step was sent the same guessed body and almost none of them took
// those names.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'supabase', 'functions', 'leads');
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'lead-endpoints-test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const name of ['endpoints.ts', 'scoring.ts']) {
  fs.copyFileSync(path.join(SRC, name), path.join(OUT, name));
}
fs.writeFileSync(
  path.join(OUT, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022', lib: ['ES2022'], module: 'preserve', moduleResolution: 'bundler',
      strict: true, noEmitOnError: true, outDir: path.join(OUT, 'dist'),
    },
    files: ['endpoints.ts', 'scoring.ts'],
  }),
);
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(OUT, 'tsconfig.json')], { stdio: 'pipe', cwd: ROOT });
} catch (e) {
  console.error('compile failed:');
  console.error(String(e.stdout || e.message).split('\n').slice(0, 20).join('\n'));
  process.exit(1);
}

const E = require(path.join(OUT, 'dist', 'endpoints.js'));
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'treg', 'catalog-2026-10-18.json'), 'utf8')).endpoints;

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
};

/** The shape matches the catalog: method, only documented params, every required one present. */
function conforms(id, shape, label) {
  const c = CAT[id];
  check(`${label}: ${id} is in the fixture`, Boolean(c));
  if (!c || !shape) return;
  check(`${label}: ${id} method ${c.method}`, shape.method === c.method, shape.method);
  const keys = Object.keys(shape.params);
  const unknown = keys.filter((k) => !(k in c.params));
  check(`${label}: ${id} sends only documented params`, unknown.length === 0, unknown);
  const missing = Object.entries(c.params).filter(([k, v]) => v.required && !(k in shape.params)).map(([k]) => k);
  check(`${label}: ${id} sends every required param`, missing.length === 0, missing);
}

const full = { person_name: 'Jane Q Doe', domain: 'https://www.Example.com/about', linkedin_url: 'https://www.linkedin.com/in/jane-doe', company_name: 'Example' };
const nameDomain = { person_name: 'Jane Doe', domain: 'example.com' };
const liOnly = { linkedin_url: 'https://www.linkedin.com/in/jane-doe' };
const nothing = {};

// ---------------------------------------------------------------------------
// Email finders
// ---------------------------------------------------------------------------
for (const id of ['quickenrich.people.email.find', 'trykitt.people.email.find', 'aiark.people.email.find', 'tomba.people.email.find', 'leadsforge.people.email.find']) {
  conforms(id, E.emailFindRequest(id, full), 'email find (full row)');
  check(`${id}: nothing to ask with -> null`, E.emailFindRequest(id, nothing) === null);
}
conforms('quickenrich.people.email.find', E.emailFindRequest('quickenrich.people.email.find', nameDomain), 'email find (name+domain)');
check('quickenrich name+domain uses company_url/first/last',
  JSON.stringify(E.emailFindRequest('quickenrich.people.email.find', nameDomain).params) ===
  JSON.stringify({ company_url: 'example.com', first_name: 'Jane', last_name: 'Doe' }));
check('kitt needs a domain', E.emailFindRequest('trykitt.people.email.find', liOnly) === null);
check('kitt sends realtime:true', E.emailFindRequest('trykitt.people.email.find', nameDomain).params.realtime === true);
check('aiark needs a profile URL', E.emailFindRequest('aiark.people.email.find', nameDomain) === null);
check('tomba strips the scheme and path from the domain', E.emailFindRequest('tomba.people.email.find', full).params.domain === 'example.com');
check('leadsforge prefers its own person id',
  E.emailFindRequest('leadsforge.people.email.find', { ...full, leadsforge_id: 'p_1' }).params.personID === 'p_1');
check('a one-word name is not split into first/last', E.emailFindRequest('trykitt.people.email.find', { person_name: 'Cher', domain: 'x.com' }) === null);

// Readers against the catalog examples.
const ex = (id) => CAT[id].example_response;
check('quickenrich reads data.email', E.readEmailHit('quickenrich.people.email.find', ex('quickenrich.people.email.find'))?.email === 'person@example.com');
check('quickenrich gives no verdict', E.readEmailHit('quickenrich.people.email.find', ex('quickenrich.people.email.find'))?.verdict === null);
const kitt = E.readEmailHit('trykitt.people.email.find', ex('trykitt.people.email.find'));
check('kitt reads email + validity=valid as deliverable', kitt?.email === 'erol@trykitt.ai' && kitt?.verdict === 'deliverable', kitt);
check('kitt no-results-found is a miss', E.readEmailHit('trykitt.people.email.find', { email: 'no-results-found' }) === null);
const ark = E.readEmailHit('aiark.people.email.find', ex('aiark.people.email.find'));
check('aiark reads output[0] VALID', ark?.email === 'jane@example.com' && ark?.verdict === 'deliverable', ark);
check('aiark data:null is a miss', E.readEmailHit('aiark.people.email.find', { status: 200, data: null }) === null);
const tomba = E.readEmailHit('tomba.people.email.find', ex('tomba.people.email.find'));
check('tomba valid on an accept_all domain is catch_all, not verified', tomba?.email === 'patrick@stripe.com' && tomba?.verdict === 'catch_all', tomba);
check('tomba null email is a miss', E.readEmailHit('tomba.people.email.find', { data: { email: null, score: 0 } }) === null);
check('leadsforge reads succeeded email', E.readEmailHit('leadsforge.people.email.find', ex('leadsforge.people.email.find'))?.email === 'jane.doe@example.com');
check('leadsforge non-succeeded is a miss', E.readEmailHit('leadsforge.people.email.find', { status: 'failed', email: 'x@y.com' }) === null);
check('garbage email is a miss', E.readEmailHit('quickenrich.people.email.find', { data: { email: 'not an email' } }) === null);

// ---------------------------------------------------------------------------
// Verifiers
// ---------------------------------------------------------------------------
for (const id of ['contactout.people.email.verify', 'trykitt.people.email.verify', 'millionverifier.people.email.verify']) {
  conforms(id, E.verifyRequest(id, 'Jane@Example.com'), 'verify');
  check(`${id}: bad address -> null`, E.verifyRequest(id, 'nope') === null);
}
check('contactout accept_all (the documented example) is catch_all', E.readVerifyVerdict('contactout.people.email.verify', ex('contactout.people.email.verify')) === 'catch_all');
check('contactout valid', E.readVerifyVerdict('contactout.people.email.verify', { data: { status: 'valid' } }) === 'deliverable');
check('contactout unrecognised word is unknown, not guessed', E.readVerifyVerdict('contactout.people.email.verify', { data: { status: 'weird' } }) === 'unknown');
check('contactout empty body is silence', E.readVerifyVerdict('contactout.people.email.verify', {}) === null);
check('kitt verify valid', E.readVerifyVerdict('trykitt.people.email.verify', ex('trykitt.people.email.verify')) === 'deliverable');
check('kitt verify catchall', E.readVerifyVerdict('trykitt.people.email.verify', { validity: 'catchall' }) === 'catch_all');
check('millionverifier ok', E.readVerifyVerdict('millionverifier.people.email.verify', ex('millionverifier.people.email.verify')) === 'deliverable');
for (const [w, v] of [['catch_all', 'catch_all'], ['invalid', 'undeliverable'], ['disposable', 'disposable'], ['unknown', 'unknown'], ['unverified', 'unknown']]) {
  check(`millionverifier ${w} -> ${v}`, E.readVerifyVerdict('millionverifier.people.email.verify', { result: w }) === v);
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------
for (const id of ['blitzapi.people.phone.find', 'quickenrich.people.phone.find', 'aiark.people.phone.find', 'dropleads.people.phone.find', 'leadmagic.people.phone.find']) {
  conforms(id, E.phoneRequest(id, full), 'phone');
}
check('blitz needs a profile URL', E.phoneRequest('blitzapi.people.phone.find', nameDomain) === null);
check('blitz reads phone when found', E.readPhoneHit('blitzapi.people.phone.find', ex('blitzapi.people.phone.find')) === '+14155550123');
check('quickenrich phone', E.readPhoneHit('quickenrich.people.phone.find', ex('quickenrich.people.phone.find')) === '+15550101000');
check('aiark nested phone array', E.readPhoneHit('aiark.people.phone.find', ex('aiark.people.phone.find')) === '+15555550100');
check('dropleads found', E.readPhoneHit('dropleads.people.phone.find', ex('dropleads.people.phone.find')) === '+12025550123');
check('leadmagic null number is a miss (documented example)', E.readPhoneHit('leadmagic.people.phone.find', ex('leadmagic.people.phone.find')) === null);

// ---------------------------------------------------------------------------
// Company enrich
// ---------------------------------------------------------------------------
conforms('prospeo.companies.enrich', E.companyEnrichRequest('prospeo.companies.enrich', full), 'enrich');
check('prospeo wraps the website in data', E.companyEnrichRequest('prospeo.companies.enrich', full).params.data.company_website === 'example.com');
const co = E.readCompanyEnrich('prospeo.companies.enrich', ex('prospeo.companies.enrich'));
check('prospeo normalised', co?.name === 'Intercom' && co?.employee_count === 1117 && co?.domain === 'intercom.io' && co?.country_code === 'US', co);
check('prospeo technologies carried', Array.isArray(co?.technologies) && co.technologies.includes('Node.js'));
check('prospeo source recorded', co?.source === 'prospeo.companies.enrich');
check('prospeo error is a miss', E.readCompanyEnrich('prospeo.companies.enrich', { error: true }) === null);

// ---------------------------------------------------------------------------
// Decision makers and company discovery
// ---------------------------------------------------------------------------
for (const id of ['icypeas.people.search', 'findymail.search.employees', 'leadmagic.people.search']) {
  conforms(id, E.personAtCompanyRequest(id, 'https://stripe.com', ['CEO', 'Founder']), 'person');
}
const icyQ = E.personAtCompanyRequest('icypeas.people.search', 'stripe.com', ['CEO']).params.query;
check('icypeas filters by company website and titles', icyQ.currentCompanyWebsite.include[0] === 'stripe.com' && icyQ.currentJobTitle.include[0] === 'CEO');
check('findymail without titles is not asked', E.personAtCompanyRequest('findymail.search.employees', 'stripe.com', []) === null);
check('findymail count is the price dial: 1', E.personAtCompanyRequest('findymail.search.employees', 'stripe.com', ['CEO']).params.count === 1);
const icyPeople = E.readPeopleAtCompany('icypeas.people.search', ex('icypeas.people.search'));
check('icypeas people read', icyPeople.length >= 1 && icyPeople[0].name === 'Jane Doe' && icyPeople[0].linkedinUrl === 'https://www.linkedin.com/in/jane-doe', icyPeople[0]);
const fm = E.readPeopleAtCompany('findymail.search.employees', ex('findymail.search.employees'));
check('findymail people read', fm.length === 1 && fm[0].title === 'Head of Risk Engineering');
check('leadmagic empty example reads as nobody', E.readPeopleAtCompany('leadmagic.people.search', ex('leadmagic.people.search')).length === 0);

const seg = { industries: ['financial services'], keywords: ['payments'], countries: ['ie'], employeeRange: [11, 200] };
const tReq = E.companySearchRequest('tomba.companies.search.reveal', seg, 50);
conforms('tomba.companies.search.reveal', tReq, 'company search');
check('tomba uses include filters, not the flat shape', tReq.params.filters.industry.include[0] === 'financial services' && tReq.params.filters.location_country.include[0] === 'IE');
check('tomba size buckets cover 11-200', JSON.stringify(tReq.params.filters.size.include) === JSON.stringify(['11-50', '51-200']));
const iReq = E.companySearchRequest('icypeas.companies.search', seg, 30);
conforms('icypeas.companies.search', iReq, 'company search');
check('icypeas headcount range', iReq.params.query.headcount['>='] === 11 && iReq.params.query.headcount['<='] === 200);
check('icypeas page size is the target', iReq.params.pagination.size === 30);
check('nothing to search -> null', E.companySearchRequest('tomba.companies.search.reveal', {}, 10) === null);
check('name stands in when there is nothing else', E.companySearchRequest('tomba.companies.search.reveal', { name: 'UK accountants' }, 10).params.filters.keywords.include[0] === 'UK accountants');
const tc = E.readCompanySearch('tomba.companies.search.reveal', ex('tomba.companies.search.reveal'));
check('tomba companies read', tc.length >= 1 && tc[0].domain === 'google.com' && tc[0].name === 'Google', tc[0]);
const ic = E.readCompanySearch('icypeas.companies.search', ex('icypeas.companies.search'));
check('icypeas companies read with bare domain', ic.length === 1 && ic[0].domain === 'buy.stripe.com', ic[0]);

// ---------------------------------------------------------------------------
// Advanced people search (LeadsForge)
// ---------------------------------------------------------------------------
const f = E.cleanPeopleFilters({
  jobTitles: ['VP Marketing', '', 7], seniorities: ['vp', 'director'], industries: ['software development'],
  employeesMin: '50', employeesMax: 500, companyLocations: ['United States'], technologies: ['hubspot'],
  fundingRounds: ['SERIES_B'], revenueRanges: ['small_upper'], companyDomains: ['https://www.acme.com/x'],
  maxPerCompany: 3, junk: 'ignored',
});
check('filters cleaned: blanks and non-strings dropped', JSON.stringify(f.jobTitles) === JSON.stringify(['VP Marketing']));
check('filters cleaned: numbers parsed', f.employeesMin === 50 && f.employeesMax === 500);
check('filters cleaned: domains bare', f.companyDomains[0] === 'acme.com');
check('no filters is refused', E.hasAnyPeopleFilter(E.cleanPeopleFilters({})) === false);
const lfBody = E.leadsforgePeopleBody(f, { limit: 25, excludeDomains: ['blocked.com'] });
conforms('leadsforge.people.search', { method: 'POST', params: lfBody }, 'people search');
check('seniority as include', lfBody.leadSeniorities.include.join() === 'vp,director');
check('technologies as any', lfBody.companyTechnologies.any[0] === 'hubspot');
check('employee range object', lfBody.companyEmployeeNumberRange.min === 50 && lfBody.companyEmployeeNumberRange.max === 500);
check('revenue ranges are a bare array', Array.isArray(lfBody.companyRevenueRanges));
check('suppressed domains passed as excludeDomains', lfBody.excludeDomains[0] === 'blocked.com');
check('unset filters are not sent', !('companyNames' in lfBody) && !('leadDepartments' in lfBody));
const countBody = E.leadsforgePeopleBody(f);
check('count body has no limit', !('limit' in countBody));
const lp = E.readLeadsforgePeople(ex('leadsforge.people.search'));
check('leadsforge people read', lp.people.length >= 2 && lp.people[0].leadsforge_id && lp.people[0].domain === 'stripe.com', lp.people[0]);
check('leadsforge firmographics', lp.people[0].company.employee_count === 14940 && lp.people[0].company.industry === 'software development');
check('leadsforge person location', lp.people[0].person_location === 'United States');
check('leadsforge count', E.readLeadsforgeCount(ex('leadsforge.people.search.count')) === 83);
check('vocab seniorities', E.readVocab('seniorities', ex('leadsforge.people.search.filters.seniorities')).some((v) => v.value === 'c_suite'));
check('vocab departments label drops master_', E.readVocab('departments', ex('leadsforge.people.search.filters.departments')).find((v) => v.value === 'master_sales')?.label === 'sales');
check('vocab funding id/name', E.readVocab('funding', ex('leadsforge.people.search.filters.funding_types'))[0].value === 'SERIES_G');
check('vocab revenue display/value', E.readVocab('revenue', ex('leadsforge.people.search.filters.revenue_ranges'))[0].label === '$0-$0.1M');
check('vocab industries', E.readVocab('industries', ex('leadsforge.people.search.filters.industries'))[0].value === 'software development');

// ---------------------------------------------------------------------------
// The status a row ends with
// ---------------------------------------------------------------------------
check('no address -> not_found', E.statusFor(null, 'deliverable') === 'not_found');
check('deliverable -> verified', E.statusFor('a@b.co', 'deliverable') === 'verified');
check('catch_all', E.statusFor('a@b.co', 'catch_all') === 'catch_all');
check('undeliverable -> invalid', E.statusFor('a@b.co', 'undeliverable') === 'invalid');
check('disposable', E.statusFor('a@b.co', 'disposable') === 'disposable');
check('verifier unsure -> unknown', E.statusFor('a@b.co', 'unknown') === 'unknown');
check('never checked -> unchecked, never verified', E.statusFor('a@b.co', null) === 'unchecked');

console.log(`${pass}/${pass + fails.length} assertions passed`);
if (fails.length) {
  for (const x of fails) console.log('  FAIL ' + x);
  process.exit(1);
}
