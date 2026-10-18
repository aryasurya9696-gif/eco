/**
 * Echo Leads — fit scoring
 * ----------------------------------------------------------------------------
 * A score is how well a lead matches the workspace's own rules, out of 100. It
 * is not a probability of anything and is never presented as one.
 *
 * Three rules keep it honest:
 *
 *   Missing data is not evidence. A factor the lead has no data for is left out
 *   of both sides of the fraction, so a lead with no known industry is scored
 *   on what is known rather than marked down for what is not.
 *
 *   Too little data is said, not hidden. When the factors that could be checked
 *   carry less than a third of the total weight, the label says so and no number
 *   is given.
 *
 *   Every point has a reason. The caller stores the reasons and the UI shows them.
 *
 * No imports, so the Node test harness can compile it alone.
 */

export type Seniority =
  | 'c_suite' | 'founder' | 'owner' | 'partner' | 'vp' | 'head' | 'director' | 'manager' | 'senior' | 'entry';

export interface ScoringRules {
  titles: { include: string[]; weight: number };
  seniority: { levels: Seniority[]; weight: number };
  industries: { include: string[]; weight: number };
  employees: { min: number | null; max: number | null; weight: number };
  locations: { include: string[]; weight: number };
  email: { weight: number };
  phone: { weight: number };
  thresholds: { strong: number; possible: number };
}

export interface ScoreReason {
  factor: string;
  points: number;
  max: number;
  note: string;
}

export interface ScoreResult {
  score: number | null;
  label: 'Strong fit' | 'Possible fit' | 'Weak fit' | 'Not enough data';
  reasons: ScoreReason[];
  /** Share of the configured weight that could be evaluated, 0..1. */
  coverage: number;
}

/** The lead as the scorer sees it. All optional: absence is the normal case. */
export interface ScorableLead {
  title?: string | null;
  location?: string | null;
  email_status?: string | null;
  phone?: string | null;
  attributes?: Record<string, unknown> | null;
  company?: Record<string, unknown> | null;
}

export const DEFAULT_RULES: ScoringRules = {
  titles: { include: [], weight: 25 },
  seniority: { levels: ['c_suite', 'founder', 'owner', 'partner', 'vp', 'head', 'director'], weight: 15 },
  industries: { include: [], weight: 15 },
  employees: { min: null, max: null, weight: 15 },
  locations: { include: [], weight: 10 },
  email: { weight: 15 },
  phone: { weight: 5 },
  thresholds: { strong: 70, possible: 40 },
};

const SENIORITY_ORDER: Seniority[] = [
  'c_suite', 'founder', 'owner', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry',
];

const words = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];
const weight = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : d;
};
const optNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Cleans rules from the client into a valid set, falling back per field. */
export function cleanRules(raw: unknown): ScoringRules {
  const r = (raw ?? {}) as Record<string, any>;
  const d = DEFAULT_RULES;
  const strong = weight(r.thresholds?.strong, d.thresholds.strong);
  const possible = Math.min(weight(r.thresholds?.possible, d.thresholds.possible), strong);
  return {
    titles: { include: words(r.titles?.include).slice(0, 50), weight: weight(r.titles?.weight, d.titles.weight) },
    seniority: {
      levels: words(r.seniority?.levels).filter((x): x is Seniority => (SENIORITY_ORDER as string[]).includes(x)),
      weight: weight(r.seniority?.weight, d.seniority.weight),
    },
    industries: { include: words(r.industries?.include).slice(0, 50), weight: weight(r.industries?.weight, d.industries.weight) },
    employees: {
      min: optNum(r.employees?.min),
      max: optNum(r.employees?.max),
      weight: weight(r.employees?.weight, d.employees.weight),
    },
    locations: { include: words(r.locations?.include).slice(0, 50), weight: weight(r.locations?.weight, d.locations.weight) },
    email: { weight: weight(r.email?.weight, d.email.weight) },
    phone: { weight: weight(r.phone?.weight, d.phone.weight) },
    thresholds: { strong, possible },
  };
}

/**
 * Rules seeded from an ICP segment, so a workspace that wrote a profile gets a
 * useful score before it opens the settings.
 */
