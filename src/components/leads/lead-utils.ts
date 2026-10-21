import type { B2BLead } from '../../types';

// ============================================================================
// Lead helpers shared by the Prospector table, the cards view and the CSV
// export, so the three can never disagree about what counts as a revealed,
// verified email or about which row a server response belongs to.
// ============================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('*') && EMAIL_RE.test(value.trim());
}

/**
 * The identity the server matches leads on (company domain + full name).
 * Every place that maps a response back onto a row goes through this.
 */
export function leadKey(lead: Pick<B2BLead, 'company_domain' | 'full_name'>): string {
  return `${(lead.company_domain || '').toLowerCase().trim()}::${(lead.full_name || '').toLowerCase().trim()}`;
}

/** The person's resolved work email, or null. Never a preview or placeholder. */
export function revealedEmail(lead: B2BLead): string | null {
  if (lead.email_status === 'preview' || lead.email_status === 'invalid') return null;
  const email = lead.revealed_email || lead.work_email;
  return isEmailAddress(email) ? email.trim() : null;
}

export function revealedPhone(lead: B2BLead): string | null {
  const phone = lead.revealed_phone || lead.phone_number;
  return phone && phone.trim() ? phone.trim() : null;
}

/** The provider's unverified company address, when there is one. */
export function previewEmail(lead: B2BLead): string | null {
  // Saved rows from before the preview/verified split carry it in work_email.
  const email =
    lead.preview_email || (lead.email_status === 'preview' ? lead.revealed_email || lead.work_email : null);
  return isEmailAddress(email) ? email.trim() : null;
}

export type EmailState =
  | { kind: 'verified'; email: string; label: string }
  | { kind: 'unconfirmed'; email: string; label: string }
  | { kind: 'not_found' }
  | { kind: 'none' };

/**
 * What the email cell should say.
 *
 * The table used to fall back to a "VERIFIED" badge whenever the status was
 * missing, and showed preview addresses under a "Verified work email" header.
 * A label now only says "Verified" when the verifier said so.
 */
export function emailState(lead: B2BLead): EmailState {
  const email = revealedEmail(lead);
  const status = (lead.email_status || '').toLowerCase();
  // The verifier said this address bounces: it is not a usable email.
  if (email && status !== 'invalid') {
    if (status === 'valid' || status === 'deliverable' || status === 'verified') {
      return { kind: 'verified', email, label: 'Verified' };
    }
    // Found but not confirmed deliverable. Only verified addresses are
    // charged, so these are labelled free.
    const label =
      status === 'accept_all' || status === 'catch_all'
        ? 'Catch-all · free'
        : status === 'risky'
          ? 'Risky · free'
          : 'Unconfirmed · free';
    return { kind: 'unconfirmed', email, label };
  }
  if (status === 'invalid') return { kind: 'not_found' };
  if (status === 'not_found' || status === 'unlisted' || lead.email_lookup === 'not_found') return { kind: 'not_found' };
  return { kind: 'none' };
}

export function needsEmailReveal(lead: B2BLead): boolean {
  return revealedEmail(lead) === null;
}

export function initialsOf(name?: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

export function linkedinHref(url: string): string {
  return url.startsWith('http') ? url : `https://${url}`;
}

export type ContactStatus = 'processing' | 'enriched' | 'partial' | 'none' | 'failed' | 'skipped' | 'not_started';

/**
 * One status per row, from what the lookups actually returned. `wantPhone`
 * says whether a phone was part of the job; without it, an email alone is a
 * complete result rather than a partial one.
 */
export function contactStatus(lead: B2BLead, wantPhone: boolean): ContactStatus {
  const busy = (s?: B2BLead['email_lookup']) => s === 'queued' || s === 'processing';
  if (busy(lead.email_lookup) || busy(lead.phone_lookup)) return 'processing';
  const email = Boolean(revealedEmail(lead));
  const phone = Boolean(revealedPhone(lead));
  if (email && (phone || !wantPhone)) return 'enriched';
  if (email || phone) return 'partial';
  if (lead.email_lookup === 'failed' || lead.phone_lookup === 'failed') return 'failed';
  if (lead.email_lookup === 'no_credits' || lead.phone_lookup === 'no_credits') return 'skipped';
  const emailMissed = emailState(lead).kind === 'not_found' || lead.email_lookup === 'not_found';
  if (emailMissed && (!wantPhone || lead.phone_lookup === 'not_found')) return 'none';
  return 'not_started';
}

export const CONTACT_STATUS_LABEL: Record<ContactStatus, string> = {
  processing: 'Finding contacts…',
  enriched: 'Enriched',
  partial: 'Partially enriched',
  none: 'No contact info found',
  failed: 'Lookup failed',
  skipped: 'Needs credits',
  not_started: 'Not enriched',
};

/** A lead worth showing in the default results view: a verified email or a phone. */
export function hasVerifiedContact(lead: B2BLead): boolean {
  return emailState(lead).kind === 'verified' || Boolean(revealedPhone(lead));
}
