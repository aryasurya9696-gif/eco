/**
 * Echo Leads — turning a provider call into a billing outcome
 * ---------------------------------------------------------------------------
 * Two vocabularies that did not match, and the silence that came out of it.
 *
 * treg.ts classifies a call six ways: success, free, not_found, upstream_failed,
 * uncertain, error. api_usage's CHECK constraint accepts five, and `error` and
 * `not_found` are not among them. So every 402 and every 429 raised a check
 * violation, logAttempt did not look at the error, and the row vanished.
 *
 * That is not a cosmetic gap. api_usage is what the margin views read, so the
 * failures were invisible in every report, and the attempt history could not
 * show "HTTP 429" because there was nothing to show. It looked like a feature
 * that had not been built. It was a feature that had been failing silently for
 * as long as the worker had been running.
 *
 * The mapping lives here rather than being loosened in the database on purpose.
 * The five values in the constraint are billing outcomes and the constraint
 * keeping that set closed is exactly what lets a margin view group by outcome
 * without defensively handling a sixth. `error` and `not_found` are not billing
 * outcomes — one is a transport classification and the other is a result — and
 * widening the set would trade a real guarantee for a cosmetic one.
 *
 * The transport detail is not lost. http_status and error_code go onto the
 * api_usage row, so "429, rate limited" stays visible on the row even once it has
 * been recorded as the billing outcome it is.
 */

/** What treg.ts reports. Kept loose so a new one is a compile error, not a silent drop. */
export type TransportOutcome =
  | 'success'
  | 'free'
  | 'not_found'
  | 'upstream_failed'
  | 'uncertain'
  | 'error';

/** What api_usage accepts. Exactly the CHECK constraint's list, nothing else. */
export type BillingOutcome =
  | 'success'
  | 'free'
  | 'upstream_failed'
  | 'not_billed'
  | 'uncertain';

export interface CallResult {
  outcome: TransportOutcome;
  httpStatus?: number;
  error?: string;
}

/**
 * The billing outcome for one provider call.
 *
 * Each mapping is a statement about who owes whom.
 *
 *   success         we used the service and are paying for it, whatever it found
 *   free            the provider did not charge us
 *   not_found       the call worked and we are still paying. A miss on a
 *                   per-success provider is the expensive case, not the free one,
 *                   so recording it as anything but a success would understate
 *                   what a run costs.
 *   upstream_failed the provider would not serve the request. Not our fault, and
 *                   nothing charged.
 *   uncertain       the answer was lost or the call is still running. We may or
 *                   may not be charged and we must not guess either way — this is
 *                   the one value a report has to be careful with.
 *   not_billed      refused for money. A 402 is us out of credit, which means
 *                   nothing was taken and the workspace cannot keep spending.
 */
export function billingOutcome(result: CallResult): BillingOutcome {
  switch (result.outcome) {
    case 'success':
    case 'free':
    case 'upstream_failed':
    case 'uncertain':
      return result.outcome;

    case 'not_found':
      return 'success';

    case 'error': {
      const status = result.httpStatus ?? 0;

      // 409 and 410 mean the call is still running, or it completed and was
      // charged and the answer was lost. treg.ts already reports those as
      // 'uncertain', so this arm is unreachable through it — but the pairing of a
      // transport error with these two statuses means exactly one thing, and
      // answering it with anything else would be a guess about whether we were
      // charged. Refunding on our own initiative is how a workspace gets served
      // for free, so the safe answer is the one that admits uncertainty.
      if (status === 409 || status === 410) return 'uncertain';

      // Rate limited: the provider would not serve us right now. Same bucket as
      // any other upstream refusal, because from the billing side it is the same
      // thing — nothing came back and nothing was charged.
      if (status === 429 || status === 502 || status === 503 || status === 504) {
        return 'upstream_failed';
      }

      // 402 is us out of credit. Everything else that failed this way — a 400 we
      // sent wrong, an auth failure, a 404 on an endpoint that moved — is
      // something we did not get billed for either, and the distinction between
      // the two does not change what anyone owes.
      return 'not_billed';
    }

    default:
      // Unreachable through the type, but a runtime value from a provider library
      // is not. An unknown outcome is billed as free rather than as a success:
      // claiming a cost we cannot substantiate is worse than admitting we do not
      // know, and the margin view can always be corrected by hand.
      return 'free';
  }
}

/**
 * What to put in the error_code column.
 *
 * The transport's own code where there is one, so a row reads "rate_limited"
 * rather than an HTTP number the reader has to look up. Kept separate from the
 * billing outcome precisely so the two can differ without either being lost.
 */
export function errorCodeFor(result: CallResult): string | null {
  if (result.error) return result.error;
  if (result.outcome === 'error' && result.httpStatus) return `http_${result.httpStatus}`;
  return null;
}

/**
 * Whether this call should have produced a hit on the attempt.
 *
 * Separate from the outcome because a call can be a billing success and a finding
 * miss, and the two are recorded in different tables for a reason: api_usage
 * answers "what did it cost", lead_attempts answers "did it find anything".
 * Conflating them is what made a verifier that answered "this mailbox does not
 * exist" count as a hit.
 */
export function countsAsHit(result: CallResult, found: boolean): boolean {
  // Uncertain is explicitly not a hit. The answer was lost; we do not know, and
  // recording a guess would corrupt the smoothed rate that prices the waterfall.
  if (result.outcome === 'uncertain' || result.outcome === 'error') return false;
  return Boolean(found);
}