/**
 * Echo Leads — the endpoint registry
 * ----------------------------------------------------------------------------
 * The waterfall, the estimator and the worker all read this file. Nothing else
 * knows an endpoint id, so a provider swap is a change to one table and nothing
 * in the run logic moves.
 *
 * ---------------------------------------------------------------------------
 * Verified against the catalog, not yet against a live call
 * ---------------------------------------------------------------------------
 * Every entry was checked on 18 Oct 2026 against the public catalog API
 * (GET https://treg.to/catalog/endpoints/{id}): the id exists and is not
 * superseded, and the price, cost type (per call / per hit / per row) and miss
 * policy are the catalog's. Request shapes and response readers live in
 * endpoints.ts, written from each entry's documented inputs and example
 * response, and are tested against those examples.
 *
 * What is still not verified: a real call from this codebase. No Treg token is
 * available to the build, so the first live run is the remaining check, and
 * pricing_config keeps cost_verified = false until api_usage shows real costs.
 * The X-Treg-Cost-Micro header, never this table, is what is recorded as cost.
 *
 * `readHit` is documentation only now; the readers in endpoints.ts are what run.
 */

export type LeadStep = 'company' | 'person' | 'email' | 'verify' | 'phone' | 'enrich' | 'search';

export interface EndpointEntry {
  id: string;
  /** Short name for the chip. */
  label: string;
  step: LeadStep;
  /** The catalog price per unit (call, hit or row), in USD. */
  priceUsd: number;
  /**
   * The most one call can cost. Equal to priceUsd for per-call and per-hit
   * endpoints; for endpoints billed per row returned it is the price times the
   * page size endpoints.ts asks for. Sent as X-Treg-Route-Max-Cost and used for
   * the row cap, because the unit price alone understates a ten-row page tenfold.
   */
  maxCallUsd: number;
  /**
   * True when a miss costs nothing. This is the entire economic idea behind the
   * waterfall: a lead pays only for the provider that found it, so the order runs
   * cheapest-first and a miss is free.
   */
  missIsFree: boolean;
  /** True when a verified public route exists and no provider key is needed. */
  freeRoute: boolean;
  /** Inputs this endpoint needs. Missing ones mean it cannot run for a row. */
  requires: Array<'full_name' | 'first_last' | 'domain' | 'company' | 'linkedin_url' | 'email' | 'phone'>;
  /**
   * Where the answer is in the body. Guessed from the documented shape until a
   * real call confirms it — see the banner above.
   */
  readHit: string;
  /** The provider colour, matched by id prefix in the client. */
  verified: boolean;
  verifiedAt: string | null;
}

/**
 * Stamped on every entry checked against the catalog on 18 Oct 2026: id exists,
 * not superseded, price, cost type, inputs and example response read from
 * GET https://treg.to/catalog/endpoints/{id}. Not a live call from this codebase.
 */
const CATALOG_2026_10_18 = { verified: true, verifiedAt: '2026-10-18' } as const;

type Entry = Omit<EndpointEntry, 'verified' | 'verifiedAt' | 'maxCallUsd'> & { maxCallUsd?: number };
const e = (x: Entry): EndpointEntry => ({ ...x, maxCallUsd: x.maxCallUsd ?? x.priceUsd, ...CATALOG_2026_10_18 });

