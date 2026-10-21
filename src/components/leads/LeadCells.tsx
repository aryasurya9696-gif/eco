import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, Mail, Phone, CheckCircle2, AlertTriangle, RotateCcw, Clock, CircleDashed, Lock } from 'lucide-react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import {
  emailState,
  previewEmail,
  revealedPhone,
  contactStatus,
  CONTACT_STATUS_LABEL,
  type ContactStatus,
} from './lead-utils';
import { useLeadPricing } from './leads-store';
import { mailStore } from '../mail/mail-store';

// ============================================================================
// Contact cells shared by the results table, the cards view and Quick Lookup.
// Each state has its own words, not just its own colour, so "verified",
// "unconfirmed", "not found" and "not revealed yet" read differently to anyone
// who cannot tell green from amber.
// ============================================================================

export const LinkedinIcon: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
  </svg>
);

export const CopyButton: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          // Clipboard access can be denied (insecure origin, permission); the
          // tick must not claim a copy that never happened.
          return;
        }
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1800);
      }}
      className="p-1 shrink-0 text-muted hover:text-ink hover:bg-fill transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-ink"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-ok" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
    </button>
  );
};

/**
 * Manual "find" action for a row automatic enrichment has not covered. Kept
 * as a quiet text link: contacts are normally found automatically after a
 * search, so a solid button on every row read as a required step.
 */
const findLink =
  'inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-2 hover:text-ink underline-offset-2 hover:underline whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink';

/** Shown instead of a find action while the wallet is empty. */
const LockedLine: React.FC<{ onTopUp?: () => void }> = ({ onTopUp }) => (
  <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
    <Lock className="w-3.5 h-3.5" aria-hidden />
    {onTopUp ? (
      <button type="button" onClick={onTopUp} className="underline underline-offset-2 hover:text-ink cursor-pointer">
        Top up to reveal
      </button>
    ) : (
      'Top up to reveal'
    )}
  </span>
);

/** Shared "in progress / failed / skipped" line for a lookup that has no value yet. */
const LookupLine: React.FC<{
  state: B2BLead['email_lookup'];
  what: string;
  onRetry?: () => unknown;
  retryTitle: string;
}> = ({ state, what, onRetry, retryTitle }) => {
  if (state === 'queued') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
        <Clock className="w-3.5 h-3.5" aria-hidden />
        Queued
      </span>
    );
  }
  if (state === 'processing') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
        Finding {what}…
      </span>
    );
  }
  const label = state === 'failed' ? 'Lookup failed' : state === 'no_credits' ? 'Not enough credits' : `No ${what} found`;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`text-[13px] ${state === 'failed' ? 'text-danger' : 'text-muted'}`}>{label}</span>
      {onRetry && (
        <button
          type="button"
          onClick={() => onRetry()}
          className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink underline underline-offset-2 cursor-pointer"
          title={retryTitle}
        >
          <RotateCcw className="w-3 h-3" aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
};

interface EmailCellProps {
  lead: B2BLead;
  onReveal?: (lead: B2BLead) => unknown;
  isRevealing?: boolean;
  /** The wallet is empty: show "Top up to reveal" instead of a find action. */
  locked?: boolean;
  onTopUp?: () => void;
}

export const EmailCell: React.FC<EmailCellProps> = ({ lead, onReveal, isRevealing, locked, onTopUp }) => {
  const pricing = useLeadPricing();
  const state = emailState(lead);
  const preview = previewEmail(lead);

  if (state.kind === 'verified' || state.kind === 'unconfirmed') {
    const verified = state.kind === 'verified';
    return (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <a
            href={`mailto:${state.email}`}
            className="font-mono text-[13px] text-ink hover:underline truncate"
            title={state.email}
          >
            {state.email}
          </a>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              mailStore.openComposer({
                leadId: lead.id,
                to: state.email,
                name: lead.first_name,
                company: lead.company_name,
                subject: lead.company_name ? `Quick intro // ${lead.company_name}` : '',
              });
            }}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono font-medium bg-[#1b7f3b] text-white hover:bg-[#15662f] transition-colors cursor-pointer shrink-0 rounded-xs"
            title="Send 1-Click Outreach via Echo Mail"
          >
            <Mail className="w-3 h-3" />
            <span>Email</span>
          </button>
          <CopyButton value={state.email} label="email" />
        </div>
        <span
          className={`mt-0.5 inline-flex items-center gap-1 text-xs font-medium ${verified ? 'text-ok' : 'text-warn'}`}
          title={
            verified
              ? 'Verified deliverable by the email verifier (charged)'
              : 'Found, but the verifier could not confirm it is deliverable — not charged'
          }
        >
          {verified ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> : <AlertTriangle className="w-3.5 h-3.5" aria-hidden />}
          {state.label}
        </span>
      </div>
    );
  }

  const lookup = lead.email_lookup ?? (isRevealing ? 'processing' : state.kind === 'not_found' ? 'not_found' : null);
  const busy = lookup === 'queued' || lookup === 'processing';

  return (
    <div className="min-w-0 space-y-1">
      {locked && !busy && lookup !== 'not_found' ? (
        <LockedLine onTopUp={onTopUp} />
      ) : lookup ? (
        <LookupLine
          state={lookup}
          what="email"
          onRetry={!busy && onReveal ? () => onReveal(lead) : undefined}
          retryTitle={`Try again — ${pricing.email} credit${pricing.email === 1 ? '' : 's'} only if a verified email is found`}
        />
      ) : onReveal ? (
        <button
          type="button"
          onClick={() => onReveal(lead)}
          className={findLink}
          title={`Find this person's work email — ${pricing.email} credit${pricing.email === 1 ? '' : 's'} only if it is verified`}
          aria-label={`Find email for ${lead.full_name || 'this lead'} (${pricing.email} credit${pricing.email === 1 ? '' : 's'} if verified)`}
        >
          <Mail className="w-3.5 h-3.5" aria-hidden />
          <span>Find email</span>
        </button>
      ) : (
        <span className="text-[13px] text-muted">Not revealed</span>
      )}
      {preview && (
        <p className="text-xs text-muted truncate" title={`Company address from the provider, not verified: ${preview}`}>
          Company: <span className="font-mono">{preview}</span> <span className="italic">(unverified)</span>
        </p>
      )}
    </div>
  );
};

