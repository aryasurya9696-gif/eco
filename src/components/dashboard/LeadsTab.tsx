import React from 'react';
import {
  ListChecks, Plus, Search, ArrowLeft,
  AlertTriangle, Play, Pause, Square, X, Users, Building2, Upload, CalendarClock,
  Settings, Sliders, Users2, Bookmark, ChevronLeft, ChevronRight,
  Filter, Layers, Download, Pencil, Trash2,
} from 'lucide-react';
import type { LeadsView, LeadRow, LeadRun, LeadAttempt } from '../../types';
import type { AttemptWithFailure } from '../leads/AttemptHistory';
import {
  getRun, isActiveRun, controlRun, providerLabel,
} from '../../lib/leads';
import { fetchBalance, formatUsd } from '../../lib/billing';
import { supabase } from '../../lib/supabase';
import { subscribeToRun, mergeRow, summarise } from '../../lib/leads-live';
import { RunsList } from '../leads/RunsList';
import { CleanList } from '../leads/CleanList';
import { NewSearch } from '../leads/NewSearch';
import { ProviderLab } from '../leads/ProviderLab';
import { OptOuts } from '../leads/OptOuts';
import { LeadsTable } from '../leads/LeadsTable';
import { CompositionBar, RunStrip, MeterFigure, ProviderMix } from '../leads/Data';
import { WaterfallColumn } from '../leads/WaterfallChain';
import { Button, Screen, Segmented } from '../leads/Screen';
import { EmptyState } from '../leads/Empty';
import { ExportDialog } from '../leads/ExportDialog';
import { StatusPill } from '../leads/StatusPill';
import { DialogsProvider, useDialogs } from '../leads/Dialogs';
import { SearchView } from '../leads/SearchView';
import { AutomationsView } from '../leads/AutomationsView';
import { PeopleView } from '../leads/PeopleView';
import { CompaniesView, UsageView } from '../leads/CompaniesView';
import { ScoringDialog, DuplicatesDialog } from '../leads/ScoringDialog';
import type { ContactFilters, LeadList, SavedSearch } from '../../lib/leads-db';
import { getLists, createList, updateList, deleteList, getSavedSearches } from '../../lib/leads-db';
import { getWaterfall } from '../../lib/leads';
import type { LeadStep } from '../../types';

/**
 * The Leads tab.
 *
 * Consolidated into 4 unified hubs:
 * - Find:      Search, Find by profile (ICP), Import CSV
 * - Leads:     People & Companies directory with left sidebar for Lists & Saved Searches
 * - Activity:  Runs & live Credit Usage + Automations
 * - Settings:  Fit Scoring, Duplicate Review, Opt-outs, Provider Waterfall Lab
 *
 * Routing and data live here; each screen is a leaf that owns its own fetching.
 */

interface LeadsTabProps {
  view: LeadsView;
  subMode?: string | null;
  runId: string | null;
  onViewChange: (view: LeadsView, subMode?: string | null) => void;
  onOpenRun: (runId: string) => void;
}

export const LeadsTab: React.FC<LeadsTabProps> = ({ view, subMode, runId, onViewChange, onOpenRun }) => {
  const [peopleInit, setPeopleInit] = React.useState<{ key: number; filters: ContactFilters } | null>(null);

  const openPeople = (filters: ContactFilters) => {
    setPeopleInit({ key: Date.now(), filters });
    onViewChange('leads', 'people');
  };

  return (
    <DialogsProvider>
      {view === 'run' ? (
        <RunView
          runId={runId}
          onBack={() => onViewChange('activity', 'runs')}
          onOpenPeople={openPeople}
        />
      ) : (
        <LeadsWorkspace
          view={view}
          subMode={subMode}
          onViewChange={onViewChange}
          onOpenRun={onOpenRun}
          peopleInit={peopleInit}
          setPeopleInit={setPeopleInit}
          openPeople={openPeople}
        />
      )}
    </DialogsProvider>
  );
};

// ---------------------------------------------------------------------------
// Left Sidebar for Lists and Saved Searches in the Leads Hub
// ---------------------------------------------------------------------------

interface LeadsSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  activeListId: string | null;
  onSelectList: (list: LeadList | null) => void;
  onSelectSearch: (search: SavedSearch) => void;
  onAutomateSearch: (search: SavedSearch) => void;
  activeKind: 'people' | 'companies';
  onSwitchKind: (kind: 'people' | 'companies') => void;
}

