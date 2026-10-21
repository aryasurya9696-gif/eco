import React, { useEffect, useState } from 'react';
import {
  Inbox,
  Send,
  FileText,
  Archive,
  Trash2,
  AlertOctagon,
  Plus,
  Globe,
  AtSign,
  ChevronsUpDown,
  Check,
  PenSquare,
} from 'lucide-react';
import { mailStore, useMailStore } from './mail-store';
import type { MailFolder, Mailbox } from '../../types';

export const MAIL_FOLDERS: { id: MailFolder; label: string; icon: React.ElementType }[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'drafts', label: 'Drafts', icon: FileText },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'spam', label: 'Spam', icon: AlertOctagon },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];

const avatarLetter = (mb: Mailbox) => (mb.display_name || mb.address || '?').trim()[0]?.toUpperCase() ?? '?';

export const MailSidebar: React.FC = () => {
  const { mailboxes, activeMailboxId, activeFolder, activeSubView, threads } = useMailStore();
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);

  const activeMailbox = mailboxes.find((m) => m.id === activeMailboxId) || mailboxes[0];

  useEffect(() => {
    if (!isAccountMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsAccountMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isAccountMenuOpen]);

  const mailboxThreads = threads.filter((t) => t.mailbox_id === activeMailboxId);
  const counts: Partial<Record<MailFolder, number>> = {
    inbox: mailboxThreads.filter((t) => t.folder === 'inbox' && t.unread_count > 0).length,
    drafts: mailboxThreads.filter((t) => t.folder === 'drafts').length,
  };

  const sent = activeMailbox?.sent_today ?? 0;
  const limit = Math.max(1, activeMailbox?.daily_send_limit ?? 1);
  const usage = Math.min(100, (sent / limit) * 100);

  const navItem = (isActive: boolean) =>
    `w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[13px] transition-colors cursor-pointer ${
      isActive ? 'bg-[#ebebe6] text-[#18181b] font-medium' : 'text-[#52525b] hover:bg-[#f0f0eb] hover:text-[#18181b]'
    }`;

  return (
    <aside className="hidden md:flex w-60 shrink-0 border-r border-[#e8e8e3] flex-col h-full bg-[#fafaf8] select-none">
      {/* Mailbox switcher */}
      <div className="p-3 relative">
        <button
          type="button"
          onClick={() => setIsAccountMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={isAccountMenuOpen}
          className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-[#f0f0eb] transition-colors text-left cursor-pointer"
        >
          {activeMailbox && (
            <span className="w-8 h-8 shrink-0 rounded-full bg-[#18181b] text-white flex items-center justify-center text-[13px] font-semibold">
              {avatarLetter(activeMailbox)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[#18181b] truncate">
              {activeMailbox?.display_name || 'No mailbox'}
            </div>
            <div className="text-[12px] text-[#71717a] truncate">{activeMailbox?.address}</div>
          </div>
          <ChevronsUpDown className="w-4 h-4 text-[#a1a1aa] shrink-0" />
        </button>

        {isAccountMenuOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setIsAccountMenuOpen(false)} />
            <div
              role="menu"
              className="absolute top-full left-3 right-3 -mt-1 bg-white border border-[#e8e8e3] rounded-lg shadow-lg z-30 p-1"
            >
              {mailboxes.map((mb) => (
                <button
                  key={mb.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    mailStore.setActiveSubView('mailbox');
                    mailStore.setActiveMailbox(mb.id);
                    setIsAccountMenuOpen(false);
                  }}
                  className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[#f4f4f0] flex items-center gap-2.5 cursor-pointer"
                >
                  <span className="w-6 h-6 shrink-0 rounded-full bg-[#f0f0eb] text-[#52525b] flex items-center justify-center text-[11px] font-semibold">
                    {avatarLetter(mb)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-[#18181b] truncate">{mb.display_name}</div>
                    <div className="text-[11px] text-[#71717a] truncate">{mb.address}</div>
                  </div>
                  {mb.id === activeMailboxId && <Check className="w-4 h-4 text-emerald-700 shrink-0" />}
                </button>
              ))}
              <div className="my-1 border-t border-[#f0f0eb]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  mailStore.setActiveSubView('accounts');
                  setIsAccountMenuOpen(false);
                }}
                className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[#f4f4f0] text-[13px] text-[#52525b] flex items-center gap-2.5 cursor-pointer"
              >
                <Plus className="w-4 h-4 mx-1" />
                Connect mailbox
              </button>
            </div>
          </>
        )}
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => mailStore.openComposer()}
          className="w-full inline-flex items-center justify-center gap-2 h-9 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg transition-colors cursor-pointer"
        >
          <PenSquare className="w-4 h-4" />
          Compose
        </button>
      </div>

      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        {MAIL_FOLDERS.map(({ id, label, icon: Icon }) => {
          const isActive = activeSubView === 'mailbox' && activeFolder === id;
          const count = counts[id];
          return (
            <button
              key={id}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => {
                mailStore.setActiveSubView('mailbox');
                mailStore.setActiveFolder(id);
              }}
              className={navItem(isActive)}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-[#18181b]' : 'text-[#a1a1aa]'}`} />
              <span className="flex-1 text-left">{label}</span>
              {count ? (
                <span
                  className={`text-[11px] tabular-nums ${
                    id === 'inbox' ? 'font-semibold text-emerald-700' : 'text-[#a1a1aa]'
                  }`}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}

        <div className="pt-5 pb-1 px-2.5 text-[11px] font-medium text-[#a1a1aa]">Setup</div>

        <button
          type="button"
          aria-current={activeSubView === 'accounts' ? 'page' : undefined}
          onClick={() => mailStore.setActiveSubView('accounts')}
          className={navItem(activeSubView === 'accounts')}
        >
          <AtSign className={`w-4 h-4 ${activeSubView === 'accounts' ? 'text-[#18181b]' : 'text-[#a1a1aa]'}`} />
          <span className="flex-1 text-left">Mailboxes</span>
          <span className="text-[11px] text-[#a1a1aa] tabular-nums">{mailboxes.length}</span>
        </button>
        <button
          type="button"
          aria-current={activeSubView === 'domains' ? 'page' : undefined}
          onClick={() => mailStore.setActiveSubView('domains')}
          className={navItem(activeSubView === 'domains')}
        >
          <Globe className={`w-4 h-4 ${activeSubView === 'domains' ? 'text-[#18181b]' : 'text-[#a1a1aa]'}`} />
          <span className="flex-1 text-left">Domains & DNS</span>
        </button>
      </nav>

      {/* Daily sending usage for the active mailbox */}
      {activeMailbox && (
        <div className="m-3 p-3 rounded-lg border border-[#e8e8e3] bg-white">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[#71717a]">Sent today</span>
            <span className="font-medium text-[#18181b] tabular-nums">
              {sent} / {activeMailbox.daily_send_limit}
            </span>
          </div>
          <div className="mt-2 w-full bg-[#f0f0eb] h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                usage >= 100 ? 'bg-red-500' : usage >= 85 ? 'bg-amber-500' : 'bg-emerald-600'
              }`}
              style={{ width: `${usage}%` }}
            />
          </div>
          <div className="mt-1.5 text-[11px] text-[#a1a1aa]">
            {usage >= 100 ? 'Daily limit reached' : 'Paced to protect deliverability'}
          </div>
        </div>
      )}
    </aside>
  );
};

/**
 * The mail sidebar is hidden below md, so small screens get this bar instead:
 * one picker for the folders and the Setup pages (Mailboxes, Domains & DNS),
 * and a mailbox switcher when there is more than one.
 */
export const MailMobileNav: React.FC = () => {
  const { mailboxes, activeMailboxId, activeFolder, activeSubView } = useMailStore();
  const value = activeSubView === 'mailbox' ? `folder:${activeFolder}` : `view:${activeSubView}`;

  const onViewChange = (next: string) => {
    const [kind, id] = next.split(':');
    if (kind === 'folder') {
      mailStore.setActiveSubView('mailbox');
      mailStore.setActiveFolder(id as MailFolder);
    } else {
      mailStore.setActiveSubView(id as 'accounts' | 'domains');
    }
  };

  return (
    <nav aria-label="Mail" className="md:hidden flex items-center gap-2 px-4 py-2 border-b border-[#e8e8e3] bg-[#fafaf8]">
      <label htmlFor="mail-mobile-view" className="sr-only">
        Mail section
      </label>
      <select
        id="mail-mobile-view"
        value={value}
        onChange={(e) => onViewChange(e.target.value)}
        className="min-w-0 flex-1 h-9 px-2 rounded-md border border-[#e8e8e3] bg-white text-[13px] text-[#18181b] focus:outline-none focus:border-[#a1a1aa]"
      >
        <optgroup label="Folders">
          {MAIL_FOLDERS.map((f) => (
            <option key={f.id} value={`folder:${f.id}`}>
              {f.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Setup">
          <option value="view:accounts">Mailboxes ({mailboxes.length})</option>
          <option value="view:domains">Domains &amp; DNS</option>
        </optgroup>
      </select>

      {mailboxes.length > 1 && (
        <>
          <label htmlFor="mail-mobile-mailbox" className="sr-only">
            Mailbox
          </label>
          <select
            id="mail-mobile-mailbox"
            value={activeMailboxId}
            onChange={(e) => {
              mailStore.setActiveSubView('mailbox');
              mailStore.setActiveMailbox(e.target.value);
            }}
            className="min-w-0 flex-1 h-9 px-2 rounded-md border border-[#e8e8e3] bg-white text-[13px] text-[#18181b] focus:outline-none focus:border-[#a1a1aa]"
          >
            {mailboxes.map((mb) => (
              <option key={mb.id} value={mb.id}>
                {mb.address}
              </option>
            ))}
          </select>
        </>
      )}
    </nav>
  );
};
