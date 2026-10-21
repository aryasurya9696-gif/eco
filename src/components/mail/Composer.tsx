import React, { useState, useEffect, useRef } from 'react';
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
} from 'lucide-react';
import { mailStore, useMailStore, mailboxSendBlocker, sendCostFor, type ComposerDraft } from './mail-store';
import type { Mailbox } from '../../types';
import { leadsStore } from '../leads/leads-store';
import { useEcho } from '../../context/EchoContext';
import { useAuth } from '../../context/AuthContext';

interface ComposerProps {
  mode?: 'drawer' | 'modal';
}

type ServiceKey = 'echo_signals' | 'outbound_pipeline' | 'custom';
type PitchFramework = 'value' | 'direct' | 'casual';
type PolishAction = 'persuasive' | 'shorter' | 'cta';

interface ServiceDefinition {
  id: ServiceKey;
  label: string;
  badge: string;
  summary: string;
  painPoint: string;
  valueProp: string;
  metric: string;
  goal: string;
}

const SERVICE_PRESETS: Record<ServiceKey, ServiceDefinition> = {
  echo_signals: {
    id: 'echo_signals',
    label: 'Echo Social Intent',
    badge: 'Intent Intelligence',
    summary: 'Monitor Reddit, X, and Web discussions to catch buyers actively seeking solutions.',
    painPoint: 'spending hours manually checking feeds or waiting for inbound form fills',
    valueProp: 'detect real-time buying signals across social channels and deliver verified executive contacts in 1 click',
    metric: 'a 3x jump in reply rates and 70% cut in manual prospecting time',
    goal: 'capturing active buyer demand before competitors',
  },
  outbound_pipeline: {
    id: 'outbound_pipeline',
    label: 'Verified Outbound',
    badge: 'Deliverability & Data',
    summary: 'B2B contact enrichment with 98% verified work emails and warm SES mailbox infrastructure.',
    painPoint: 'outreach landing in spam or bouncing due to unverified contact lists',
    valueProp: 'enrich verified C-level emails and send through dedicated AWS SES pools with 99.8% inbox placement',
    metric: 'sub-1% bounce rates and verified direct executive inboxes',
    goal: 'scaling cold email outreach without domain reputation risk',
  },
  custom: {
    id: 'custom',
    label: 'Custom Offer',
    badge: 'Your Offering',
    summary: 'Pitch your custom product, consulting service, or agency solution.',
    painPoint: 'manual bottlenecks and inefficiencies in daily operations',
    valueProp: 'automate core workflows and deliver measurable business outcomes',
    metric: 'accelerated delivery timelines and measurable ROI within 30 days',
    goal: 'optimizing core business workflows',
  },
};

const GREETING_RE = /^\s*(hi|hey|hello|dear)\b[^\n]*\n+/i;
// A closing line ("Best,", "Thanks,", "Cheers") plus anything after it (the name).
const SIGNOFF_RE = /\n+\s*(best|best regards|kind regards|regards|thanks|thank you|cheers|sincerely)[,!.]?\s*(\n[^\n]*){0,3}\s*$/i;

