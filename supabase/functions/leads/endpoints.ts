/**
 * Echo Leads — what each endpoint is actually sent, and how its answer is read
 * ----------------------------------------------------------------------------
 * Written from the Treg catalog (GET https://treg.to/catalog/endpoints/{id},
 * read 18 Oct 2026): each endpoint's method, input location, parameter names and
 * example response. Before this file every provider in a step was sent the same
 * guessed body - `{full_name, domain, linkedin_url}` for every email finder,
 * `{query, q, search, industry, ...}` for every company search - and the catalog
 * says almost none of them take those names:
 *
 *   tomba.companies.search.reveal   wants `filters: {industry: {include}}`; the
 *                                   flat shape is silently ignored, so a find
 *                                   run got unfiltered companies.
 *   icypeas.*.search                require a `query` object of include/exclude
 *                                   filters.
 *   findymail.search.employees      requires `website` and `job_titles`.
 *   trykitt.*                       require `realtime: true`; kitt wants `fullName`.
 *   quickenrich / tomba / contactout / millionverifier
 *                                   are GET endpoints that read query params.
 *
 * Every builder returns null when the row cannot supply the inputs the endpoint
 * requires, so the caller skips it rather than paying to be told so.
 *
 * Verified means "matches the catalog's documented schema and example". It does
 * not mean a live call has been made from this codebase; no Treg token is
 * available to the build. The readers are tested against the catalog examples in
 * supabase/tests/fixtures/treg.
 *
 * No imports, so the Node test harness can compile it alone.
 */

export type Verdict = 'deliverable' | 'catch_all' | 'undeliverable' | 'disposable' | 'unknown';

export interface CallShape {
  method: 'GET' | 'POST';
  /** Query params for GET, body for POST. */
  params: Record<string, unknown>;
}

