import React from 'react';
import { BrandLogo } from '../common/BrandLogo';
import { useAuth } from '../../context/AuthContext';
import { useEcho } from '../../context/EchoContext';
import type { DashboardTab } from '../../types';
import {
  Inbox,
  Tag,
  Settings,
  CreditCard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  BarChart3,
} from 'lucide-react';

interface NavItem {
  id: DashboardTab;
  label: string;
  icon: React.ReactNode;
  count?: number | string;
  isPlaceholder?: boolean;
}

interface SidebarProps {
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  onNavigateHome: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  onNavigateHome,
  isCollapsed,
  onToggleCollapse,
}) => {
  const { user, profile, signOut } = useAuth();
  const { keywords, keywordLimit, posts, sweepTime, sweepCadence, lookbackHours, enabledChannels } = useEcho();

  // Compute user initials for avatar
  const getInitials = () => {
    if (profile?.full_name) {
      const parts = profile.full_name.trim().split(' ');
      if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
      }
      return profile.full_name.slice(0, 2).toUpperCase();
    }
    if (user?.email) {
      return user.email.slice(0, 2).toUpperCase();
    }
    return 'EC';
  };

  const navItems: { group: string; items: NavItem[] }[] = [
    {
      group: 'MAIN',
      items: [
        {
          id: 'feed' as DashboardTab,
          label: 'Feed',
          icon: <Inbox className="w-4 h-4" />,
          count: posts.length,
        },
        {
          id: 'keywords' as DashboardTab,
          label: 'Keywords',
          icon: <Tag className="w-4 h-4" />,
          count: `${keywords.length}/${keywordLimit}`,
        },
      ],
    },
    {
      group: 'ACCOUNT',
      items: [
        {
          id: 'settings' as DashboardTab,
          label: 'Settings',
          icon: <Settings className="w-4 h-4" />,
        },
        {
          id: 'billing' as DashboardTab,
          label: 'Billing',
          icon: <CreditCard className="w-4 h-4" />,
        },
      ],
    },
  ];

  // The profit view reads aggregates across every workspace, so it is only ever
  // offered to an admin. Hiding the link is convenience; the server refuses a
  // non-admin regardless.
  if (profile?.is_admin) {
    navItems.push({
      group: 'ADMIN',
      items: [
        {
          id: 'admin' as DashboardTab,
          label: 'Billing & profit',
          icon: <BarChart3 className="w-4 h-4" />,
        },
      ],
    });
  }

  return (
    <aside
      className={`${
        isCollapsed ? 'w-16' : 'w-64'
      } bg-[#ffffff] border-r border-[#e3e3de] flex flex-col justify-between h-screen flex-shrink-0 select-none transition-all duration-300 ease-in-out`}
    >
      {/* Top Header */}
      <div>
        <div
          className={`border-b border-[#eeeeea] flex items-center transition-all ${
            isCollapsed
              ? 'p-3 flex-col gap-2.5 justify-center'
              : 'p-4 justify-between'
          }`}
        >
          <button
            onClick={onNavigateHome}
            className="hover:opacity-85 transition-opacity cursor-pointer"
            title="Go to Echo homepage"
          >
            <BrandLogo size="md" showSubtitle={!isCollapsed} iconOnly={isCollapsed} />
          </button>

          <button
            onClick={onToggleCollapse}
            className="p-1.5 text-[#8a8a86] hover:text-[#141414] hover:bg-[#f6f6f4] border border-transparent hover:border-[#deded8] transition-colors cursor-pointer"
            title={isCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Minimize sidebar (Ctrl+B)'}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Minimize sidebar'}
          >
            {isCollapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Sweep Status Card */}
        {!isCollapsed ? (
          <div className="mx-4 mt-4 p-3 bg-[#f6f6f4] border border-[#e3e3de] text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-[#4a4a47] font-semibold">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                SWEEP SCHEDULE
              </span>
              <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 bg-white border border-[#deded8] text-emerald-700 font-medium">
                {sweepCadence === '24h' ? 'Daily' : sweepCadence === '12h' ? '12h Cycle' : '6h Fast'}
              </span>
            </div>
            <p className="text-[11px] text-[#8a8a86] font-mono">
              Next: <span className="text-[#141414] font-medium">{sweepTime} UTC</span>
            </p>
            <p className="text-[10px] text-[#9b9b96] font-mono mt-0.5 truncate">
              {enabledChannels.map((c) => (c === 'twitter' ? 'X' : c === 'google' ? 'Web' : c.charAt(0).toUpperCase() + c.slice(1))).join(', ')} ({lookbackHours}h)
            </p>
          </div>
        ) : (
          <div
            className="mx-2 mt-3 p-2 bg-[#f6f6f4] border border-[#e3e3de] flex flex-col items-center justify-center cursor-default group"
            title={`Sweep Schedule: Next at ${sweepTime} UTC (${sweepCadence === '24h' ? 'Daily' : sweepCadence}) • ${lookbackHours}h lookback`}
          >
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-[9px] font-mono text-[#8a8a86] mt-1">
              {sweepTime.split(':')[0]}h
            </span>
          </div>
        )}

        {/* Nav groups */}
        <div className={`py-4 ${isCollapsed ? 'px-2 space-y-3' : 'px-4 space-y-6'}`}>
          {navItems.map((group) => (
            <div key={group.group} className="space-y-1">
              {!isCollapsed && (
                <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] px-2 block mb-2">
                  {group.group}
                </span>
              )}
              {group.items.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onTabChange(item.id)}
                    title={`${item.label} ${item.count !== undefined ? `(${item.count})` : ''}`}
                    aria-label={item.label}
                    className={`w-full flex items-center transition-colors cursor-pointer relative ${
                      isCollapsed
                        ? `h-10 justify-center rounded-none ${
                            isActive
                              ? 'bg-[#141414] text-white font-medium'
                              : 'text-[#4a4a47] hover:bg-[#f6f6f4] hover:text-[#141414]'
                          }`
                        : `justify-between px-2.5 py-2 text-xs rounded-none ${
                            isActive
                              ? 'bg-[#141414] text-white font-medium'
                              : 'text-[#4a4a47] hover:bg-[#f6f6f4] hover:text-[#141414]'
                          }`
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      {item.icon}
                      {!isCollapsed && <span>{item.label}</span>}
                    </div>

                    {!isCollapsed && item.count !== undefined && (
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                          isActive
                            ? 'bg-white/20 text-white'
                            : 'bg-[#eeeeea] text-[#8a8a86]'
                        }`}
                      >
                        {item.count}
                      </span>
                    )}

                    {isCollapsed && item.count !== undefined && (
                      <span
                        className={`absolute top-1 right-1 text-[8px] font-mono px-1 py-0.2 rounded-full font-bold ${
                          isActive ? 'bg-emerald-500 text-white' : 'bg-[#141414] text-white'
                        }`}
                      >
                        {typeof item.count === 'string' ? item.count.split('/')[0] : item.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Bottom User Account Card & Logout */}
      <div
        className={`border-t border-[#eeeeea] bg-[#fafaf9] ${
          isCollapsed ? 'p-2 flex flex-col items-center gap-2' : 'p-4'
        }`}
      >
        {!isCollapsed ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Avatar with Initials */}
              <div className="w-8 h-8 rounded-full bg-[#141414] text-white flex items-center justify-center text-xs font-mono font-medium flex-shrink-0">
                {getInitials()}
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-[#141414] truncate">
                  {profile?.full_name || 'Founder'}
                </p>
                <p className="text-[10px] text-[#8a8a86] font-mono truncate">
                  {user?.email || 'user@example.com'}
                </p>
              </div>
            </div>

            <button
              onClick={() => signOut()}
              title="Log out"
              className="p-1.5 text-[#8a8a86] hover:text-[#141414] hover:bg-[#eeeeea] rounded-none transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 w-full">
            <div
              className="w-8 h-8 rounded-full bg-[#141414] text-white flex items-center justify-center text-xs font-mono font-medium flex-shrink-0 cursor-default"
              title={`${profile?.full_name || 'Founder'} (${user?.email || ''})`}
            >
              {getInitials()}
            </div>
            <button
              onClick={() => signOut()}
              title="Log out"
              className="p-1.5 text-[#8a8a86] hover:text-[#141414] hover:bg-[#eeeeea] transition-colors cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};