export const REGISTRY: Record<string, EndpointEntry> = {
  // --- read the site -------------------------------------------------------
  // treg.web.extract is routed: misses on billing children are charged.
  'treg.web.extract': e({ id: 'treg.web.extract', label: 'Web', step: 'company', priceUsd: 0.005, missIsFree: false, freeRoute: false, requires: [], readHit: 'markdown' }),
  'branddev.web.scrape': e({ id: 'branddev.web.scrape', label: 'BrandDev', step: 'company', priceUsd: 0.002534, missIsFree: true, freeRoute: false, requires: [], readHit: 'markdown' }),
  'branddev.brand.retrieve': e({ id: 'branddev.brand.retrieve', label: 'BrandDev', step: 'company', priceUsd: 0.0253, missIsFree: false, freeRoute: false, requires: [], readHit: 'brand' }),

  // --- free counts and the free people search ------------------------------
  'icypeas.companies.search.count': e({ id: 'icypeas.companies.search.count', label: 'Icypeas', step: 'company', priceUsd: 0, missIsFree: true, freeRoute: true, requires: [], readHit: 'total' }),
  'companyenrich.companies.search.count': e({ id: 'companyenrich.companies.search.count', label: 'CompanyEnrich', step: 'company', priceUsd: 0, missIsFree: true, freeRoute: true, requires: [], readHit: 'total' }),
  'icypeas.people.search.count': e({ id: 'icypeas.people.search.count', label: 'Icypeas', step: 'person', priceUsd: 0, missIsFree: true, freeRoute: true, requires: [], readHit: 'total' }),
  'leadsforge.people.search': e({ id: 'leadsforge.people.search', label: 'LeadsForge', step: 'search', priceUsd: 0, missIsFree: true, freeRoute: true, requires: [], readHit: 'leads' }),
  'leadsforge.people.search.count': e({ id: 'leadsforge.people.search.count', label: 'LeadsForge', step: 'search', priceUsd: 0, missIsFree: true, freeRoute: true, requires: [], readHit: 'totalCount' }),

  // --- companies -----------------------------------------------------------
  // Tomba bills one call for up to 50 rows; icypeas bills per row returned.
  'tomba.companies.search.reveal': e({ id: 'tomba.companies.search.reveal', label: 'Tomba', step: 'company', priceUsd: 0.000178, missIsFree: false, freeRoute: false, requires: [], readHit: 'data.companies' }),
  'icypeas.companies.search': e({ id: 'icypeas.companies.search', label: 'Icypeas', step: 'company', priceUsd: 0.00038, maxCallUsd: 0.00038 * 200, missIsFree: true, freeRoute: false, requires: [], readHit: 'leads' }),
  'crustdata.companies.identify': e({ id: 'crustdata.companies.identify', label: 'Crustdata', step: 'company', priceUsd: 0, missIsFree: true, freeRoute: true, requires: ['company'], readHit: 'matches' }),

  // --- decision makers (per person returned; page sizes set in endpoints.ts)
  'icypeas.people.search': e({ id: 'icypeas.people.search', label: 'Icypeas', step: 'person', priceUsd: 0.00038, maxCallUsd: 0.00038 * 10, missIsFree: true, freeRoute: false, requires: ['domain'], readHit: 'leads' }),
  'findymail.search.employees': e({ id: 'findymail.search.employees', label: 'Findymail', step: 'person', priceUsd: 0.0198, missIsFree: true, freeRoute: false, requires: ['domain'], readHit: '[]' }),
  'leadmagic.people.search': e({ id: 'leadmagic.people.search', label: 'LeadMagic', step: 'person', priceUsd: 0.025, maxCallUsd: 0.025 * 3, missIsFree: true, freeRoute: false, requires: ['domain'], readHit: 'people' }),

  // --- the email waterfall, cheapest first; every miss is free ------------
  'quickenrich.people.email.find': e({ id: 'quickenrich.people.email.find', label: 'QuickEnrich', step: 'email', priceUsd: 0.004834, missIsFree: true, freeRoute: false, requires: [], readHit: 'data.email' }),
  'trykitt.people.email.find': e({ id: 'trykitt.people.email.find', label: 'Kitt', step: 'email', priceUsd: 0.005, missIsFree: true, freeRoute: false, requires: ['full_name', 'domain'], readHit: 'email' }),
  'aiark.people.email.find': e({ id: 'aiark.people.email.find', label: 'AI Ark', step: 'email', priceUsd: 0.005267, missIsFree: true, freeRoute: false, requires: ['linkedin_url'], readHit: 'data.email.output' }),
  'tomba.people.email.find': e({ id: 'tomba.people.email.find', label: 'Tomba', step: 'email', priceUsd: 0.0089, missIsFree: true, freeRoute: false, requires: ['full_name', 'domain'], readHit: 'data.email' }),
  'leadsforge.people.email.find': e({ id: 'leadsforge.people.email.find', label: 'LeadsForge', step: 'email', priceUsd: 0.0245, missIsFree: true, freeRoute: false, requires: [], readHit: 'email' }),

  // --- verification --------------------------------------------------------
  // Kitt bills every completed check, invalid included. MillionVerifier bills
  // a definite answer and refunds unknown / catch-all.
  'contactout.people.email.verify': e({ id: 'contactout.people.email.verify', label: 'ContactOut', step: 'verify', priceUsd: 0, missIsFree: true, freeRoute: true, requires: ['email'], readHit: 'data.status' }),
  'trykitt.people.email.verify': e({ id: 'trykitt.people.email.verify', label: 'Kitt', step: 'verify', priceUsd: 0.0015, missIsFree: false, freeRoute: false, requires: ['email'], readHit: 'validity' }),
  'millionverifier.people.email.verify': e({ id: 'millionverifier.people.email.verify', label: 'MillionVerifier', step: 'verify', priceUsd: 0.00178, missIsFree: false, freeRoute: false, requires: ['email'], readHit: 'result' }),

  // --- phone, opt-in only; every finder below bills only a found number ---
  'blitzapi.people.phone.find': e({ id: 'blitzapi.people.phone.find', label: 'BlitzAPI', step: 'phone', priceUsd: 0.000495, missIsFree: true, freeRoute: false, requires: ['linkedin_url'], readHit: 'phone' }),
  'quickenrich.people.phone.find': e({ id: 'quickenrich.people.phone.find', label: 'QuickEnrich', step: 'phone', priceUsd: 0.004834, missIsFree: true, freeRoute: false, requires: [], readHit: 'data.employee_phone' }),
  'aiark.people.phone.find': e({ id: 'aiark.people.phone.find', label: 'AI Ark', step: 'phone', priceUsd: 0.026335, missIsFree: true, freeRoute: false, requires: [], readHit: 'data.data' }),
  'dropleads.people.phone.find': e({ id: 'dropleads.people.phone.find', label: 'Dropleads', step: 'phone', priceUsd: 0.054, missIsFree: true, freeRoute: false, requires: ['linkedin_url'], readHit: 'mobile_number' }),
  'leadmagic.people.phone.find': e({ id: 'leadmagic.people.phone.find', label: 'LeadMagic', step: 'phone', priceUsd: 0.125, missIsFree: true, freeRoute: false, requires: [], readHit: 'mobile_number' }),
  // A line-status check on a number already held, not a finder. Kept out of the
  // phone chain: at the end of it, it could only ever be skipped (a row with no
  // phone cannot supply one).
  'hlrlookup.people.phone.network': e({ id: 'hlrlookup.people.phone.network', label: 'HLR Lookup', step: 'phone', priceUsd: 0.003304, missIsFree: true, freeRoute: false, requires: ['phone'], readHit: 'results' }),

  // --- company data, on demand --------------------------------------------
  'prospeo.companies.enrich': e({ id: 'prospeo.companies.enrich', label: 'Prospeo', step: 'enrich', priceUsd: 0.0245, missIsFree: true, freeRoute: false, requires: [], readHit: 'company' }),
};

