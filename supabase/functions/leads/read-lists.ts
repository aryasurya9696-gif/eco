/**
 * Reading a list of companies out of a provider response.
 *
 * A company search returns many results where the email find returns one, so
 * this is the one reader that has to decide how many of them are real. It takes
 * the first MAX_COMPANIES that carry a domain, because the alternative — one call
 * per company — is a round trip per lead before a single person has been found.
 *
 * The domain is what a row is keyed on, so a result without one is not a company
 * this pipeline can work on. It may well be a real company; it is not one this
 * run can use, and keeping it would produce a row that the person and email steps
 * both refuse, which is a row that costs the discovery call and delivers nothing.
 */

const MAX_COMPANIES = 200;

export interface CompanyHit {
  name: string | null;
  domain: string | null;
  logoUrl: string | null;
  /** Anything else the provider returned, kept for the enriched view. */
  extra: Record<string, unknown>;
}

/**
 * A company's own name.
 *
 * `title` belongs here and not in the person list. Several company shapes call
 * the company name "title" — it is the headline of a search result — and it is
 * the same word that means a job title everywhere else.
 */
const COMPANY_NAME_KEYS = ['name', 'company_name', 'companyName', 'organisation', 'organization', 'title', 'legal_name'];

/**
 * A person's own name.
 *
 * `full_name` is the most common spelling any of these providers use and it was
 * missing, so every person came back nameless and was discarded — the run
 * finished with no decision makers and no indication why.
 *
 * No `title` here. Deliberately: it is a job title, and reading it as a name
 * produces a lead called "Founder".
 */
const PERSON_NAME_KEYS = ['name', 'full_name', 'fullName', 'person_name', 'contact_name', 'display_name'];
const DOMAIN_KEYS = ['domain', 'website_domain', 'company_domain', 'website', 'url', 'primary_domain', 'domain_name'];
const LOGO_KEYS = ['logo', 'logo_url', 'logoUrl', 'image', 'logo_src'];

/**
 * The result list, however deeply the provider buried it.
 *
 * Two levels, because `{ data: { results: [...] } }` and
 * `{ data: { results: { items: [...] } } }` are both shapes in the wild and both
 * were being read as no results — which looks exactly like a search that found
 * nothing, and produces a run that completes with zero leads and no error.
 *
 * Stops at the first array found rather than collecting every array in the body:
 * a page of results is the one thing here worth having, and the rest is usually
 * facets and counts.
 */
function findList(root: Record<string, unknown>): unknown[] {
  let frontier: Record<string, unknown>[] = [root];

  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: Record<string, unknown>[] = [];

    for (const node of frontier) {
      for (const k of LIST_KEYS) {
        const v = node[k];
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') next.push(v as Record<string, unknown>);
      }
    }

    frontier = next;
  }

  return [];
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function asDomain(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (!s) return null;

  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0].split(':')[0].trim();

  // A bare word is not a domain, and passing "Accounting" as one would send every
  // person and email lookup at a host that does not exist.
  if (!s.includes('.') || s.endsWith('.') || !/^[a-z0-9.-]+$/.test(s)) return null;
  return s;
}

function asName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, 200);
  return t === '' ? null : t;
}

/**
 * The keys a provider is likely to wrap its result list in.
 *
 * Checked because the shape is unverified for every endpoint in the registry, and
 * an empty result is indistinguishable from a search that found nothing — which is
 * the difference between "your filters are wrong" and "we called the wrong thing".
 */
const LIST_KEYS = [
  'results', 'data', 'companies', 'items', 'records', 'matches', 'hits',
  'accounts', 'rows', 'list', 'payload',
];

export function readCompanies(body: unknown): CompanyHit[] {
  if (!body || typeof body !== 'object') return [];

  // A bare array as the whole body. Some providers return one, and an array is an
  // object, so the wrapper search below would look for "results" and find nothing.
  if (Array.isArray(body)) return companiesFrom(body);

  const root = body as Record<string, unknown>;
  const list = findList(root);

  if (list.length === 0 && asDomain(pick(root, DOMAIN_KEYS)) !== null) {
    // A single company object rather than a list.
    return companiesFrom([root]);
  }

  return companiesFrom(list);
}

function companiesFrom(list: unknown[]): CompanyHit[] {
  const out: CompanyHit[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (out.length >= MAX_COMPANIES) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const o = item as Record<string, unknown>;
    const domain = asDomain(pick(o, DOMAIN_KEYS));
    if (!domain) continue;

    // Deduplicated on the domain, because the providers overlap and two rows for
    // one company is one row's worth of person and email lookups spent for
    // nothing.
    if (seen.has(domain)) continue;
    seen.add(domain);

    const logo = pick(o, LOGO_KEYS);

    out.push({
      name: asName(pick(o, COMPANY_NAME_KEYS)),
      domain,
      logoUrl: typeof logo === 'string' && logo.trim() !== '' ? logo.trim().slice(0, 400) : null,
      extra: o,
    });
  }

  return out;
}

