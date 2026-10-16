import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useEcho } from '../context/EchoContext';
import { Sidebar } from '../components/dashboard/Sidebar';
import { FeedTab } from '../components/dashboard/FeedTab';
import { KeywordsTab } from '../components/dashboard/KeywordsTab';
import { SettingsTab } from '../components/dashboard/SettingsTab';
import { BillingTab } from '../components/dashboard/BillingTab';
import { OnboardingModal } from '../components/onboarding/OnboardingModal';
import type { DashboardTab } from '../types';
import { RefreshCw, Radio } from 'lucide-react';

interface DashboardPageProps {
  onNavigateHome: () => void;
  onNavigateAuth?: () => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  onNavigateHome,
}) => {
  const { profile, isMock } = useAuth();
  const { isSweeping, runSweep, keywords } = useEcho();
  const [activeTab, setActiveTab] = useState<DashboardTab>('feed');

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

  // Check if onboarding needs to be shown
  const showOnboarding = Boolean(profile && !profile.onboarding_completed);

  return (
    <div className="flex h-screen bg-[#f6f6f4] text-[#141414] font-sans overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onNavigateHome={onNavigateHome}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={toggleSidebar}
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
                  : activeTab === 'settings'
                  ? 'Workspace Settings'
                  : 'Subscription & Billing'}
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
            {isMock && (
              <span className="hidden md:inline-flex items-center gap-1 text-[10px] font-mono text-[#8a8a86] bg-[#f6f6f4] px-2.5 py-1 border border-[#e3e3de]">
                Local Mock Engine Active
              </span>
            )}

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
          {activeTab === 'settings' && <SettingsTab />}
          {activeTab === 'billing' && <BillingTab />}
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