// ---------------------------------------------------------------------------
// The default order
// ---------------------------------------------------------------------------
// Cheapest first, per step. The email order is the one that matters: it runs
// until something is found, and a miss is free on all five, so the only cost of
// running it this way is time.

export const DEFAULT_ORDER: Record<LeadStep, string[]> = {
  company: ['tomba.companies.search.reveal', 'icypeas.companies.search'],
  person: ['icypeas.people.search', 'findymail.search.employees', 'leadmagic.people.search'],
  email: [
    'quickenrich.people.email.find',
    'trykitt.people.email.find',
    'aiark.people.email.find',
    'tomba.people.email.find',
    'leadsforge.people.email.find',
  ],
  verify: [
    'contactout.people.email.verify',
    'trykitt.people.email.verify',
    'millionverifier.people.email.verify',
  ],
  phone: [
    'blitzapi.people.phone.find',
    'quickenrich.people.phone.find',
    'aiark.people.phone.find',
    'dropleads.people.phone.find',
    'leadmagic.people.phone.find',
  ],
  enrich: ['prospeo.companies.enrich'],
  search: [],
};

/**
 * What a row can supply to an endpoint.
 *
 * AI Ark's email finder needs a profile URL and most social rows never have one,
 * so it is skipped for them rather than called and missed — a miss is free, but
 * the call still costs a round trip and pollutes the attempt log that the hit
 * rate is computed from.
 */
