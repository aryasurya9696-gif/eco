import React, { useState, useEffect, useRef } from 'react';
import { Star, Archive, Trash2, Send, ArrowLeft, Inbox, CheckCircle2 } from 'lucide-react';
import { mailStore, useMailStore, mailboxSendBlocker } from './mail-store';
import { MessageBody } from './MessageBody';
import { initialsFor } from './ThreadList';
import { useEcho } from '../../context/EchoContext';
import type { MailMessage } from '../../types';

const formatFullTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const OUTBOUND_STATUS: Partial<Record<MailMessage['status'], string>> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  complained: 'Marked as spam',
  failed: 'Failed',
};

export const ThreadView: React.FC = () => {
  const { threads, messages, activeThreadId, mailboxes } = useMailStore();
  const { addToast } = useEcho();
  const [replyText, setReplyText] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset the reply box when switching conversations so a draft never leaks
  // into the wrong thread.
  useEffect(() => {
    setReplyText('');
  }, [activeThreadId]);

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const threadMessages = activeThread ? messages[activeThread.id] || [] : [];

  // Keep the newest message in view when opening a thread or after replying.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [activeThreadId, threadMessages.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !activeThreadId) return;
      // Leave Escape to whatever overlay is on top (composer, dialogs).
      if (mailStore.getSnapshot().isComposerOpen || document.querySelector('[role="dialog"]')) return;
      mailStore.setActiveThread(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeThreadId]);

  if (!activeThread) return null;

  const mailbox = mailboxes.find((m) => m.id === activeThread.mailbox_id);
  const sendBlocker = mailboxSendBlocker(mailbox);
  const isInTrash = activeThread.folder === 'trash';
  const isArchived = activeThread.folder === 'archive' || activeThread.folder === 'spam';
  const canReply = !isInTrash;

  const nameFor = (address: string) =>
    activeThread.participants.find((p) => p.address.toLowerCase() === address.toLowerCase())?.name || address;

  const handleSendReply = async () => {
    if (!replyText.trim() || isSendingReply) return;
    setIsSendingReply(true);
    const res = await mailStore.sendQuickReply(activeThread.id, replyText);
    setIsSendingReply(false);
    if (res.success) {
      setReplyText('');
      addToast('Reply sent.', 'success');
    } else {
      addToast(res.error, 'error');
    }
  };

  const iconButton =
    'p-2 rounded-md text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f0] transition-colors cursor-pointer';

  return (
    <section className="flex-1 min-w-0 flex flex-col h-full bg-white">
      {/* Toolbar */}
      <div className="h-14 shrink-0 px-3 sm:px-4 border-b border-[#f0f0eb] flex items-center justify-between gap-2">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => mailStore.setActiveThread(null)}
            className={iconButton}
            title="Back to list (Esc)"
            aria-label="Back to list"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="mx-1 h-5 w-px bg-[#e8e8e3]" />

          {isInTrash || isArchived ? (
            <button
              type="button"
              onClick={() => {
                mailStore.moveThread(activeThread.id, 'inbox');
                addToast('Moved to Inbox.', 'info');
              }}
              className={iconButton}
              title="Move to Inbox"
              aria-label="Move to Inbox"
            >
              <Inbox className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                mailStore.moveThread(activeThread.id, 'archive');
                addToast('Archived.', 'info');
              }}
              className={iconButton}
              title="Archive"
              aria-label="Archive"
            >
              <Archive className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              if (isInTrash) {
                if (!window.confirm('Delete this conversation forever? This cannot be undone.')) return;
                mailStore.deleteThread(activeThread.id);
                addToast('Conversation deleted.', 'info');
              } else {
                mailStore.moveThread(activeThread.id, 'trash');
                addToast('Moved to Trash.', 'info');
              }
            }}
            className={`${iconButton} hover:!text-red-600`}
            title={isInTrash ? 'Delete forever' : 'Move to Trash'}
            aria-label={isInTrash ? 'Delete forever' : 'Move to Trash'}
          >
            <Trash2 className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => mailStore.toggleStar(activeThread.id)}
            className={iconButton}
            title={activeThread.starred ? 'Unstar' : 'Star'}
            aria-pressed={activeThread.starred}
            aria-label={activeThread.starred ? 'Unstar' : 'Star'}
          >
            <Star className={`w-4 h-4 ${activeThread.starred ? 'fill-amber-400 text-amber-500' : ''}`} />
          </button>
        </div>

        {activeThread.lead_name && (
          <div className="hidden sm:flex items-center gap-2 min-w-0 text-[12px]">
            <span className="truncate text-[#52525b]">
              <span className="font-medium text-[#18181b]">{activeThread.lead_name}</span>
              {activeThread.lead_company && ` · ${activeThread.lead_company}`}
            </span>
            <span className="shrink-0 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 capitalize">
              {activeThread.lead_pipeline_status || 'contacted'}
            </span>
          </div>
        )}
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
          <h2 className="text-[19px] font-semibold text-[#18181b] leading-snug">
            {activeThread.subject || '(no subject)'}
          </h2>
          <p className="mt-1 text-[12px] text-[#71717a]">
            {threadMessages.length} {threadMessages.length === 1 ? 'message' : 'messages'} with{' '}
            {activeThread.participants.map((p) => p.name || p.address).join(', ') || 'no recipients'}
          </p>

          <div className="mt-6 space-y-4">
            {threadMessages.length === 0 && (
              <div className="py-12 text-center text-[13px] text-[#71717a]">No messages in this conversation yet.</div>
            )}

            {threadMessages.map((msg) => {
              const isOutgoing = msg.direction === 'out';
              const senderLabel = isOutgoing ? 'You' : nameFor(msg.from_addr);
              const timestamp = (isOutgoing ? msg.sent_at : msg.received_at) || msg.created_at;
              const outboundStatus = isOutgoing ? OUTBOUND_STATUS[msg.status] : undefined;

              return (
                <article
                  key={msg.id}
                  className={`rounded-xl border p-4 sm:p-5 ${
                    isOutgoing ? 'border-[#ebebe6] bg-[#fafaf8]' : 'border-[#e8e8e3] bg-white shadow-xs'
                  }`}
                >
                  <header className="flex items-start gap-3">
                    <span
                      className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                        isOutgoing ? 'bg-[#18181b] text-white' : 'bg-emerald-700 text-white'
                      }`}
                    >
                      {initialsFor(isOutgoing ? 'You' : senderLabel)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13px] font-semibold text-[#18181b] truncate">{senderLabel}</span>
                        <span className="text-[12px] text-[#a1a1aa] truncate">
                          {isOutgoing ? msg.from_addr : msg.from_addr !== senderLabel ? msg.from_addr : ''}
                        </span>
                        <time
                          dateTime={timestamp}
                          className="ml-auto shrink-0 text-[12px] text-[#a1a1aa] tabular-nums"
                        >
                          {formatFullTime(timestamp)}
                        </time>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[12px] text-[#71717a]">
                        <span className="truncate">to {msg.to_addrs.map((t) => t.name || t.address).join(', ')}</span>
                        {outboundStatus && (
                          <span
                            className={`ml-auto shrink-0 inline-flex items-center gap-1 ${
                              msg.status === 'bounced' || msg.status === 'failed' || msg.status === 'complained'
                                ? 'text-red-600'
                                : 'text-[#a1a1aa]'
                            }`}
                          >
                            {msg.status === 'delivered' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
                            {outboundStatus}
                          </span>
                        )}
                      </div>
                    </div>
                  </header>

                  <div className="mt-4 sm:pl-11">
                    <MessageBody html={msg.html_body} text={msg.text_body} />
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </div>

      {/* Reply */}
      {canReply && (
        <div className="shrink-0 border-t border-[#f0f0eb] bg-white">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3">
            <div className="rounded-xl border border-[#e8e8e3] focus-within:border-[#a1a1aa] transition-colors">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    handleSendReply();
                  }
                }}
                placeholder={`Reply to ${activeThread.participants[0]?.name || activeThread.participants[0]?.address || 'this thread'}…`}
                rows={3}
                aria-label="Reply"
                className="w-full px-4 pt-3 pb-1 text-[14px] text-[#18181b] leading-relaxed resize-none bg-transparent focus:outline-none placeholder:text-[#c4c4bf]"
              />
              <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
                <span className={`text-[12px] truncate ${sendBlocker ? 'text-amber-700' : 'text-[#a1a1aa]'}`}>
                  {sendBlocker || `From ${mailbox?.address ?? 'unknown mailbox'} · Ctrl/⌘ + Enter to send`}
                </span>
                <button
                  type="button"
                  onClick={handleSendReply}
                  disabled={isSendingReply || !replyText.trim() || Boolean(sendBlocker)}
                  className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Reply
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
