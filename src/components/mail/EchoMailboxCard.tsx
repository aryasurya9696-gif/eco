import React, { useEffect, useId, useRef, useState } from 'react';
import { AtSign, Check, Loader2, AlertCircle, Inbox, Globe } from 'lucide-react';
import { mailStore, useMailStore, MAILBOX_NAME_REASON_COPY, type MailboxNameReason } from './mail-store';
import { useAuth } from '../../context/AuthContext';
import { useEcho } from '../../context/EchoContext';

const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

/** "Rahul Kumar" -> "rahul"; only characters an address can hold. */
const suggestLocalPart = (fullName: string | null | undefined) =>
  (fullName || '')
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '') || '';

/** Quick checks that need no server round trip. */
function localReason(value: string): MailboxNameReason | null {
  if (value.length < 3) return 'too_short';
  if (!LOCAL_PART_RE.test(value) || /\.\./.test(value)) return 'invalid';
  return null;
}

type Availability =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; address: string }
  | { state: 'unavailable'; reason: MailboxNameReason; suggestions: string[] }
  | { state: 'unknown'; message: string };

interface EchoMailboxCardProps {
  /** "first-run" fills the empty inbox; "panel" sits at the top of Mailboxes. */
  variant?: 'panel' | 'first-run';
  /** Opens the app-password dialog; defaults to sending the user to Mailboxes. */
  onUseOwnInbox?: () => void;
}

/**
 * "Get your Echo email": claims name@<shared domain> in one click, with live
 * availability while typing. Shown in Mailboxes and as the first-run state of
 * the Mail tab.
 */
