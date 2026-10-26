import { invokeFunction, ApiError } from '../../lib/api';
import { walletStore } from '../../lib/wallet-store';
import type { B2BLead, Company } from '../../types';
import { leadsStore } from './leads-store';
import { foundEmail } from './lead-utils';

// ============================================================================
// Person enrichment (leads `enrich-person`) for one lead or a selection.
//
// A saved lead is enriched in place on the server; an unsaved one (a search
// result, a Quick Lookup) gets the profile back and is filled in here. Either
// way only blank fields are filled, and a lead is marked enriched so it is
// never bought twice in a session.
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The saved row id, or null for a lead that is not saved. */
export function savedLeadId(lead: B2BLead): string | null {
  const id = lead.db_id || lead.id;
  return id && UUID_RE.test(id) ? id : null;
}

/** Whether a lead can be enriched: not done yet, and something to match on. */
export function canEnrichPerson(lead: B2BLead): boolean {
  if (lead.person_enriched_at) return false;
  return Boolean(lead.linkedin_url || foundEmail(lead) || (lead.company_domain && lead.full_name));
}

export type EnrichOutcome =
  | { kind: 'found'; credits: number }
  | { kind: 'not_found' }
  | { kind: 'no_credits'; error: ApiError }
  | { kind: 'error'; message: string };

interface PersonResult {
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company_name: string | null;
  company_domain: string | null;
  linkedin_url: string | null;
  location: string | null;
}

const PLACEHOLDER_TITLES = ['Executive', 'Executive / Leader', 'Target Decision Maker'];
const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** The lead with blank fields filled from what enrichment found. */
function fillLead(lead: B2BLead, person: PersonResult, company: Company | null): B2BLead {
  const out: B2BLead = { ...lead, person_enriched_at: new Date().toISOString() };
  if (person.title && (blank(lead.title) || PLACEHOLDER_TITLES.includes(lead.title))) out.title = person.title;
  if (person.company_name && blank(lead.company_name)) out.company_name = person.company_name;
  if (person.company_domain && blank(lead.company_domain)) out.company_domain = person.company_domain;
  if (person.linkedin_url && blank(lead.linkedin_url)) out.linkedin_url = person.linkedin_url;
  if (person.location && blank(lead.location)) out.location = person.location;
  if (person.first_name && blank(lead.first_name)) out.first_name = person.first_name;
  if (person.last_name && blank(lead.last_name)) out.last_name = person.last_name;
  if (company?.employees && blank(lead.company_size)) out.company_size = company.employees;
  if (company?.industry && blank(lead.industry)) out.industry = company.industry;
  return out;
}

/** Enriches one lead and writes the result into the leads store. Never throws. */
export async function enrichPerson(lead: B2BLead, refreshWallet = true): Promise<EnrichOutcome> {
  const id = savedLeadId(lead);
  try {
    const res = await invokeFunction<{
      ok: boolean;
      lead?: Partial<B2BLead>;
      person?: PersonResult;
      company?: Company | null;
      credits_charged?: number;
    }>(
      'leads',
      id
        ? { action: 'enrich-person', lead_id: id }
        : {
            action: 'enrich-person',
            full_name: lead.full_name,
            first_name: lead.first_name,
            last_name: lead.last_name,
            company_domain: lead.company_domain,
            linkedin_url: lead.linkedin_url,
            email: foundEmail(lead) || undefined,
          },
    );
    if (id && res?.lead) {
      leadsStore.applySavedLead(res.lead);
      const saved = res.lead;
      leadsStore.setLeads((prev) =>
        prev.map((l) => (savedLeadId(l) === id ? { ...l, ...saved, id: l.id, db_id: id } : l)),
      );
    } else if (res?.person) {
      const person = res.person;
      const company = res.company ?? null;
      leadsStore.setLeads((prev) => prev.map((l) => (l.id === lead.id ? fillLead(l, person, company) : l)));
    }
    return { kind: 'found', credits: res?.credits_charged ?? 0 };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { kind: 'not_found' };
    if (err instanceof ApiError && err.status === 402) return { kind: 'no_credits', error: err };
    return { kind: 'error', message: (err as Error)?.message || 'Enrichment failed. Please try again.' };
  } finally {
    if (refreshWallet) void walletStore.refresh();
  }
}

/**
 * Enriches a selection, two at a time (the server allows 10 lookups per 10
 * seconds). Stops early when the wallet runs out.
 */
export async function enrichPeople(
  leads: B2BLead[],
  onProgress?: (done: number) => void,
): Promise<{ found: number; notFound: number; failed: number; credits: number; stoppedForCredits: ApiError | null }> {
  const queue = leads.filter(canEnrichPerson);
  const totals = { found: 0, notFound: 0, failed: 0, credits: 0, stoppedForCredits: null as ApiError | null };
  let done = 0;
  const worker = async () => {
    while (queue.length > 0 && !totals.stoppedForCredits) {
      const lead = queue.shift()!;
      const outcome = await enrichPerson(lead, false);
      if (outcome.kind === 'found') {
        totals.found++;
        totals.credits += outcome.credits;
      } else if (outcome.kind === 'not_found') totals.notFound++;
      else if (outcome.kind === 'no_credits') totals.stoppedForCredits = outcome.error;
      else totals.failed++;
      onProgress?.(++done);
    }
  };
  await Promise.all([worker(), worker()]);
  void walletStore.refresh();
  return totals;
}
