import React, { useEffect, useState } from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { SearchBar } from './SearchBar';
import { ResultsPanel } from './ResultsPanel';
import type { EnrichmentRun } from './leads-store';
import { loadRecentSearches, saveRecentSearch } from './recent-searches';
import { EXAMPLE_SEARCHES, parseLeadQueryLocally } from '../../lib/lead-suggestions';
import {
  formToParams,
  paramsToForm,
  hasCriteria,
  sameCriteria,
  searchCost,
  searchFeeText,
  domainCountOf,
  maxContactCost,
  type SearchForm,
  type LeadPricing,
  type LastSearch,
  type ProspectorSearchParams,
  type SearchStatus,
} from './prospector-types';
import { AlertCircle, RefreshCw, Search, Sparkles, Bookmark, ArrowRight } from 'lucide-react';
import { WELCOME_ONLY_MESSAGE } from '../../lib/wallet-store';
import { prospectorPrefill, usePendingProspectorDomain } from './prospector-prefill';
import { creditsLabel, formatCredits } from '../../lib/billing';

export type { ProspectorSearchParams, LastSearch, SearchStatus } from './prospector-types';

interface ProspectorViewProps {
  userId: string | null;
  pricing: LeadPricing;
  onSearch: (params: ProspectorSearchParams) => Promise<void>;
  onRevealEmail?: (lead: B2BLead) => Promise<unknown>;
  onRevealPhone?: (lead: B2BLead) => Promise<unknown>;
  /** Queues email and/or phone lookups; returns how many leads were added. */
  onEnrichContacts: (leads: B2BLead[], opts: { email: boolean; phone: boolean }) => number;
  onStopEnrichment: () => void;
  enrichment: EnrichmentRun | null;
  onBulkSave: (leads: B2BLead[]) => Promise<any>;
  onSaveLead: (lead: B2BLead) => Promise<any>;
  onStatusChange: (lead: B2BLead, status: B2BPipelineStatus) => Promise<boolean | void>;
  leads: B2BLead[];
  searchStatus: SearchStatus;
  lastSearch: LastSearch | null;
  isBulkRevealing?: boolean;
  revealingEmailIds: ReadonlySet<string>;
  revealingPhoneIds: ReadonlySet<string>;
  /** null when the wallet could not be loaded. */
  availableCredits: number | null;
  onNavigateBilling?: () => void;
}

/**
 * The Prospector: one search bar, results directly underneath. The form used
 * to be four step cards that had to be filled before anything appeared; now
 * a role and Enter are enough, and every other filter is an optional chip.
 */
export const ProspectorView: React.FC<ProspectorViewProps> = (props) => {
  const { userId, pricing, onSearch, leads, searchStatus, lastSearch, availableCredits, onNavigateBilling } = props;

  // Starts from the last search, so coming back to the tab (or refreshing)
  // shows the filters that produced the results below.
  const [form, setForm] = useState<SearchForm>(() => paramsToForm(lastSearch?.params));
  const [recent, setRecent] = useState<ProspectorSearchParams[]>(() => loadRecentSearches(userId));
  const [dismissedError, setDismissedError] = useState<SearchStatus | null>(null);

  // "Find people at this company" from a company profile: a fresh form with
  // just that domain. The search waits for the user's click.
  const pendingDomain = usePendingProspectorDomain();
  const [appliedDomain, setAppliedDomain] = useState<string | null>(null);
  if (pendingDomain && pendingDomain !== appliedDomain) {
    setAppliedDomain(pendingDomain);
    setForm({ ...paramsToForm(null), companyDomain: pendingDomain });
  } else if (!pendingDomain && appliedDomain) {
    setAppliedDomain(null);
  }
  useEffect(() => {
    if (pendingDomain) prospectorPrefill.take();
  }, [pendingDomain]);

  const isSearching = searchStatus.kind === 'searching';
  const params = formToParams(form);
  const changed = Boolean(lastSearch && hasCriteria(form) && !sameCriteria(params, lastSearch.params));
  const cost = searchCost(params.limit, pricing, domainCountOf(params.companyDomain)) + maxContactCost(params, pricing);
  const errorVisible = searchStatus.kind === 'error' && dismissedError !== searchStatus;
  const showResults = leads.length > 0 || Boolean(lastSearch) || isSearching;

  const run = (p: ProspectorSearchParams) => {
    if (isSearching) return;
    setDismissedError(null);
    setRecent(saveRecentSearch(userId, p));
    void onSearch(p);
  };

  const walletEmpty = availableCredits !== null && availableCredits < Math.max(1, pricing.searchCredits);
  const searchFee = searchFeeText(pricing);
  const notice: React.ComponentProps<typeof SearchBar>['notice'] = walletEmpty
    ? {
        tone: 'warn',
        text: `You need bought credits to search: ${searchFee}, then ${creditsLabel(pricing.email)} per verified email and ${formatCredits(pricing.phone)} per phone found. Free welcome credits don't cover leads.`,
      }
    : !hasCriteria(form)
      ? { tone: 'info', text: 'Type a job title to start — keywords, company and country are optional.' }
      : availableCredits !== null && cost > availableCredits
        ? {
            tone: 'info',
            text: `Up to ${creditsLabel(cost)} (search: ${searchFee}, plus every lead verified); you have ${formatCredits(availableCredits)}. Lookups stop when your balance runs out.`,
          }
        : changed && !isSearching
        ? { tone: 'info', text: 'Filters changed — press Search to update the results below.' }
        : null;

  return (
    <div className="space-y-4">
      <SearchBar
        form={form}
        onChange={setForm}
        onSubmit={() => run(params)}
        isSearching={isSearching}
        pricing={pricing}
        availableCredits={availableCredits}
        recent={showResults ? [] : recent}
        onPickRecent={(p) => {
          setForm(paramsToForm(p));
          // Fills the filters; the search itself is a click on Find leads so
          // the cost shown on the button is seen before anything is spent.
        }}
        notice={notice}
        onNavigateBilling={onNavigateBilling}
      />

      {errorVisible && searchStatus.kind === 'error' && (
        <div role="alert" className="bg-danger-bg border border-danger-line px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2 text-sm text-danger-ink min-w-0">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium">Search did not run</p>
              <p className="text-[13px] break-words">
                {searchStatus.message}
                {leads.length > 0 && ' Your previous results are still shown below.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {searchStatus.message === WELCOME_ONLY_MESSAGE && onNavigateBilling && (
              <button
                type="button"
                onClick={onNavigateBilling}
                className="h-9 px-3 bg-ink hover:bg-black text-white text-sm font-medium cursor-pointer"
              >
                Go to Billing
              </button>
            )}
            {typeof searchStatus.affordableLimit === 'number' && searchStatus.affordableLimit >= 5 && (
              <button
                type="button"
                onClick={() => {
                  const p = { ...searchStatus.params, limit: searchStatus.affordableLimit! };
                  setForm(paramsToForm(p));
                  run(p);
                }}
                className="h-9 px-3 bg-ink hover:bg-black text-white text-sm font-medium cursor-pointer"
              >
                Search {searchStatus.affordableLimit} leads
                {searchCost(searchStatus.affordableLimit, pricing, domainCountOf(searchStatus.params.companyDomain)) === 0 ? ' free' : ''} instead
              </button>
            )}
            <button
              type="button"
              onClick={() => run(searchStatus.params)}
              className="h-9 px-3 bg-danger-strong hover:bg-danger text-white text-sm font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" aria-hidden />
              Retry
            </button>
            <button
              type="button"
              onClick={() => setDismissedError(searchStatus)}
              className="h-9 px-3 text-sm text-danger-ink hover:bg-white/60 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {showResults ? (
        <ResultsPanel {...props} />
      ) : (
        !errorVisible && <EmptyState pricing={pricing} onExample={(text) => setForm({ ...form, ...toForm(text) })} />
      )}
    </div>
  );
};

