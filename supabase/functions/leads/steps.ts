/**
 * Echo Leads — what a row actually has to go through
 * ---------------------------------------------------------------------------
 * The run's mode, turned into the set of steps that row will perform.
 *
 * This existed as a `mode` column on lead_runs that nothing read. The estimate
 * priced the three clean modes differently, the UI described them differently,
 * and processRow did exactly the same email waterfall for all of them — which
 * meant "check what I have" went out and found replacements for the rows it had
 * promised to leave alone, and charged the find price for doing it.
 *
 * So the mode is decided here, in one pure function, rather than being
 * interpreted at each place that needs to know. Three things read this: the
 * worker, the estimator's worst case, and the tests. When they disagree it is
 * this file that is wrong, and there is one file to look at.
 *
 * No imports. It has to compile under the project's test harness as well as
 * under Deno, and a module that pulls in a Supabase client cannot do both.
 */

export type LeadStep = 'company' | 'person' | 'email' | 'verify' | 'phone' | 'enrich';

export type RunKind = 'find' | 'clean' | 'lab';

export type CleanMode = 'verify_only' | 'verify_refind' | 'full_enrich';

export interface StepPlan {
  /**
   * Look the company and the decision maker up as part of this run.
   *
   * False for every clean mode, because the user already had both in the file
   * they imported. Present here so the credit function can refuse to charge for
   * a company lookup on a clean run even if a caller reports one — which is the
   * failure mode this whole change is about: the modes being silently conflated,
   * so a clean run billed as though it had found companies and people.
   */
  findCompany: boolean;
  /** Check the address the row already carries. */
  verifyExisting: boolean;
  /** Go looking for an address. */
  findEmail: boolean;
  /**
   * Whether finding is conditional on the existing address failing.
   *
   * Kept separate from findEmail because the difference is the whole cost of the
   * operation. verify_refind spends the find price on exactly the rows that fail
   * verification; anything else spends it on every row.
   */
  refindOnFailure: boolean;
  /** Add the company's own details. */
  enrich: boolean;
  /**
   * Charge the verification price as its own line.
   *
   * False for find runs, and deliberately so. An address found by a find run is
   * verified as part of being found — the find endpoint is asked to return a
   * deliverable one — so a separate verification line would charge the user twice
   * for one piece of work. The clean modes are different: verification is the
   * thing being bought, so it is priced on its own.
   */
  chargeVerifySeparately: boolean;
}

const NOTHING: StepPlan = {
  // find and lab look the company and the person up. Every clean mode does not.
  findCompany: true,
  verifyExisting: false,
  findEmail: false,
  refindOnFailure: false,
  enrich: false,
  chargeVerifySeparately: false,
};

/**
 * A plan is built from the run's mode alone.
 *
 * The kind is not an input, which is worth stating because it looks like it
 * should be. It does not affect the answer: a find run has no mode and gets the
 * full waterfall, a lab run has no mode and gets the same, and a clean run
 * carries the mode that names its work. Reading the kind would add a second way
 * for a run to be described and no new behaviour.
 *
 * The signature used to take it and ignore it, which is worse than either — a
 * caller reading that signature concludes the kind is part of the answer.
 */
export function planSteps(mode: CleanMode | null | undefined): StepPlan {
  // An unrecognised mode is treated as no mode rather than trusted. Falling back
  // to the full waterfall means the user still gets their leads; silently doing
  // less work because of a typo in a column would be the worse failure.
  const m = (mode ?? '').trim() as CleanMode;

  if (m === 'verify_only') {
    return {
      findCompany: false,
      verifyExisting: true,
      // The defining promise of this mode: a row whose address fails is left
      // alone. Not charged, not looked up, not replaced.
      findEmail: false,
      refindOnFailure: false,
      enrich: false,
      chargeVerifySeparately: true,
    };
  }

  if (m === 'verify_refind') {
    return {
      findCompany: false,
      verifyExisting: true,
      findEmail: true,
      refindOnFailure: true,
      enrich: false,
      chargeVerifySeparately: true,
    };
  }

  if (m === 'full_enrich') {
    return {
      findCompany: false,
      verifyExisting: true,
      findEmail: true,
      refindOnFailure: true,
      enrich: true,
      chargeVerifySeparately: true,
    };
  }

  // find and lab, and anything with no mode set. Both look up the company and
  // the person, then the address, and leave the verification inside the find —
  // which is why chargeVerifySeparately stays false here and why no verify step
  // appears ahead of the find.
  return { ...NOTHING, findEmail: true };
}

/**
 * Every step this row could perform, in order, given what it starts with.
 *
 * Deliberately the *maximum* set, not the actual one. Whether a refind happens
 * depends on whether the verification passed, and that is not knowable until the
 * verify call has been made and answered — so planning it here would mean
 * guessing. The worker runs the steps in order and skips the ones whose
 * precondition failed.
 *
 * Returned as a list rather than decided as it happens because "tried Kitt, then
 * ContactOut, then gave up" is only believable if there was a plan to be honest
 * to, and the receipt shows the plan as well as the result.
 */
export function maxStepsFor(plan: StepPlan, hasEmail: boolean): LeadStep[] {
  const steps: LeadStep[] = [];

  // Verification comes first and only ever once up front. If the address the row
  // was given turns out to be good there is nothing else to do.
  if (plan.verifyExisting && hasEmail) steps.push('verify');

  if (plan.findEmail) steps.push('email');

  // A replacement is verified like any other address. Leaving this out is how a
  // row ends up holding an address that nothing ever checked, which is the exact
  // failure the verified badge exists to rule out.
  if (plan.findEmail && plan.verifyExisting) steps.push('verify');

  if (plan.enrich) steps.push('enrich');

  return steps;
}

/**
 * Whether the find step should actually run for a row.
 *
 * The gate, called by the worker after the first verification has answered. Only
 * modes with refindOnFailure consult a verdict; the others decide on the plan
 * alone, so an unreachable verifier cannot stop a find run from finding anything.
 */
export function shouldFindEmail(plan: StepPlan, verificationPassed: boolean | null): boolean {
  if (!plan.findEmail) return false;
  // No verdict to go on: find anyway. A verifier being unreachable is a reason to
  // keep trying, not a reason to give up on the row.
  if (!plan.refindOnFailure) return true;
  if (verificationPassed === null) return true;
  return !verificationPassed;
}

/**
 * The worst case per row, in credits, matching what the estimator's max is
 * built from.
 *
 * Lives here rather than being read back from the estimate so the worker's
 * reservation for a chunk and the wallet check at run start are computed from one
 * rule. They are different numbers for different purposes — a chunk reserves the
 * worst case for the rows it claimed, a run checks the worst case for all of
 * them — but they must not be different rules.
 */
export function worstCasePerRow(
  plan: StepPlan,
  prices: { verifyOnly: number; emailVerified: number; enrich: number },
): number {
  let worst = 0;

  if (plan.verifyExisting) worst += prices.verifyOnly;
  if (plan.findEmail) worst += prices.emailVerified;
  if (plan.enrich) worst += prices.enrich;

  return round6(worst);
}

/**
 * numeric(20,6) has six decimals.
 *
 * Local rather than imported from pricing-row.ts, because that module imports a
 * type from this file using a .ts extension — which Deno requires and the Node
 * test harness cannot resolve. Four duplicated lines beat a build step that runs
 * in one runtime only.
 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