/**
 * People at a company.
 *
 * Kept separate from readCompanies because a provider that returns people does not
 * necessarily return companies, and the two have different shapes. This one does
 * not require a domain on each result — the domain is what was searched for.
 */
export interface PersonHit {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  linkedinUrl: string | null;
}

const TITLE_KEYS = ['title', 'job_title', 'jobTitle', 'position', 'role', 'seniority', 'job'];
const LINKEDIN_KEYS = ['linkedin', 'linkedin_url', 'linkedinUrl', 'profile_url', 'linkedin_profile'];

function splitName(full: string | null): { first: string | null; last: string | null } {
  if (!full) return { first: null, last: null };
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts[parts.length - 1] };
}

export function readPeople(body: unknown): PersonHit[] {
  if (!body || typeof body !== 'object') return [];

  if (Array.isArray(body)) return peopleFrom(body);

  const root = body as Record<string, unknown>;
  const list = findList(root);

  if (list.length === 0 && pick(root, PERSON_NAME_KEYS) !== undefined) {
    return peopleFrom([root]);
  }

  return peopleFrom(list);
}

function peopleFrom(list: unknown[]): PersonHit[] {
  const out: PersonHit[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (out.length >= 25) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const o = item as Record<string, unknown>;

    const full = asName(pick(o, PERSON_NAME_KEYS));
    const first = asName(pick(o, ['first_name', 'firstName', 'firstname']));
    const last = asName(pick(o, ['last_name', 'lastName', 'lastname', 'surname']));

    // A person with no name at all is not somebody the email step can look up:
    // every email endpoint here keys on a name or a LinkedIn URL.
    const linkedin = pick(o, LINKEDIN_KEYS);
    const hasIdentity = Boolean(full) || Boolean(first) || (Boolean(linkedin) && typeof linkedin === 'string');
    if (!hasIdentity) continue;

    const name = full ?? (first && last ? `${first} ${last}` : first ?? last);
    const key = (name ?? '').toLowerCase().trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);

    const { first: f2, last: l2 } = splitName(name);

    out.push({
      name,
      firstName: first ?? f2,
      lastName: last ?? l2,
      title: asName(pick(o, TITLE_KEYS)),
      linkedinUrl: typeof linkedin === 'string' && linkedin.trim() !== '' ? linkedin.trim().slice(0, 300) : null,
    });
  }

  return out;
}

/**
 * A phone number.
 *
 * Only digits and the usual separators survive. A provider that returns a
 * formatted string is normal and a provider that returns a link or a tracking id
 * is not, and putting the second into a dial column is worse than putting nothing.
 */
export function readPhone(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;

  const root = body as Record<string, unknown>;
  const KEYS = ['phone', 'phone_number', 'phoneNumber', 'mobile', 'telephone', 'number', 'contact_number', 'direct_dial'];

  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  let found: string | null = null;

  while (queue.length && queue.length < 300 && !found) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    for (const k of KEYS) {
      const v = (cur as Record<string, unknown>)[k];
      if (typeof v !== 'string') continue;
      // A URL with digits in it is a tracking link, not a telephone number, and
      // its digits pass every length test. Several providers return the tracking
      // URL when they mean the number, which puts a link in a dial column.
      if (/^(https?:)?\/\//i.test(v.trim()) || v.includes('/')) continue;

      const digits = v.replace(/[^\d+]/g, '');
      // Too short to dial, and long enough to be a tracking id rather than a
      // number. Both are filtered here rather than in the column, because a
      // number that reaches the table is a number the export will contain.
      const digitCount = digits.replace(/\D/g, '').length;
      if (digitCount >= 7 && digitCount <= 15) {
        found = digits.slice(0, 20);
        break;
      }
    }

    for (const v of Object.values(cur as Record<string, unknown>)) {
      if (v && typeof v === 'object') queue.push(v);
    }
  }

  return found;
}

/**
 * A company record for the enriched view.
 *
 * Flattened to a depth of two because the table shows it as key-value pairs and a
 * nested object renders as [object Object], which is worse than showing nothing.
 */
export function readCompanyRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;

  const out: Record<string, unknown> = {};
  const seen = new Set<unknown>();
  const queue: Array<{ v: unknown; depth: number }> = [{ v: body, depth: 0 }];

  while (queue.length && queue.length < 400) {
    const { v, depth } = queue.shift()!;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);

    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null || val === undefined || val === '') continue;
      if (typeof val === 'string') {
        const t = val.trim();
        if (t !== '' && t.length <= 300) out[k] = t;
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        out[k] = val;
      } else if (depth < 2) {
        queue.push({ v: val, depth: depth + 1 });
      }
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}