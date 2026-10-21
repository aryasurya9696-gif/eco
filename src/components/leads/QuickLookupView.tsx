import React, { useId, useState } from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { LeadCard } from './LeadCard';
import { LinkedinIcon } from './LeadCells';
import type { RevealOutcome } from './LeadsTab';
import { leadKey, revealedEmail, revealedPhone } from './lead-utils';
import { useLeadPricing } from './leads-store';
import { creditsLabel, formatCredits } from '../../lib/billing';
import { User, Building2, Search, Loader2, AlertCircle, SearchX, RefreshCw, CheckCircle2 } from 'lucide-react';

interface QuickLookupViewProps {
  onReveal: (lead: B2BLead, kind: 'email' | 'phone') => Promise<RevealOutcome>;
  onSaveLead: (lead: B2BLead) => Promise<B2BLead | null>;
  onStatusChange: (lead: B2BLead, status: B2BPipelineStatus) => Promise<boolean | void>;
  /** Checked first, so a contact already in the pipeline costs nothing and needs no request. */
  savedLeads: B2BLead[];
  availableCredits: number | null;
  onNavigateBilling?: () => void;
}

type Mode = 'linkedin' | 'name';

type Result =
  | { kind: 'idle' }
  | { kind: 'loading'; label: string }
  | { kind: 'found'; lead: B2BLead; note: string }
  | { kind: 'not_found'; label: string; phoneTried: boolean }
  | { kind: 'no_credits'; message?: string }
  | { kind: 'error'; message: string };

const LINKEDIN_RE = /^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/(in|pub)\/[^/?#\s]+/i;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function cleanDomain(raw: string): string {
  // Mirrors cleanDomain() on the server: the unique key is case-sensitive,
  // so "Stripe.com" here would become a second row for "stripe.com".
  return raw.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
}

function linkedinSlug(url?: string | null): string | null {
  const m = (url || '').match(/linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** "patrick-collison" → Patrick Collison, so a LinkedIn lookup saves a readable row. */
function nameFromLinkedinSlug(url: string): { first: string; last: string; full: string } | null {
  const slug = url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i)?.[1];
  if (!slug) return null;
  const parts = slug
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b[0-9a-f]{6,}\b/gi, '') // trailing hash LinkedIn adds to duplicate names
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const first = cap(parts[0]);
  const last = parts.slice(1).map(cap).join(' ');
  return { first, last, full: `${first}${last ? ' ' + last : ''}` };
}

