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
  const verdictGiven = o.verified || o.catchAll || o.invalid;
  if (plan.chargeVerifySeparately && verdictGiven && !o.unreadable) {
    credits += prices.verifyOnly;
  }

  if (o.emailFound) {
    // A catch-all is not the deliverable a verified address is, and is priced
    // accordingly. Charging it the verified price is selling the worse answer at
    // the better price; charging the catch-all price for an address that is in
    // fact deliverable undercharges by more than half.
    if (o.catchAll && !o.verified) credits += prices.emailCatchAll;
    else credits += prices.emailVerified;
  }

  if (o.phoneFound) credits += prices.phone;
  if (o.companyEnriched) credits += prices.enrich;

  return round6(credits);
}

/** numeric(20,6) has six decimals; sending more is noise and can be rejected. */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}