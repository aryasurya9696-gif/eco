import type { B2BLead } from '../../types';

// ============================================================================
// Lead helpers shared by the Prospector table, the cards view and the CSV
// export, so the three can never disagree about what counts as a revealed,
// verified email or about which row a server response belongs to.
// ============================================================================

/** Credits per action. Mirrors pricing_config and the leads edge function. */
export const EMAIL_REVEAL_CREDITS = 1;
export const PHONE_REVEAL_CREDITS = 2;

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
  if (lead.email_status === 'preview') return null;
  const email = lead.revealed_email || lead.work_email;
  return isEmailAddress(email) ? email.trim() : null;
}

export function revealedPhone(lead: B2BLead): string | null {
  const phone = lead.revealed_phone || lead.phone_number;
  return phone && phone.trim() ? phone.trim() : null;
}

/** The provider's unverified company address, when there is one. */
export function previewEmail(lead: B2BLead): string | null {
  const email = lead.preview_email || (lead.email_status === 'preview' ? lead.revealed_email : null);
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
  if (email) {
    const status = (lead.email_status || '').toLowerCase();
    if (status === 'valid' || status === 'deliverable' || status === 'verified') {
      return { kind: 'verified', email, label: 'Verified' };
    }
    const label =
      status === 'accept_all' || status === 'catch_all'
        ? 'Catch-all'
        : status === 'risky'
          ? 'Risky'
          : status === 'invalid'
            ? 'Invalid'
            : 'Unconfirmed';
    return { kind: 'unconfirmed', email, label };
  }
  const status = (lead.email_status || '').toLowerCase();
  if (status === 'not_found' || status === 'unlisted') return { kind: 'not_found' };
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
