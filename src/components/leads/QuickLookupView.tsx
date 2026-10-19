import React, { useState } from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { LeadCard } from './LeadCard';
import {
  Zap,
  Building2,
  User,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  Loader2,
} from 'lucide-react';

const LinkedinIcon: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/>
  </svg>
);

interface QuickLookupViewProps {
  /** Returns the persisted lead so the card can render what was actually found. */
  onRevealEmail: (lead: B2BLead) => Promise<B2BLead | null>;
  onRevealPhone: (lead: B2BLead) => Promise<B2BLead | null>;
  onSaveLead: (lead: B2BLead) => Promise<B2BLead | null>;
  onStatusChange: (lead: B2BLead, status: B2BPipelineStatus) => Promise<boolean | void>;
  revealingEmailIds: ReadonlySet<string>;
  revealingPhoneIds: ReadonlySet<string>;
}

/**
 * Turns a LinkedIn slug into something a person can read.
 *
 * "patrickcollison" was previously sent through as the literal full name, so
 * every LinkedIn lookup saved a row called "LinkedIn Prospect" with an empty
 * domain — junk that then showed up in the pipeline and could never be matched
 * against a later search. Splitting the camel-cased slug keeps one lookup from
 * colliding with another.
 */
function nameFromLinkedinSlug(url: string): { first: string; last: string; full: string } | null {
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  const slug = match?.[1];
  if (!slug) return null;
  const spaced = slug.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  const parts = spaced.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const first = cap(parts[0]);
  const last = cap(parts.slice(1).join(' '));
  return { first, last, full: `${first}${last ? ' ' + last : ''}` };
}

