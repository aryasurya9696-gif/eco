import React from 'react';
import {
  Search,
  ListChecks,
  FlaskConical,
  ShieldOff,
  Plus,
} from 'lucide-react';
import type { LeadsView } from '../../types';

interface SubNavItem {
  view: LeadsView;
  label: string;
  icon: React.ReactNode;
}

const SUB_NAV: SubNavItem[] = [
  { view: 'runs', label: 'Runs', icon: <ListChecks className="w-3.5 h-3.5" /> },
  { view: 'new', label: 'New search', icon: <Plus className="w-3.5 h-3.5" /> },
  { view: 'clean', label: 'Clean a list', icon: <Search className="w-3.5 h-3.5" /> },
  { view: 'lab', label: 'Provider lab', icon: <FlaskConical className="w-3.5 h-3.5" /> },
  { view: 'optouts', label: 'Opt-outs', icon: <ShieldOff className="w-3.5 h-3.5" /> },
];

interface LeadsTabProps {
  view: LeadsView;
  runId: string | null;
  onViewChange: (view: LeadsView) => void;
}

export const LeadsTab: React.FC<LeadsTabProps> = ({ view, runId, onViewChange }) => {
  // A run is a detail screen, so it hides the sub-nav: the way back is Runs, and
  // leaving a row of five panels above a table that belongs to none of them only
  // invites the wrong click.
  if (view === 'run') {
    return <RunPlaceholder runId={runId} onBack={() => onViewChange('runs')} />;
  }

  return (
    <div className="space-y-6">
      <SubNav view={view} onViewChange={onViewChange} />
      {view === 'runs' && <RunsView onNewSearch={() => onViewChange('new')} />}
      {view === 'new' && <NewSearchView />}
      {view === 'clean' && <EmptyPanel
        title="Clean a list"
        body="Import a CSV of people or companies and Echo will verify the addresses it already has, and find the ones it does not. The price is shown before anything runs."
      />}
      {view === 'lab' && <EmptyPanel
        title="Provider lab"
        body="Run the same leads through each email provider alone, and through the waterfall, and see which actually finds the most for what it costs. Uses your own rows, so the numbers are yours."
      />}
      {view === 'optouts' && <EmptyPanel
        title="Opt-outs"
        body="People and domains you never want contacted. Echo checks this list before every paid call, so a suppressed address is never even looked up."
      />}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sub-nav
// ---------------------------------------------------------------------------

const SubNav: React.FC<{
  view: LeadsView;
  onViewChange: (view: LeadsView) => void;
}> = ({ view, onViewChange }) => (
  <div className="flex items-center gap-1 border-b border-[#e3e3de] -mt-2">
    {SUB_NAV.map((item) => {
      const isActive = view === item.view;
      return (
        <button
          key={item.view}
          onClick={() => onViewChange(item.view)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono transition-colors cursor-pointer border-b-2 -mb-px ${
            isActive
              ? 'border-[#141414] text-[#141414] font-medium'
              : 'border-transparent text-[#8a8a86] hover:text-[#141414]'
          }`}
        >
          {item.icon}
          {item.label}
        </button>
      );
    })}
  </div>
);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const RunsView: React.FC<{ onNewSearch: () => void }> = ({ onNewSearch }) => (
  <EmptyState
    title="No runs yet"
    body="Describe who buys from you and Echo finds them."
    action={{ label: 'New search', onClick: onNewSearch }}
  />
);

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------
// Phase 1 is the shell: the tab, the sub-nav, the routing and the states. These
// stand in for the panels that later phases fill in, so the routing and the empty
// states can be clicked and refreshed before anything behind them exists.

const NewSearchView: React.FC = () => (
  <EmptyPanel
    title="New search"
    body="Your website and what you sell are already on file, so this starts from your profile: Echo reads the site, writes an ideal customer profile from it, and shows you a free count of the companies that match before you spend anything."
  />
);

const RunPlaceholder: React.FC<{ runId: string | null; onBack: () => void }> = ({
  runId,
  onBack,
}) => (
  <div className="space-y-4">
    <button
      onClick={onBack}
      className="text-xs font-mono text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer"
    >
      ← Runs
    </button>
    <EmptyPanel
      title="Run detail"
      body={
        runId
          ? `The run table for ${runId.slice(0, 8)} fills in here, provider by provider, as the workers find each person.`
          : 'No run selected.'
      }
    />
  </div>
);

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * The first-run empty state.
 *
 * One line of copy and one action, per the design language: the user either has
 * runs or does not, and there is nothing to choose between. The button is the
 * whole call to action, so it is not wrapped in a card or given a subtitle.
 */
export const EmptyState: React.FC<{
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}> = ({ title, body, action }) => (
  <div className="bg-white border border-[#e3e3de] px-8 py-16 flex flex-col items-center text-center">
    <h3 className="text-sm font-bold tracking-tight text-[#141414]">{title}</h3>
    <p className="text-xs font-mono text-[#8a8a86] mt-2 max-w-md leading-relaxed">{body}</p>
    {action && (
      <button
        onClick={action.onClick}
        className="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-[#141414] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer"
      >
        {action.label}
      </button>
    )}
  </div>
);

/** A titled panel for a sub-view that is routed but not built yet. */
const EmptyPanel: React.FC<{ title: string; body: string }> = ({ title, body }) => (
  <div className="bg-white border border-[#e3e3de] px-8 py-12">
    <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block mb-3">
      {title}
    </span>
    <p className="text-xs font-mono text-[#4a4a47] leading-relaxed max-w-2xl">{body}</p>
  </div>
);
