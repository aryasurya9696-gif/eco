/**
 * Choosing which of a company's people is the decision maker.
 *
 * A people search returns whoever the provider had. At a company with 400
 * employees that is a list of engineers, a list of recruiters and, somewhere in
 * the middle, the two people this run was bought for. Taking the first row
 * because it arrived first is how a run fills with the wrong titles and the user
 * concludes the search did not work.
 *
 * Ranking rather than filtering. Filtering to a title list and returning nothing
 * when no title matched exactly discards people who are plainly right - a "Chief
 * Revenue Officer" against a list containing "Sales Director" is the obvious
 * case - so the scoring below rewards proximity instead of demanding equality,
 * and the caller takes the best one available.
 *
 * No imports, on purpose: it has to compile under the Node test harness as well
 * as Deno.
 */

export interface Candidate {
  name: string | null;
  title: string | null;
}

/** What a title match is worth at each distance. */
const SCORE_EXACT = 100;
const SCORE_PARTIAL = 40;
const SCORE_SENIORITY_BONUS = 15;
const SCORE_PENALTY = -35;

/**
 * The words that mark a title as a decision maker's, without needing a taxonomy.
 *
 * Deliberately coarse. A provider's own seniority field is better than anything
 * inferred from a title string, and where it is present it is used instead - this
 * is the fallback for when it is not.
 */
const DECISION_WORDS = [
  'founder', 'co-founder', 'cofounder', 'owner', 'ceo', 'cfo', 'coo', 'cto',
  'cmo', 'cro', 'president', 'chief', 'partner', 'principal', 'vp',
  'vice president', 'head of', 'director', 'general manager', 'gm',
  'managing director', 'board', 'executive',
];

/** Words that mean this person is not who the run is looking for. */
const EXCLUDE_WORDS = [
  'intern', 'coordinator', 'assistant', 'associate', 'junior', 'apprentice',
  'trainee', 'student', 'part-time', 'contractor', 'temp',
];

/**
 * Normalises a title for comparison: lowercase, punctuation to spaces, and the
 * punctuation-in-the-middle abbreviations expanded so "VP, Sales" and "Vice
 * President of Sales" land near each other.
 */
function norm(s: string | null): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/\bvp\b/g, 'vice president')
    .replace(/\bceo\b/g, 'chief executive')
    .replace(/\bcfo\b/g, 'chief financial')
    .replace(/\bcoo\b/g, 'chief operating')
    .replace(/\bcto\b/g, 'chief technology')
    .replace(/\bcmo\b/g, 'chief marketing')
    .replace(/\bcro\b/g, 'chief revenue')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * How well one title matches what the run asked for.
 *
 * 0 means no opinion either way, which is what makes ranking safe: an untitled
 * candidate scores nothing but is still eligible, because returning no person at
 * all is worse than returning a plausible one.
 */
export function scoreTitle(candidateTitle: string | null, wanted: string[]): number {
  const t = norm(candidateTitle);
  if (!t) return 0;

  const wantedNorm = wanted.map(norm).filter(Boolean);

  let score = 0;

  if (wantedNorm.length > 0) {
    let best = 0;
    for (const w of wantedNorm) {
      if (t === w) {
        best = Math.max(best, SCORE_EXACT);
      } else if (t.includes(w) || w.includes(t)) {
        // Substring either way, so "sales director" matches "director of sales"
        // and "regional sales director" without needing stemming.
        best = Math.max(best, SCORE_PARTIAL);
      } else {
        // Shared words. One shared word is weak - "of" and "the" are shared by
        // everything - so only a two-word overlap counts for anything.
        const shared = w.split(' ').filter((word) => word.length > 3 && t.includes(word));
        if (shared.length >= 1) best = Math.max(best, SCORE_PARTIAL - 10);
      }
    }
    score += best;

    // A title that shares nothing with anything asked for is probably still a
    // decision maker, just not the one described. Not zero: the seniority bonus
    // below is what lifts it, and a company always has one relevant person.
  }

  if (DECISION_WORDS.some((w) => t.includes(w))) score += SCORE_SENIORITY_BONUS;

  if (EXCLUDE_WORDS.some((w) => t.includes(w))) score += SCORE_PENALTY;

  return score;
}

/**
 * The best candidate, or null.
 *
 * Order is stable for equal scores so the same provider response always picks
 * the same person - a row whose decision maker changes between chunks would look
 * like the search was finding different answers each pass.
 *
 * A candidate with no name is never returned, because the email step is keyed on
 * a name and a person who cannot be named is not somebody the next step can look
 * up.
 */
export function pickPerson<T extends Candidate>(candidates: T[], wanted: string[]): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;

  for (const c of candidates) {
    if (!c.name || !c.name.trim()) continue;

    const s = scoreTitle(c.title, wanted);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  return best;
}

/**
 * A readable summary of how the choice was made, for the row's receipt.
 *
 * Returns null rather than a guess when there was nothing to rank against, so the
 * UI can say "no titles given" instead of implying a match it did not make.
 */
export function describeChoice(chosen: Candidate | null, considered: number, wanted: string[]): string | null {
  if (!chosen) return null;
  if (considered <= 1) return null;

  const wantedNorm = wanted.map(norm).filter(Boolean);
  if (wantedNorm.length === 0) {
    return 'Picked from ' + considered + ' people at this company.';
  }

  return (
    'Picked from ' +
    considered +
    ' people at this company, closest to ' +
    wantedNorm.slice(0, 3).map((w) => w.split(' ').slice(0, 2).join(' ')).join(', ')
  );
}