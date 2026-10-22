import React, { useEffect } from 'react';
import { MailSidebar, MailMobileNav } from './MailSidebar';
import { ThreadList } from './ThreadList';
import { ThreadView } from './ThreadView';
import { DomainsPanel } from './DomainsPanel';
import { AccountsPanel } from './AccountsPanel';
import { EchoMailboxCard } from './EchoMailboxCard';
import { mailStore, useMailStore } from './mail-store';

/** How often the open Mail tab re-reads threads so inbound replies appear. */
const INBOX_REFRESH_MS = 30_000;

export const MailTab: React.FC = () => {
  const { activeSubView, activeThreadId, loadError, loading, mailboxes } = useMailStore();
  // mailStore is initialised and reset by AuthContext.

  // Replies arrive server-side (mail-inbound); poll while the tab is open and
  // visible, and catch up as soon as it becomes visible again.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void mailStore.refreshThreads();
    };
    const timer = window.setInterval(refresh, INBOX_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const isFirstRun = !loading && !loadError && mailboxes.length === 0;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden bg-white relative">
      {loadError && (
        <div
          role="alert"
          className="absolute top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2 rounded-lg border border-red-200 bg-red-50 text-[13px] text-red-700 shadow-sm"
        >
          {loadError}
          <button type="button" onClick={() => mailStore.reload()} className="font-medium underline cursor-pointer">
            Retry
          </button>
        </div>
      )}
      {/* Below md the sidebar is hidden; this bar reaches folders, Mailboxes and Domains. */}
      <MailMobileNav />

      <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Pane 1: Left Mail Sidebar */}
      <MailSidebar />

      {/* Pane 2 & 3: Dependent on Active Sub-view */}
      {activeSubView === 'mailbox' && isFirstRun && (
        // No mailbox yet: offer the 1-click Echo address instead of an empty inbox.
        <div className="flex-1 overflow-y-auto bg-[#fafaf8]">
          <div className="max-w-xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
            <div className="text-center mb-6">
              <h2 className="text-[19px] font-semibold text-[#18181b]">Set up your outreach inbox</h2>
              <p className="mt-1 text-[13px] text-[#71717a]">
                Pick an address to send from. Replies to your outreach will land here.
              </p>
            </div>
            <EchoMailboxCard variant="first-run" />
          </div>
        </div>
      )}

      {activeSubView === 'mailbox' && !isFirstRun && (
        <>
          {/* Pane 2: Thread List */}
          <ThreadList />

          {/* Pane 3: Conversation Reader (only visible when a thread is opened) */}
          {activeThreadId && <ThreadView />}
        </>
      )}

      {activeSubView === 'domains' && <DomainsPanel />}

      {activeSubView === 'accounts' && <AccountsPanel />}
      </div>
    </div>
  );
};
