/**
 * Turning an ICP into rows.
 *
 * A find run is created with no rows. The comment in workRun says the first chunk
 * has to make them, and nothing did — so claimRows found nothing, finishRun
 * marked the run done, and the user watched a search complete in under a second
 * with zero leads and no error. Everything downstream of this file was correct
 * and unreachable.
 *
 * The company search is also where `leads.company.found` is charged, once per
 * company created. processRow does not charge it again: the two are different
 * moments — a search that returns a thousand companies to pick fifty from is not
 * fifty companies' worth of work, and a search that returns ten is not ten
 * thousand. What is sold is the company delivered, so that is what is charged.
 */

import { type LeadStep, type EndpointEntry } from './registry.ts';
import { tregCallWithRetry, type TregConfig, type LeadOutcome } from './treg.ts';
import { readCompanies, type CompanyHit } from './read-lists.ts';
import { round6 } from './pricing-row.ts';

/** One company search call and what it produced. */
export interface SeedResult {
  inserted: number;
  costUsd: number;
  /** Credits earned, at the per-company price. */
  credits: number;
  /** Set when the run cannot be searched at all, rather than finding nothing. */
  error?: 'no_icp' | 'no_query' | 'bad_range';
}

/**
 * One discovery call, in the shape the margin write needs.
 *
 * Carries the treg result rather than just its cost, because api_usage is keyed
 * on a unique idempotency_key and the only string guaranteed to match the call
 * that was actually made is the one it was made with.
 */
export interface DiscoveryAttempt {
  endpointId: string;
  step: LeadStep;
  costUsd: number;
  hit: boolean;
  idempotencyKey: string;
  httpStatus: number;
  outcome: LeadOutcome;
  callId: string | null;
  error?: string;
}

/** What a segment can be searched for, in one place. */
export interface SearchableSegment {
  industries?: string[] | null;
  keywords?: string[] | null;
  countries?: string[] | null;
  targetTitles?: string[] | null;
  employeeRange?: [number, number] | null;
  name?: string | null;
}

/**
 * The query for a company search.
 *
 * A guess at the parameter names, because no endpoint in the registry has been
 * called against a live response. Sending several spellings of the same filter is
 * deliberate: an endpoint that ignores an unknown key costs nothing extra, and an
 * endpoint that only understands `limit` would otherwise return its default page
 * of twenty and the run would fill with whatever was at the top of it.
 *
 * Keywords are the query. An industry taxonomy is not a string and the providers
 * disagree about what they accept for one, so industries go as their own field
 * and the keywords do the work of narrowing.
 */
export function companyQuery(seg: SearchableSegment, want: number): Record<string, unknown> {
  const industries = (seg.industries ?? []).filter(Boolean);
  const keywords = (seg.keywords ?? []).filter(Boolean);
  const [lo, hi] = seg.employeeRange ?? [];

  // Both, because a user who filled in one often means the other and a search
  // that drops half the form silently is a search that returns the wrong people.
  let text = [...keywords, ...industries].join(' ').trim();

  // The name, only when there is nothing else to search with.
  //
  // This was a refusal instead: a profile with a name and no keywords was treated
  // as unsearchable and the run failed with "add an industry or keyword". But the
  // name is what the user typed to describe their buyer - "UK accounting firms" -
  // and a screen that refuses to search for the description the user gave is
  // worse than one that searches for it.
  //
  // Kept as a fallback rather than always included, because the name is a label
  // for the segment ("Series A founders") and not always a query. Keywords are
  // the query when there are any; the name only stands in when there are none.
  const name = (seg.name ?? '').trim();
  if (!text && name) text = name;

  const country = (seg.countries ?? [])[0] ?? null;

  return {
    query: text,
    q: text,
    search: text,
    industry: industries[0] ?? null,
    industries: industries.join(',') || null,
    country,
    country_code: country,
    countryCode: country,
    employees_min: Number.isFinite(lo) ? lo : null,
    employees_max: Number.isFinite(hi) ? hi : null,
    employee_count_min: Number.isFinite(lo) ? lo : null,
    employee_count_max: Number.isFinite(hi) ? hi : null,
    size_min: Number.isFinite(lo) ? lo : null,
    size_max: Number.isFinite(hi) ? hi : null,
    // A page bigger than asked for would be billed for and then discarded, since
    // the row cap is the user's decision and not the provider's.
    limit: Math.max(1, Math.min(want, 200)),
  };
}

/**
 * Whether a segment has enough in it to search for.
 *
 * A name counts. It is a description rather than a filter taxonomy, and it is
 * the thing a user typed when they were asked who they are looking for, so
 * refusing to search for it would mean refusing the only input the form
 * requires.
 *
 * The number is not garbage: employeeRange is derived from a chip and one of the
 * bands used to parse to NaN, so a NaN here would mean "the form is broken" and
 * must be reported as such rather than turned into a failed search.
 */
export function isSearchable(seg: SearchableSegment | null | undefined): boolean {
  if (!seg) return false;
  if (hasJunkRange(seg)) return false;

  const keywords = (seg.keywords ?? []).filter((k) => k && k.trim());
  const industries = (seg.industries ?? []).filter((i) => i && i.trim());
  const name = (seg.name ?? '').trim();
  return keywords.length > 0 || industries.length > 0 || name.length > 0;
}

