import React, { useEffect } from 'react';
import { MailSidebar } from './MailSidebar';
import { ThreadList } from './ThreadList';
import { ThreadView } from './ThreadView';
import { DomainsPanel } from './DomainsPanel';
import { AccountsPanel } from './AccountsPanel';
import { mailStore, useMailStore } from './mail-store';
import { useAuth } from '../../context/AuthContext';

export const MailTab: React.FC = () => {
  const { user } = useAuth();
  const { activeSubView, activeThreadId, loadError } = useMailStore();

  useEffect(() => {
    mailStore.init(user?.id ?? null);
  }, [user?.id]);

  return (
    <div className="flex-1 flex h-full overflow-hidden bg-white relative">
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
      {/* Pane 1: Left Mail Sidebar */}
      <MailSidebar />

      {/* Pane 2 & 3: Dependent on Active Sub-view */}
      {activeSubView === 'mailbox' && (
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
  );
};
