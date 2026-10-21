import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useEcho } from '../context/EchoContext';
import { Sidebar } from '../components/dashboard/Sidebar';
import { FeedTab } from '../components/dashboard/FeedTab';
import { LeadsTab } from '../components/leads/LeadsTab';
import { KeywordsTab } from '../components/dashboard/KeywordsTab';
import { SettingsTab } from '../components/dashboard/SettingsTab';
import { BillingTab } from '../components/dashboard/BillingTab';
import { MailTab } from '../components/mail/MailTab';
import { Composer } from '../components/mail/Composer';
import { OnboardingModal } from '../components/onboarding/OnboardingModal';
import type { DashboardTab } from '../types';
import {
  clearIntendedPackage,
  clearIntendedTab,
  explicitTabFromHash,
  hashForTab,
  peekIntendedPackage,
  peekIntendedTab,
  tabFromHash,
} from '../lib/tab-routing';
import { SweepButton } from '../components/dashboard/SweepButton';
import { Radio } from 'lucide-react';

interface DashboardPageProps {
  onNavigateHome: () => void;
  onNavigateAuth?: () => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  onNavigateHome,
}) => {
  const { profile, profileError, retryProfile } = useAuth();
  const { keywords } = useEcho();
  // A package picked on the landing page ("Buy"). The visitor arrives here to
  // pay, whichever route (sign-in, sign-up, an email confirmation link in a new
  // tab) brought them. Read once and owned here, not by BillingTab: a new user
  // first goes through onboarding, and the intent has to survive that (see the
  // effect below). Stored in localStorage with a TTL by lib/tab-routing.
  const [intendedPackage] = useState<string | null>(() => peekIntendedPackage());

  // Read the tab out of the hash on first paint rather than always starting on
  // the feed, so a refresh on #dashboard/billing comes up on Billing. An
  // intended package wins, then the tab a signed-out deep link named.
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => {
    if (intendedPackage) return 'billing';
    return ((explicitTabFromHash() ?? peekIntendedTab() ?? tabFromHash()) as DashboardTab) ?? 'feed';
  });
  const [isRetryingProfile, setIsRetryingProfile] = useState(false);

  // Sidebar collapse state with localStorage persistence
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('echo_sidebar_collapsed');
      return saved ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });

  // Below the md breakpoint the full 256px sidebar left a phone ~130px of
  // content, so it is shown collapsed there regardless of the saved setting.
  const [isNarrow, setIsNarrow] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggleSidebar = () => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('echo_sidebar_collapsed', JSON.stringify(next));
      } catch (err) {
        console.error('Failed to save sidebar state', err);
      }
      return next;
    });
  };

  // Keyboard shortcut (Cmd+B or Ctrl+B) to toggle sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // The hash can change without this component remounting: the browser Back
  // button, or a link from elsewhere in the app. Keep it in step.
  useEffect(() => {
    const syncFromHash = () => {
      const tab = tabFromHash() as DashboardTab | null;
      if (tab) setActiveTab(tab);
    };

    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  // replaceState rather than assigning location.hash: assigning pushes a history
  // entry, so Back after switching tabs would walk back through every tab click
  // instead of leaving the dashboard. Switching tabs is not navigation.
  const replaceHash = (hash: string) => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    );
  };

  const handleTabChange = (tab: DashboardTab) => {
    setActiveTab(tab);
    replaceHash(hashForTab(tab));
  };

  // Keep the URL naming the tab actually shown (e.g. Billing chosen from an
  // intended package while the hash still said #/dashboard). A no-op whenever
  // the tab came from the hash or from handleTabChange.
  useEffect(() => {
    if (tabFromHash() !== activeTab) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${hashForTab(activeTab)}`,
      );
    }
  }, [activeTab]);

  // Check if onboarding needs to be shown
  const showOnboarding = Boolean(profile && !profile.onboarding_completed);

  // Intents are consumed only once a fully set-up user is looking at them.
  // Clearing them earlier (while the profile was loading, or under the
  // onboarding modal) lost them for every new user, and a reload mid-onboarding
  // lost them too.
  useEffect(() => {
    if (!profile?.onboarding_completed) return;
    clearIntendedTab();
    if (intendedPackage && activeTab === 'billing') clearIntendedPackage();
  }, [intendedPackage, activeTab, profile?.onboarding_completed]);

  return (
    <div className="flex h-screen bg-[#f6f6f4] text-[#141414] font-sans overflow-hidden">
      {/* Sidebar. Inert under the onboarding dialog, like the content. */}
      <div className="contents" inert={showOnboarding}>
        <Sidebar
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onNavigateHome={onNavigateHome}
          isCollapsed={isSidebarCollapsed || isNarrow}
          onToggleCollapse={toggleSidebar}
        />
      </div>

      {/* Main Content Area with 58px Grid Pattern */}
      <div
        className="flex-1 min-w-0 flex flex-col h-screen overflow-hidden bg-grid-58 relative"
        inert={showOnboarding}
      >
        {/* Top Header Bar */}
        <header className="h-16 bg-[#ffffff]/90 backdrop-blur-md border-b border-[#e3e3de] px-6 sm:px-8 flex items-center justify-between flex-shrink-0 z-20">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-[#8a8a86] hidden sm:inline">Workspace</span>
              <span className="text-xs font-mono text-[#8a8a86] hidden sm:inline">/</span>
              <h1 className="text-sm sm:text-base font-bold tracking-tight text-[#141414]">
                {activeTab === 'feed'
                  ? 'Monitored Mentions Feed'
                  : activeTab === 'leads'
                  ? 'B2B Leads & Prospecting'
                  : activeTab === 'mail'
                  ? 'Mailbox & Outreach'
                  : activeTab === 'keywords'
                  ? 'Keyword Management'
                  : activeTab === 'billing'
                  ? 'Credits & Billing'
                  : 'Workspace Settings'}
              </h1>
            </div>

            {activeTab === 'feed' && (
              <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-[#eeeeea] text-[10px] font-mono text-[#4a4a47] rounded-full border border-[#deded8]">
                <Radio className="w-2.5 h-2.5 text-emerald-600" aria-hidden="true" />
                <span>Tracking {keywords.length} keywords</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {activeTab === 'feed' && (
              <SweepButton variant="header" onNavigateBilling={() => handleTabChange('billing')} />
            )}
          </div>
        </header>

        {/* Content Pane */}
        <main
          className={`flex-1 ${activeTab === 'leads' || activeTab === 'mail' ? 'p-0 flex flex-col overflow-hidden' : 'p-6 sm:p-8 overflow-y-auto'} ${
            showOnboarding ? 'pointer-events-none select-none blur-[1px]' : ''
          }`}
        >
          {profileError && !profile && (
            <div role="alert" className="mb-6 p-4 border border-[#f0c4c4] bg-[#fdf2f2] text-xs text-[#8a2a2a] flex items-center justify-between gap-4 pointer-events-auto">
              <span>Could not load your workspace profile: {profileError}</span>
              <button
                type="button"
                disabled={isRetryingProfile}
                onClick={async () => {
                  setIsRetryingProfile(true);
                  await retryProfile();
                  setIsRetryingProfile(false);
                }}
                className="px-3 py-1.5 border border-[#8a2a2a] text-[#8a2a2a] hover:bg-[#8a2a2a] hover:text-white transition-colors cursor-pointer disabled:opacity-50"
              >
                {isRetryingProfile ? 'Retrying...' : 'Retry'}
              </button>
            </div>
          )}
          {activeTab === 'feed' && <FeedTab onNavigateBilling={() => handleTabChange('billing')} />}
          {activeTab === 'leads' && <LeadsTab onNavigateBilling={() => handleTabChange('billing')} />}
          {activeTab === 'mail' && <MailTab />}
          {activeTab === 'keywords' && <KeywordsTab />}
          {activeTab === 'billing' && <BillingTab intendedCode={intendedPackage} />}
          {activeTab === 'settings' && <SettingsTab />}
        </main>
      </div>

      {/* Onboarding Modal Overlay */}
      <OnboardingModal
        isOpen={showOnboarding}
        onComplete={() => {
          // Keep the tab a deep link named; only a picked package overrides it.
          if (intendedPackage) handleTabChange('billing');
        }}
      />

      {/* Global Mail Outreach Slide-Over Drawer */}
      <Composer mode="drawer" />
    </div>
  );
};