/** What the row (or the search) can offer an endpoint. */
export interface RowInput {
  person_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  company_name?: string | null;
  domain?: string | null;
  linkedin_url?: string | null;
  email?: string | null;
  phone?: string | null;
  /** A LeadsForge person id, carried from a LeadsForge search. */
  leadsforge_id?: string | null;
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** "Jane Q. Doe" -> ["Jane", "Doe"]. Middle names are dropped, not guessed at. */
export function splitName(full: string): { first: string; last: string } | null {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

function names(row: RowInput): { full: string; first: string; last: string } | null {
  const first = s(row.first_name);
  const last = s(row.last_name);
  const full = s(row.person_name) || [first, last].filter(Boolean).join(' ');
  if (first && last) return { full, first, last };
  const split = splitName(full);
  return split ? { full, ...split } : null;
}

/** Bare host: no scheme, no www, no path. */
export function bareDomain(v: unknown): string {
  return s(v)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

// ---------------------------------------------------------------------------
// Contact steps: email find, verify, phone, company enrich
// ---------------------------------------------------------------------------

export function emailFindRequest(endpointId: string, row: RowInput): CallShape | null {
  const n = names(row);
  const domain = bareDomain(row.domain);
  const li = s(row.linkedin_url);

  switch (endpointId) {
    case 'quickenrich.people.email.find':
      // linkedin_url, or company_url + first_name + last_name.
      if (li) return { method: 'GET', params: { linkedin_url: li } };
      if (n && domain) return { method: 'GET', params: { company_url: domain, first_name: n.first, last_name: n.last } };
      return null;

    case 'trykitt.people.email.find':
      if (!n || !domain) return null;
      return {
        method: 'POST',
        params: { fullName: n.full, domain, realtime: true, ...(li ? { linkedinStandardProfileURL: li } : {}) },
      };

    case 'aiark.people.email.find':
      return li ? { method: 'POST', params: { url: li } } : null;

    case 'tomba.people.email.find':
      if (!n || !domain) return null;
      return { method: 'GET', params: { domain, full_name: n.full } };

    case 'leadsforge.people.email.find':
      if (s(row.leadsforge_id)) return { method: 'POST', params: { personID: s(row.leadsforge_id) } };
      if (li) return { method: 'POST', params: { linkedinURL: li } };
      if (n && domain) return { method: 'POST', params: { firstName: n.first, lastName: n.last, companyDomain: domain } };
      return null;

    default:
      return null;
  }
}

export interface EmailHit {
  email: string;
  /** What the finder itself said about deliverability, when it checks. */
  verdict: Verdict | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const asEmail = (v: unknown): string | null => {
  const e = s(v).toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
};

export function readEmailHit(endpointId: string, body: unknown): EmailHit | null {
  const b = (body ?? {}) as any;
  switch (endpointId) {
    case 'quickenrich.people.email.find': {
      const email = asEmail(b?.data?.email);
      // "Verification date is not a fresh SMTP verification" - no verdict.
      return email ? { email, verdict: null } : null;
    }
    case 'trykitt.people.email.find': {
      const email = asEmail(b?.email);
      if (!email) return null; // email = "no-results-found" is the free miss
      return { email, verdict: kittVerdict(b?.validity) };
    }
    case 'aiark.people.email.find': {
      const out = Array.isArray(b?.data?.email?.output) ? b.data.email.output : [];
      const first = out.find((o: any) => asEmail(o?.address));
      if (!first) return null;
      const st = s(first.status).toUpperCase();
      return {
        email: asEmail(first.address)!,
        verdict: st === 'VALID' ? 'deliverable' : st === 'INVALID' ? 'undeliverable' : st ? 'unknown' : null,
      };
    }
    case 'tomba.people.email.find': {
      const email = asEmail(b?.data?.email);
      if (!email) return null;
      const st = s(b?.data?.verification?.status).toLowerCase();
      let verdict: Verdict | null =
        st === 'valid' ? 'deliverable' : st === 'invalid' ? 'undeliverable' : st ? 'unknown' : null;
      // A valid verdict on an accept-all domain is a catch-all, not a mailbox.
      if (b?.data?.accept_all === true && verdict === 'deliverable') verdict = 'catch_all';
      return { email, verdict };
    }
    case 'leadsforge.people.email.find': {
      const email = asEmail(b?.email);
      if (!email || s(b?.status).toLowerCase() !== 'succeeded') return null;
      return { email, verdict: null };
    }
    default:
      return null;
  }
}

export function verifyRequest(endpointId: string, email: string): CallShape | null {
  const e = asEmail(email);
  if (!e) return null;
  switch (endpointId) {
    case 'contactout.people.email.verify':
      return { method: 'GET', params: { email: e } };
    case 'trykitt.people.email.verify':
      return { method: 'POST', params: { email: e, realtime: true } };
    case 'millionverifier.people.email.verify':
      return { method: 'GET', params: { email: e, timeout: 20 } };
    default:
      return null;
  }
}

function kittVerdict(v: unknown): Verdict | null {
  const w = s(v).toLowerCase().replace(/[\s-]/g, '_');
  if (!w) return null;
  if (w === 'valid') return 'deliverable';
  if (w === 'invalid') return 'undeliverable';
  if (w === 'catchall' || w === 'catch_all' || w === 'accept_all') return 'catch_all';
  return 'unknown';
}

/**
 * The verdict, or null when the verifier gave no readable answer.
 *
 * 'unknown' is an answer - the verifier ran and could not decide - and is kept
 * apart from null, which is silence. Silence is never charged.
 */
export function readVerifyVerdict(endpointId: string, body: unknown): Verdict | null {
  const b = (body ?? {}) as any;
  switch (endpointId) {
    case 'contactout.people.email.verify': {
      // Full enum not documented; the example is "accept_all". Mapped by meaning,
      // and anything unrecognised is 'unknown' rather than guessed.
      const w = s(b?.data?.status).toLowerCase();
      if (!w) return null;
      if (w === 'valid' || w === 'deliverable') return 'deliverable';
      if (w === 'accept_all' || w === 'catch_all' || w === 'catchall') return 'catch_all';
      if (w === 'invalid' || w === 'undeliverable' || w === 'bounce') return 'undeliverable';
      if (w === 'disposable') return 'disposable';
      return 'unknown';
    }
    case 'trykitt.people.email.verify':
      return kittVerdict(b?.validity);
    case 'millionverifier.people.email.verify': {
      // ok | catch_all | invalid | unknown | disposable | unverified
      const w = s(b?.result).toLowerCase();
      if (!w) return null;
      if (w === 'ok') return 'deliverable';
      if (w === 'catch_all') return 'catch_all';
      if (w === 'invalid') return 'undeliverable';
      if (w === 'disposable') return 'disposable';
      return 'unknown';
    }
    default:
      return null;
  }
}

export function phoneRequest(endpointId: string, row: RowInput): CallShape | null {
  const n = names(row);
  const domain = bareDomain(row.domain);
  const li = s(row.linkedin_url);
  switch (endpointId) {
    case 'blitzapi.people.phone.find':
      return li ? { method: 'POST', params: { person_linkedin_url: li } } : null;
    case 'quickenrich.people.phone.find':
      if (li) return { method: 'GET', params: { linkedin_url: li } };
      if (n && domain) return { method: 'GET', params: { company_url: domain, first_name: n.first, last_name: n.last } };
      return null;
    case 'aiark.people.phone.find':
      if (li) return { method: 'POST', params: { linkedin: li } };
      if (n && domain) return { method: 'POST', params: { name: n.full, domain } };
      return null;
    case 'dropleads.people.phone.find':
      return li ? { method: 'POST', params: { linkedin_url: li } } : null;
    case 'leadmagic.people.phone.find':
      if (li) return { method: 'POST', params: { profile_url: li } };
      if (asEmail(row.email)) return { method: 'POST', params: { work_email: asEmail(row.email) } };
      return null;
    default:
      return null;
  }
}

const PHONE_RE = /^\+?[0-9][0-9 ()\-.]{6,}$/;
const asPhone = (v: unknown): string | null => {
  const p = s(v);
  return PHONE_RE.test(p) ? p : null;
};

export function readPhoneHit(endpointId: string, body: unknown): string | null {
  const b = (body ?? {}) as any;
  switch (endpointId) {
    case 'blitzapi.people.phone.find':
      return b?.found === true ? asPhone(b?.phone) : null;
    case 'quickenrich.people.phone.find':
      return asPhone(b?.data?.employee_phone);
    case 'aiark.people.phone.find': {
      const d = b?.data?.data;
      const first = Array.isArray(d) ? (Array.isArray(d[0]) ? d[0][0] : d[0]) : null;
      return asPhone(first);
    }
    case 'dropleads.people.phone.find':
      return s(b?.status).toLowerCase() === 'found' ? asPhone(b?.mobile_number) : null;
    case 'leadmagic.people.phone.find':
      return asPhone(b?.mobile_number);
    default:
      return null;
  }
}

export function companyEnrichRequest(endpointId: string, row: RowInput): CallShape | null {
  const domain = bareDomain(row.domain);
  switch (endpointId) {
    case 'prospeo.companies.enrich':
      if (domain) return { method: 'POST', params: { data: { company_website: domain } } };
      if (s(row.company_name)) return { method: 'POST', params: { data: { company_name: s(row.company_name) } } };
      return null;
    default:
      return null;
  }
}

/**
 * The company record, normalised to the fields the workspace shows.
 *
 * Provider names are kept under `source` so the profile can say where each
 * figure came from. Fields the provider did not return are absent, never zero.
 */
export function readCompanyEnrich(endpointId: string, body: unknown): Record<string, unknown> | null {
  const b = (body ?? {}) as any;
  if (endpointId !== 'prospeo.companies.enrich') return null;
  if (b?.error === true || !b?.company || !s(b.company.name)) return null;
  const c = b.company;
  const out: Record<string, unknown> = { source: endpointId };
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v) && v.length === 0) return;
    out[k] = v;
  };
  put('name', s(c.name));
  put('domain', bareDomain(c.domain || c.website));
  put('website', s(c.website));
  put('description', s(c.description));
  put('industry', s(c.industry));
  put('type', s(c.type));
  put('employee_count', Number.isFinite(Number(c.employee_count)) && c.employee_count !== null ? Number(c.employee_count) : null);
  put('employee_range', s(c.employee_range));
  put('revenue_range', s(c.revenue_range_printed));
  put('founded', Number.isFinite(Number(c.founded)) && c.founded !== null ? Number(c.founded) : null);
  put('linkedin_url', s(c.linkedin_url));
  put('country', s(c.location?.country));
  put('country_code', s(c.location?.country_code));
  put('state', s(c.location?.state));
  put('city', s(c.location?.city));
  put('keywords', Array.isArray(c.keywords) ? c.keywords.filter((k: unknown) => typeof k === 'string') : []);
  put(
    'technologies',
    Array.isArray(c.technology?.technology_names)
      ? c.technology.technology_names.filter((k: unknown) => typeof k === 'string')
      : [],
  );
  return Object.keys(out).length > 1 ? out : null;
}

// ---------------------------------------------------------------------------
// Decision maker at a known company
// ---------------------------------------------------------------------------

export function personAtCompanyRequest(endpointId: string, domain: string, titles: string[]): CallShape | null {
  const d = bareDomain(domain);
  if (!d) return null;
  const t = titles.map((x) => s(x)).filter(Boolean).slice(0, 10);
  switch (endpointId) {
    case 'icypeas.people.search':
      return {
        method: 'POST',
        params: {
          query: {
            currentCompanyWebsite: { include: [d] },
            ...(t.length ? { currentJobTitle: { include: t } } : {}),
          },
          // Billed per row returned; ten is enough to choose from.
          pagination: { size: 10 },
        },
      };
    case 'findymail.search.employees':
      // job_titles is required; without the user's titles there is nothing to ask.
      if (!t.length) return null;
      return { method: 'POST', params: { website: d, job_titles: t, count: 1 } };
    case 'leadmagic.people.search':
      return { method: 'POST', params: { company_domain: d, ...(t.length ? { titles: t } : {}), limit: 3, include_contact_details: false } };
    default:
      return null;
  }
}

export interface PersonHit {
  name: string;
  title: string | null;
  linkedinUrl: string | null;
  location?: string | null;
}

export function readPeopleAtCompany(endpointId: string, body: unknown): PersonHit[] {
  const b = body as any;
  const out: PersonHit[] = [];
  const push = (name: unknown, title: unknown, li: unknown, loc?: unknown) => {
    const n = s(name);
    if (!n) return;
    out.push({ name: n, title: s(title) || null, linkedinUrl: s(li) || null, location: s(loc) || null });
  };
  switch (endpointId) {
    case 'icypeas.people.search':
      for (const l of Array.isArray(b?.leads) ? b.leads : []) {
        push([s(l?.firstname), s(l?.lastname)].filter(Boolean).join(' '), l?.lastJobTitle || l?.headline, l?.profileUrl, l?.address);
      }
      break;
    case 'findymail.search.employees':
      for (const p of Array.isArray(b) ? b : []) push(p?.name, p?.jobTitle, p?.linkedinUrl);
      break;
    case 'leadmagic.people.search':
      for (const p of Array.isArray(b?.people) ? b.people : []) {
        push(
          p?.full_name ?? [s(p?.first_name), s(p?.last_name)].filter(Boolean).join(' '),
          p?.job_title ?? p?.title,
          p?.profile_url ?? p?.linkedin_url,
        );
      }
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Company discovery from an ICP segment
// ---------------------------------------------------------------------------

export interface SegmentFilters {
  industries?: string[];
  keywords?: string[];
  countries?: string[];
  employeeRange?: [number, number] | number[];
  name?: string;
}

/** Tomba's size buckets, as the reveal search writes them ("10K-50K"). */
const TOMBA_SIZES: Array<[number, number, string]> = [
  [1, 10, '1-10'], [11, 50, '11-50'], [51, 200, '51-200'], [201, 500, '201-500'],
  [501, 1000, '501-1K'], [1001, 5000, '1K-5K'], [5001, 10000, '5K-10K'],
  [10001, 50000, '10K-50K'], [50001, 100000, '50K-100K'], [100001, Number.MAX_SAFE_INTEGER, '100K+'],
];

export function sizeBuckets(lo: number, hi: number): string[] {
  return TOMBA_SIZES.filter(([a, b]) => b >= lo && a <= hi).map(([, , label]) => label);
}

export function companySearchRequest(endpointId: string, seg: SegmentFilters, want: number): CallShape | null {
  const industries = (seg.industries ?? []).map(s).filter(Boolean);
  const keywords = (seg.keywords ?? []).map(s).filter(Boolean);
  const countries = (seg.countries ?? []).map((c) => s(c).toUpperCase()).filter(Boolean);
  const [lo, hi] = (seg.employeeRange ?? []) as number[];
  const hasRange = Number.isFinite(lo) && Number.isFinite(hi);
  // The name stands in only when there is nothing else, as before.
  const kw = keywords.length || industries.length ? keywords : seg.name ? [s(seg.name)] : [];

  switch (endpointId) {
    case 'tomba.companies.search.reveal': {
      const filters: Record<string, unknown> = {};
      if (industries.length) filters.industry = { include: industries };
      if (kw.length) filters.keywords = { include: kw };
      if (countries.length) filters.location_country = { include: countries };
      if (hasRange) filters.size = { include: sizeBuckets(lo, hi) };
      if (!Object.keys(filters).length) return null;
      // One call reveals up to 50; pages are not requested past the first here.
      return { method: 'POST', params: { filters, page: 1 } };
    }
    case 'icypeas.companies.search': {
      const query: Record<string, unknown> = {};
      if (industries.length) query.industry = { include: industries };
      if (kw.length) query.keyword = { include: kw };
      if (countries.length) query.location = { include: countries };
      if (hasRange) query.headcount = { '>=': lo, '<=': hi };
      if (!Object.keys(query).length) return null;
      return { method: 'POST', params: { query, pagination: { size: Math.max(1, Math.min(want, 200)) } } };
    }
    default:
      return null;
  }
}

export interface CompanyHit {
  name: string;
  domain: string;
  logoUrl: string | null;
  industry?: string | null;
  size?: string | null;
  country?: string | null;
}

export function readCompanySearch(endpointId: string, body: unknown): CompanyHit[] {
  const b = body as any;
  const out: CompanyHit[] = [];
  switch (endpointId) {
    case 'tomba.companies.search.reveal':
      for (const c of Array.isArray(b?.data?.companies) ? b.data.companies : []) {
        const domain = bareDomain(c?.website_url);
        if (!domain || !s(c?.name)) continue;
        out.push({ name: s(c.name), domain, logoUrl: null, industry: s(c.industry) || null, size: s(c.company_size) || null, country: s(c.country) || null });
      }
      break;
    case 'icypeas.companies.search':
      for (const c of Array.isArray(b?.leads) ? b.leads : []) {
        const domain = bareDomain(c?.website);
        if (!domain || !s(c?.name)) continue;
        out.push({ name: s(c.name), domain, logoUrl: s(c?.pictureUrl) || null, industry: s(c.industry) || null, size: c?.numberOfEmployees ? String(c.numberOfEmployees) : null, country: null });
      }
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advanced people search (LeadsForge: free search, free count)
// ---------------------------------------------------------------------------
//
// The only documented people search that is free, people-first, and carries
// seniority, department, funding, revenue and technology filters. It returns
// names, titles, locations and firmographics - never an email or phone - so the
// search itself costs nothing and only revealing a contact is paid.

export interface PeopleSearchFilters {
  jobTitles?: string[];
  excludeJobTitles?: string[];
  seniorities?: string[];
  departments?: string[];
  personLocations?: string[];
  companyDomains?: string[];
  companyNames?: string[];
  industries?: string[];
  companyLocations?: string[];
  employeesMin?: number | null;
  employeesMax?: number | null;
  fundingRounds?: string[];
  revenueRanges?: string[];
  technologies?: string[];
  companyKeywords?: string[];
  maxPerCompany?: number | null;
}

const list = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? v.map(s).filter(Boolean).slice(0, max) : [];

/** Cleans untrusted filters from the client into the shape above. */
export function cleanPeopleFilters(raw: unknown): PeopleSearchFilters {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? Math.floor(x) : null;
  };
  return {
    jobTitles: list(r.jobTitles),
    excludeJobTitles: list(r.excludeJobTitles),
    seniorities: list(r.seniorities, 12),
    departments: list(r.departments, 30),
    personLocations: list(r.personLocations),
    companyDomains: list(r.companyDomains, 500).map(bareDomain).filter(Boolean),
    companyNames: list(r.companyNames),
    industries: list(r.industries),
    companyLocations: list(r.companyLocations),
    employeesMin: n(r.employeesMin),
    employeesMax: n(r.employeesMax),
    fundingRounds: list(r.fundingRounds, 20),
    revenueRanges: list(r.revenueRanges, 20),
    technologies: list(r.technologies),
    companyKeywords: list(r.companyKeywords),
    maxPerCompany: n(r.maxPerCompany),
  };
}

export function hasAnyPeopleFilter(f: PeopleSearchFilters): boolean {
  return Boolean(
    f.jobTitles?.length || f.seniorities?.length || f.departments?.length || f.personLocations?.length ||
      f.companyDomains?.length || f.companyNames?.length || f.industries?.length || f.companyLocations?.length ||
      f.employeesMin != null || f.employeesMax != null || f.fundingRounds?.length || f.revenueRanges?.length ||
      f.technologies?.length || f.companyKeywords?.length,
  );
}

/** The LeadsForge body. Shared by search and count, which take the same filters. */
export function leadsforgePeopleBody(
  f: PeopleSearchFilters,
  opts: { limit?: number; excludeEmails?: string[]; excludeDomains?: string[] } = {},
): Record<string, unknown> {
  const inc = (v?: string[], exclude?: string[]) =>
    v && v.length ? { include: v, ...(exclude && exclude.length ? { exclude } : {}) } : undefined;
  const body: Record<string, unknown> = {
    leadJobTitles: inc(f.jobTitles, f.excludeJobTitles),
    leadSeniorities: inc(f.seniorities),
    leadDepartments: inc(f.departments),
    leadLocations: inc(f.personLocations),
    companyDomains: inc(f.companyDomains),
    companyNames: inc(f.companyNames),
    companyIndustries: inc(f.industries),
    companyLocations: inc(f.companyLocations),
    companyFundingRounds: inc(f.fundingRounds),
    companyRevenueRanges: f.revenueRanges && f.revenueRanges.length ? f.revenueRanges : undefined,
    companyTechnologies: f.technologies && f.technologies.length ? { any: f.technologies } : undefined,
    companyKeywords: inc(f.companyKeywords),
    companyEmployeeNumberRange:
      f.employeesMin != null || f.employeesMax != null
        ? { ...(f.employeesMin != null ? { min: f.employeesMin } : {}), ...(f.employeesMax != null ? { max: f.employeesMax } : {}) }
        : undefined,
    maxContactsPerCompany: f.maxPerCompany ?? undefined,
    limit: opts.limit,
    excludeEmails: opts.excludeEmails && opts.excludeEmails.length ? opts.excludeEmails : undefined,
    excludeDomains: opts.excludeDomains && opts.excludeDomains.length ? opts.excludeDomains : undefined,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

export interface SearchPerson {
  leadsforge_id: string;
  first_name: string;
  last_name: string;
  person_name: string;
  title: string | null;
  person_location: string | null;
  company_name: string | null;
  domain: string | null;
  company: {
    employee_count: number | null;
    industry: string | null;
    location: string | null;
    revenue_min: number | null;
    revenue_max: number | null;
    years_in_business: number | null;
  };
}

const place = (loc: any): string | null => {
  if (!loc || typeof loc !== 'object') return null;
  const p = [s(loc.city), s(loc.state), s(loc.country)].filter(Boolean);
  return p.length ? p.join(', ') : null;
};

export function readLeadsforgePeople(body: unknown): { people: SearchPerson[]; cursor: string | null } {
  const b = body as any;
  const people: SearchPerson[] = [];
  for (const l of Array.isArray(b?.leads) ? b.leads : []) {
    const id = s(l?.id);
    const first = s(l?.firstName);
    const last = s(l?.lastName);
    if (!id || !(first || last)) continue;
    const c = l?.company ?? {};
    const num = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
    people.push({
      leadsforge_id: id,
      first_name: first,
      last_name: last,
      person_name: [first, last].filter(Boolean).join(' '),
      title: s(l?.jobTitle) || null,
      person_location: place(l?.location),
      company_name: s(c?.name) || null,
      domain: bareDomain(c?.domain || c?.website) || null,
      company: {
        employee_count: num(c?.employeeCount),
        industry: s(c?.industry) || null,
        location: place(c?.location),
        revenue_min: num(c?.revenueRange?.start),
        revenue_max: num(c?.revenueRange?.end),
        years_in_business: num(c?.yearsInBusiness),
      },
    });
  }
  const cursor = s(b?.cursor) || s(b?.nextCursor) || s(b?.next_cursor) || null;
  return { people, cursor };
}

export function readLeadsforgeCount(body: unknown): number | null {
  const n = Number((body as any)?.totalCount);
  return Number.isFinite(n) ? n : null;
}

/** Filter vocabularies: endpoint, and how to read its values into {value, label}. */
export const FILTER_VOCAB: Record<string, { endpoint: string; params?: Record<string, unknown> }> = {
  seniorities: { endpoint: 'leadsforge.people.search.filters.seniorities' },
  departments: { endpoint: 'leadsforge.people.search.filters.departments' },
  funding: { endpoint: 'leadsforge.people.search.filters.funding_types' },
  revenue: { endpoint: 'leadsforge.people.search.filters.revenue_ranges' },
  company_types: { endpoint: 'leadsforge.people.search.filters.company_types' },
  industries: { endpoint: 'leadsforge.people.search.filters.industries', params: { limit: 100 } },
};

export function readVocab(kind: string, body: unknown): Array<{ value: string; label: string }> {
  const b = body as any;
  const words = (arr: unknown) =>
    (Array.isArray(arr) ? arr : []).map(s).filter(Boolean).map((v) => ({ value: v, label: v.replace(/^master_/, '').replace(/_/g, ' ') }));
  switch (kind) {
    case 'seniorities':
      return words(b?.seniorities);
    case 'departments':
      return words(b?.departments);
    case 'revenue':
      return (Array.isArray(b?.revenueRanges) ? b.revenueRanges : [])
        .filter((r: any) => s(r?.value))
        .map((r: any) => ({ value: s(r.value), label: s(r.display) || s(r.value) }));
    case 'funding':
    case 'company_types':
      return (Array.isArray(b) ? b : [])
        .filter((r: any) => s(r?.id))
        .map((r: any) => ({ value: s(r.id), label: s(r.name) || s(r.id) }));
    case 'industries':
      return (Array.isArray(b) ? b : [])
        .filter((r: any) => s(r?.name))
        .map((r: any) => ({ value: s(r.name), label: s(r.name) }));
    default:
      return [];
  }
}

/** The status a row's address carries, from the verdict it ended with. */
export function statusFor(email: string | null, verdict: Verdict | null): string {
  if (!email) return 'not_found';
  switch (verdict) {
    case 'deliverable':
      return 'verified';
    case 'catch_all':
      return 'catch_all';
    case 'undeliverable':
      return 'invalid';
    case 'disposable':
      return 'disposable';
    case 'unknown':
      return 'unknown';
    default:
      // Nothing checked it. Not 'unknown', which says a verifier tried.
      return 'unchecked';
  }
}