const LeadsSidebar: React.FC<LeadsSidebarProps> = ({
  collapsed,
  onToggleCollapsed,
  activeListId,
  onSelectList,
  onSelectSearch,
  onAutomateSearch,
  activeKind,
  onSwitchKind,
}) => {
  const dialogs = useDialogs();
  const [lists, setLists] = React.useState<LeadList[]>([]);
  const [searches, setSearches] = React.useState<SavedSearch[]>([]);
  const [loading, setLoading] = React.useState(true);

  const loadData = React.useCallback(async () => {
    try {
      const [lRes, sRes] = await Promise.all([
        getLists().catch(() => null),
        getSavedSearches('people_search').catch(() => null),
      ]);
      if (lRes && lRes.ok) setLists(lRes.lists);
      if (sRes && sRes.ok) setSearches(sRes.searches);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateList = async () => {
    const name = await dialogs.prompt({
      title: 'New List',
      label: 'List name',
      placeholder: activeKind === 'companies' ? 'e.g. Target Accounts Q4' : 'e.g. Enterprise Decision Makers',
      confirmLabel: 'Create list',
    });
    if (!name) return;
    const res = await createList(name, activeKind).catch(() => null);
    if (res && res.ok) {
      await loadData();
      onSelectList(res.list as unknown as LeadList);
    }
  };

  const handleRenameList = async (list: LeadList, e: React.MouseEvent) => {
    e.stopPropagation();
    const newName = await dialogs.prompt({
      title: 'Rename List',
      label: 'List name',
      initial: list.name,
      confirmLabel: 'Save',
    });
    if (!newName || newName === list.name) return;
    const res = await updateList(list.id, { name: newName }).catch(() => null);
    if (res && res.ok) {
      await loadData();
    }
  };

  const handleDeleteList = async (list: LeadList, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await dialogs.confirm({
      title: 'Delete List',
      body: `Delete the list "${list.name}"? Contacts in it are kept in your Leads directory.`,
      confirmLabel: 'Delete list',
      danger: true,
    });
    if (!ok) return;
    const res = await deleteList(list.id).catch(() => null);
    if (res && res.ok) {
      if (activeListId === list.id) {
        onSelectList(null);
      }
      await loadData();
    }
  };

  if (collapsed) {
    return (
      <button
        onClick={onToggleCollapsed}
        className="flex items-center gap-1.5 px-2.5 py-1.5 border border-line bg-white hover:bg-surface text-xs font-mono text-muted hover:text-ink cursor-pointer mb-2 transition-colors"
        title="Show Lists & Saved Views"
      >
        <ChevronRight className="w-3.5 h-3.5" />
        <span>Lists & Views</span>
      </button>
    );
  }

  return (
    <aside className="w-full md:w-60 flex-shrink-0 bg-white border border-line p-3.5 space-y-5 text-xs font-mono select-none">
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <span className="text-[10px] uppercase font-bold tracking-wider text-muted flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5" /> Views & Lists
        </span>
        <button
          onClick={onToggleCollapsed}
          className="text-muted hover:text-ink cursor-pointer p-0.5 rounded"
          title="Collapse sidebar"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Directory Views */}
      <div className="space-y-1">
        <span className="text-[10px] uppercase tracking-wider text-muted block mb-1.5 px-2">
          Directory
        </span>
        <button
          onClick={() => {
            onSelectList(null);
            onSwitchKind('people');
          }}
          className={`w-full flex items-center justify-between px-2 py-1.5 text-left cursor-pointer transition-colors ${
            activeKind === 'people' && !activeListId
              ? 'bg-ink text-white font-medium'
              : 'text-ink hover:bg-surface'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> All People
          </span>
        </button>
        <button
          onClick={() => {
            onSelectList(null);
            onSwitchKind('companies');
          }}
          className={`w-full flex items-center justify-between px-2 py-1.5 text-left cursor-pointer transition-colors ${
            activeKind === 'companies' && !activeListId
              ? 'bg-ink text-white font-medium'
              : 'text-ink hover:bg-surface'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5" /> All Companies
          </span>
        </button>
      </div>

      {/* Lists */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between px-2">
          <span className="text-[10px] uppercase tracking-wider text-muted">Lists</span>
          <button
            onClick={handleCreateList}
            className="text-[10px] text-muted hover:text-ink inline-flex items-center gap-1 cursor-pointer"
            title="Create list"
          >
            <Plus className="w-3 h-3" /> New
          </button>
        </div>

        {loading ? (
          <div className="text-[11px] text-muted px-2 py-1">Loading…</div>
        ) : lists.length === 0 ? (
          <div className="text-[11px] text-muted px-2 py-1">No lists yet</div>
        ) : (
          <div className="space-y-0.5 max-h-48 overflow-y-auto">
            {lists.map((l) => {
              const isSelected = activeListId === l.id;
              return (
                <div
                  key={l.id}
                  onClick={() => {
                    onSelectList(l);
                    onSwitchKind(l.kind === 'companies' ? 'companies' : 'people');
                  }}
                  className={`w-full flex items-center justify-between px-2 py-1 text-left cursor-pointer transition-colors group ${
                    isSelected
                      ? 'bg-ink text-white font-medium'
                      : 'text-ink hover:bg-surface'
                  }`}
                  title={l.name}
                >
                  <span className="truncate flex items-center gap-1.5 flex-1 min-w-0">
                    <span className={`text-[9px] px-1 border flex-shrink-0 ${
                      isSelected ? 'border-white/40 text-white' : 'border-line text-muted'
                    }`}>
                      {l.kind === 'companies' ? 'C' : 'P'}
                    </span>
                    <span className="truncate">{l.name}</span>
                  </span>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-1">
                    {typeof l.members === 'number' && (
                      <span className={`text-[10px] tabular-nums group-hover:hidden ${isSelected ? 'text-white/80' : 'text-muted'}`}>
                        {l.members}
                      </span>
                    )}
                    <button
                      onClick={(e) => void handleRenameList(l, e)}
                      className={`p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-ink transition-opacity ${
                        isSelected ? 'text-white/80 hover:text-white' : 'text-muted'
                      }`}
                      title="Rename list"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => void handleDeleteList(l, e)}
                      className={`p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-danger transition-opacity ${
                        isSelected ? 'text-white/80 hover:text-danger' : 'text-muted'
                      }`}
                      title="Delete list"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Saved Searches */}
      <div className="space-y-1.5 border-t border-line-soft pt-3">
        <span className="text-[10px] uppercase tracking-wider text-muted block px-2">
          Saved Searches
        </span>
        {searches.length === 0 ? (
          <div className="text-[11px] text-muted px-2 py-1">No saved searches</div>
        ) : (
          <div className="space-y-0.5 max-h-40 overflow-y-auto">
            {searches.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between px-2 py-1 hover:bg-surface group"
              >
                <button
                  onClick={() => onSelectSearch(s)}
                  className="truncate text-ink hover:text-ink font-normal text-left cursor-pointer flex items-center gap-1.5 flex-1 min-w-0"
                  title={s.name}
                >
                  <Bookmark className="w-3 h-3 text-muted flex-shrink-0" />
                  <span className="truncate">{s.name}</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAutomateSearch(s);
                  }}
                  className="text-muted hover:text-ink p-1 cursor-pointer opacity-70 group-hover:opacity-100 transition-opacity"
                  title="Create automation schedule"
                >
                  <CalendarClock className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};

// ---------------------------------------------------------------------------
// Mode options for each hub
// ---------------------------------------------------------------------------

const FIND_MODES = [
  { value: 'search', label: 'Search' },
  { value: 'profile', label: 'Find by profile' },
  { value: 'upload', label: 'Import CSV' },
];

const LEADS_MODES = [
  { value: 'people', label: 'People' },
  { value: 'companies', label: 'Companies' },
];

const ACTIVITY_MODES = [
  { value: 'runs', label: 'Runs & Usage' },
  { value: 'automations', label: 'Automations' },
];

const SETTINGS_MODES = [
  { value: 'scoring', label: 'Fit Scoring' },
  { value: 'duplicates', label: 'Duplicate Review' },
  { value: 'optouts', label: 'Opt-outs' },
  { value: 'lab', label: 'Provider Lab' },
];

// ---------------------------------------------------------------------------
// The sub-views workspace
// ---------------------------------------------------------------------------

const LeadsWorkspace: React.FC<{
  view: LeadsView;
  subMode?: string | null;
  onViewChange: (view: LeadsView, subMode?: string | null) => void;
  onOpenRun: (runId: string) => void;
  peopleInit: { key: number; filters: ContactFilters } | null;
  setPeopleInit: React.Dispatch<React.SetStateAction<{ key: number; filters: ContactFilters } | null>>;
  openPeople: (filters: ContactFilters) => void;
}> = ({ view, subMode, onViewChange, onOpenRun, peopleInit, setPeopleInit, openPeople }) => {
  const [companyList, setCompanyList] = React.useState<{ key: number; id: string } | null>(null);
  const [activeList, setActiveList] = React.useState<LeadList | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);

  const activeFindMode = (subMode as 'search' | 'profile' | 'upload') || 'search';
  const activeLeadsMode = (subMode as 'people' | 'companies') || 'people';
  const activeActivityMode = (subMode as 'runs' | 'automations') || 'runs';
  const activeSettingsMode = (subMode as 'scoring' | 'duplicates' | 'optouts' | 'lab') || 'scoring';

  return (
    <div className="space-y-6">
      <SubNav
        view={view}
        onViewChange={(v) => {
          if (v === 'leads') {
            setActiveList(null);
            setPeopleInit(null);
            setCompanyList(null);
          }
          onViewChange(v);
        }}
      />

      {/* 1. FIND HUB */}
      {view === 'find' && (
        <div className="space-y-5">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <Segmented
              options={FIND_MODES}
              value={activeFindMode}
              onChange={(m) => onViewChange('find', m)}
            />
          </div>

          {activeFindMode === 'search' && (
            <Screen
              title="Search people"
              subtitle="Free search by title, seniority, company and location. Save who you find; finding their emails is a separate, priced step."
              icon={<Search className="w-4 h-4" />}
              wide
            >
              <SearchView
                onOpenRun={onOpenRun}
                onOpenPeople={() => openPeople({})}
              />
            </Screen>
          )}

          {activeFindMode === 'profile' && (
            <NewSearch onStarted={onOpenRun} />
          )}

          {activeFindMode === 'upload' && (
            <Screen
              title="Import"
              subtitle="Upload a CSV of people or companies to import for free or verify/enrich with waterfall. Nothing is spent until you start a run."
              icon={<Upload className="w-4 h-4" />}
            >
              <CleanList onOpenRun={onOpenRun} onOpenPeople={() => openPeople({})} />
            </Screen>
          )}
        </div>
      )}

      {/* 2. LEADS HUB */}
      {view === 'leads' && (
        <div className="flex flex-col md:flex-row items-start gap-6">
          <LeadsSidebar
            collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
            activeListId={activeList?.id ?? null}
            onSelectList={(list) => {
              setActiveList(list);
              if (!list) {
                setPeopleInit(null);
                setCompanyList(null);
              } else if (list.kind === 'companies') {
                setCompanyList({ key: Date.now(), id: list.id });
                onViewChange('leads', 'companies');
              } else {
                openPeople({ list_id: list.id });
              }
            }}
            onSelectSearch={(s) => {
              openPeople(s.filters as ContactFilters);
            }}
            onAutomateSearch={(_s) => {
              onViewChange('activity', 'automations');
            }}
            activeKind={activeLeadsMode}
            onSwitchKind={(k) => onViewChange('leads', k)}
          />

          <div className="flex-1 min-w-0 w-full space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
              <div className="flex items-center gap-3">
                <Segmented
                  options={LEADS_MODES}
                  value={activeLeadsMode}
                  onChange={(m) => {
                    setActiveList(null);
                    onViewChange('leads', m);
                  }}
                />
                {activeList && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 bg-surface-2 border border-line">
                    <Filter className="w-3 h-3 text-muted" />
                    <span>List: <strong className="text-ink">{activeList.name}</strong></span>
                    <button
                      onClick={() => {
                        setActiveList(null);
                        setPeopleInit(null);
                        setCompanyList(null);
                      }}
                      className="ml-1 text-muted hover:text-ink cursor-pointer"
                      title="Clear list filter"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                )}
              </div>
            </div>

            {activeLeadsMode === 'people' && (
              <Screen
                title="People"
                subtitle="Every lead you hold, one record per person, merged across searches, runs and imports."
                icon={<Users className="w-4 h-4" />}
                wide
              >
                <PeopleView
                  key={peopleInit?.key ?? (activeList ? `list-${activeList.id}` : 'people')}
                  initialFilters={peopleInit?.filters}
                  onOpenRun={onOpenRun}
                  onOpenSearch={() => onViewChange('find', 'search')}
                />
              </Screen>
            )}

            {activeLeadsMode === 'companies' && (
              <Screen
                title="Companies"
                subtitle="Every company where you hold a lead or keep a target account, with what is missing there."
                icon={<Building2 className="w-4 h-4" />}
                wide
              >
                <CompaniesView
                  key={companyList?.key ?? (activeList ? `company-list-${activeList.id}` : 'companies')}
                  initialListId={companyList?.id}
                  onOpenRun={onOpenRun}
                  onOpenPeople={(f) => openPeople(f)}
                  onOpenSearch={() => onViewChange('find', 'search')}
                />
              </Screen>
            )}
          </div>
        </div>
      )}

      {/* 3. ACTIVITY HUB */}
      {view === 'activity' && (
        <div className="space-y-5">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <Segmented
              options={ACTIVITY_MODES}
              value={activeActivityMode}
              onChange={(m) => onViewChange('activity', m)}
            />
          </div>

          {activeActivityMode === 'runs' && (
            <RunsList
              headerSlot={
                <div className="mb-6">
                  <UsageView cardsOnly={true} onOpenRun={onOpenRun} />
                </div>
              }
              onOpenRun={onOpenRun}
              onNewSearch={() => onViewChange('find', 'profile')}
            />
          )}

          {activeActivityMode === 'automations' && (
            <Screen
              title="Automations"
              subtitle="Scheduled searches, enrichment and tagging, in UTC. Anything priced only starts if the most it could cost fits the automation's caps."
              icon={<CalendarClock className="w-4 h-4" />}
              wide
            >
              <AutomationsView onOpenRun={onOpenRun} />
            </Screen>
          )}
        </div>
      )}

      {/* 4. SETTINGS HUB */}
      {view === 'settings' && (
        <div className="space-y-5">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <Segmented
              options={SETTINGS_MODES}
              value={activeSettingsMode}
              onChange={(m) => onViewChange('settings', m)}
            />
          </div>

          {activeSettingsMode === 'scoring' && (
            <Screen
              title="Fit Scoring"
              subtitle="The workspace's fit rules: what counts, and how much. Saved rules rescore every lead."
              icon={<Sliders className="w-4 h-4" />}
              wide
            >
              <ScoringDialog inline />
            </Screen>
          )}

          {activeSettingsMode === 'duplicates' && (
            <Screen
              title="Duplicate Review"
              subtitle="Groups of records that look like the same person, and a merge that keeps the record you pick."
              icon={<Users2 className="w-4 h-4" />}
              wide
            >
              <DuplicatesDialog inline />
            </Screen>
          )}

          {activeSettingsMode === 'optouts' && <OptOuts />}

          {activeSettingsMode === 'lab' && <ProviderLab />}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sub-nav for the 4 Unified Hubs
// ---------------------------------------------------------------------------

const SUB_NAV: Array<{ view: LeadsView; label: string; icon: React.ReactNode }> = [
  { view: 'find', label: 'Find', icon: <Search className="w-3.5 h-3.5" /> },
  { view: 'leads', label: 'Leads', icon: <Users className="w-3.5 h-3.5" /> },
  { view: 'activity', label: 'Activity', icon: <ListChecks className="w-3.5 h-3.5" /> },
  { view: 'settings', label: 'Settings', icon: <Settings className="w-3.5 h-3.5" /> },
];

const SubNav: React.FC<{ view: LeadsView; onViewChange: (v: LeadsView) => void }> = ({
  view,
  onViewChange,
}) => (
  <nav className="flex items-center gap-1 border-b border-line -mt-2 overflow-x-auto" aria-label="Leads sections">
    {SUB_NAV.map((item) => {
      const active = view === item.view;
      return (
        <button
          key={item.view}
          aria-current={active ? 'page' : undefined}
          onClick={() => onViewChange(item.view)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono transition-colors cursor-pointer border-b-2 -mb-px ${
            active
              ? 'border-ink text-ink font-medium'
              : 'border-transparent text-muted hover:text-ink'
          }`}
        >
          {item.icon}
          {item.label}
        </button>
      );
    })}
  </nav>
);

// ---------------------------------------------------------------------------
// One run — the table, live
// ---------------------------------------------------------------------------

const RunView: React.FC<{
  runId: string | null;
  onBack: () => void;
  onOpenPeople?: (filters: ContactFilters) => void;
}> = ({
  runId,
  onBack,
  onOpenPeople,
}) => {
  const [showExport, setShowExport] = React.useState(false);
  const [run, setRun] = React.useState<LeadRun | null>(null);
  const [rows, setRows] = React.useState<LeadRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [live, setLive] = React.useState(false);

  // The real wallet balance. It used to be a hardcoded 1000, so the meter beside
  // it was drawing a picture of nobody's account — a balance figure that is
  // confidently wrong is worse than no balance figure, because it is the one
  // number somebody checks before starting a run.
  const [balance, setBalance] = React.useState<number | null>(null);
  const [reserved, setReserved] = React.useState<number | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // The eight rows that cost the most to resolve, with their attempt history.
  //
  // Eight and not fifty: this panel makes one extra query per row, and a panel
  // that fetches fifty is a panel nobody opens twice. Eight is enough for the
  // shape to read and cheap enough to fetch on every load.
  const [expensive, setExpensive] = React.useState<Array<{ id: string; attempts: LeadAttempt[] }>>([]);
  // Every attempt made on the rows currently on the page, by row.
  //
  // One query for the page rather than the per-row fetch below, because the same
  // data answers two questions: which providers earned a row, and what each of
  // those providers was paid. Both are things the run detail view cannot state
  // without it.
  const [attemptsByRow, setAttemptsByRow] = React.useState<Map<string, LeadAttempt[]>>(new Map());
  // The order each step's providers run in, so an untried provider is drawn as a
  // rung rather than omitted.
  //
  // This is the thing the chain diagram was always supposed to do and never
  // could: "tried Kitt, then ContactOut, then gave up" is only believable if
  // there was a plan to be honest to, and without the plan the diagram shows
  // three providers when five ran and two were never reached. Six steps' worth is
  // one fetch of six small calls, and it only happens when the panel is on screen.
  const [stepOrders, setStepOrders] = React.useState<Partial<Record<LeadStep, string[]>>>({});

  const fetchPage = React.useCallback(async (id: string) => {
    const res = await getRun(id, { limit: 500, offset: 0 });
    if (!res.ok) throw new Error(res.error);
    return { rows: res.rows, total: res.total };
  }, []);

  // Initial page. Then the subscription owns the updates.
  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    getRun(runId, { limit: 500, offset: 0 })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error);
          setLoading(false);
          return;
        }
        setRun(res.run);
        setRows(res.rows);
        setTotal(res.total);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error)?.message ?? 'Could not load the run.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Live updates, with polling underneath until the socket proves itself.
  React.useEffect(() => {
    if (!runId || !supabase) return;

    const dispose = subscribeToRun(supabase, runId, fetchPage, {
      onPage: (pageRows, pageTotal) => {
        setRows(pageRows);
        setTotal(pageTotal);
        setLoading(false);
      },
      onRow: (row) => setRows((prev) => mergeRow(prev, row)),
      onRun: (next) => setRun(next),
      onLiveChange: setLive,
    });

    return dispose;
  }, [runId, fetchPage, supabase]);

  // Attempts for whatever is on the page. Refetched when the row ids change,
  // which is once per page rather than once per row - the alternative was eight
  // round trips to build one bar.
  const pageKey = React.useMemo(() => rows.map((r) => r.id).join(','), [rows]);

  React.useEffect(() => {
    if (!supabase || !rows.length) {
      setAttemptsByRow(new Map());
      return;
    }

    let cancelled = false;
    const ids = pageKey ? pageKey.split(',') : [];

    void (async () => {
      const { data } = await supabase
        .from('lead_attempts')
        .select('row_id, endpoint_id, step, hit, cost_usd, created_at')
        .in('row_id', ids)
        .order('created_at', { ascending: true });

      if (cancelled) return;

      const byRow = new Map<string, LeadAttempt[]>();
      for (const a of (data ?? []) as LeadAttempt[]) {
        if (!a.row_id) continue;
        const list = byRow.get(a.row_id);
        if (list) list.push(a);
        else byRow.set(a.row_id, [a]);
      }
      setAttemptsByRow(byRow);
    })();

    return () => {
      cancelled = true;
    };
  }, [pageKey, rows.length, supabase]);

  const stats = React.useMemo(() => summarise(rows), [rows]);

  // Status counts for the composition bar, straight off the rows on screen rather
  // than off the run's denormalised counters. During a run the row list is the
  // thing being looked at, and the counters are written a chunk at a time, so the
  // two disagree for minutes at a time and the bar would lag the table beside it.
  // What the providers actually charged, across the rows on screen. Shown beside
  // the credits because a per-result waterfall's whole claim is that the charge is
  // the measured provider cost at a mark-up, and a mark-up nobody can see is one
  // they have to take on trust.
  const providerUsd = React.useMemo(
    () => rows.reduce((n, r) => n + (r.treg_cost_usd ?? 0), 0),
    [rows],
  );

  const statusCounts = React.useMemo(() => {
    const out: Record<string, number> = {
      verified: 0, catch_all: 0, invalid: 0, unknown: 0, not_found: 0,
    };
    for (const r of rows) out[r.email_status] = (out[r.email_status] ?? 0) + 1;
    return out;
  }, [rows]);

  // Who actually supplied each address, in waterfall order rather than by size,
  // so a provider moving in the bar is visibly moving.
  //
  // Built from lead_attempts rather than from the row's email_provider. That
  // column is written by exactly one step, so before this the panel counted the
  // address providers and nothing else - and on a find run the decision-maker
  // step is 28% of what the row costs, entirely absent from a bar captioned "a
  // provider high on this bar is earning its place in the waterfall". It also
  // credited the whole row's provider cost to whichever step found the address,
  // which puts a person lookup's money on the email provider's bar.
  //
  // First hit per row is what counts, for the same reason it is what the lab
  // counts on: a provider that repeated what another one had already found did
  // not earn that row.
  const mix = React.useMemo(() => {
    const credited = new Set<string>();
    const found = new Map<string, { found: number; costUsd: number }>();

    for (const r of rows) {
      for (const a of attemptsByRow.get(r.id) ?? []) {
        if (!a.hit) continue;
        if (credited.has(a.row_id + '|' + a.endpoint_id)) continue;
        credited.add(a.row_id + '|' + a.endpoint_id);
        const cur = found.get(a.endpoint_id) ?? { found: 0, costUsd: 0 };
        cur.found++;
        cur.costUsd += a.cost_usd ?? 0;
        found.set(a.endpoint_id, cur);
      }
    }

    // Every step's providers can appear, in no fixed order, ranked by what they
    // earned. An ordered list keyed on the email default would leave the
    // decision-maker providers off the end of it.
    return [...found.entries()]
      .map(([endpointId, v]) => ({
        endpointId,
        label: providerLabel(endpointId),
        found: v.found,
        costUsd: v.costUsd,
      }))
      .sort((a, b) => b.found - a.found || b.costUsd - a.costUsd);
  }, [rows, attemptsByRow]);

  // Fetched once. Polling the wallet every three seconds alongside the run would
  // be a second realtime channel for a number that changes only when the run
  // spends something, and the run's own figures already show that.
  React.useEffect(() => {
    let cancelled = false;
    fetchBalance()
      .then((b) => {
        if (cancelled) return;
        setBalance(b?.wallet?.available ?? null);
        // What is held right now is one chunk's worst case, not the run's ceiling.
        // Conflating the two is precisely what makes a balance look wrong to
        // somebody reading it: the ceiling is checked once, at the start.
        setReserved(b?.wallet?.reserved ?? 0);
      })
      .catch(() => {
        // Left null, which renders a dash. The meter is drawn against the run's
        // ceiling and does not need the balance to be meaningful.
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Skipped while loading and until there are rows, because the ranking is
  // only meaningful once something has been worked — a run at 3 rows would
  // otherwise render a "where the money went" panel from two attempts and
  // present it as a finding.
  React.useEffect(() => {
    if (!runId || loading || !supabase) {
      if (!rows.length) setExpensive([]);
      return;
    }

    let cancelled = false;

    const ranked = [...rows]
      .filter((r) => r.email || r.credits)
      .sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0))
      .slice(0, 8);

    if (ranked.length === 0) {
      setExpensive([]);
      return;
    }

    void (async () => {
      const out: Array<{ id: string; attempts: LeadAttempt[] }> = [];
      for (const r of ranked) {
        if (cancelled) return;
        const { data } = await supabase
          .from('lead_attempts')
          .select('*')
          .eq('row_id', r.id)
          .order('created_at', { ascending: true });
        out.push({ id: r.id, attempts: (data ?? []) as LeadAttempt[] });
      }
      if (!cancelled) setExpensive(out);
    })();

    // The chains the rows will be drawn against. Fetched here rather than passed
    // in because they belong to the run detail view, not to a component that
    // might be mounted for a clean run where two of the six steps are never used.
    void (async () => {
      const steps: LeadStep[] = ['company', 'person', 'email', 'verify', 'phone', 'enrich'];
      const settled = await Promise.all(steps.map((s) => getWaterfall(s)));
      if (cancelled) return;
      const orders: Partial<Record<LeadStep, string[]>> = {};
      settled.forEach((w, i) => {
        if (w.effectiveOrder.length) orders[steps[i]] = w.effectiveOrder;
      });
      setStepOrders(orders);
    })();

    return () => {
      cancelled = true;
    };
  }, [runId, rows, loading, supabase]);

  const doControl = async (action: 'pause' | 'resume' | 'cancel') => {
    try {
      await controlRun(runId!, action);
      const res = await getRun(runId!, { limit: 500, offset: 0 });
      if (res.ok) setRun(res.run);
    } catch {
      setNotice('That did not work. Try again in a moment.');
    }
  };

  // Attempt history is fetched per expanded row rather than with the page.
  // One query, because the foreign key now exists.
//
// Before it did not — api_usage_id was uuid and api_usage.id is bigint, so the two
// could never reference each other — and every attempt had it null. That is why a
// refused call could not be shown: there was no row to carry its status, and no
// way to have found one. Two columns in api_usage exist for exactly this and
// neither was reachable from a lead.
const attemptsFor = React.useCallback(async (rowId: string): Promise<AttemptWithFailure[]> => {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('lead_attempts')
    .select('*, api_usage:api_usage_id(http_status, error_code)')
    .eq('row_id', rowId)
    .order('created_at', { ascending: true });

  if (error) {
    // Left to the caller's empty placeholder. A row that cannot show its history
    // says so; it does not claim to have none.
    console.warn('leads: attempt history unavailable', error.message);
    return [];
  }

  return ((data ?? []) as Array<AttemptWithFailure & { api_usage: { http_status: number | null; error_code: string | null } | null }>).map(
    (a) => ({
      ...a,
      // PostgREST returns the embed as an object or as null depending on whether
      // the FK was set. Both shapes have to flatten to the same thing, or half
      // the rows would show an error and half would not — which is worse than
      // showing neither.
      http_status: a.api_usage?.http_status ?? null,
      error_code: a.api_usage?.error_code ?? null,
      api_usage: undefined,
    }),
  );
}, []);

  if (!runId) {
    return <EmptyState title="No run selected" body="Pick a run from the list." />;
  }

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink onBack={onBack} />
        <div className="bg-white border border-line px-8 py-10">
          <p className="text-xs font-mono text-danger">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-5">
      <BackLink onBack={onBack} />

      {/* ---- Title ------------------------------------------------------- */}
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-lg font-medium text-ink truncate">
            {run?.name || (run?.target ? `${run.target} leads` : 'Run')}
          </h1>
          <p className="text-xs text-muted font-mono mt-1">
            {total.toLocaleString()} {total === 1 ? 'row' : 'rows'}
            {run?.target ? ` of ${run.target.toLocaleString()}` : ''}
            {run?.started_at ? ` · started ${ago(run.started_at)}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap flex-shrink-0">
          {onOpenPeople && runId && (
            <Button onClick={() => onOpenPeople({ run_id: runId })}>
              <Users className="w-3.5 h-3.5" />
              View in Leads Directory ({total.toLocaleString()})
            </Button>
          )}

          {/* Shown because a table that stopped updating with no indication is
              indistinguishable from a run that stopped. */}
          <StatusPill
            tone={live ? 'ok' : 'outline'}
            dot={live ? 'pulse' : undefined}
            title={live ? 'Updating over a live connection' : 'Updating every few seconds'}
          >
            {live ? 'live' : 'polling'}
          </StatusPill>

          {run && <RunStrip status={run.status} pauseReason={run.pause_reason} />}

          <Button variant="secondary" onClick={() => setShowExport(true)} disabled={total === 0}>
            <Download className="w-3.5 h-3.5" />
            Export
          </Button>
        </div>
      </div>

      {/* ---- Pause ------------------------------------------------------- */}
      {run?.status === 'paused' && run.pause_reason && (
        <div className="flex items-start gap-2 px-4 py-3 bg-warn-bg border border-warn-line">
          <AlertTriangle className="w-3.5 h-3.5 text-warn mt-0.5 flex-shrink-0" />
          <p className="text-xs font-mono text-warn leading-relaxed">
            {run.pause_reason === 'credits'
              ? 'Out of credits for the worst case of this run. Top up and it will pick up where it stopped.'
              : run.pause_reason === 'provider_balance'
                ? 'The data provider is out of credit, so no lookups can run until it is topped up.'
                : run.pause_reason === 'importing'
                  ? 'Waiting for the rows to finish uploading. If the upload was interrupted, Resume works the rows that arrived.'
                  : run.pause_reason.replace(/_/g, ' ')}
          </p>
        </div>
      )}

      {/* ---- What it produced, and what it cost -------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-5">
        <div className="border border-line bg-white p-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-3">
            What it produced
          </span>
          <CompositionBar
            counts={statusCounts}
            notFound={statusCounts.not_found ?? 0}
            height={10}
          />
        </div>

        <div className="border border-line bg-white p-5 flex flex-col">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-3">
            What it cost
          </span>

          <div className="flex gap-8">
            <MeterFigure
              label="Spent"
              value={stats.credits}
              display={`${round2(stats.credits)} cr`}
              of={run?.max_credits ?? null}
              tone={run?.max_credits && stats.credits > run.max_credits ? 'warn' : 'default'}
              sub={providerUsd > 0 ? `${formatUsd(providerUsd, { decimals: 4 })} at providers` : undefined}
            />

            <MeterFigure
              label="Held now"
              value={reserved ?? 0}
              display={reserved === null ? '—' : `${round2(reserved)} cr`}
              tone={reserved !== null && reserved > 0 ? 'warn' : 'default'}
              sub="released as each batch finishes"
            />

            <MeterFigure
              label="Balance"
              value={balance ?? 0}
              display={balance === null ? '—' : `${Math.round(balance)} cr`}
              of={run?.max_credits ?? null}
              tone={
                balance !== null && run?.max_credits && balance < run.max_credits
                  ? 'warn'
                  : 'default'
              }
              sub={
                balance === null
                  ? 'not loaded'
                  : run?.max_credits
                    ? balance < run.max_credits
                      ? 'less than this run may still need'
                      : 'covers the worst case'
                    : undefined
              }
            />
          </div>

          {/* The sentence.
              We have reserved the worst case and settled down since the first
              migration and this screen has never said so. A user who watches
              credits leave their balance and is never told what happens next has
              every reason to think the worst, and this is the line that prevents
              it. It is the cheapest and most load-bearing sentence in the app. */}
          <p className="text-[10px] font-mono text-muted leading-relaxed mt-5 pt-3 border-t border-line-soft">
            {run?.max_credits
              ? `This run can cost at most ${round2(run.max_credits)} credits, and that figure is what was checked against your balance before it started. ` +
                `Each batch holds only what it might spend and returns the rest as it finishes, so the balance moves in steps rather than dropping all at once.`
              : 'Each batch holds only what it might spend and returns the rest as it finishes.'}
          </p>
        </div>
      </div>

      {notice && (
        <div className="flex items-start gap-2 px-4 py-2.5 bg-surface border border-line">
          <span className="text-xs font-mono text-ink-2 leading-relaxed">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="ml-auto text-muted hover:text-ink cursor-pointer flex-shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ---- Who actually did the work ----------------------------------- */}
      {mix.length > 0 && (
        <div className="border border-line bg-white p-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-1">
            Who found them
          </span>
          <p className="text-[11px] font-mono text-faint mb-4 leading-relaxed">
            Of the rows on this page. A provider high on this bar is earning its place in the
            waterfall; one at the end is costing money on every call it is asked about.
          </p>
          <ProviderMix mix={mix} />
        </div>
      )}

      {/* ---- Where the money went --------------------------------------- */}
      {expensive.some((e) => e.attempts.length > 1) && (
        <div className="border border-line bg-white p-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-1">
            Where the money went
          </span>
          <p className="text-[11px] font-mono text-faint mb-4 leading-relaxed">
            The rows that took the most providers to resolve. One dot lit cost the price of one
            lookup; four dots with the last one filled cost four.
          </p>
          <WaterfallColumn rows={expensive} fullOrders={stepOrders} limit={8} />
        </div>
      )}

      {/* ---- Controls ---------------------------------------------------- */}
      {run && isActiveRun(run.status) && (
        <div className="flex items-center gap-2">
          {run.status === 'paused' ? (
            <Button variant="secondary" onClick={() => void doControl('resume')}>
              <Play className="w-3 h-3" />
              Resume
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void doControl('pause')}>
              <Pause className="w-3 h-3" />
              Pause
            </Button>
          )}
          <Button variant="secondary" onClick={() => void doControl('cancel')}>
            <Square className="w-3 h-3" />
            Cancel run
          </Button>
          <span className="text-[10px] font-mono text-muted ml-1">
            Cancelling keeps every row it already found.
          </span>
        </div>
      )}

      <LeadsTable
        rows={rows}
        total={total}
        loading={loading}
        attemptsFor={attemptsFor}
      />

      {showExport && runId && (
        <ExportDialog
          runId={runId}
          totalMatching={total}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
};

const round2 = (n: number) => Math.round((n ?? 0) * 100) / 100;

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const BackLink: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <button
    onClick={onBack}
    className="inline-flex items-center gap-1.5 text-xs font-mono text-muted hover:text-ink transition-colors cursor-pointer"
  >
    <ArrowLeft className="w-3 h-3" />
    Runs
  </button>
);

