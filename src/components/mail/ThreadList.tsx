import React from 'react';
import { Search, Star, Paperclip, PenSquare, X } from 'lucide-react';
import { mailStore, useMailStore, type ThreadFilter } from './mail-store';
import { MAIL_FOLDERS } from './MailSidebar';
import type { MailFolder, MailThread } from '../../types';

const EMPTY_COPY: Record<MailFolder, string> = {
  inbox: 'Replies from your leads will show up here.',
  sent: 'Emails you send will show up here.',
  drafts: 'Closing the composer saves unfinished emails here.',
  archive: 'Archived conversations will show up here.',
  trash: 'Deleted conversations will show up here.',
  spam: 'No spam. Nice.',
};

const FILTERS: { id: ThreadFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'leads', label: 'Leads' },
];

export const formatMailTime = (dateStr: string) => {
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

export const initialsFor = (label: string) =>
  label
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

const statusLabel = (status?: string) => (status ? status.charAt(0).toUpperCase() + status.slice(1) : '');

export const ThreadList: React.FC = () => {
  const { threads, activeFolder, activeThreadId, activeMailboxId, searchQuery, filter } = useMailStore();

  const query = searchQuery.trim().toLowerCase();
  const filteredThreads = threads
    .filter((t) => {
      if (t.mailbox_id !== activeMailboxId || t.folder !== activeFolder) return false;

      if (query) {
        const haystack = [
          t.subject,
          t.snippet,
          t.lead_name,
          t.lead_company,
          ...t.participants.flatMap((p) => [p.name, p.address]),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      if (filter === 'unread' && t.unread_count === 0) return false;
      if (filter === 'leads' && !t.lead_id) return false;
      return true;
    })
    .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));

  const folderLabel = MAIL_FOLDERS.find((f) => f.id === activeFolder)?.label ?? activeFolder;
  const isSplitView = Boolean(activeThreadId);
  const isFiltered = Boolean(query) || filter !== 'all';

  const openThread = (thread: MailThread) => {
    if (thread.folder === 'drafts') mailStore.openDraft(thread.id);
    else mailStore.toggleActiveThread(thread.id);
  };

  return (
    <section
      className={`flex-col h-full min-w-0 bg-white ${
        isSplitView ? 'hidden lg:flex w-[360px] xl:w-[400px] shrink-0 border-r border-[#e8e8e3]' : 'flex flex-1'
      }`}
    >
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-[#f0f0eb] space-y-3">
        <div className="flex items-center justify-between gap-3">
          {/* Folder picker for small screens (the sidebar is hidden there) */}
          <select
            value={activeFolder}
            onChange={(e) => mailStore.setActiveFolder(e.target.value as MailFolder)}
            className="md:hidden text-[15px] font-semibold text-[#18181b] bg-transparent focus:outline-none"
            aria-label="Folder"
          >
            {MAIL_FOLDERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <h2 className="hidden md:block text-[15px] font-semibold text-[#18181b]">{folderLabel}</h2>

          <div className="flex items-center gap-2">
            <span className="text-[12px] text-[#a1a1aa] tabular-nums">
              {filteredThreads.length} {filteredThreads.length === 1 ? 'conversation' : 'conversations'}
            </span>
            <button
              type="button"
              onClick={() => mailStore.openComposer()}
              className="md:hidden p-2 rounded-md bg-[#18181b] text-white cursor-pointer"
              aria-label="Compose"
            >
              <PenSquare className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className={`flex gap-2 ${isSplitView ? 'flex-col' : 'flex-col sm:flex-row sm:items-center'}`}>
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#a1a1aa] pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => mailStore.setSearchQuery(e.target.value)}
              placeholder="Search mail"
              aria-label="Search mail"
              className="w-full h-9 bg-[#f7f7f4] border border-transparent rounded-lg pl-8 pr-8 text-[13px] text-[#18181b] placeholder:text-[#a1a1aa] focus:bg-white focus:border-[#d4d4cf] focus:outline-none transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => mailStore.setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-[#a1a1aa] hover:text-[#18181b] cursor-pointer"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="inline-flex p-0.5 rounded-lg bg-[#f0f0eb] self-start">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => mailStore.setFilter(f.id)}
                className={`px-3 h-8 rounded-md text-[12px] transition-colors cursor-pointer ${
                  filter === f.id ? 'bg-white text-[#18181b] font-medium shadow-xs' : 'text-[#71717a] hover:text-[#18181b]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Threads */}
      <div className="flex-1 overflow-y-auto">
        {filteredThreads.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <div className="text-[14px] font-medium text-[#18181b]">
              {isFiltered ? 'No matching conversations' : `${folderLabel} is empty`}
            </div>
            <p className="mt-1 text-[13px] text-[#71717a]">
              {isFiltered ? 'Try a different search or filter.' : EMPTY_COPY[activeFolder]}
            </p>
            {isFiltered && (
              <button
                type="button"
                onClick={() => {
                  mailStore.setSearchQuery('');
                  mailStore.setFilter('all');
                }}
                className="mt-4 text-[13px] text-[#18181b] underline underline-offset-2 cursor-pointer"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-[#f0f0eb]">
            {filteredThreads.map((thread) => {
              const isSelected = thread.id === activeThreadId;
              const isUnread = thread.unread_count > 0;
              const isDraft = thread.folder === 'drafts';
              const isOutbound = thread.folder === 'sent' || isDraft;
              const person = thread.participants[0];
              const personLabel = person?.name || person?.address || (isDraft ? 'No recipient' : 'Unknown');

              return (
                <li key={thread.id} className="relative group">
                  <button
                    type="button"
                    onClick={() => openThread(thread)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`w-full text-left flex gap-3 px-4 py-3.5 transition-colors cursor-pointer ${
                      isSelected ? 'bg-[#f4f4f0]' : 'hover:bg-[#fafaf8]'
                    }`}
                  >
                    <span
                      className={`mt-0.5 w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                        isUnread ? 'bg-emerald-700 text-white' : 'bg-[#f0f0eb] text-[#52525b]'
                      }`}
                    >
                      {initialsFor(personLabel)}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={`truncate text-[13px] ${
                            isUnread ? 'font-semibold text-[#18181b]' : 'font-medium text-[#3f3f46]'
                          }`}
                        >
                          {isDraft && <span className="text-red-600 font-medium">Draft · </span>}
                          {isOutbound && !isDraft && <span className="text-[#a1a1aa] font-normal">To: </span>}
                          {personLabel}
                        </span>
                        <span className="ml-auto shrink-0 text-[12px] text-[#a1a1aa] tabular-nums">
                          {formatMailTime(thread.last_message_at)}
                        </span>
                      </div>

                      <div
                        className={`mt-0.5 pr-7 truncate text-[13px] ${
                          isUnread ? 'font-semibold text-[#18181b]' : 'text-[#3f3f46]'
                        }`}
                      >
                        {thread.subject || <span className="text-[#a1a1aa]">(no subject)</span>}
                      </div>

                      <div className="mt-0.5 pr-7 flex items-center gap-2">
                        <p className="truncate text-[12px] text-[#71717a] flex-1">{thread.snippet}</p>
                        {thread.has_attachments && <Paperclip className="w-3.5 h-3.5 shrink-0 text-[#a1a1aa]" />}
                      </div>

                      {thread.lead_id && (thread.lead_company || thread.lead_name) && (
                        <div className="mt-2 flex items-center gap-1.5 text-[11px]">
                          <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800">
                            {thread.lead_company || thread.lead_name}
                          </span>
                          {thread.lead_pipeline_status && (
                            <span className="px-1.5 py-0.5 rounded bg-[#f4f4f0] text-[#52525b]">
                              {statusLabel(thread.lead_pipeline_status)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </button>

                  {/* Star sits outside the row button so it isn't a nested control */}
                  <button
                    type="button"
                    onClick={() => mailStore.toggleStar(thread.id)}
                    className={`absolute right-3 top-9 p-1 rounded transition-opacity cursor-pointer ${
                      thread.starred
                        ? 'text-amber-500'
                        : 'text-[#c4c4bf] hover:text-amber-500 opacity-0 group-hover:opacity-100 focus:opacity-100'
                    }`}
                    aria-label={thread.starred ? 'Unstar' : 'Star'}
                    aria-pressed={thread.starred}
                  >
                    <Star className={`w-4 h-4 ${thread.starred ? 'fill-amber-400' : ''}`} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
};
