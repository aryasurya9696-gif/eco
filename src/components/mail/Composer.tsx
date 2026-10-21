import React, { useState, useEffect, useId, useRef } from 'react';
import {
  X,
  Send,
  Sparkles,
  CheckCircle2,
  ChevronDown,
  Trash2,
  Maximize2,
  Minimize2,
  Lightbulb,
  Check,
  RotateCcw,
  ChevronUp,
  Wand2,
  Scissors,
  Target,
  Braces,
  Inbox,
  Loader2,
} from 'lucide-react';
import { mailStore, useMailStore, mailboxSendBlocker, sendCostFor, type ComposerDraft } from './mail-store';
import { leadsStore } from '../leads/leads-store';
import { useEcho } from '../../context/EchoContext';
import { useAuth } from '../../context/AuthContext';
import { generateColdEmail, type ColdEmailRequest, type DraftTone, type PolishAction } from '../../lib/ai';
import { hashForTab } from '../../lib/tab-routing';
import { creditsLabel } from '../../lib/billing';
import { SendProblem, type SendProblemState } from './SendProblem';

interface ComposerProps {
  mode?: 'drawer' | 'modal';
}

type PitchFramework = 'value' | 'direct' | 'casual';

/** Composer tone buttons, mapped to the tones the ai function accepts. */
const FRAMEWORK_TONE: Record<PitchFramework, DraftTone> = {
  value: 'consultative',
  direct: 'direct',
  casual: 'casual',
};