interface PhoneCellProps {
  lead: B2BLead;
  onReveal?: (lead: B2BLead) => unknown;
  isRevealing?: boolean;
  locked?: boolean;
  onTopUp?: () => void;
}

export const PhoneCell: React.FC<PhoneCellProps> = ({ lead, onReveal, isRevealing, locked, onTopUp }) => {
  const pricing = useLeadPricing();
  const phone = revealedPhone(lead);
  if (phone) {
    return (
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <a href={`tel:${phone}`} className="font-mono text-[13px] text-ink hover:underline whitespace-nowrap">
            {phone}
          </a>
          <CopyButton value={phone} label="phone number" />
        </div>
        <span className="text-xs text-muted">{lead.phone_type === 'landline' ? 'Landline' : 'Direct'}</span>
      </div>
    );
  }
  const lookup = lead.phone_lookup ?? (isRevealing ? 'processing' : null);
  const phoneBusy = lookup === 'queued' || lookup === 'processing';
  if (locked && !phoneBusy && lookup !== 'not_found') return <LockedLine onTopUp={onTopUp} />;
  if (lookup) {
    const busy = lookup === 'queued' || lookup === 'processing';
    return (
      <LookupLine
        state={lookup}
        what="phone"
        onRetry={!busy && onReveal ? () => onReveal(lead) : undefined}
        retryTitle={`Try again — ${pricing.phone} credit${pricing.phone === 1 ? '' : 's'} only if a number is found`}
      />
    );
  }
  if (!onReveal) return <span className="text-[13px] text-muted">—</span>;
  return (
    <button
      type="button"
      onClick={() => onReveal(lead)}
      className={findLink}
      title={`Find a direct phone number — ${pricing.phone} credit${pricing.phone === 1 ? '' : 's'}, charged only if one is found`}
      aria-label={`Find phone for ${lead.full_name || 'this lead'} (${pricing.phone} credit${pricing.phone === 1 ? '' : 's'} if found)`}
    >
      <Phone className="w-3.5 h-3.5" aria-hidden />
      <span>Find phone</span>
    </button>
  );
};

const STATUS_TONE: Record<ContactStatus, string> = {
  processing: 'text-info',
  enriched: 'text-ok',
  partial: 'text-warn',
  none: 'text-muted',
  failed: 'text-danger',
  skipped: 'text-warn',
  not_started: 'text-muted',
};

/** One-line enrichment status for a row; text and icon, never colour alone. */
export const ContactStatusBadge: React.FC<{ lead: B2BLead; wantPhone: boolean }> = ({ lead, wantPhone }) => {
  const status = contactStatus(lead, wantPhone);
  if (status === 'not_started') return null;
  const Icon =
    status === 'processing'
      ? Loader2
      : status === 'enriched'
        ? CheckCircle2
        : status === 'none'
          ? CircleDashed
          : AlertTriangle;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${STATUS_TONE[status]}`}>
      <Icon className={`w-3.5 h-3.5 ${status === 'processing' ? 'animate-spin' : ''}`} aria-hidden />
      {CONTACT_STATUS_LABEL[status]}
    </span>
  );
};

interface StageSelectProps {
  lead: B2BLead;
  onChange: (lead: B2BLead, status: B2BPipelineStatus) => unknown;
}

const STAGE_STYLE: Record<string, string> = {
  new: 'border-line-strong text-ink',
  contacted: 'border-info/40 text-info',
  replied: 'border-ok-line text-ok',
  dismissed: 'border-line text-muted',
};

export const StageSelect: React.FC<StageSelectProps> = ({ lead, onChange }) => {
  const value = lead.status || (lead.is_saved ? 'new' : '');
  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value) onChange(lead, e.target.value as B2BPipelineStatus);
      }}
      aria-label={`Pipeline stage for ${lead.full_name || 'this lead'}`}
      className={`h-8 pl-2 pr-7 text-[13px] bg-white border cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink ${
        value ? STAGE_STYLE[value] ?? STAGE_STYLE.new : 'border-line text-muted hover:border-line-strong'
      }`}
    >
      {!value && <option value="">+ Pipeline</option>}
      <option value="new">New</option>
      <option value="contacted">Contacted</option>
      <option value="replied">Replied</option>
      <option value="dismissed">Dismissed</option>
    </select>
  );
};
