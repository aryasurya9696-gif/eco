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

export type CleanMode = 'verify_only' | 'verify_refind' | 'full_enrich' | 'phone_only' | 'enrich_only';

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
  /**
   * Look a phone number up as well.
   *
   * The only step that is not decided by the mode: it is opt-in on the run
   * because at roughly eight times the price of the address find, a step that
   * was on by default would dominate every invoice without being what anybody
   * came for.
   *
   * It is in the plan rather than left to the worker because creditsForRow has
   * to be able to refuse it. Gating this one on the plan is what stops a future
   * caller passing phoneFound for a row from a run that never asked for phones
   * from charging eight credits a row for a number that was never looked for -
   * 16000 credits across a 2000-row run, and the same class of bug as the
   * company and person lines that are already gated.
   */
  phone: boolean;
}

const NOTHING: StepPlan = {
  // find and lab look the company and the person up. Every clean mode does not.
  findCompany: true,
  verifyExisting: false,
  findEmail: false,
  refindOnFailure: false,
  enrich: false,
  chargeVerifySeparately: false,
  phone: false,
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
 *
 * The second argument is a run's opt-in settings, not its identity. Phone is the
 * one step no mode implies, and a step the plan cannot describe is a step the
 * price function cannot gate - which is how a phone charge once had nowhere to be
 * refused.
 */
export function planSteps(
  mode: CleanMode | null | undefined,
  opts?: { phone?: boolean },
): StepPlan {
  // Read once here so nothing downstream has to remember it.
  const wantPhone = opts?.phone === true;

  // An unrecognised mode is treated as no mode rather than trusted. Falling back
  // to the full waterfall means the user still gets their leads; silently doing
  // less work because of a typo in a column would be the worse failure.
  const m = (mode ?? '').trim() as CleanMode;

  // Single-purpose modes for bulk actions on leads already held. Nothing is
  // found or verified that was not asked for.
  if (m === 'phone_only') {
    return { ...NOTHING, findCompany: false, phone: true };
  }
  if (m === 'enrich_only') {
    return { ...NOTHING, findCompany: false, enrich: true, phone: wantPhone };
  }

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
      phone: wantPhone,
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
      phone: wantPhone,
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
      phone: wantPhone,
    };
  }

  // find and lab, and anything with no mode set. Both look up the company and
  // the person, then the address, and leave the verification inside the find —
  // which is why chargeVerifySeparately stays false here and why no verify step
  // appears ahead of the find.
  return { ...NOTHING, findEmail: true, phone: wantPhone };
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
export function maxStepsFor(plan: StepPlan, hasEmail: boolean, hasPerson = false): LeadStep[] {
  const steps: LeadStep[] = [];

  // The decision maker comes before the address, because every email endpoint
  // here is keyed on a name or a profile URL. Without one there is nothing to
  // look the address up with, so a find plan that did not list this step was
  // describing a row that could not be worked.
  //
  // 'company' is not in this list. The company was looked up when the row was
  // created, by the discovery pass, and a step list that opened with a call
  // nobody makes is a receipt that cannot be read against the log.
  if (plan.findCompany && !hasPerson) steps.push('person');

  // Verification comes first and only ever once up front. If the address the row
  // was given turns out to be good there is nothing else to do.
  if (plan.verifyExisting && hasEmail) steps.push('verify');

  if (plan.findEmail) steps.push('email');

  // A replacement is verified like any other address. Leaving this out is how a
  // row ends up holding an address that nothing ever checked, which is the exact
  // failure the verified badge exists to rule out.
  if (plan.findEmail && plan.verifyExisting) steps.push('verify');

  if (plan.enrich) steps.push('enrich');

  // Phone last of all. It is the most expensive step by an order of magnitude and
  // the least related to the rest, so putting it anywhere else would imply the
  // address depends on it.
  if (plan.phone) steps.push('phone');

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
  prices: {
    company: number;
    person: number;
    verifyOnly: number;
    emailVerified: number;
    enrich: number;
    phone: number;
  },
): number {
  let worst = 0;

  // The company and decision-maker lines are here for one reason: they are what
  // the row is charged for, so they have to be held.
  //
  // This was the price of a find row and nothing else, which under-held it. The
  // SQL estimator's max for a find is target * (company + person + email), but the
  // chunk reserved target * email, so a chunk of five rows held 5.00 and could
  // legitimately settle 6.10. settle refuses to charge more than was held, so
  // every find run with a company in it failed settlement, paused itself with
  // pause_reason 'settlement_failed', and left the user with a run that looks
  // finished and credits that vanished.
  //
  // Two numbers for the same row is not a rounding difference. One of them was
  // wrong, and the fix belongs here rather than in the estimator because the
  // estimator's version is the one the user was quoted.
  if (plan.findCompany) worst += prices.company + prices.person;

  if (plan.verifyExisting) worst += prices.verifyOnly;
  if (plan.findEmail) worst += prices.emailVerified;
  if (plan.enrich) worst += prices.enrich;

  // Inside the plan rather than added by the caller. The worker used to add the
  // phone price on top of this number from run.options, which worked and is the
  // reason the estimate and the hold could disagree without anything noticing:
  // two files computing one row. A run that asked for phones and got a plan
  // without them - a refactored call site, a restored mode - would have held
  // nothing at all for an eight-credit step.
  if (plan.phone) worst += prices.phone;

  return round6(worst);
}

/**
 * Whether this run should be sent out to find companies right now.
 *
 * Three conditions, and getting the second one wrong is expensive:
 *
 *   1. only a find run. A clean run's rows came from the user's file and a lab
 *      run's from a single hand-picked company; neither has anything to search
 *      for.
 *   2. only when the queue is empty. The worker re-invokes itself per chunk, so
 *      discovering whenever it looked would mean a 2000-row run making 400
 *      company searches, each one asking for the rows it had not created yet.
 *      Paid calls, once per chunk, for a single search.
 *   3. only while the target is still unmet.
 *
 * Kept here rather than inline at the call site for the same reason the rest of
 * this file exists: it is a rule about what a run does, and a rule with a money
 * consequence in it should be somewhere a test can reach.
 */
export function shouldDiscover(input: {
  kind: string;
  /** Rows created for this run, of any state. */
  have: number;
  /** Rows currently queued or being worked. */
  waiting: number;
  target: number;
}): boolean {
  if (input.kind !== 'find') return false;
  if (input.waiting > 0) return false;
  return input.have < Math.max(1, input.target);
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