export function rulesFromSegment(seg: {
  targetTitles?: unknown;
  industries?: unknown;
  countries?: unknown;
  employeeRange?: unknown;
} | null | undefined): ScoringRules {
  const range = Array.isArray(seg?.employeeRange) ? (seg!.employeeRange as unknown[]) : [];
  return cleanRules({
    ...DEFAULT_RULES,
    titles: { include: words(seg?.targetTitles), weight: DEFAULT_RULES.titles.weight },
    industries: { include: words(seg?.industries), weight: DEFAULT_RULES.industries.weight },
    locations: { include: words(seg?.countries), weight: DEFAULT_RULES.locations.weight },
    employees: { min: optNum(range[0]), max: optNum(range[1]), weight: DEFAULT_RULES.employees.weight },
  });
}

/** Seniority from a provider attribute when present, otherwise from the title. */
export function seniorityOf(title: string | null | undefined, attr?: unknown): Seniority | null {
  const a = typeof attr === 'string' ? attr.toLowerCase().replace(/[\s-]+/g, '_') : '';
  if ((SENIORITY_ORDER as string[]).includes(a)) return a as Seniority;
  if (a === 'cxo' || a === 'c_level' || a === 'c_team') return 'c_suite';

  const t = ` ${String(title ?? '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ')} `;
  if (t.trim() === '') return null;
  if (/ (ceo|cto|cfo|coo|cmo|cro|cio|ciso|cpo|chief|president) /.test(t)) return 'c_suite';
  if (/ (co ?founder|founder) /.test(t)) return 'founder';
  if (/ owner /.test(t)) return 'owner';
  if (/ (managing )?partner /.test(t)) return 'partner';
  if (/ (vp|svp|evp|vice president) /.test(t)) return 'vp';
  if (/ head /.test(t)) return 'head';
  if (/ director /.test(t)) return 'director';
  if (/ (manager|lead|supervisor) /.test(t)) return 'manager';
  if (/ (senior|sr|principal|staff) /.test(t)) return 'senior';
  if (/ (intern|junior|jr|assistant|associate|trainee) /.test(t)) return 'entry';
  return null;
}

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');

function headcount(lead: ScorableLead): number | null {
  const c = lead.company ?? {};
  const a = (lead.attributes?.company ?? {}) as Record<string, unknown>;
  for (const v of [c.employee_count, a.employee_count]) {
    const n = optNum(v);
    if (n !== null) return n;
  }
  // "51-200" -> midpoint; "1001-2000" style ranges from enrichment.
  const range = String(c.employee_range ?? '').match(/(\d[\d,]*)\s*-\s*(\d[\d,]*)/);
  if (range) {
    const lo = Number(range[1].replace(/,/g, ''));
    const hi = Number(range[2].replace(/,/g, ''));
    if (Number.isFinite(lo) && Number.isFinite(hi)) return Math.round((lo + hi) / 2);
  }
  return null;
}

function industryOf(lead: ScorableLead): string {
  const c = lead.company ?? {};
  const a = (lead.attributes?.company ?? {}) as Record<string, unknown>;
  return lower(c.industry) || lower(a.industry);
}

function placeOf(lead: ScorableLead): string {
  const c = lead.company ?? {};
  const a = (lead.attributes?.company ?? {}) as Record<string, unknown>;
  return [lead.location, c.country, c.country_code, c.city, c.state, a.location]
    .map(lower)
    .filter(Boolean)
    .join(' | ');
}

const COUNTRY_ALIASES: Record<string, string[]> = {
  us: ['united states', 'usa'], gb: ['united kingdom', 'uk', 'england', 'scotland', 'wales'],
  uk: ['united kingdom', 'england'], ca: ['canada'], au: ['australia'], ie: ['ireland'],
  in: ['india'], de: ['germany'], fr: ['france'], nl: ['netherlands'], es: ['spain'],
};

