/**
 * Echo Leads — the endpoint registry
 * ----------------------------------------------------------------------------
 * The waterfall, the estimator and the worker all read this file. Nothing else
 * knows an endpoint id, so a provider swap is a change to one table and nothing
 * in the run logic moves.
 *
 * ---------------------------------------------------------------------------
 * NOT VERIFIED — read this before trusting a single line of the price column
 * ---------------------------------------------------------------------------
 * Every entry below carries `verified: false`. These ids, parameters and prices
 * come from a catalog snapshot, and none of them has been checked against
 * catalog_get or against a real response. A `false` here is the whole point of
 * the flag: the seed prices in pricing_config are also marked cost_verified =
 * false for the same reason, and an unverified price presented as a measured one
 * is the exact failure the rest of the billing design refuses to commit.
 *
 * Two consequences while they stay unverified:
 *
 *   - `readHit` is a guess at where the answer sits in the body. It is written
 *     per endpoint from the shape each provider is documented to use, and the
 *     first real call is the only thing that confirms it. A wrong guess produces
 *     a miss, which costs nothing on a per-success provider — but on an endpoint
 *     that bills misses it would charge for a call that never looked.
 *   - `priceUsd` is what the *snapshot* said. The row cap is what actually
 *     protects the balance, because it is enforced by the provider rather than by
 *     our arithmetic.
 *
 * To verify: read each endpoint's parameters, price and response shape with
 * catalog_get, fill in `verified: true` and `verifiedAt`, and correct readHit.
 */

export type LeadStep = 'company' | 'person' | 'email' | 'verify' | 'phone' | 'enrich';