export const QuickLookupView: React.FC<QuickLookupViewProps> = ({
  onRevealEmail,
  onRevealPhone,
  onSaveLead,
  onStatusChange,
  revealingEmailIds,
  revealingPhoneIds,
}) => {
  const [mode, setMode] = useState<'linkedin' | 'name'>('linkedin');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [fullName, setFullName] = useState('');
  const [companyDomain, setCompanyDomain] = useState('');
  const [lookupLead, setLookupLead] = useState<B2BLead | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSearching) return;
    setErrorMsg(null);

    const cleanUrl = linkedinUrl.trim();
    const cleanName = fullName.trim();
    // Mirrors cleanDomain() on the server: the unique key is case-sensitive,
    // so "Stripe.com" here would become a second row for "stripe.com" and a
    // later lookup would charge for the same contact again.
    const cleanDomain = companyDomain
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .toLowerCase();

    if (mode === 'linkedin' && !cleanUrl) {
      setErrorMsg('Please enter a valid LinkedIn profile URL');
      return;
    }
    if (mode === 'linkedin' && !/^https?:\/\/(www\.)?linkedin\.com\/(in|pub)\//i.test(cleanUrl)) {
      setErrorMsg('That does not look like a LinkedIn profile URL (expected linkedin.com/in/…).');
      return;
    }
    if (mode === 'name' && (!cleanName || !cleanDomain)) {
      setErrorMsg('Both full name and company domain are required');
      return;
    }

    // The id is derived from the input rather than Date.now(): a fresh id on
    // every submit meant the per-lead loading flag could never match the card
    // that was on screen, so a second click was possible while the first
    // request was still in flight — and a second request is a second credit.
    const identity = mode === 'linkedin' ? cleanUrl : `${cleanDomain}::${cleanName}`.toLowerCase();
    const derived = mode === 'linkedin' ? nameFromLinkedinSlug(cleanUrl) : null;
    const nameParts = derived ? [derived.first, derived.last] : cleanName.split(/\s+/);
    const resolvedName = derived ? derived.full : cleanName;

    const lead: B2BLead = {
      id: `quick_${identity}`,
      first_name: nameParts[0] || '',
      last_name: nameParts.slice(1).join(' ') || '',
      full_name: resolvedName || 'LinkedIn Prospect',
      title: 'Target Decision Maker',
      company_name: cleanDomain ? cleanDomain.split('.')[0].toUpperCase() : 'Target Company',
      company_domain: cleanDomain,
      linkedin_url: mode === 'linkedin' ? cleanUrl : null,
      has_email: true,
      has_phone: true,
      is_saved: false,
    };

    // The result card used to be mounted before the request was made, so a
    // lookup that found nothing still rendered an "Enriched Contact Result"
    // panel over a contact with no email. Only a real result creates the card.
    setLookupLead(null);
    // The spinner used to be cleared before the request was even made, so the
    // only visible effect of clicking the button was a toast.
    setIsSearching(true);
    try {
      await handleRevealEmail(lead);
    } finally {
      setIsSearching(false);
    }
  };

  const handleRevealEmail = async (lead: B2BLead) => {
  // Wrapped rather than passed straight through: the shared handler updates the
    // Prospector's result list, which this view does not own, so its own card
    // would have kept showing "unlisted" after paying for the reveal.
    const revealed = await onRevealEmail(lead);
    if (revealed) setLookupLead(revealed);
    return revealed;
  };

  const handleRevealPhone = async () => {
    if (!lookupLead) return;
    const revealed = await onRevealPhone(lookupLead);
    if (revealed) setLookupLead(revealed);
  };

  const handleSaveLead = async (lead: B2BLead) => {
    const saved = await onSaveLead(lead);
    setLookupLead((prev) =>
      prev && prev.id === lead.id
        ? {
            ...prev,
            is_saved: saved !== null,
            db_id: saved?.id || (saved === null ? null : prev.db_id),
          }
        : prev
    );
    return saved;
  };

  const handleStatusChange = async (lead: B2BLead, status: B2BPipelineStatus) => {
    // The shared handler catches its own errors and reports a boolean, so the
    // card must not move to the new stage when the write was rejected.
    const applied = await onStatusChange(lead, status);
    if (applied === false) return;
    setLookupLead((prev) =>
      prev && prev.id === lead.id ? { ...prev, status, is_saved: true } : prev
    );
  };

  return (
    <div className="max-w-2xl space-y-4">
      {/* Panel header — same shape as the Prospector panel so the two tabs
          read as one tool rather than two different products. */}
      <div className="bg-white border border-[#e3e3de] px-4 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-[#141414]" />
          <h2 className="text-xs font-semibold text-[#141414] uppercase tracking-wider">
            Single Lead Fast Reveal
          </h2>
        </div>
        <p className="text-[11px] font-mono text-[#8a8a86]">
          Resolve a verified work email, deliverability check and direct mobile for one contact.
        </p>
      </div>

      {/* Lookup Card */}
      <div className="bg-white border border-[#e3e3de] p-4 shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
        {/* Toggle Mode */}
        <div className="flex border-b border-[#eeeeea] mb-5">
          <button
            type="button"
            onClick={() => { setMode('linkedin'); setErrorMsg(null); }}
            className={`pb-2.5 px-4 font-mono text-xs font-medium border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
              mode === 'linkedin'
                ? 'border-[#141414] text-[#141414]'
                : 'border-transparent text-[#8a8a86] hover:text-[#141414]'
            }`}
          >
            <LinkedinIcon className="w-3.5 h-3.5" />
            <span>Via LinkedIn URL</span>
          </button>
          <button
            type="button"
            onClick={() => { setMode('name'); setErrorMsg(null); }}
            className={`pb-2.5 px-4 font-mono text-xs font-medium border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
              mode === 'name'
                ? 'border-[#141414] text-[#141414]'
                : 'border-transparent text-[#8a8a86] hover:text-[#141414]'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            <span>Via Name &amp; Domain</span>
          </button>
        </div>

        <form onSubmit={handleLookup} className="space-y-4">
          {mode === 'linkedin' ? (
            <div>
              <label className="block text-[11px] font-mono font-medium text-[#8a8a86] mb-1.5 uppercase tracking-wider">
                LinkedIn Profile URL
              </label>
              <div className="relative">
                <LinkedinIcon className="w-4 h-4 text-[#8a8a86] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="url"
                  value={linkedinUrl}
                  onChange={(e) => setLinkedinUrl(e.target.value)}
                  placeholder="https://www.linkedin.com/in/patrickcollison"
                  className="w-full pl-9 pr-3 py-2 bg-[#fafaf8] border border-[#e3e3de] focus:border-[#141414] focus:bg-white text-sm text-[#141414] placeholder-[#8a8a86] font-mono outline-none"
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-mono font-medium text-[#8a8a86] mb-1.5 uppercase tracking-wider">
                  Executive Full Name
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-[#8a8a86] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Patrick Collison"
                    className="w-full pl-9 pr-3 py-2 bg-[#fafaf8] border border-[#e3e3de] focus:border-[#141414] focus:bg-white text-sm text-[#141414] placeholder-[#8a8a86] font-mono outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-mono font-medium text-[#8a8a86] mb-1.5 uppercase tracking-wider">
                  Company Domain
                </label>
                <div className="relative">
                  <Building2 className="w-4 h-4 text-[#8a8a86] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={companyDomain}
                    onChange={(e) => setCompanyDomain(e.target.value)}
                    placeholder="stripe.com"
                    className="w-full pl-9 pr-3 py-2 bg-[#fafaf8] border border-[#e3e3de] focus:border-[#141414] focus:bg-white text-sm text-[#141414] placeholder-[#8a8a86] font-mono outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          {errorMsg && (
            <p className="text-xs text-rose-600 font-mono">{errorMsg}</p>
          )}

          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-1.5 text-[11px] text-[#8a8a86] font-mono">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
              <span>Includes mailbox deliverability check</span>
            </div>

            <button
              type="submit"
              disabled={isSearching}
              className="py-2 px-5 bg-[#141414] hover:bg-black text-[#f6f6f4] text-xs font-mono font-semibold flex items-center gap-2 cursor-pointer transition-all disabled:opacity-50"
            >
              {isSearching ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>RESOLVING...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                  <span>REVEAL CONTACT (1 CR)</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Display Result if fetched */}
      {lookupLead && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span className="text-xs font-mono font-semibold text-[#141414] uppercase tracking-wider">
              Enriched Contact Result
            </span>
          </div>
          <LeadCard
            lead={lookupLead}
            onRevealEmail={handleRevealEmail}
            onRevealPhone={handleRevealPhone}
            onSaveLead={handleSaveLead}
            onStatusChange={handleStatusChange}
            isRevealingEmail={revealingEmailIds.has(lookupLead.id)}
            isRevealingPhone={revealingPhoneIds.has(lookupLead.id)}
          />
        </div>
      )}
    </div>
  );
};