export function canRunWith(row: {
  person_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  domain?: string | null;
  linkedin_url?: string | null;
  email?: string | null;
  phone?: string | null;
}, entry: EndpointEntry): boolean {
  return entry.requires.every((req) => {
    switch (req) {
      case 'full_name':
        return Boolean((row.person_name ?? '').trim());
      case 'first_last':
        return Boolean((row.first_name ?? '').trim() && (row.last_name ?? '').trim());
      case 'domain':
        return Boolean((row.domain ?? '').trim());
      case 'company':
        return Boolean((row.company_name ?? '').trim());
      case 'linkedin_url':
        return Boolean((row.linkedin_url ?? '').trim());
      case 'email':
        return Boolean((row.email ?? '').trim());
      case 'phone':
        return Boolean((row.phone ?? '').trim());
      default:
        return false;
    }
  });
}

/**
 * The smoothed hit rate for one provider, from this user's own attempts.
 *
 * (hits + 1) / (attempts + 2) is Laplace smoothing. It matters more than it
 * looks: without it a provider that has been tried twice and hit once reads as
 * 50% and a provider tried twice and missed twice reads as 0%, and smart order
 * would then build a ranking out of noise.
 *
 * Returns null below the threshold, because a rate computed from a handful of
 * attempts is not better than the default and should not pretend to be.
 */
export function smoothedHitRate(hits: number, attempts: number): number | null {
  if (attempts < 50) return null;
  return (hits + 1) / (attempts + 2);
}

/**
 * Expected cost per hit, which is what smart order ranks on.
 *
 * Price alone is the wrong ranking: a provider at $0.005 that hits 20% of the
 * time costs more per successful find than one at $0.0089 that hits 80%. Misses
 * on per-success providers are free, so only a provider that bills its misses
 * adds a term — and when it does, that term is what the ranking is really about.
 */
export function expectedCostPerHit(entry: EndpointEntry, hitRate: number): number {
  const missCost = entry.missIsFree ? 0 : entry.priceUsd;
  if (hitRate <= 0 || hitRate >= 1) return entry.priceUsd / Math.max(hitRate, 0.01);
  return entry.priceUsd + (missCost * (1 - hitRate)) / hitRate;
}

/**
 * The order for a step: the user's saved order if they have one, otherwise smart
 * if they have enough history to rank on, otherwise the shipped default.
 *
 * Smart order falls back to the default for any endpoint with no history rather
 * than dropping it, so a newly added provider is tried rather than silently
 * never reached.
 */
export function orderFor(
  step: LeadStep,
  stats: Record<string, { hits: number; attempts: number }>,
  saved: string[] | null,
): EndpointEntry[] {
  const base = DEFAULT_ORDER[step] ?? [];
  const candidates = base.map((id) => REGISTRY[id]).filter(Boolean);

  if (saved && saved.length) {
    // Honour the user's order, then append anything new they have not seen, in
    // default position — so a provider added later is not invisible forever.
    const byId = new Map(candidates.map((e) => [e.id, e]));
    const ordered = saved.map((id) => byId.get(id)).filter(Boolean) as EndpointEntry[];
    for (const e of candidates) if (!ordered.includes(e)) ordered.push(e);
    return ordered;
  }

  const ranked = candidates
    .map((entry) => {
      const s = stats[entry.id] ?? { hits: 0, attempts: 0 };
      const rate = smoothedHitRate(s.hits, s.attempts);
      if (rate === null) return { entry, cost: Number.POSITIVE_INFINITY };
      return { entry, cost: expectedCostPerHit(entry, rate) };
    })
    // Infinity sorts last, and the original index keeps unranked providers in
    // their shipped order among themselves.
    .sort((a, b) => a.cost - b.cost || candidates.indexOf(a.entry) - candidates.indexOf(b.entry))
    .map((r) => r.entry);

  return ranked;
}

/** True when nothing in the file has been checked against the live catalog. */
export function registryFullyVerified(): boolean {
  return Object.values(REGISTRY).every((e) => e.verified);
}