export interface EndpointEntry {
  id: string;
  /** Short name for the chip. */
  label: string;
  step: LeadStep;
  /** What the catalog snapshot said this costs per hit, in USD. */
  priceUsd: number;
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

/** Format the verified flag stamps once, so every entry reads the same way. */
const UNVERIFIED = { verified: false, verifiedAt: null } as const;

export const REGISTRY: Record<string, EndpointEntry> = {
  // --- read the site -------------------------------------------------------
  'treg.web.extract': {
    id: 'treg.web.extract',
    label: 'Web',
    step: 'company',
    priceUsd: 0.005,
    missIsFree: false, // routed: a miss can bill
    freeRoute: true,
    requires: [],
    readHit: 'markdown',
    ...UNVERIFIED,
  },
  'branddev.web.scrape': {
    id: 'branddev.web.scrape',
    label: 'BrandDev',
    step: 'company',
    priceUsd: 0.0025,
    missIsFree: false,
    freeRoute: false,
    requires: [],
    readHit: 'markdown',
    ...UNVERIFIED,
  },
  'branddev.brand.retrieve': {
    id: 'branddev.brand.retrieve',
    label: 'BrandDev',
    step: 'company',
    priceUsd: 0.025,
    missIsFree: false,
    freeRoute: false,
    requires: [],
    readHit: 'brand',
    ...UNVERIFIED,
  },

  // --- free counts, shown before anything is spent -------------------------
  'icypeas.companies.search.count': {
    id: 'icypeas.companies.search.count',
    label: 'Icypeas',
    step: 'company',
    priceUsd: 0,
    missIsFree: true,
    freeRoute: true,
    requires: [],
    readHit: 'count',
    ...UNVERIFIED,
  },
  'companyenrich.companies.search.count': {
    id: 'companyenrich.companies.search.count',
    label: 'CompanyEnrich',
    step: 'company',
    priceUsd: 0,
    missIsFree: true,
    freeRoute: true,
    requires: [],
    readHit: 'count',
    ...UNVERIFIED,
  },
  'icypeas.people.search.count': {
    id: 'icypeas.people.search.count',
    label: 'Icypeas',
    step: 'person',
    priceUsd: 0,
    missIsFree: true,
    freeRoute: true,
    requires: [],
    readHit: 'count',
    ...UNVERIFIED,
  },

  // --- companies -----------------------------------------------------------
  'tomba.companies.search.reveal': {
    id: 'tomba.companies.search.reveal',
    label: 'Tomba',
    step: 'company',
    priceUsd: 0.000178,
    missIsFree: false,
    freeRoute: false,
    requires: [],
    readHit: 'companies',
    ...UNVERIFIED,
  },
  'icypeas.companies.search': {
    id: 'icypeas.companies.search',
    label: 'Icypeas',
    step: 'company',
    priceUsd: 0.00038,
    missIsFree: false,
    freeRoute: false,
    requires: [],
    readHit: 'companies',
    ...UNVERIFIED,
  },
  'crustdata.companies.identify': {
    id: 'crustdata.companies.identify',
    label: 'Crustdata',
    step: 'company',
    priceUsd: 0,
    missIsFree: true,
    freeRoute: true,
    requires: ['company'],
    readHit: 'domain',
    ...UNVERIFIED,
  },

  // --- decision makers ------------------------------------------------------
  'icypeas.people.search': {
    id: 'icypeas.people.search',
    label: 'Icypeas',
    step: 'person',
    priceUsd: 0.00038,
    missIsFree: false,
    freeRoute: false,
    requires: ['domain'],
    readHit: 'people',
    ...UNVERIFIED,
  },
  'findymail.search.employees': {
    id: 'findymail.search.employees',
    label: 'Findymail',
    step: 'person',
    priceUsd: 0.0198,
    missIsFree: false,
    freeRoute: false,
    requires: ['domain'],
    readHit: 'people',
    ...UNVERIFIED,
  },
  'leadmagic.people.search': {
    id: 'leadmagic.people.search',
    label: 'LeadMagic',
    step: 'person',
    priceUsd: 0.025,
    missIsFree: false,
    freeRoute: false,
    requires: ['domain'],
    readHit: 'people',
    ...UNVERIFIED,
  },

  // --- the email waterfall, cheapest first --------------------------------
  'quickenrich.people.email.find': {
    id: 'quickenrich.people.email.find',
    label: 'QuickEnrich',
    step: 'email',
    priceUsd: 0.0048,
    missIsFree: true,
    freeRoute: false,
    requires: ['full_name'],
    readHit: 'email',
    ...UNVERIFIED,
  },
  'trykitt.people.email.find': {
    id: 'trykitt.people.email.find',
    label: 'Kitt',
    step: 'email',
    priceUsd: 0.005,
    missIsFree: true,
    freeRoute: false,
    requires: ['full_name', 'domain'],
    readHit: 'email',
    ...UNVERIFIED,
  },
  'aiark.people.email.find': {
    id: 'aiark.people.email.find',
    label: 'AI Ark',
    step: 'email',
    priceUsd: 0.0053,
    missIsFree: true,
    freeRoute: false,
    requires: ['linkedin_url'],
    readHit: 'email',
    ...UNVERIFIED,
  },
  'tomba.people.email.find': {
    id: 'tomba.people.email.find',
    label: 'Tomba',
    step: 'email',
    priceUsd: 0.0089,
    missIsFree: true,
    freeRoute: false,
    requires: ['full_name', 'domain'],
    readHit: 'email',
    ...UNVERIFIED,
  },
  'leadsforge.people.email.find': {
    id: 'leadsforge.people.email.find',
    label: 'LeadsForge',
    step: 'email',
    priceUsd: 0.0245,
    missIsFree: true,
    freeRoute: false,
    requires: [],
    readHit: 'email',
    ...UNVERIFIED,
  },

  // --- verification --------------------------------------------------------
  'contactout.people.email.verify': {
    id: 'contactout.people.email.verify',
    label: 'ContactOut',
    step: 'verify',
    priceUsd: 0,
    missIsFree: true,
    freeRoute: true,
    requires: ['email'],
    readHit: 'verdict',
    ...UNVERIFIED,
  },
  'trykitt.people.email.verify': {
    id: 'trykitt.people.email.verify',
    label: 'Kitt',
    step: 'verify',
    priceUsd: 0.0015,
    missIsFree: false,
    freeRoute: false,
    requires: ['email'],
    readHit: 'verdict',
    ...UNVERIFIED,
  },
  'millionverifier.people.email.verify': {
    id: 'millionverifier.people.email.verify',
    label: 'MillionVerifier',
    step: 'verify',
    priceUsd: 0.00178,
    missIsFree: false,
    freeRoute: false,
    requires: ['email'],
    readHit: 'verdict',
    ...UNVERIFIED,
  },

  // --- phone, opt-in only --------------------------------------------------
  'aiark.people.phone.find': {
    id: 'aiark.people.phone.find',
    label: 'AI Ark',
    step: 'phone',
    priceUsd: 0.026,
    missIsFree: false,
    freeRoute: false,
    requires: [],
    readHit: 'phone',
    ...UNVERIFIED,
  },
  'dropleads.people.phone.find': {
    id: 'dropleads.people.phone.find',
    label: 'Dropleads',
    step: 'phone',
    priceUsd: 0.054,
    missIsFree: false,
    freeRoute: false,
    requires: [],
    readHit: 'phone',
    ...UNVERIFIED,
  },
  'leadmagic.people.phone.find': {
    id: 'leadmagic.people.phone.find',
    label: 'LeadMagic',
    step: 'phone',
    priceUsd: 0.125,
    missIsFree: false,
    freeRoute: false,
    requires: [],
    readHit: 'phone',
    ...UNVERIFIED,
  },
  'hlrlookup.people.phone.network': {
    id: 'hlrlookup.people.phone.network',
    label: 'HLR Lookup',
    step: 'phone',
    priceUsd: 0.0033,
    missIsFree: false,
    freeRoute: false,
    requires: ['phone'],
    readHit: 'live',
    ...UNVERIFIED,
  },

  // --- company data, on demand --------------------------------------------
  'prospeo.companies.enrich': {
    id: 'prospeo.companies.enrich',
    label: 'Prospeo',
    step: 'enrich',
    priceUsd: 0.0245,
    missIsFree: false,
    freeRoute: false,
    requires: ['domain'],
    readHit: 'company',
    ...UNVERIFIED,
  },
};

// ---------------------------------------------------------------------------
// The default order
// ---------------------------------------------------------------------------
// Cheapest first, per step. The email order is the one that matters: it runs
// until something is found, and a miss is free on all five, so the only cost of
// running it this way is time.

const DEFAULT_ORDER: Record<LeadStep, string[]> = {
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
  phone: ['aiark.people.phone.find', 'dropleads.people.phone.find', 'leadmagic.people.phone.find', 'hlrlookup.people.phone.network'],
  enrich: ['prospeo.companies.enrich'],
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
