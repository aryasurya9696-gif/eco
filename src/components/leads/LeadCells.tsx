import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, Mail, Phone, CheckCircle2, AlertTriangle, RotateCcw } from 'lucide-react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import {
  emailState,
  previewEmail,
  revealedPhone,
  EMAIL_REVEAL_CREDITS,
  PHONE_REVEAL_CREDITS,
} from './lead-utils';

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

const revealBtn =
  'inline-flex items-center gap-1.5 h-8 px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink';

interface EmailCellProps {
  lead: B2BLead;
  onReveal?: (lead: B2BLead) => unknown;
  isRevealing?: boolean;
}

export const EmailCell: React.FC<EmailCellProps> = ({ lead, onReveal, isRevealing }) => {
  const state = emailState(lead);
  const preview = previewEmail(lead);

  if (state.kind === 'verified' || state.kind === 'unconfirmed') {
    const verified = state.kind === 'verified';
    return (
      <div className="min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          <a
            href={`mailto:${state.email}`}
            className="font-mono text-[13px] text-ink hover:underline truncate"
            title={state.email}
          >
            {state.email}
          </a>
          <CopyButton value={state.email} label="email" />
        </div>
        <span
          className={`mt-0.5 inline-flex items-center gap-1 text-xs font-medium ${verified ? 'text-ok' : 'text-warn'}`}
          title={verified ? 'Verified deliverable by the email verifier' : 'Found, but the verifier could not confirm it is deliverable'}
        >
          {verified ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> : <AlertTriangle className="w-3.5 h-3.5" aria-hidden />}
          {state.label}
        </span>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-1">
      {state.kind === 'not_found' ? (
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted">No email found</span>
          {onReveal && (
            <button
              type="button"
              onClick={() => onReveal(lead)}
              disabled={isRevealing}
              className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink underline underline-offset-2 cursor-pointer disabled:opacity-60"
              title={`Try again — ${EMAIL_REVEAL_CREDITS} credit only if an email is found`}
            >
              {isRevealing ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <RotateCcw className="w-3 h-3" aria-hidden />}
              Retry
            </button>
          )}
        </div>
      ) : onReveal ? (
        <button
          type="button"
          onClick={() => onReveal(lead)}
          disabled={isRevealing}
          className={`${revealBtn} bg-ink hover:bg-black text-white`}
          title={`Find this person's verified work email — ${EMAIL_REVEAL_CREDITS} credit, charged only if one is found`}
          aria-label={`Reveal email for ${lead.full_name || 'this lead'} (${EMAIL_REVEAL_CREDITS} credit)`}
        >
          {isRevealing ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Mail className="w-3.5 h-3.5" aria-hidden />}
          <span>{isRevealing ? 'Revealing…' : `Reveal · ${EMAIL_REVEAL_CREDITS} cr`}</span>
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
}

export const PhoneCell: React.FC<PhoneCellProps> = ({ lead, onReveal, isRevealing }) => {
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
  if (lead.phone_lookup === 'not_found') {
    return <span className="text-[13px] text-muted whitespace-nowrap">No phone found</span>;
  }
  if (!onReveal) return <span className="text-[13px] text-muted">—</span>;
  return (
    <button
      type="button"
      onClick={() => onReveal(lead)}
      disabled={isRevealing}
      className={`${revealBtn} bg-white border border-line-strong hover:border-ink text-ink`}
      title={`Find a direct phone number — ${PHONE_REVEAL_CREDITS} credits, charged only if one is found`}
      aria-label={`Reveal phone for ${lead.full_name || 'this lead'} (${PHONE_REVEAL_CREDITS} credits)`}
    >
      {isRevealing ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Phone className="w-3.5 h-3.5" aria-hidden />}
      <span>{isRevealing ? 'Revealing…' : `Reveal · ${PHONE_REVEAL_CREDITS} cr`}</span>
    </button>
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