function placeMatches(place: string, wanted: string): boolean {
  const w = wanted.toLowerCase().trim();
  if (!w) return false;
  const parts = place.split(' | ');
  if (w.length === 2) {
    // An ISO code: match the code exactly or the country name it stands for.
    if (parts.includes(w)) return true;
    return (COUNTRY_ALIASES[w] ?? []).some((n) => place.includes(n));
  }
  return place.includes(w);
}

export function scoreLead(lead: ScorableLead, rules: ScoringRules): ScoreResult {
  const reasons: ScoreReason[] = [];
  let configured = 0;
  let possible = 0;
  let earned = 0;

  const factor = (name: string, w: number, active: boolean, evaluate: () => { frac: number; note: string } | null) => {
    if (!active || w <= 0) return;
    configured += w;
    const r = evaluate();
    if (!r) return; // no data: not counted either way
    possible += w;
    const pts = Math.round(w * Math.max(0, Math.min(1, r.frac)));
    earned += pts;
    reasons.push({ factor: name, points: pts, max: w, note: r.note });
  };

  factor('Title', rules.titles.weight, rules.titles.include.length > 0, () => {
    const t = lower(lead.title);
    if (!t) return null;
    const hit = rules.titles.include.find((x) => t.includes(x.toLowerCase()));
    return hit ? { frac: 1, note: `Title matches "${hit}"` } : { frac: 0, note: 'Title is not one of your target titles' };
  });

  factor('Seniority', rules.seniority.weight, rules.seniority.levels.length > 0, () => {
    const s = seniorityOf(lead.title, lead.attributes?.seniority);
    if (!s) return null;
    const ok = rules.seniority.levels.includes(s);
    return { frac: ok ? 1 : 0, note: ok ? `Seniority: ${s.replace('_', ' ')}` : `Seniority ${s.replace('_', ' ')} is outside your target` };
  });

  factor('Industry', rules.industries.weight, rules.industries.include.length > 0, () => {
    const ind = industryOf(lead);
    if (!ind) return null;
    const hit = rules.industries.include.find((x) => ind.includes(x.toLowerCase()) || x.toLowerCase().includes(ind));
    return hit ? { frac: 1, note: `Industry: ${ind}` } : { frac: 0, note: `Industry ${ind} is not a target` };
  });

  factor('Company size', rules.employees.weight, rules.employees.min !== null || rules.employees.max !== null, () => {
    const n = headcount(lead);
    if (n === null) return null;
    const lo = rules.employees.min ?? 0;
    const hi = rules.employees.max ?? Number.POSITIVE_INFINITY;
    const ok = n >= lo && n <= hi;
    return { frac: ok ? 1 : 0, note: ok ? `About ${n} employees, in range` : `About ${n} employees, outside your range` };
  });

  factor('Location', rules.locations.weight, rules.locations.include.length > 0, () => {
    const p = placeOf(lead);
    if (!p) return null;
    const hit = rules.locations.include.find((x) => placeMatches(p, x));
    return hit ? { frac: 1, note: `Located in a target region (${hit})` } : { frac: 0, note: 'Outside your target locations' };
  });

  factor('Email', rules.email.weight, true, () => {
    switch (lead.email_status) {
      case 'verified':
        return { frac: 1, note: 'Verified work email' };
      case 'catch_all':
        return { frac: 0.5, note: 'Catch-all domain: deliverability cannot be confirmed' };
      case 'unknown':
        return { frac: 0.25, note: 'Verifier could not decide' };
      case 'invalid':
      case 'disposable':
        return { frac: 0, note: `Email is ${lead.email_status}` };
      default:
        return null; // no address, or never checked
    }
  });

  factor('Phone', rules.phone.weight, true, () => (lead.phone ? { frac: 1, note: 'Phone number on file' } : null));

  const coverage = configured > 0 ? possible / configured : 0;
  if (possible === 0 || coverage < 1 / 3) {
    return { score: null, label: 'Not enough data', reasons, coverage: round2(coverage) };
  }

  const score = Math.round((100 * earned) / possible);
  const label = score >= rules.thresholds.strong ? 'Strong fit' : score >= rules.thresholds.possible ? 'Possible fit' : 'Weak fit';
  return { score, label, reasons, coverage: round2(coverage) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