export const EchoMailboxCard: React.FC<EchoMailboxCardProps> = ({ variant = 'panel', onUseOwnInbox }) => {
  const { mailConfig, mailConfigLoading, userId } = useMailStore();
  const { profile } = useAuth();
  const { addToast } = useEcho();
  const ids = { local: useId(), name: useId(), status: useId() };

  const [localPart, setLocalPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const touchedLocal = useRef(false);
  const touchedName = useRef(false);
  const [availability, setAvailability] = useState<Availability>({ state: 'idle' });
  const [isCreating, setIsCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const checkSeq = useRef(0);

  useEffect(() => {
    if (userId) void mailStore.loadMailConfig();
  }, [userId]);

  // Prefill from the profile until the user edits the fields themselves.
  useEffect(() => {
    if (!touchedName.current && profile?.full_name) setDisplayName(profile.full_name);
    if (!touchedLocal.current && profile?.full_name) setLocalPart(suggestLocalPart(profile.full_name));
  }, [profile?.full_name]);

  const sharedDomain = mailConfig?.shared_domain || null;
  const value = localPart.trim().toLowerCase();

  // Debounced live availability check.
  useEffect(() => {
    if (!sharedDomain) return;
    const seq = ++checkSeq.current;
    if (!value) {
      setAvailability({ state: 'idle' });
      return;
    }
    const quick = localReason(value);
    if (quick) {
      setAvailability({ state: 'unavailable', reason: quick, suggestions: [] });
      return;
    }
    setAvailability({ state: 'checking' });
    const timer = window.setTimeout(async () => {
      const res = await mailStore.checkMailboxName(value);
      if (seq !== checkSeq.current) return;
      if (!res.ok) {
        setAvailability({ state: 'unknown', message: res.error });
      } else if (res.available) {
        setAvailability({ state: 'available', address: res.address || `${value}@${sharedDomain}` });
      } else {
        setAvailability({ state: 'unavailable', reason: res.reason || 'taken', suggestions: res.suggestions });
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [value, sharedDomain]);

  const used = mailConfig?.echo_mailboxes_used ?? 0;
  const max = mailConfig?.max_echo_mailboxes ?? 3;
  const atLimit = used >= max;

  const pickSuggestion = (s: string) => {
    touchedLocal.current = true;
    setLocalPart(s.replace(/@.*$/, ''));
    setFormError(null);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCreating || !sharedDomain) return;
    const quick = value ? localReason(value) : 'too_short';
    if (quick) return setFormError(MAILBOX_NAME_REASON_COPY[quick]);
    if (availability.state === 'unavailable') return setFormError(MAILBOX_NAME_REASON_COPY[availability.reason]);
    if (!displayName.trim()) return setFormError('Enter the name recipients should see.');

    setIsCreating(true);
    setFormError(null);
    const res = await mailStore.claimEchoMailbox(value, displayName);
    setIsCreating(false);
    if ('error' in res) {
      if (res.code === 'taken' || res.code === 'invalid') {
        setAvailability({ state: 'unavailable', reason: res.reason || 'taken', suggestions: res.suggestions || [] });
      }
      setFormError(res.error);
      return;
    }
    const address = res.mailbox?.address || `${value}@${sharedDomain}`;
    addToast(`${address} is ready. Replies will arrive in your Echo inbox.`, 'success');
    touchedLocal.current = true;
    setLocalPart('');
    setAvailability({ state: 'idle' });
    if (variant === 'first-run') mailStore.setActiveSubView('mailbox');
  };

  const ownInbox = onUseOwnInbox || (() => mailStore.requestConnectInbox());
  const isFirstRun = variant === 'first-run';

  const secondary = (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${isFirstRun ? 'justify-center' : ''}`}>
      <button
        type="button"
        onClick={ownInbox}
        className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] text-[#18181b] border border-[#e8e8e3] rounded-md bg-white hover:bg-[#f4f4f0] transition-colors cursor-pointer"
      >
        <Inbox className="w-3.5 h-3.5 text-[#71717a]" />
        Use your own inbox (Gmail/Zoho)
      </button>
      <button
        type="button"
        onClick={() => mailStore.setActiveSubView('domains')}
        className="inline-flex items-center gap-1.5 text-[13px] text-[#52525b] hover:text-[#18181b] underline-offset-2 hover:underline cursor-pointer"
      >
        <Globe className="w-3.5 h-3.5" />
        Use your own domain
      </button>
    </div>
  );

  const shell = `rounded-xl border border-[#e8e8e3] ${isFirstRun ? 'bg-white shadow-xs' : 'bg-[#fafaf8]'} p-5 sm:p-6`;

  // Still asking the server whether Echo addresses are switched on.
  if (!mailConfig) {
    return (
      <div className={shell} aria-busy={mailConfigLoading}>
        <div className="flex items-center gap-2 text-[13px] text-[#a1a1aa]">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  if (!sharedDomain) {
    return (
      <div className={shell}>
        <div className={`flex items-start gap-3 ${isFirstRun ? 'flex-col items-center text-center' : ''}`}>
          <span className="w-9 h-9 shrink-0 rounded-full bg-[#f0f0eb] text-[#a1a1aa] flex items-center justify-center">
            <AtSign className="w-4 h-4" />
          </span>
          <div>
            <div className="text-[14px] font-medium text-[#52525b]">Echo email addresses are coming soon</div>
            <p className="mt-1 text-[13px] text-[#a1a1aa] max-w-md">
              For now, connect your own inbox or send from your own domain.
            </p>
          </div>
        </div>
        <div className="mt-4">{secondary}</div>
      </div>
    );
  }

  const statusLine = (() => {
    switch (availability.state) {
      case 'checking':
        return (
          <span className="inline-flex items-center gap-1.5 text-[#a1a1aa]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…
          </span>
        );
      case 'available':
        return (
          <span className="inline-flex items-center gap-1.5 text-emerald-700">
            <Check className="w-3.5 h-3.5" /> {availability.address} is available
          </span>
        );
      case 'unavailable':
        return (
          <span className="inline-flex items-center gap-1.5 text-red-600">
            <AlertCircle className="w-3.5 h-3.5" /> {MAILBOX_NAME_REASON_COPY[availability.reason]}
          </span>
        );
      case 'unknown':
        return <span className="text-[#a1a1aa]">{availability.message}</span>;
      default:
        return null;
    }
  })();

  return (
    <div className={shell}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-semibold text-[#18181b]">Get your Echo email</h3>
          <p className="mt-1 text-[13px] text-[#71717a] max-w-lg leading-relaxed">
            A ready-to-send address for your Echo outreach. Sends up to 40 emails a day (15 a day in the first week), and
            replies arrive in your Echo inbox.
          </p>
        </div>
        <span className="text-[12px] text-[#a1a1aa] tabular-nums">
          {used} of {max} used
        </span>
      </div>

      {atLimit ? (
        <p className="mt-4 text-[13px] text-[#71717a]">
          You’re using all {max} Echo addresses. Remove one from the list below to create another.
        </p>
      ) : (
        <form onSubmit={handleCreate} className="mt-4 space-y-3" noValidate>
          <div className="grid sm:grid-cols-[1fr_12rem] gap-3">
            <div>
              <label htmlFor={ids.local} className="block text-[12px] font-medium text-[#52525b] mb-1.5">
                Address
              </label>
              <div className="flex items-center min-w-0">
                <input
                  id={ids.local}
                  type="text"
                  value={localPart}
                  onChange={(e) => {
                    touchedLocal.current = true;
                    setLocalPart(e.target.value.replace(/\s+/g, '').toLowerCase());
                    setFormError(null);
                  }}
                  placeholder="yourname"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={64}
                  aria-describedby={ids.status}
                  aria-invalid={availability.state === 'unavailable'}
                  className="flex-1 min-w-0 h-9 px-3 text-[13px] font-mono text-[#18181b] bg-white border border-[#e8e8e3] rounded-l-md placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]"
                />
                <span className="h-9 px-2.5 flex items-center text-[12px] font-mono text-[#71717a] border border-l-0 border-[#e8e8e3] rounded-r-md bg-[#f7f7f4] truncate max-w-[55%]">
                  @{sharedDomain}
                </span>
              </div>
            </div>
            <div>
              <label htmlFor={ids.name} className="block text-[12px] font-medium text-[#52525b] mb-1.5">
                Sender name
              </label>
              <input
                id={ids.name}
                type="text"
                value={displayName}
                onChange={(e) => {
                  touchedName.current = true;
                  setDisplayName(e.target.value);
                  setFormError(null);
                }}
                placeholder="Your name"
                autoComplete="name"
                className="w-full h-9 px-3 text-[13px] text-[#18181b] bg-white border border-[#e8e8e3] rounded-md placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]"
              />
            </div>
          </div>

          <div id={ids.status} aria-live="polite" className="min-h-[18px] text-[12px]">
            {statusLine}
          </div>

          {availability.state === 'unavailable' && availability.suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-[#a1a1aa]">Try:</span>
              {availability.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => pickSuggestion(s)}
                  className="h-7 px-2.5 rounded-full border border-[#e8e8e3] bg-white text-[12px] font-mono text-[#18181b] hover:bg-[#f4f4f0] cursor-pointer"
                >
                  {s.replace(/@.*$/, '')}
                </button>
              ))}
            </div>
          )}

          {formError && (
            <p role="alert" className="text-[12px] text-red-600">
              {formError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={isCreating || availability.state === 'checking' || availability.state === 'unavailable' || !value}
              className="inline-flex items-center gap-1.5 h-9 px-4 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCreating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {isCreating ? 'Creating…' : 'Create'}
            </button>
            <span className="text-[12px] text-[#a1a1aa]">Free to create · 0.1 credit per email sent</span>
          </div>
        </form>
      )}

      <div className="mt-5 pt-4 border-t border-[#f0f0eb]">{secondary}</div>
    </div>
  );
};
