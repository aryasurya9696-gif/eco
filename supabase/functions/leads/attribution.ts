/**
 * Who actually earned the find.
 *
 * A waterfall asks several providers for the same thing until one answers. Two
 * providers can both return an answer, and only one of them did the work - the
 * other spent money confirming what the chain already had. The lab's entire
 * claim is that it can tell those apart, and the number that does it is the
 * "independent find".
 *
 * Pure, and in its own file, because it was inline in the stats query where no
 * test could reach it and where it had quietly become wrong.
 *
 * No imports: it has to compile under the Node test harness as well as Deno.
 */

export interface Attempt {
  endpoint_id: string;
  hit: boolean;
  /** Null for a discovery call, which happens before any row exists. */
  row_id: string | null;
}

export interface EndpointAcc {
  attempts: number;
  hits: number;
  /** Attempts that were the first for their row on this step. */
  firstToFind: number;
}

/**
 * Folds a step's attempts into per-endpoint counts.
 *
 * `attempts` must be in the order they happened. That is not a formality: which
 * provider is credited depends entirely on who answered first, so an unsorted
 * list credits whichever row the database happened to return first, which for a
 * step with several providers is an arbitrary answer presented as a measurement.
 *
 * Attempts with no row are counted but never credited. Discovery runs before any
 * row exists, and there is nothing for its provider to have supplied first -
 * crediting it would be saying "the first company search found something nobody
 * else had" about a call that happened when there was nothing to find.
 */
export function foldAttempts(attempts: Attempt[]): Map<string, EndpointAcc> {
  const acc = new Map<string, EndpointAcc>();
  const credited = new Set<string>();

  for (const a of attempts) {
    let cur = acc.get(a.endpoint_id);
    if (!cur) {
      cur = { attempts: 0, hits: 0, firstToFind: 0 };
      acc.set(a.endpoint_id, cur);
    }

    cur.attempts++;
    if (a.hit) cur.hits++;

    if (a.hit && a.row_id && !credited.has(a.row_id)) {
      credited.add(a.row_id);
      cur.firstToFind++;
    }
  }

  return acc;
}

/**
 * Reads the total independent finds out of a fold.
 *
 * One per row on this step, so it is also the number of rows this step supplied
 * anything for. Used for the "cost per find" figure at the top of the lab, and
 * deliberately the sum of the per-endpoint figures rather than a separate count,
 * so the two can never disagree.
 */
export function totalFinds(acc: Map<string, EndpointAcc>): number {
  let n = 0;
  for (const a of acc.values()) n += a.firstToFind;
  return n;
}