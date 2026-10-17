import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useEcho } from '../context/EchoContext';
import { Sidebar } from '../components/dashboard/Sidebar';
import { FeedTab } from '../components/dashboard/FeedTab';
import { KeywordsTab } from '../components/dashboard/KeywordsTab';
import { SettingsTab } from '../components/dashboard/SettingsTab';
import { BillingTab } from '../components/dashboard/BillingTab';
import { LeadsTab } from '../components/dashboard/LeadsTab';
import { OnboardingModal } from '../components/onboarding/OnboardingModal';
import type { DashboardTab, LeadsView } from '../types';
import { leadsRouteFromHash, tabFromHash } from '../lib/leads';
import { supabase } from '../lib/supabase';
import { RefreshCw, Radio } from 'lucide-react';

interface DashboardPageProps {
  onNavigateHome: () => void;
  onNavigateAuth?: () => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  onNavigateHome,
}) => {
  const { profile } = useAuth();
  const { isSweeping, runSweep, keywords } = useEcho();
  // Read the tab out of the hash on first paint rather than always starting on
  // the feed. Without this a refresh on #dashboard/leads/run/<id> came up showing
  // the feed with the hash still pointing at Leads, which reads as a broken link.
  const [activeTab, setActiveTab] = useState<DashboardTab>(
    () => (tabFromHash() as DashboardTab) ?? 'feed',
  );

  // The Leads sub-view, also from the hash, so a run link survives a refresh.
  const [leadsRoute, setLeadsRoute] = useState<{ view: LeadsView; runId: string | null }>(
    () => leadsRouteFromHash(),
  );

  /**
   * Unfinished runs, for the sidebar badge.
   *
   * Held on the page rather than fetched inside the sidebar, so the count keeps
   * updating while the user is on the feed and the run list is unmounted.
   *
   * lead_active_run_count() takes no arguments and is not SECURITY DEFINER: it
   * reads auth.uid() and RLS still applies, so this cannot be pointed at another
   * workspace. A failed poll deliberately leaves the previous number rather than
   * setting zero — a transient blip should not make work in progress vanish.
   */
  const [activeLeadRuns, setActiveLeadRuns] = useState(0);

  useEffect(() => {
    const client = supabase;
    if (!client) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const { count, error } = await client.rpc('lead_active_run_count');
        if (cancelled || error) return;
        setActiveLeadRuns(count ?? 0);
      } catch {
        /* keep the last known count */
      }
    };

    void poll();
    // 15s is slow enough not to matter and fast enough that a run started on
    // another tab shows its badge here within one poll.
    const timer = setInterval(poll, 15000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Sidebar collapse state with localStorage persistence
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('echo_sidebar_collapsed');
      return saved ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });

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
  // button, or a link from elsewhere in the app. Keep both in step with it.
  useEffect(() => {
    const syncFromHash = () => {
      const tab = tabFromHash() as DashboardTab | null;
      if (tab) setActiveTab(tab);
      setLeadsRoute(leadsRouteFromHash());
    };

    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  // replaceState rather than assigning location.hash: assigning pushes a history
  // entry, so Back after switching Leads panels would walk back through every
  // panel click instead of leaving the dashboard. Switching panels is not
  // navigation, and neither is switching tabs.
  const replaceHash = (hash: string) => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    );
  };

  const handleTabChange = (tab: DashboardTab) => {
    setActiveTab(tab);
    if (tab === 'leads') {
      replaceHash(`#dashboard/leads/${leadsRoute.view}`);
    } else {
      replaceHash(`#dashboard/${tab}`);
    }
  };

  const handleLeadsViewChange = (view: LeadsView) => {
    // Switching away from a run clears the id, so returning to Runs does not
    // leave the previous run id in the hash ready to be reopened by Back.
    setLeadsRoute({ view, runId: null });
    replaceHash(`#dashboard/leads/${view}`);
  };

  // Opening a specific run writes the run id into the hash, so the link works
  // and Back returns to the list. The id is checked as a uuid rather than
  // concatenated blindly: it ends up in a query string the browser will send.
  const handleOpenRun = (id: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
    setLeadsRoute({ view: 'run', runId: id });
    replaceHash(`#dashboard/leads/run/${id}`);
  };

  // Check if onboarding needs to be shown
  const showOnboarding = Boolean(profile && !profile.onboarding_completed);

  return (
    <div className="flex h-screen bg-[#f6f6f4] text-[#141414] font-sans overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onNavigateHome={onNavigateHome}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        activeLeadRuns={activeLeadRuns}
      />

      {/* Main Content Area with 58px Grid Pattern */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-grid-58 relative">
        {/* Top Header Bar */}
        <header className="h-16 bg-[#ffffff]/90 backdrop-blur-md border-b border-[#e3e3de] px-6 sm:px-8 flex items-center justify-between flex-shrink-0 z-20">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-[#8a8a86] hidden sm:inline">Workspace</span>
              <span className="text-xs font-mono text-[#8a8a86] hidden sm:inline">/</span>
              <h1 className="text-sm sm:text-base font-bold tracking-tight text-[#141414]">
                {activeTab === 'feed'
                  ? 'Monitored Mentions Feed'
                  : activeTab === 'keywords'
                  ? 'Keyword Management'
                  : activeTab === 'leads'
                  ? 'Leads'
                  : activeTab === 'billing'
                  ? 'Credits & Billing'
                  : 'Workspace Settings'}
              </h1>
            </div>

            {activeTab === 'feed' && (
              <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-[#eeeeea] text-[10px] font-mono text-[#4a4a47] rounded-full border border-[#deded8]">
                <Radio className="w-2.5 h-2.5 text-emerald-600 animate-pulse" />
                <span>Tracking {keywords.length} keywords</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden md:inline-flex items-center gap-1.5 text-[10px] font-mono text-emerald-800 bg-emerald-50 px-2.5 py-1 border border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Live Radar Active
            </span>

            <button
              onClick={runSweep}
              disabled={isSweeping}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 bg-[#121212] hover:bg-black text-white text-xs font-mono rounded-none transition-colors cursor-pointer disabled:opacity-50 shadow-xs"
            >
              <RefreshCw className={`w-3 h-3 ${isSweeping ? 'animate-spin' : ''}`} />
              <span>{isSweeping ? 'Sweeping...' : 'Trigger Sweep'}</span>
            </button>
          </div>
        </header>

        {/* Content Pane */}
        <main
          className={`flex-1 overflow-y-auto p-6 sm:p-8 ${
            showOnboarding ? 'pointer-events-none select-none blur-[1px]' : ''
          }`}
        >
          {activeTab === 'feed' && <FeedTab />}
          {activeTab === 'keywords' && <KeywordsTab />}
          {activeTab === 'leads' && (
            <LeadsTab
              view={leadsRoute.view}
              runId={leadsRoute.runId}
              onViewChange={handleLeadsViewChange}
              onOpenRun={handleOpenRun}
            />
          )}
          {activeTab === 'billing' && <BillingTab />}
          {activeTab === 'settings' && <SettingsTab />}
        </main>
      </div>

      {/* Onboarding Modal Overlay */}
      <OnboardingModal
        isOpen={showOnboarding}
        onComplete={() => {
          setActiveTab('feed');
        }}
      />
    </div>
  );
};