function toForm(text: string): Partial<SearchForm> {
  const f = parseLeadQueryLocally(text);
  return { title: f.title, keywords: f.keywords, country: f.country, location: f.location, companyDomain: f.company };
}

const EmptyState: React.FC<{ pricing: LeadPricing; onExample: (text: string) => void }> = ({ pricing, onExample }) => (
  <section className="bg-white border border-line" aria-labelledby="leads-empty-title">
    <div className="px-5 sm:px-8 pt-8 pb-6">
      <h3 id="leads-empty-title" className="text-base font-semibold text-ink">Start with an example</h3>
      <p className="mt-1 text-sm text-ink-2">Pick one to fill the search bar, then press Search. Nothing runs until you do.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {EXAMPLE_SEARCHES.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onExample(text)}
            className="group h-10 px-3.5 inline-flex items-center gap-2 bg-surface-2 border border-line hover:border-ink hover:bg-white text-sm text-ink-2 hover:text-ink cursor-pointer transition-colors"
          >
            <Search className="w-4 h-4 text-muted group-hover:text-ink" aria-hidden />
            {text}
            <ArrowRight className="w-3.5 h-3.5 opacity-0 -ml-1 group-hover:opacity-100 group-hover:ml-0 transition-all" aria-hidden />
          </button>
        ))}
      </div>
    </div>
    <ol className="grid grid-cols-1 md:grid-cols-3 gap-px bg-line-soft border-t border-line-soft">
      {[
        {
          icon: <Search className="w-4 h-4" />,
          title: 'Search',
          text: `Pick a role and location. A search costs ${searchFeeText(pricing)}.`,
        },
        {
          icon: <Sparkles className="w-4 h-4" />,
          title: 'Verified contacts appear',
          text: `Every lead is checked automatically. ${pricing.email} credit${pricing.email === 1 ? '' : 's'} per verified email, ${pricing.phone} per phone — nothing for the rest.`,
        },
        {
          icon: <Bookmark className="w-4 h-4" />,
          title: 'Save & export',
          text: 'Leads with contacts land in your pipeline, ready to export as CSV.',
        },
      ].map((item, i) => (
        <li key={item.title} className="bg-white p-5 flex gap-3">
          <span className="w-9 h-9 bg-fill text-ink flex items-center justify-center shrink-0" aria-hidden>
            {item.icon}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">
              <span className="text-muted tabular-nums mr-1.5">{i + 1}.</span>
              {item.title}
            </p>
            <p className="mt-0.5 text-[13px] text-ink-2">{item.text}</p>
          </div>
        </li>
      ))}
    </ol>
  </section>
);