export const QuickLookupView: React.FC<QuickLookupViewProps> = ({
  onReveal,
  onSaveLead,
  onStatusChange,
  savedLeads,
  availableCredits,
  onNavigateBilling,
}) => {
  const ids = useId();
  const [mode, setMode] = useState<Mode>('linkedin');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [fullName, setFullName] = useState('');
  const [companyDomain, setCompanyDomain] = useState('');
  const [alsoPhone, setAlsoPhone] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<'linkedin' | 'name' | 'domain', string>>>({});
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const [lastQuery, setLastQuery] = useState<B2BLead | null>(null);

  const pricing = useLeadPricing();
  const busy = result.kind === 'loading';
  const walletEmpty = availableCredits !== null && availableCredits <= 0;
  const maxCost = pricing.email + (alsoPhone ? pricing.phone : 0);

  const validate = (): B2BLead | null => {
    const next: typeof errors = {};
    const url = linkedinUrl.trim();
    const name = fullName.trim().replace(/\s+/g, ' ');
    const domain = cleanDomain(companyDomain);
    if (mode === 'linkedin') {
      if (!url) next.linkedin = 'Enter a LinkedIn profile URL.';
      else if (!LINKEDIN_RE.test(url)) next.linkedin = 'Use a profile URL like linkedin.com/in/jane-doe.';
    } else {
      if (!name) next.name = 'Enter the person’s full name.';
      else if (name.split(' ').length < 2) next.name = 'Enter first and last name.';
      if (!domain) next.domain = 'Enter the company’s website domain.';
      else if (!DOMAIN_RE.test(domain)) next.domain = 'Use a domain like stripe.com.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return null;

    const normalizedUrl = mode === 'linkedin' ? (url.startsWith('http') ? url : `https://${url}`) : null;
    const derived = normalizedUrl ? nameFromLinkedinSlug(normalizedUrl) : null;
    const resolvedName = derived ? derived.full : name;
    const parts = derived ? [derived.first, derived.last] : resolvedName.split(' ');
    // The id comes from the input, so the same query is always the same lead.
    const identity = mode === 'linkedin' ? `li:${linkedinSlug(normalizedUrl)}` : `${domain}::${name.toLowerCase()}`;
    return {
      id: `quick_${identity}`,
      first_name: parts[0] || '',
      last_name: parts.slice(1).join(' '),
      full_name: resolvedName,
      title: '',
      company_name: '',
      company_domain: mode === 'name' ? domain : '',
      linkedin_url: normalizedUrl,
      is_saved: false,
    };
  };

  const describe = (lead: B2BLead) =>
    lead.linkedin_url ? lead.linkedin_url.replace(/^https?:\/\/(www\.)?/, '') : `${lead.full_name} at ${lead.company_domain}`;

  /** A contact already in the pipeline is shown from there — no request, no credits. */
  const findSaved = (lead: B2BLead): B2BLead | undefined => {
    const slug = linkedinSlug(lead.linkedin_url);
    return savedLeads.find(
      (s) => (slug && linkedinSlug(s.linkedin_url) === slug) || (lead.company_domain && leadKey(s) === leadKey(lead)),
    );
  };

  const run = async (query: B2BLead) => {
    if (busy) return;
    setLastQuery(query);
    const label = describe(query);

    const saved = findSaved(query);
    if (saved && revealedEmail(saved) && (!alsoPhone || revealedPhone(saved))) {
      setResult({ kind: 'found', lead: { ...saved }, note: 'Already in your pipeline — no credits used.' });
      return;
    }

    setResult({ kind: 'loading', label });
    const email = await onReveal(saved ? { ...query, ...saved, id: query.id } : query, 'email');
    if (email.kind === 'no_credits') return setResult({ kind: 'no_credits', message: email.message });
    if (email.kind === 'error') return setResult({ kind: 'error', message: email.message });

    let lead = email.kind === 'found' ? email.lead : null;
    let phoneNote = '';
    let phoneTried = false;
    if (alsoPhone && !(lead && revealedPhone(lead))) {
      phoneTried = true;
      const phone = await onReveal(lead ?? query, 'phone');
      if (phone.kind === 'found') lead = { ...(lead ?? query), ...phone.lead };
      else if (phone.kind === 'not_found') phoneNote = ' No direct phone found (not charged).';
      else if (phone.kind === 'no_credits') phoneNote = ' Phone skipped — not enough credits.';
      else phoneNote = ` Phone lookup failed: ${phone.message}`;
    }

    if (!lead) return setResult({ kind: 'not_found', label, phoneTried });
    const credits = email.kind === 'found' ? email.credits : 0;
    setResult({
      kind: 'found',
      lead,
      note:
        (email.kind === 'found' && email.cached
          ? 'Already on file — no credits used.'
          : email.kind === 'found'
            ? `Found and saved to your pipeline · ${creditsLabel(credits)}.`
            : 'No work email found (not charged).') + phoneNote,
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const query = validate();
    if (query) void run(query);
  };

  const updateFound = (patch: (l: B2BLead) => B2BLead) =>
    setResult((prev) => (prev.kind === 'found' ? { ...prev, lead: patch(prev.lead) } : prev));

  const inputCls = (error?: string) =>
    `w-full h-10 pl-9 pr-3 bg-white border text-sm text-ink placeholder:text-muted outline-none focus:ring-2 focus:ring-ink/10 disabled:opacity-50 ${
      error ? 'border-danger focus:border-danger' : 'border-line hover:border-line-strong focus:border-ink'
    }`;
  const fieldError = (id: string, msg?: string) =>
    msg ? (
      <p id={id} className="mt-1 text-xs text-danger flex items-center gap-1">
        <AlertCircle className="w-3.5 h-3.5" aria-hidden />
        {msg}
      </p>
    ) : null;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)] gap-5 items-start">
      <section className="bg-white border border-line" aria-labelledby={`${ids}-title`}>
        <header className="px-4 sm:px-6 pt-5 pb-4 border-b border-line-soft">
          <h2 id={`${ids}-title`} className="text-lg font-semibold text-ink">Quick lookup</h2>
          <p className="mt-0.5 text-sm text-ink-2">Find the work email (and optionally phone) for one person you already know.</p>
        </header>

        <form onSubmit={handleSubmit} noValidate className="px-4 sm:px-6 py-5 space-y-4">
          <div className="inline-flex border border-line" role="group" aria-label="Look up by">
            {([
              ['linkedin', 'LinkedIn URL', <LinkedinIcon key="i" className="w-4 h-4" />],
              ['name', 'Name & company', <User key="u" className="w-4 h-4" aria-hidden />],
            ] as const).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                aria-pressed={mode === id}
                onClick={() => {
                  setMode(id);
                  setErrors({});
                }}
                disabled={busy}
                className={`h-9 px-3 text-sm flex items-center gap-2 border-r border-line last:border-r-0 cursor-pointer ${
                  mode === id ? 'bg-ink text-white font-medium' : 'bg-white text-ink-2 hover:bg-fill'
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          {mode === 'linkedin' ? (
            <div>
              <label htmlFor={`${ids}-li`} className="block text-[13px] font-medium text-ink-2 mb-1.5">LinkedIn profile URL</label>
              <div className="relative">
                <LinkedinIcon className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id={`${ids}-li`}
                  type="url"
                  inputMode="url"
                  value={linkedinUrl}
                  onChange={(e) => setLinkedinUrl(e.target.value)}
                  placeholder="linkedin.com/in/jane-doe"
                  disabled={busy}
                  aria-invalid={Boolean(errors.linkedin)}
                  aria-describedby={errors.linkedin ? `${ids}-li-err` : undefined}
                  className={inputCls(errors.linkedin)}
                />
              </div>
              {fieldError(`${ids}-li-err`, errors.linkedin)}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${ids}-name`} className="block text-[13px] font-medium text-ink-2 mb-1.5">Full name</label>
                <div className="relative">
                  <User className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
                  <input
                    id={`${ids}-name`}
                    type="text"
                    autoComplete="off"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Doe"
                    disabled={busy}
                    aria-invalid={Boolean(errors.name)}
                    aria-describedby={errors.name ? `${ids}-name-err` : undefined}
                    className={inputCls(errors.name)}
                  />
                </div>
                {fieldError(`${ids}-name-err`, errors.name)}
              </div>
              <div>
                <label htmlFor={`${ids}-domain`} className="block text-[13px] font-medium text-ink-2 mb-1.5">Company domain</label>
                <div className="relative">
                  <Building2 className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
                  <input
                    id={`${ids}-domain`}
                    type="text"
                    autoComplete="off"
                    value={companyDomain}
                    onChange={(e) => setCompanyDomain(e.target.value)}
                    placeholder="stripe.com"
                    disabled={busy}
                    aria-invalid={Boolean(errors.domain)}
                    aria-describedby={errors.domain ? `${ids}-domain-err` : undefined}
                    className={inputCls(errors.domain)}
                  />
                </div>
                {fieldError(`${ids}-domain-err`, errors.domain)}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={alsoPhone}
              onChange={(e) => setAlsoPhone(e.target.checked)}
              disabled={busy}
              className="w-4 h-4 accent-ink"
            />
            <span className="text-sm text-ink">Also find a direct phone number</span>
            <span className="text-xs text-muted">{formatCredits(pricing.phone)} cr</span>
          </label>

          <div className="pt-1 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-xs text-muted">
              {walletEmpty ? (
                <span className="text-warn">
                  Your balance is {creditsLabel(availableCredits)}.{' '}
                  {onNavigateBilling && (
                    <button type="button" onClick={onNavigateBilling} className="underline underline-offset-2 cursor-pointer">
                      Top up
                    </button>
                  )}
                </span>
              ) : (
                `Charged only when found. Contacts already in your pipeline are free.`
              )}
            </p>
            <button
              type="submit"
              disabled={busy}
              className="h-10 px-5 bg-ink hover:bg-black text-white text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Search className="w-4 h-4" aria-hidden />}
              {busy ? 'Looking up…' : `Find contact · up to ${formatCredits(maxCost)} cr`}
            </button>
          </div>
        </form>
      </section>

      <div aria-live="polite" className="min-w-0">
        {result.kind === 'idle' && (
          <div className="bg-white border border-dashed border-line-strong px-6 py-12 text-center text-sm text-ink-2">
            The contact you look up appears here.
          </div>
        )}

        {result.kind === 'loading' && (
          <div className="bg-white border border-line px-6 py-12 flex items-center justify-center gap-2 text-sm text-ink-2" role="status">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            Looking up <span className="font-medium text-ink truncate">{result.label}</span>…
          </div>
        )}

        {result.kind === 'found' && (
          <div className="space-y-2">
            <p className="flex items-start gap-1.5 text-[13px] text-ink-2">
              <CheckCircle2 className="w-4 h-4 text-ok shrink-0 mt-0.5" aria-hidden />
              <span>{result.note}</span>
            </p>
            <LeadCard
              lead={result.lead}
              wantPhone={alsoPhone}
              onRevealPhone={async (l) => {
                const r = await onReveal(l, 'phone');
                if (r.kind === 'found') updateFound((prev) => ({ ...prev, ...r.lead }));
                else updateFound((prev) => ({ ...prev, phone_lookup: r.kind === 'no_credits' ? 'no_credits' : r.kind === 'error' ? 'failed' : 'not_found' }));
              }}
              onSaveLead={async (l) => {
                const saved = await onSaveLead(l);
                updateFound((prev) => ({ ...prev, is_saved: l.is_saved ? false : saved !== null, db_id: saved?.id ?? (l.is_saved ? null : prev.db_id) }));
                return saved;
              }}
              onStatusChange={async (l, status) => {
                const ok = await onStatusChange(l, status);
                if (ok !== false) updateFound((prev) => ({ ...prev, status, is_saved: true }));
                return ok;
              }}
            />
          </div>
        )}

        {result.kind === 'not_found' && (
          <div className="bg-white border border-line px-5 py-6">
            <div className="flex items-start gap-3">
              <SearchX className="w-5 h-5 text-muted shrink-0" aria-hidden />
              <div className="min-w-0">
                <h3 className="font-semibold text-ink">No contact details found</h3>
                <p className="mt-1 text-sm text-ink-2 break-words">
                  The provider has no work email{result.phoneTried ? ' or phone' : ''} for <span className="font-medium text-ink">{result.label}</span>. You were not charged.
                </p>
                <p className="mt-2 text-[13px] text-muted">
                  {mode === 'linkedin'
                    ? 'Try “Name & company” with their current company domain.'
                    : 'Check the spelling, or try their LinkedIn profile URL instead.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {result.kind === 'no_credits' && (
          <div className="bg-warn-bg border border-warn-line px-5 py-5 flex flex-wrap items-center justify-between gap-3" role="alert">
            <p className="text-sm text-ink">{result.message || 'Not enough credits for this lookup.'} Nothing was charged.</p>
            {onNavigateBilling && (
              <button type="button" onClick={onNavigateBilling} className="h-9 px-3 bg-ink hover:bg-black text-white text-sm font-medium cursor-pointer">
                {result.message ? 'Go to Billing' : 'Top up'}
              </button>
            )}
          </div>
        )}

        {result.kind === 'error' && (
          <div className="bg-danger-bg border border-danger-line px-5 py-5 flex flex-wrap items-center justify-between gap-3" role="alert">
            <p className="text-sm text-danger-ink flex items-start gap-2 min-w-0">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <span className="break-words">Lookup failed: {result.message} Nothing was charged.</span>
            </p>
            {lastQuery && (
              <button
                type="button"
                onClick={() => void run(lastQuery)}
                className="h-9 px-3 bg-danger-strong hover:bg-danger text-white text-sm font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" aria-hidden />
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