/**
 * Whether the employee range is a number rather than the result of a bad parse.
 *
 * Present because one of the size chips used to produce [NaN, NaN] - '1000+'
 * split on a hyphen it does not contain - and that NaN was written straight into
 * a numeric column on the ICP. The user could pick "1000 or more", get an error
 * about the form being broken, and have no way back to a working profile except
 * re-picking a different band.
 */
export function hasJunkRange(seg: SearchableSegment | null | undefined): boolean {
  const r = seg?.employeeRange;
  if (!r) return false;
  return !Number.isFinite(Number(r[0])) || !Number.isFinite(Number(r[1]));
}

/** The message for a run that cannot start, so the reason is on the screen. */
export function seedFailureMessage(error: SeedResult['error']): string {
  switch (error) {
    case 'no_icp':
      return 'This search has no saved profile, so there is nothing to search for.';
    case 'no_query':
      return (
        'This profile has no name, industries or keywords, so there is nothing to search for. ' +
        'Give it a name on the New search screen.'
      );
    case 'bad_range':
      return 'The company size on this profile is not a number, so it cannot be searched on.';
    default:
      return 'The company search could not be run.';
  }
}

/**
 * Runs the company waterfall until it has enough companies or runs out of
 * providers, and returns them.
 *
 * Does not write. The caller does, because the row cap and the credit hold are
 * the caller's decisions and this function has no business knowing about either.
 *
 * The chain is passed in rather than resolved here. It used to read
 * DEFAULT_ORDER.company directly, which silently ignored two things: the user's
 * own saved order for the company step, and the measured-hit-rate ranking every
 * other step gets. A user who reordered their company providers in the lab would
 * have watched the ordering have no effect on the one step where it mattered
 * most - and that step decides which companies the entire run is about.
 *
 * The loop stops on cost as well as on count. Two of these endpoints bill their
 * misses, so an unbounded waterfall is not bounded by anything: without the check
 * a user whose first provider finds nothing pays for every provider in the list.
 */
export async function discoverCompanies(
  cfg: TregConfig,
  runId: string,
  seg: SearchableSegment,
  want: number,
  alreadyHave: Set<string>,
  chain: EndpointEntry[],
): Promise<{
  companies: CompanyHit[];
  costUsd: number;
  attempts: DiscoveryAttempt[];
}> {
  const out: CompanyHit[] = [];
  const attempts: DiscoveryAttempt[] = [];
  let costUsd = 0;

  // What one full page costs at the most expensive provider in the list. This is
  // the ceiling on the whole discovery phase, and it is deliberately generous:
  // under it a user gets fewer companies than they asked for, over it they get a
  // bill for rows the run will not keep.
  const ceiling = Math.max(want, 1) * 0.02;

  // An empty chain is a real possibility rather than a bug: a saved order naming
  // only endpoints since removed from the registry resolves to nothing. Returning
  // here means the run reports "nothing to search with" rather than looping over
  // an empty list and calling that a clean search that found nothing on purpose.
  if (chain.length === 0) return { companies: [], costUsd: 0, attempts };

  for (const entry of chain) {
    const id = entry.id;
    if (out.length >= want) break;
    if (costUsd >= ceiling) break;

    const need = want - out.length;
    const idempotencyKey = `leads:${runId}:company:${id}:${attempts.length}`;

    const result = await tregCallWithRetry(cfg, {
      endpointId: id,
      params: companyQuery(seg, need),
      // Keyed on the attempt index as well as the endpoint, because the same
      // provider may legitimately be asked twice when the first page missed and
      // the next provider is the same vendor under a different id.
      idempotencyKey,
      maxCostUsd: Math.min(entry.priceUsd * Math.max(1, need), ceiling - costUsd),
    });

    costUsd += result.costUsd;

    const found = result.outcome === 'success' ? readCompanies(result.body) : [];
    attempts.push({
      endpointId: id,
      step: 'company',
      costUsd: result.costUsd,
      hit: found.length > 0,
      // Carried through rather than reconstructed by the caller. api_usage's
      // idempotency_key is unique, and it has to be the same string the call was
      // made under or the retry is recorded as a second call - which overstates
      // the provider's cost by exactly the amount being reconciled.
      idempotencyKey,
      httpStatus: result.httpStatus,
      outcome: result.outcome,
      callId: result.callId,
      error: result.error,
    });

    let added = 0;
    for (const c of found) {
      if (out.length >= want) break;
      if (!c.domain) continue;
      if (alreadyHave.has(c.domain)) continue;
      alreadyHave.add(c.domain);
      out.push(c);
      added++;
    }

    // A provider that returned the same companies the previous one did will do it
    // again. One overlap in a row means the segment is not narrowing anything the
    // providers can see, and paying for more pages finds more of the same.
    if (attempts.length >= 2 && added === 0 && out.length < want) {
      const prev = attempts[attempts.length - 2];
      if (prev && !prev.hit) continue;
    }
  }

  return { companies: out, costUsd: round6(costUsd), attempts };
}