const initialsOf = (name?: string) =>
  (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

const MERGE_TAGS = [
  { label: 'First name', tag: '{{first_name}}' },
  { label: 'Company', tag: '{{company}}' },
] as const;

export const Composer: React.FC<ComposerProps> = ({ mode: initialMode = 'drawer' }) => {
  const store = useMailStore();
  const { isComposerOpen, composerDraft, mailboxes, loading: mailLoading } = store;
  const { addToast } = useEcho();
  const { profile } = useAuth();

  const [activeMode, setActiveMode] = useState<'drawer' | 'modal'>(initialMode);
  const [to, setTo] = useState(composerDraft.to);
  const [subject, setSubject] = useState(composerDraft.subject);
  const [body, setBody] = useState(composerDraft.body);
  const [selectedMailboxId, setSelectedMailboxId] = useState(composerDraft.fromMailboxId || mailboxes[0]?.id || '');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(composerDraft.leadId || null);
  const [selectedLeadName, setSelectedLeadName] = useState<string | undefined>(composerDraft.name);
  const [selectedLeadCompany, setSelectedLeadCompany] = useState<string | undefined>(composerDraft.company);
  const [selectedLeadTitle, setSelectedLeadTitle] = useState<string | undefined>(composerDraft.title);
  const [draftThreadId, setDraftThreadId] = useState<string | null>(composerDraft.draftThreadId || null);

  // AI Pitch Controls
  const [isAiDrawerOpen, setIsAiDrawerOpen] = useState(true);
  const [customPrompt, setCustomPrompt] = useState('');
  // The user's own offer from their profile; editable per email, never a
  // canned pitch of ours.
  const [offerText, setOfferText] = useState(profile?.core_offer || '');
  const [selectedFramework, setSelectedFramework] = useState<PitchFramework>('value');
  const [isAiGenerating, setIsAiGenerating] = useState(false);

  // AI Polish feature for manually written emails
  const [isPolishing, setIsPolishing] = useState(false);
  const [isSuggestingSubjects, setIsSuggestingSubjects] = useState(false);
  const [polishedPreview, setPolishedPreview] = useState<string | null>(null);
  const [showSubjectSuggestions, setShowSubjectSuggestions] = useState(false);
  const [subjectSuggestions, setSubjectSuggestions] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  // A send outcome that needs a decision (Send anyway / Billing / check Sent).
  const [sendProblem, setSendProblem] = useState<SendProblemState | null>(null);

  // Lead auto-complete
  const [showLeadSuggestions, setShowLeadSuggestions] = useState(false);
  const [matchingLeads, setMatchingLeads] = useState<any[]>([]);

  const uid = useId();
  const ids = {
    title: `${uid}-title`,
    from: `${uid}-from`,
    to: `${uid}-to`,
    subject: `${uid}-subject`,
    offer: `${uid}-offer`,
    focus: `${uid}-focus`,
    body: `${uid}-body`,
    leads: `${uid}-leads`,
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<() => void>(() => {});

  // Sync draft from external store (e.g. 1-click outreach from leads table).
  // Only re-runs when a new draft is opened, so typing is never overwritten.
  useEffect(() => {
    setTo(composerDraft.to);
    setSubject(composerDraft.subject);
    setBody(composerDraft.body);
    setSelectedMailboxId(composerDraft.fromMailboxId || (mailStore.getSnapshot().mailboxes[0]?.id || ''));
    setSelectedLeadId(composerDraft.leadId || null);
    setSelectedLeadName(composerDraft.name);
    setSelectedLeadCompany(composerDraft.company);
    setSelectedLeadTitle(composerDraft.title);
    setDraftThreadId(composerDraft.draftThreadId || null);
    setPolishedPreview(null);
    setSendProblem(null);
    setShowSubjectSuggestions(false);
    setShowLeadSuggestions(false);
  }, [composerDraft]);

  // Focus the first empty field when the composer opens.
  useEffect(() => {
    if (!isComposerOpen) return;
    const id = window.setTimeout(() => {
      if (!composerDraft.to) toInputRef.current?.focus();
      else textareaRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(id);
  }, [isComposerOpen, composerDraft]);

  useEffect(() => {
    if (profile?.core_offer) setOfferText((prev) => prev || profile.core_offer || '');
  }, [profile?.core_offer]);

  // Mailboxes can arrive after the composer opened (e.g. from Leads while mail
  // was still loading). Pick one then, without touching what was typed.
  useEffect(() => {
    if (selectedMailboxId && mailboxes.some((m) => m.id === selectedMailboxId)) return;
    const fallbackId = mailStore.getSnapshot().activeMailboxId || mailboxes[0]?.id || '';
    if (fallbackId !== selectedMailboxId) setSelectedMailboxId(fallbackId);
  }, [mailboxes, selectedMailboxId]);

  // Lead auto-complete as user types in `To:`
  useEffect(() => {
    if (!to || selectedLeadId) {
      setShowLeadSuggestions(false);
      return;
    }
    const saved = leadsStore.getSnapshot().savedLeads || [];
    const query = to.toLowerCase().trim();
    if (query.length === 0) {
      setMatchingLeads([]);
      setShowLeadSuggestions(false);
      return;
    }

    const matches = saved
      .filter(
        (l) =>
          l.first_name?.toLowerCase().includes(query) ||
          l.last_name?.toLowerCase().includes(query) ||
          l.company_name?.toLowerCase().includes(query) ||
          l.work_email?.toLowerCase().includes(query)
      )
      .slice(0, 5);

    setMatchingLeads(matches);
    setShowLeadSuggestions(matches.length > 0);
  }, [to, selectedLeadId]);

  // Escape closes the open popover first, then the composer (saving the draft).
  // Captured and stopped here so the thread view underneath doesn't also close.
  useEffect(() => {
    if (!isComposerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isComposerOpen]);

  if (!isComposerOpen) return null;

  const currentDraft = (): ComposerDraft => ({
    leadId: selectedLeadId,
    name: selectedLeadName,
    company: selectedLeadCompany,
    to: to.trim(),
    subject,
    body,
    fromMailboxId: selectedMailboxId,
    draftThreadId,
  });

  const handleClose = () => {
    if (showLeadSuggestions || showSubjectSuggestions) {
      setShowLeadSuggestions(false);
      setShowSubjectSuggestions(false);
      return;
    }
    if (mailStore.closeComposer(currentDraft())) {
      addToast('Draft saved to Drafts.', 'info');
    }
  };
  closeRef.current = handleClose;

  const handleDiscard = () => {
    mailStore.discardComposer();
    if (body.trim() || subject.trim()) addToast('Draft discarded.', 'info');
  };

  const handleSelectLead = (lead: any) => {
    setTo(lead.work_email || lead.revealed_email || '');
    // db_id is the user_leads row the mail function links the thread to.
    setSelectedLeadId(lead.db_id || lead.id);
    setSelectedLeadName(lead.first_name);
    setSelectedLeadCompany(lead.company_name);
    setSelectedLeadTitle(lead.title);
    setShowLeadSuggestions(false);
    if (!subject) {
      setSubject(`Quick question // ${lead.company_name || lead.first_name}`);
    }
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const insertMergeTag = (tag: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newBody = body.substring(0, start) + tag + body.substring(end);
    setBody(newBody);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + tag.length, start + tag.length);
    }, 0);
  };

  const selectedMailbox = mailboxes.find((m) => m.id === selectedMailboxId) || mailboxes[0];

  const goToMailAccounts = () => {
    mailStore.closeComposer();
    mailStore.setActiveSubView('accounts');
    window.location.hash = hashForTab('mail');
  };

  const aiRequest = (task: ColdEmailRequest['task']): ColdEmailRequest => ({
    task,
    lead: { name: selectedLeadName, company: selectedLeadCompany, title: selectedLeadTitle },
    tone: FRAMEWORK_TONE[selectedFramework],
    userOffer: offerText.trim() || undefined,
    userName: profile?.full_name || selectedMailbox?.display_name || undefined,
    focus: customPrompt.trim() || undefined,
    subject: subject.trim() || undefined,
    body: body.trim() || undefined,
  });

  const AI_UNAVAILABLE = 'The AI writer is unavailable right now. Write the email yourself or try again later.';
  // Rate-limit (429) and other server messages are shown as they come.
  const aiErrorMessage = (err: unknown) => (err as Error)?.message || AI_UNAVAILABLE;

  // Subject lines from the ai function (draft action, kind=email).
  const handleSuggestSubjects = async () => {
    if (isSuggestingSubjects) return;
    setIsSuggestingSubjects(true);
    try {
      const res = await generateColdEmail(aiRequest('subjects'));
      if (res.ok && res.subjects?.length) {
        setSubjectSuggestions(res.subjects);
        setShowSubjectSuggestions(true);
      } else {
        addToast(AI_UNAVAILABLE, 'error');
      }
    } catch (err) {
      addToast(aiErrorMessage(err), 'error');
    } finally {
      setIsSuggestingSubjects(false);
    }
  };

  // Writes a cold email for this recipient from the user's own offer.
  const handleAiDraft = async () => {
    if (isAiGenerating) return;
    setIsAiGenerating(true);
    try {
      const res = await generateColdEmail(aiRequest('write'));
      if (res.ok && res.body) {
        if (res.subject) setSubject(res.subject);
        setBody(res.body);
        addToast(`Draft written${selectedLeadCompany ? ` for ${selectedLeadCompany}` : ''}. Review it before sending.`, 'success');
      } else {
        addToast(AI_UNAVAILABLE, 'error');
      }
    } catch (err) {
      addToast(aiErrorMessage(err), 'error');
    } finally {
      setIsAiGenerating(false);
    }
  };

  // Rewrites the user's own draft; shown as a preview they can apply or discard.
  const handlePolishDraft = async (action: PolishAction) => {
    if (!body.trim()) {
      addToast('Write or paste some text first to polish it with AI.', 'info');
      return;
    }
    if (isPolishing) return;
    setIsPolishing(true);
    try {
      const res = await generateColdEmail({ ...aiRequest('polish'), polish: action });
      if (res.ok && res.body) setPolishedPreview(res.body);
      else addToast(AI_UNAVAILABLE, 'error');
    } catch (err) {
      addToast(aiErrorMessage(err), 'error');
    } finally {
      setIsPolishing(false);
    }
  };

  const applyPolishedDraft = () => {
    if (polishedPreview) {
      setBody(polishedPreview);
      setPolishedPreview(null);
      addToast('Polished draft applied!', 'success');
    }
  };

  // Replace {{merge_tags}} with the recipient's details. Returns the tags that
  // couldn't be filled so we never send a literal "{{first_name}}".
  const resolveMergeTags = (text: string) => {
    const values: Record<string, string | undefined> = {
      first_name: selectedLeadName?.trim().split(/\s+/)[0],
      company: selectedLeadCompany?.trim(),
    };
    const missing = new Set<string>();
    const out = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
      const value = values[key.toLowerCase()];
      if (value) return value;
      missing.add(match);
      return match;
    });
    return { out, missing: [...missing] };
  };

  const handleSend = async (confirmResend = false) => {
    if (isSending) return;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
      addToast('Please specify a valid recipient email address.', 'error');
      return;
    }

    if (!subject.trim()) {
      addToast('Please add a subject line for your email.', 'error');
      return;
    }

    if (!body.trim()) {
      addToast('Your message is empty.', 'error');
      return;
    }

    const resolvedSubject = resolveMergeTags(subject.trim());
    const resolvedBody = resolveMergeTags(body.trim());
    const missing = [...new Set([...resolvedSubject.missing, ...resolvedBody.missing])];
    if (missing.length > 0) {
      addToast(`Can't fill ${missing.join(', ')} for this recipient. Replace or remove it before sending.`, 'error');
      return;
    }

    const draftToSend: ComposerDraft = {
      ...currentDraft(),
      subject: resolvedSubject.out,
      body: resolvedBody.out,
    };

    setIsSending(true);
    setSendProblem(null);
    try {
      const res = await mailStore.sendEmail(draftToSend, { confirmResend });
      if (res.success) {
        addToast(`Sent to ${to.trim()}.`, 'success');
      } else if (res.kind === 'error') {
        addToast(res.error, 'error');
      } else {
        // Shown in the composer, which stays open with the draft intact.
        setSendProblem({ kind: res.kind, message: res.error });
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  // No fake sender: without a connected mailbox the composer says so and
  // points at Mail > Accounts instead of showing a form that cannot send.
  const noMailbox = !mailLoading && mailboxes.length === 0;

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  const sendBlocker = mailboxSendBlocker(selectedMailbox);
  const sendCost = sendCostFor(selectedMailbox);
  const readingTimeSec = Math.max(1, Math.round((wordCount / 200) * 60));

  const tones = [
    { id: 'value', label: 'Value-first' },
    { id: 'direct', label: 'Direct' },
    { id: 'casual', label: 'Casual' },
  ] as const;

  const polishActions = [
    { id: 'persuasive', label: 'Professional', icon: Wand2, title: 'Enhance tone, clarity and persuasiveness' },
    { id: 'shorter', label: 'Shorter', icon: Scissors, title: 'Cut fluff, make 3 sentences' },
    { id: 'cta', label: 'Add CTA', icon: Target, title: 'Add a clear call to action' },
  ] as const;

  const fieldLabel = 'w-16 shrink-0 text-[13px] text-[#a1a1aa]';
  const fieldRow = 'flex items-center px-5 h-11 border-b border-[#f0f0eb]';

  return (
    <div
      className={`fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] transition-opacity ${
        activeMode === 'modal' ? 'flex items-center justify-center p-4' : 'flex justify-end'
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        className={`w-full bg-white shadow-2xl flex flex-col animate-in duration-200 overflow-hidden ${
          activeMode === 'modal'
            ? 'max-w-2xl rounded-2xl border border-[#e8e8e3] h-[min(760px,92vh)]'
            : 'max-w-xl border-l border-[#e8e8e3] h-full slide-in-from-right'
        }`}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-14 border-b border-[#f0f0eb] shrink-0">
          <h2 id={ids.title} className="text-[15px] font-semibold text-[#18181b] truncate">
            {draftThreadId ? 'Edit draft' : selectedLeadName ? `Message to ${selectedLeadName}` : 'New message'}
          </h2>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setActiveMode(activeMode === 'drawer' ? 'modal' : 'drawer')}
              className="p-2 rounded-md text-[#a1a1aa] hover:text-[#18181b] hover:bg-[#f4f4f0] transition-colors cursor-pointer"
              title={activeMode === 'drawer' ? 'Open as dialog' : 'Open as side panel'}
              aria-label={activeMode === 'drawer' ? 'Expand composer' : 'Open composer as side panel'}
            >
              {activeMode === 'drawer' ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="p-2 rounded-md text-[#a1a1aa] hover:text-[#18181b] hover:bg-[#f4f4f0] transition-colors cursor-pointer"
              title="Close and keep draft (Esc)"
              aria-label="Close composer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {noMailbox ? (
          <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
            <span className="w-11 h-11 rounded-full bg-[#f4f4f0] flex items-center justify-center">
              <Inbox className="w-5 h-5 text-[#71717a]" />
            </span>
            <div className="mt-4 text-[15px] font-semibold text-[#18181b]">Connect a mailbox</div>
            <p className="mt-1.5 max-w-xs text-[13px] text-[#71717a] leading-relaxed">
              Emails are sent from your own address. Connect a mailbox or create a hosted one, then come back to write
              {selectedLeadName ? ` to ${selectedLeadName}` : ' this email'}.
            </p>
            <button
              type="button"
              onClick={goToMailAccounts}
              className="mt-5 inline-flex items-center gap-2 h-9 bg-[#18181b] hover:bg-black text-white px-4 text-[13px] font-medium rounded-lg transition-colors cursor-pointer"
            >
              Go to Mail &gt; Accounts
            </button>
          </div>
        ) : (
        <>
        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
          {/* From */}
          <div className={fieldRow}>
            <label htmlFor={ids.from} className={fieldLabel}>From</label>
            <div className="flex-1 min-w-0 relative flex items-center">
              {mailLoading && mailboxes.length === 0 ? (
                <span className="flex items-center gap-1.5 text-[13px] text-[#a1a1aa]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading mailboxes…
                </span>
              ) : (
              <select
                id={ids.from}
                value={selectedMailboxId}
                onChange={(e) => setSelectedMailboxId(e.target.value)}
                className="w-full appearance-none bg-transparent pr-6 text-[13px] text-[#18181b] focus:outline-none cursor-pointer truncate"
              >
                {mailboxes.map((mb) => (
                  <option key={mb.id} value={mb.id}>
                    {mb.display_name} &lt;{mb.address}&gt;
                  </option>
                ))}
              </select>
              )}
              <ChevronDown className="w-4 h-4 text-[#a1a1aa] pointer-events-none absolute right-0" />
            </div>
            {/* The mailbox's real limit, or nothing — never an invented one. */}
            {selectedMailbox && Number.isFinite(Number(selectedMailbox.daily_send_limit)) && Number(selectedMailbox.daily_send_limit) > 0 && (
              <span
                className="ml-3 shrink-0 text-[11px] text-[#a1a1aa] tabular-nums"
                title="Sent today / daily limit"
              >
                {selectedMailbox.sent_today || 0}/{selectedMailbox.daily_send_limit} today
              </span>
            )}
          </div>
          {sendBlocker && (
            <div role="alert" className="px-5 py-2 text-[12px] text-warn bg-warn-bg border-b border-warn-line">
              {sendBlocker}
            </div>
          )}

          {/* To */}
          <div className={`${fieldRow} relative`}>
            {selectedLeadId ? <span className={fieldLabel}>To</span> : <label htmlFor={ids.to} className={fieldLabel}>To</label>}
            {selectedLeadId ? (
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 min-w-0 pl-1 pr-2 py-0.5 rounded-full bg-[#f4f4f0] text-[13px] text-[#18181b]">
                  <span className="w-5 h-5 shrink-0 rounded-full bg-emerald-700 text-white flex items-center justify-center text-[9px] font-semibold">
                    {initialsOf(selectedLeadName)}
                  </span>
                  <span className="truncate">
                    {selectedLeadName}
                    {selectedLeadCompany && <span className="text-[#71717a]"> · {selectedLeadCompany}</span>}
                  </span>
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600" aria-label="Verified contact" />
                </span>
                <span className="text-[12px] text-[#a1a1aa] truncate">{to}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedLeadId(null);
                    setSelectedLeadName(undefined);
                    setSelectedLeadCompany(undefined);
                    setSelectedLeadTitle(undefined);
                    setTo('');
                  }}
                  className="ml-auto p-1 rounded text-[#a1a1aa] hover:text-[#18181b] hover:bg-[#f4f4f0] cursor-pointer"
                  aria-label="Remove recipient"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex-1 relative">
                <input
                  id={ids.to}
                  ref={toInputRef}
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  onBlur={() => setShowLeadSuggestions(false)}
                  role="combobox"
                  aria-expanded={showLeadSuggestions}
                  aria-controls={ids.leads}
                  aria-autocomplete="list"
                  placeholder="Email or search saved leads"
                  className="w-full bg-transparent text-[13px] text-[#18181b] placeholder:text-[#c4c4bf] focus:outline-none"
                />

                {showLeadSuggestions && (
                  <div
                    id={ids.leads}
                    role="listbox"
                    aria-label="Saved leads"
                    className="absolute top-full left-0 right-0 mt-3 bg-white rounded-lg border border-[#e8e8e3] shadow-lg z-30 max-h-56 overflow-y-auto py-1"
                  >
                    {matchingLeads.map((lead) => (
                      <button
                        key={lead.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        // mousedown so the input's blur doesn't close the list first
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleSelectLead(lead);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-[#f7f7f4] flex items-center gap-3 transition-colors cursor-pointer"
                      >
                        <span className="w-7 h-7 shrink-0 rounded-full bg-[#f0f0eb] text-[#52525b] flex items-center justify-center text-[10px] font-semibold">
                          {(lead.first_name || '?').slice(0, 1).toUpperCase()}
                          {(lead.last_name || '').slice(0, 1).toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-[#18181b] truncate">
                            {lead.first_name} {lead.last_name}
                          </div>
                          <div className="text-[12px] text-[#71717a] truncate">
                            {lead.company_name || lead.company} · {lead.work_email}
                          </div>
                        </div>
                        <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" aria-label="Verified" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Subject */}
          <div className={fieldRow}>
            <label htmlFor={ids.subject} className={fieldLabel}>Subject</label>
            <input
              id={ids.subject}
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Add a subject"
              className="flex-1 min-w-0 bg-transparent text-[13px] text-[#18181b] font-medium placeholder:text-[#c4c4bf] placeholder:font-normal focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSuggestSubjects}
              disabled={isSuggestingSubjects}
              className="ml-2 shrink-0 inline-flex items-center gap-1.5 text-[12px] text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f0] px-2 py-1 rounded-md transition-colors cursor-pointer"
              title="Suggest subject lines"
            >
              {isSuggestingSubjects ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lightbulb className="w-3.5 h-3.5" />}
              Suggest
            </button>
          </div>

          {showSubjectSuggestions && subjectSuggestions.length > 0 && (
            <div className="px-5 py-2.5 border-b border-[#f0f0eb] flex items-center gap-1.5 flex-wrap">
              {subjectSuggestions.map((s, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setSubject(s);
                    setShowSubjectSuggestions(false);
                  }}
                  className="text-[12px] px-2.5 py-1 rounded-full border border-[#e8e8e3] text-[#3f3f46] hover:border-[#18181b] hover:text-[#18181b] transition-colors cursor-pointer"
                >
                  {s}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowSubjectSuggestions(false)}
                className="ml-auto p-1 rounded text-[#a1a1aa] hover:text-[#18181b] cursor-pointer"
                aria-label="Dismiss suggestions"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* AI writer */}
          <div className="mx-5 mt-4 rounded-xl border border-[#e8e8e3] bg-[#fafaf8]">
            <button
              type="button"
              onClick={() => setIsAiDrawerOpen(!isAiDrawerOpen)}
              aria-expanded={isAiDrawerOpen}
              className="w-full flex items-center justify-between px-4 h-10 cursor-pointer"
            >
              <span className="flex items-center gap-2 text-[13px] font-medium text-[#18181b]">
                <Sparkles className="w-4 h-4 text-emerald-700" />
                Write with AI
              </span>
              {isAiDrawerOpen ? (
                <ChevronUp className="w-4 h-4 text-[#a1a1aa]" />
              ) : (
                <ChevronDown className="w-4 h-4 text-[#a1a1aa]" />
              )}
            </button>

            {isAiDrawerOpen && (
              <div className="px-4 pb-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="inline-flex p-0.5 rounded-md bg-[#efefea]" role="group" aria-label="Tone">
                    {tones.map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={selectedFramework === id}
                        onClick={() => setSelectedFramework(id)}
                        className={`px-2.5 h-7 rounded text-[12px] transition-colors cursor-pointer ${
                          selectedFramework === id
                            ? 'bg-white text-[#18181b] font-medium shadow-xs'
                            : 'text-[#71717a] hover:text-[#18181b]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <label htmlFor={ids.offer} className="sr-only">What you offer</label>
                <input
                  id={ids.offer}
                  type="text"
                  value={offerText}
                  onChange={(e) => setOfferText(e.target.value)}
                  placeholder="What you offer, e.g. AI workflow automation for agencies"
                  title="From your profile's core offer. Edits here apply to this email only."
                  className="w-full h-9 text-[13px] px-3 bg-white border border-[#e8e8e3] rounded-md text-[#18181b] placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]"
                />

                <div className="flex items-center gap-2">
                  <label htmlFor={ids.focus} className="sr-only">What the email should focus on</label>
                  <input
                    id={ids.focus}
                    type="text"
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                        e.preventDefault();
                        handleAiDraft();
                      }
                    }}
                    placeholder="What should the email focus on? (optional)"
                    className="flex-1 min-w-0 h-9 text-[13px] px-3 bg-white border border-[#e8e8e3] rounded-md text-[#18181b] placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]"
                  />
                  <button
                    type="button"
                    onClick={handleAiDraft}
                    disabled={isAiGenerating}
                    className="h-9 shrink-0 inline-flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-800 text-white px-3.5 text-[13px] font-medium rounded-md transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {isAiGenerating ? 'Writing…' : 'Generate'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Polished preview */}
          {polishedPreview && (
            <div className="mx-5 mt-4 rounded-xl border border-emerald-200 bg-emerald-50/40">
              <div className="flex items-center justify-between px-4 h-10">
                <span className="flex items-center gap-2 text-[13px] font-medium text-emerald-900">
                  <Sparkles className="w-4 h-4 text-emerald-700" />
                  Suggested rewrite
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPolishedPreview(null)}
                    className="inline-flex items-center gap-1 text-[12px] text-[#71717a] hover:text-[#18181b] px-2 h-7 rounded-md cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={applyPolishedDraft}
                    className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 h-7 bg-emerald-700 hover:bg-emerald-800 text-white rounded-md transition-colors cursor-pointer"
                  >
                    <Check className="w-3 h-3" />
                    Apply
                  </button>
                </div>
              </div>
              <p className="mx-4 mb-4 p-3 text-[13px] text-[#18181b] whitespace-pre-wrap bg-white rounded-md border border-emerald-100 leading-relaxed">
                {polishedPreview}
              </p>
            </div>
          )}

          {/* Body */}
          <div className="flex-1 flex flex-col min-h-[240px] mx-5 my-4 rounded-xl border border-[#e8e8e3] focus-within:border-[#a1a1aa] transition-colors">
            <label htmlFor={ids.body} className="sr-only">Message</label>
            <textarea
              id={ids.body}
              ref={textareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message, or use Write with AI above"
              className="flex-1 w-full px-4 pt-3.5 pb-2 text-[14px] text-[#18181b] leading-relaxed resize-none bg-transparent focus:outline-none placeholder:text-[#c4c4bf]"
            />
            <div className="flex items-center justify-between gap-2 flex-wrap px-2.5 py-2 border-t border-[#f0f0eb]">
              <div className="flex items-center gap-1">
                <Braces className="w-3.5 h-3.5 mx-1.5 text-[#c4c4bf]" aria-hidden />
                {MERGE_TAGS.map(({ label, tag }) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => insertMergeTag(tag)}
                    className="px-2 h-7 text-[12px] text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f0] rounded-md transition-colors cursor-pointer"
                    title={`Insert ${tag} (filled in when sent)`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1">
                {polishActions.map(({ id, label, icon: Icon, title }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => handlePolishDraft(id)}
                    disabled={isPolishing}
                    className="inline-flex items-center gap-1.5 px-2 h-7 text-[12px] text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f0] rounded-md transition-colors cursor-pointer disabled:opacity-50"
                    title={title}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {sendProblem && (
          <div className="px-5 pt-3 shrink-0">
            <SendProblem
              problem={sendProblem}
              busy={isSending}
              onSendAnyway={() => void handleSend(true)}
              onDismiss={() => setSendProblem(null)}
              onBeforeBilling={() => mailStore.closeComposer(currentDraft())}
            />
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 h-16 border-t border-[#f0f0eb] shrink-0">
          <div className="flex items-center gap-1 min-w-0">
            <button
              type="button"
              onClick={handleDiscard}
              className="p-2 rounded-md text-[#a1a1aa] hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
              title="Discard draft"
              aria-label="Discard draft"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <span className="text-[12px] text-[#a1a1aa] truncate">
              {wordCount} word{wordCount === 1 ? '' : 's'} · ~{readingTimeSec}s read · {creditsLabel(sendCost)}
            </span>
          </div>

          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={isSending || !selectedMailbox || Boolean(sendBlocker)}
            className="shrink-0 inline-flex items-center gap-2 h-9 bg-[#18181b] hover:bg-black text-white pl-4 pr-3 text-[13px] font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            title="Send (Ctrl/⌘ + Enter)"
          >
            {isSending ? 'Sending…' : 'Send'}
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
};
