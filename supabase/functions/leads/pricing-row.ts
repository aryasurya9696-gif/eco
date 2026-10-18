/**
 * Echo Leads — what a finished row is worth
 * ---------------------------------------------------------------------------
 * One function, because there was two and they disagreed.
 *
 * creditsForResult in billing.ts charged company + person + email and had no
 * line for verification at all, so every clean run was billed as though the
 * verification it was bought for had not happened. creditsForCleanRow in steps.ts
 * charged verification and had no line for company or person, so every find run
 * was billed as though the company lookup had not happened. Both were correct
 * about their own case and neither knew about the other's.
 *
 * The rule is now one: a row is charged for each piece of work the plan actually
 * performed, at that work's price. Not for the work it was capable of doing, and
 * not for the plan it was given.
 */

import type { StepPlan } from './steps.ts';
import type { LeadPrices } from './billing.ts';

export type { LeadPrices };

export interface RowOutcome {
  /** The company was looked up and returned. False for an import — it came from the file. */
  companyFound: boolean;
  /** The decision maker was looked up. False for an import. */
  personFound: boolean;
  /** An address the waterfall went and got. */
  emailFound: boolean;
  /** A verifier said this address is a real mailbox. */
  verified: boolean;
  /** A verifier said this address is a role pattern, not a person. */
  catchAll: boolean;
  /** A verifier said this address does not exist. */
  invalid: boolean;
  /** A verifier said this is a throwaway mailbox. A failed lead, like invalid. */
  disposable: boolean;
  /** A verifier was asked and could not be read. Not a result, and not charged. */
  unreadable: boolean;
  phoneFound: boolean;
  companyEnriched: boolean;
}

const NOTHING: RowOutcome = {
  companyFound: false,
  personFound: false,
  emailFound: false,
  verified: false,
  catchAll: false,
  invalid: false,
  disposable: false,
  unreadable: false,
  phoneFound: false,
  companyEnriched: false,
};

/**
 * Turns a row's outcome into the credits it earned.
 *
 * Every line here is conditional on work that happened, which is what keeps a
 * miss free end to end. A row where nothing resolved returns 0, and the hold
 * that was taken for it comes back at settle.
 *
 * The one line that needs care is verification, charged only when a verifier
 * actually answered. An unreachable provider is not an answer: charging for it
 * would bill the user for Echo's outage, and worse, would charge the same either
 * way whether the address was good or not — so a broken verifier would look
 * exactly like a working one on the invoice.
 */
export function creditsForRow(outcome: Partial<RowOutcome>, prices: LeadPrices, plan: StepPlan): number {
  const o: RowOutcome = { ...NOTHING, ...outcome };

  let credits = 0;

  // Gated on the plan, not merely on what the caller reported.
  //
  // The old creditsForResult added these two whenever they were set, and the
  // worker set them for every row — so a clean run was billed for a company
  // lookup and a people lookup it never performed, once per row. Trusting the
  // caller's flags is exactly what let the modes be conflated in the first
  // place, so the plan has the last word: a run whose plan has no company lookup
  // cannot be charged for one.
  if (plan.findCompany && o.companyFound) credits += prices.company;
  if (plan.findCompany && o.personFound) credits += prices.person;

  // Verification is a separate line only where the plan says so. On a find run an
  // address is verified as part of being found, so charging both would charge
  // twice for one piece of work.
  const verdictGiven = o.verified || o.catchAll || o.invalid || o.disposable;
  if (plan.chargeVerifySeparately && verdictGiven && !o.unreadable) {
    credits += prices.verifyOnly;
  }

  // The address, gated the same way.
//
// This gate was missing and it was the last one a caller could get past. Company
// and person were already refused on a clean run, so the fix for the original
// conflation held - until a caller passed emailFound for a row whose plan never
// went looking for one, and was charged the full find price for an address that
// was never looked for. On a 2000-row verify_only that is 2000 credits charged
// for work that by definition did not happen.
//
// Every flag is now refused where the plan says the step does not run, so the
// worst a bug can do is charge less rather than charge outside the mode.
if (plan.findEmail && o.emailFound) {
    // The verified price is for a verified address and nothing else. One nobody
    // could confirm - catch-all, unknown, never checked - is the lower catch-all
    // price, and one a verifier rejected is not charged at all.
    //
    // It used to be the verified price unless a verifier said catch-all, and a
    // find run never verified, so every address it found was billed as verified
    // while the row said 'unknown'.
    if (o.verified) credits += prices.emailVerified;
    else if (!o.invalid && !o.disposable) credits += prices.emailCatchAll;
  }

  // Phone and enrichment are gated the same way. Phone was the last flag a caller
  // could get past, at eight credits a row - 16000 across a 2000-row run for
  // numbers that were never looked for. It is a plan field rather than a run
  // option read in here so there is one description of what a row will do.
  if (plan.phone && o.phoneFound) credits += prices.phone;
  if (plan.enrich && o.companyEnriched) credits += prices.enrich;

  return round6(credits);
}

/** numeric(20,6) has six decimals; sending more is noise and can be rejected. */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}