const stripGreeting = (text: string) => text.replace(GREETING_RE, '');
const stripSignoff = (text: string) => text.replace(SIGNOFF_RE, '');

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
  const { isComposerOpen, composerDraft, mailboxes } = store;
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
  const [draftThreadId, setDraftThreadId] = useState<string | null>(composerDraft.draftThreadId || null);

  // AI Pitch Controls
  const [isAiDrawerOpen, setIsAiDrawerOpen] = useState(true);
  const [customPrompt, setCustomPrompt] = useState('');
  const [selectedService, setSelectedService] = useState<ServiceKey>('echo_signals');
  const [customOfferText, setCustomOfferText] = useState(
    profile?.core_offer || 'AI automation and high-intent B2B lead generation'
  );
  const [selectedFramework, setSelectedFramework] = useState<PitchFramework>('value');
  const [isAiGenerating, setIsAiGenerating] = useState(false);

  // AI Polish feature for manually written emails
  const [isPolishing, setIsPolishing] = useState(false);
  const [polishedPreview, setPolishedPreview] = useState<string | null>(null);
  const [showSubjectSuggestions, setShowSubjectSuggestions] = useState(false);
  const [subjectSuggestions, setSubjectSuggestions] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);

  // Lead auto-complete
  const [showLeadSuggestions, setShowLeadSuggestions] = useState(false);
  const [matchingLeads, setMatchingLeads] = useState<any[]>([]);

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
    setDraftThreadId(composerDraft.draftThreadId || null);
    setPolishedPreview(null);
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
    if (profile?.core_offer && selectedService === 'custom') {
      setCustomOfferText(profile.core_offer);
    }
  }, [profile, selectedService]);

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
    setSelectedLeadId(lead.id);
    setSelectedLeadName(lead.first_name);
    setSelectedLeadCompany(lead.company_name);
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

  const selectedMailbox = mailboxes.find((m) => m.id === selectedMailboxId) || mailboxes[0] || ({
    id: '',
    user_id: '',
    kind: 'hosted',
    provider: 'ses',
    address: 'alex@tryecho.io',
    display_name: 'Alex Vance (Sales)',
    status: 'active',
    daily_send_limit: 100,
    sent_today: 14,
    is_default: true,
  } as Mailbox);

  // Generate Subject Suggestions
  const handleSuggestSubjects = () => {
    const firstName = selectedLeadName || 'there';
    const company = selectedLeadCompany || 'your team';
    const srvShort = selectedService === 'echo_signals' ? 'social intent signals' : selectedService === 'outbound_pipeline' ? 'outbound pipeline' : 'growth';

    const suggestions = [
      `Quick question re: ${company} + ${srvShort}`,
      `Idea for ${firstName} at ${company}`,
      `Streamlining ${srvShort} at ${company}?`,
    ];
    setSubjectSuggestions(suggestions);
    setShowSubjectSuggestions(true);
  };

  // Generate New Pitch with AI based on user short prompt & service
  const handleAiDraft = () => {
    setIsAiGenerating(true);
    const firstName = selectedLeadName || 'there';
    const company = selectedLeadCompany || 'your team';
    const senderName = profile?.full_name || selectedMailbox.display_name.split('<')[0].trim() || 'Alex Vance';
    const senderCompany = profile?.website ? profile.website.replace(/^https?:\/\//, '').split('/')[0] : 'Echo';

    const srv = SERVICE_PRESETS[selectedService];
    const valueOffer = selectedService === 'custom' ? (customOfferText.trim() || srv.valueProp) : srv.valueProp;
    const userPromptNote = customPrompt.trim();

    setTimeout(() => {
      let generatedSubject = '';
      let generatedBody = '';

      if (selectedFramework === 'value') {
        generatedSubject = `Scaling ${selectedService === 'echo_signals' ? 'in-market lead capture' : 'outbound pipeline'} at ${company}`;
        generatedBody = `Hi ${firstName},

Saw the impressive momentum at ${company} recently!

${userPromptNote ? `Specifically regarding ${userPromptNote}:\n\n` : ''}Quick question: how is your team currently tackling ${srv.painPoint}?

We help high-growth teams ${valueOffer}. For example, our customers have achieved ${srv.metric}.

Would you be open to a brief 5-minute walk-through this Thursday?

Best regards,
${senderName}${senderCompany ? `\n${senderCompany}` : ''}`;
      } else if (selectedFramework === 'direct') {
        generatedSubject = `Quick question re: ${company}`;
        generatedBody = `Hi ${firstName},

${userPromptNote ? `Re: ${userPromptNote} — ` : ''}Are you currently exploring ways to streamline ${srv.goal} at ${company}?

We help teams ${valueOffer}.

Do you have 5 minutes for a quick chat next Tuesday?

Thanks,
${senderName}`;
      } else {
        // casual
        generatedSubject = `Quick idea for ${company}`;
        generatedBody = `Hey ${firstName},

Really love what you folks are building at ${company}!

${userPromptNote ? `I was just thinking about ${userPromptNote} and wanted to reach out. ` : ''}We help founders and growth leads ${valueOffer}.

Let me know if you'd be open to a quick 2-minute video walkthrough or brief chat!

Cheers,
${senderName}`;
      }

      setSubject(generatedSubject);
      setBody(generatedBody);
      setIsAiGenerating(false);
      addToast(`Personalized cold outreach crafted for ${company}!`, 'success');
    }, 400);
  };

  // Polish / Improve manually written email
  const handlePolishDraft = (action: PolishAction) => {
    if (!body.trim()) {
      addToast('Write or paste some text first to polish it with AI.', 'info');
      return;
    }

    setIsPolishing(true);
    const firstName = selectedLeadName || 'there';
    const senderName = profile?.full_name || selectedMailbox.display_name.split('<')[0].trim() || 'Alex';

    setTimeout(() => {
      let improved = body.trim();

      if (action === 'persuasive') {
        // Make punchy & persuasive
        improved = `Hi ${firstName},

I noticed your recent work at ${selectedLeadCompany || 'your team'} and wanted to reach out directly.

${stripSignoff(stripGreeting(improved)).trim()}

Would you be open to a quick 5-minute conversation this week to see if this aligns with your goals?

Best,
${senderName}`;
      } else if (action === 'shorter') {
        // Cut fluff, 3-sentence executive style
        const sentences = stripSignoff(stripGreeting(improved))
          .split(/(?<=[.?!])\s+/)
          .filter((s) => s.length > 10)
          .slice(0, 3);

        improved = `Hi ${firstName},

${sentences.join(' ') || 'Reaching out with a quick question regarding your current outbound setup.'}

Open to a brief 5-minute chat next week?

Best,
${senderName}`;
      } else if (action === 'cta') {
        // Add strong frictionless CTA
        const cleaned = stripSignoff(improved).trim();
        improved = `${cleaned}

Would you be opposed to a brief 5-minute walkthrough this Thursday to see how this works?

Best regards,
${senderName}`;
      }

      setPolishedPreview(improved);
      setIsPolishing(false);
    }, 350);
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

  const handleSend = async () => {
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
    try {
      const res = await mailStore.sendEmail(draftToSend);
      if (res.success) {
        addToast(`Sent to ${to.trim()}.`, 'success');
      } else {
        addToast(res.error, 'error');
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

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  const sendBlocker = mailboxSendBlocker(mailboxes.find((m) => m.id === selectedMailboxId) || mailboxes[0]);
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
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-14 border-b border-[#f0f0eb] shrink-0">
          <h2 className="text-[15px] font-semibold text-[#18181b] truncate">
            {draftThreadId ? 'Edit draft' : selectedLeadName ? `Message to ${selectedLeadName}` : 'New message'}
          </h2>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setActiveMode(activeMode === 'drawer' ? 'modal' : 'drawer')}
              className="p-2 rounded-md text-[#a1a1aa] hover:text-[#18181b] hover:bg-[#f4f4f0] transition-colors cursor-pointer"
              title={activeMode === 'drawer' ? 'Open as dialog' : 'Open as side panel'}
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

        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
          {/* From */}
          <div className={fieldRow}>
            <span className={fieldLabel}>From</span>
            <div className="flex-1 min-w-0 relative flex items-center">
              <select
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
              <ChevronDown className="w-4 h-4 text-[#a1a1aa] pointer-events-none absolute right-0" />
            </div>
            <span
              className="ml-3 shrink-0 text-[11px] text-[#a1a1aa] tabular-nums"
              title="Sent today / daily limit"
            >
              {selectedMailbox.sent_today || 0}/{selectedMailbox.daily_send_limit || 100} today
            </span>
          </div>
          {sendBlocker && (
            <div role="alert" className="px-5 py-2 text-[12px] text-warn bg-warn-bg border-b border-warn-line">
              {sendBlocker}
            </div>
          )}

          {/* To */}
          <div className={`${fieldRow} relative`}>
            <span className={fieldLabel}>To</span>
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
                  ref={toInputRef}
                  type="text"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  onBlur={() => setShowLeadSuggestions(false)}
                  role="combobox"
                  aria-expanded={showLeadSuggestions}
                  aria-autocomplete="list"
                  placeholder="Email or search saved leads"
                  className="w-full bg-transparent text-[13px] text-[#18181b] placeholder:text-[#c4c4bf] focus:outline-none"
                />

                {showLeadSuggestions && (
                  <div className="absolute top-full left-0 right-0 mt-3 bg-white rounded-lg border border-[#e8e8e3] shadow-lg z-30 max-h-56 overflow-y-auto py-1">
                    {matchingLeads.map((lead) => (
                      <button
                        key={lead.id}
                        type="button"
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
            <span className={fieldLabel}>Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Add a subject"
              className="flex-1 min-w-0 bg-transparent text-[13px] text-[#18181b] font-medium placeholder:text-[#c4c4bf] placeholder:font-normal focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSuggestSubjects}
              className="ml-2 shrink-0 inline-flex items-center gap-1.5 text-[12px] text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f0] px-2 py-1 rounded-md transition-colors cursor-pointer"
              title="Suggest subject lines"
            >
              <Lightbulb className="w-3.5 h-3.5" />
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
                  <select
                    value={selectedService}
                    onChange={(e) => setSelectedService(e.target.value as ServiceKey)}
                    className="h-8 pl-2.5 pr-7 text-[12px] text-[#18181b] bg-white border border-[#e8e8e3] rounded-md focus:outline-none focus:border-[#a1a1aa] cursor-pointer"
                    title={SERVICE_PRESETS[selectedService].summary}
                  >
                    {(['echo_signals', 'outbound_pipeline', 'custom'] as const).map((key) => (
                      <option key={key} value={key}>
                        {SERVICE_PRESETS[key].label}
                      </option>
                    ))}
                  </select>

                  <div className="inline-flex p-0.5 rounded-md bg-[#efefea]">
                    {tones.map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
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

                {selectedService === 'custom' && (
                  <input
                    type="text"
                    value={customOfferText}
                    onChange={(e) => setCustomOfferText(e.target.value)}
                    placeholder="Describe your offer, e.g. AI workflow automation"
                    className="w-full h-9 text-[13px] px-3 bg-white border border-[#e8e8e3] rounded-md text-[#18181b] placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]"
                  />
                )}

                <div className="flex items-center gap-2">
                  <input
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
            <textarea
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
              {wordCount} words · ~{readingTimeSec}s read · {sendCost} credit
            </span>
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={isSending || Boolean(sendBlocker)}
            className="shrink-0 inline-flex items-center gap-2 h-9 bg-[#18181b] hover:bg-black text-white pl-4 pr-3 text-[13px] font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            title="Send (Ctrl/⌘ + Enter)"
          >
            {isSending ? 'Sending…' : 'Send'}
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
