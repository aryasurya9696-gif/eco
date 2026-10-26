import React from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { ExternalLink, MapPin, Users, TrendingUp, Bookmark, BookmarkCheck } from 'lucide-react';
import { EmailCell, PhoneCell, StageSelect, LinkedinIcon, ContactStatusBadge } from './LeadCells';
import { initialsOf, linkedinHref } from './lead-utils';
import { CompanyName } from './CompanyPanel';
import { EnrichPersonButton } from './EnrichPersonButton';

interface LeadCardProps {
  lead: B2BLead;
  onSaveLead?: (lead: B2BLead) => Promise<any>;
  onStatusChange?: (lead: B2BLead, status: B2BPipelineStatus) => Promise<boolean | void>;
  onRevealEmail?: (lead: B2BLead) => Promise<unknown>;
  onRevealPhone?: (lead: B2BLead) => Promise<unknown>;
  isRevealingEmail?: boolean;
  isRevealingPhone?: boolean;
  /** When provided, the card shows a selection checkbox (bulk actions on mobile). */
  isSelected?: boolean;
  onToggleSelect?: (lead: B2BLead) => void;
  /** Whether phones were part of the lookup, for the status line. */
  wantPhone?: boolean;
  /** Wallet empty: show "Top up to reveal" instead of find actions. */
  locked?: boolean;
  onTopUp?: () => void;
}

/**
 * A single prospect card — the cards view, the mobile layout of the results,
 * and Quick Lookup. Contact cells are the same components the table uses, so
 * a lead cannot read "verified" in one view and "preview" in another.
 */
export const LeadCard: React.FC<LeadCardProps> = ({
  lead,
  onSaveLead,
  onStatusChange,
  onRevealEmail,
  onRevealPhone,
  isRevealingEmail,
  isRevealingPhone,
  isSelected,
  onToggleSelect,
  wantPhone = false,
  locked,
  onTopUp,
}) => {
  const selectable = Boolean(onToggleSelect);

  return (
    <article
      className={`bg-white border p-4 flex flex-col gap-3 transition-colors ${
        isSelected ? 'border-ink ring-1 ring-ink' : 'border-line hover:border-line-strong'
      }`}
      aria-label={lead.full_name || 'Lead'}
    >
      <div className="flex items-start gap-3">
        {selectable && (
          <input
            type="checkbox"
            checked={Boolean(isSelected)}
            onChange={() => onToggleSelect?.(lead)}
            aria-label={`Select ${lead.full_name || 'lead'}`}
            className="mt-1 w-4 h-4 accent-ink cursor-pointer shrink-0"
          />
        )}
        <div
          className="w-10 h-10 rounded-full bg-ink text-white flex items-center justify-center text-xs font-semibold shrink-0"
          aria-hidden
        >
          {initialsOf(lead.full_name)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="font-semibold text-[15px] text-ink truncate">{lead.full_name || 'Unnamed lead'}</h3>
            {lead.linkedin_url && (
              <a
                href={linkedinHref(lead.linkedin_url)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-[#0a66c2] transition-colors shrink-0"
                aria-label={`${lead.full_name} on LinkedIn (opens in a new tab)`}
              >
                <LinkedinIcon className="w-4 h-4" />
              </a>
            )}
          </div>
          <p className="text-[13px] text-ink-2 truncate" title={lead.title}>{lead.title || '—'}</p>
          <ContactStatusBadge lead={lead} wantPhone={wantPhone} />
          <EnrichPersonButton lead={lead} />
          <p className="mt-0.5 text-[13px] text-ink truncate">
            <CompanyName name={lead.company_name} domain={lead.company_domain} className="font-medium" />
            {lead.company_domain && (
              <>
                {' · '}
                <a
                  href={`https://${lead.company_domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted hover:text-ink hover:underline inline-flex items-center gap-0.5"
                >
                  {lead.company_domain}
                  <ExternalLink className="w-3 h-3" aria-hidden />
                </a>
              </>
            )}
          </p>
        </div>

        {onSaveLead && (
          <button
            type="button"
            onClick={() => onSaveLead(lead)}
            aria-pressed={Boolean(lead.is_saved)}
            aria-label={lead.is_saved ? 'Remove from pipeline' : 'Save to pipeline'}
            title={lead.is_saved ? 'Saved — click to remove from pipeline' : 'Save to pipeline'}
            className={`p-2 shrink-0 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-ink ${
              lead.is_saved ? 'text-ok bg-ok-bg' : 'text-muted hover:text-ink hover:bg-fill'
            }`}
          >
            {lead.is_saved ? <BookmarkCheck className="w-4 h-4" aria-hidden /> : <Bookmark className="w-4 h-4" aria-hidden />}
          </button>
        )}
      </div>

      {(lead.location || lead.company_size || lead.company_revenue) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
          {lead.location && (
            <span className="inline-flex items-center gap-1 min-w-0">
              <MapPin className="w-3.5 h-3.5 text-muted shrink-0" aria-hidden />
              <span className="truncate">{lead.location}</span>
            </span>
          )}
          {lead.company_size && (
            <span className="inline-flex items-center gap-1">
              <Users className="w-3.5 h-3.5 text-muted" aria-hidden />
              {lead.company_size}
            </span>
          )}
          {lead.company_revenue && (
            <span className="inline-flex items-center gap-1">
              <TrendingUp className="w-3.5 h-3.5 text-muted" aria-hidden />
              {lead.company_revenue}
            </span>
          )}
        </div>
      )}

      <dl className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-2.5 pt-3 border-t border-line-soft">
        <dt className="text-xs text-muted pt-1.5">Email</dt>
        <dd className="min-w-0">
          <EmailCell lead={lead} onReveal={onRevealEmail} isRevealing={isRevealingEmail} locked={locked} onTopUp={onTopUp} />
        </dd>
        <dt className="text-xs text-muted pt-1.5">Phone</dt>
        <dd className="min-w-0">
          <PhoneCell lead={lead} onReveal={onRevealPhone} isRevealing={isRevealingPhone} locked={locked} onTopUp={onTopUp} />
        </dd>
        {onStatusChange && (
          <>
            <dt className="text-xs text-muted pt-1.5">Stage</dt>
            <dd>
              <StageSelect lead={lead} onChange={onStatusChange} />
            </dd>
          </>
        )}
      </dl>
    </article>
  );
};
