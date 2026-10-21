import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEcho } from '../../context/EchoContext';
import type { MonitoredPost } from '../../types';
import type { DraftResult } from '../../lib/ai';
import { safeHttpUrl } from '../../lib/url';
import { ALL_CHANNELS, channelLabel } from '../../lib/constants';
import { formatNextSweep } from '../../lib/schedule';
import { FeedCard } from './FeedCard';
import { FeedSummary, FeedSkeleton } from './FeedSummary';
import { ModalDialog } from './ModalDialog';
import { SweepButton } from './SweepButton';
import { Search, X, Sparkles, Clock, Trash2 } from 'lucide-react';

type Tone = 'professional' | 'casual' | 'consultative' | 'direct';

/** Status filter options. 'all' is every mention that has not been dismissed. */
const STATUS_FILTERS = [
  { id: 'all', label: 'Active' },
  { id: 'new', label: 'New' },
  { id: 'saved', label: 'Saved' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'dismissed', label: 'Dismissed' },
] as const;

/**
 * Buckets posts by calendar day so the feed is scannable over time instead of
 * being one flat list. Uses local midnight, matching what the user sees.
 */
function groupByDay(
  posts: MonitoredPost[],
  now: number,
): Array<{ label: string; posts: MonitoredPost[] }> {
  const dayKey = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  };

  const buckets = new Map<string, MonitoredPost[]>();
  const UNKNOWN = 'unknown';
  for (const post of posts) {
    // /v1/web/search returns no date at all. Filing those under "Today"
    // implied they were just found, so they get their own bucket instead.
    const ts = post.posted_at ? new Date(post.posted_at).getTime() : NaN;
    const key = Number.isNaN(ts) ? UNKNOWN : dayKey(ts);
    const list = buckets.get(key) ?? [];
    list.push(post);
    buckets.set(key, list);
  }

  const today = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dayKey(yesterdayDate.getTime());

  return [...buckets.entries()]
    // The unknown bucket always sorts last regardless of key ordering.
    .sort((a, b) => {
      if (a[0] === UNKNOWN) return 1;
      if (b[0] === UNKNOWN) return -1;
      return a[0] < b[0] ? 1 : -1;
    })
    .map(([key, list]) => {
      let label: string;
      if (key === UNKNOWN) {
        label = 'Date unknown';
      } else if (key === today) {
        label = 'Today';
      } else if (key === yesterday) {
        label = 'Yesterday';
      } else {
        const [y, m, d] = key.split('-').map(Number);
        label = new Date(y, m - 1, d).toLocaleDateString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        });
      }
      return { label, posts: list };
    });
}

export const FeedTab: React.FC<{ onNavigateBilling?: () => void }> = ({ onNavigateBilling }) => {
  const {
    posts,
    keywords,
    isLoadingPosts,
    filterKeyword,
    filterPlatform,
    filterStatus,
    filterSearch,
    setFilterKeyword,
    setFilterPlatform,
    setFilterStatus,
    setFilterSearch,
    updatePostStatus,
    generateAiDraft,
    exportPostsToCsv,
    exportPostsToJson,
    // Saved values, not the Settings form's unsaved edits: the feed reflects
    // what is actually configured.
    savedChannels,
    savedMinIntentThreshold,
    savedSweepTime,
    savedSweepCadence,
    clearFeed,
    feedRetentionDays,
    addToast,
  } = useEcho();

  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [showFilters, setShowFilters] = useState<boolean>(false);
  const [confirmClear, setConfirmClear] = useState<boolean>(false);
  const [isClearing, setIsClearing] = useState<boolean>(false);
  const itemsPerPage = 20;

  // A single ticking clock keeps relative timestamps stable between renders
  // instead of calling Date.now() during render.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  // Outreach reply modal
  const [aiDraftModalPost, setAiDraftModalPost] = useState<MonitoredPost | null>(null);
  const [draftTone, setDraftTone] = useState<Tone>('consultative');
  const [draftText, setDraftText] = useState<string>('');
  const [draftSource, setDraftSource] = useState<DraftResult['source'] | null>(null);
  const [isGeneratingDraft, setIsGeneratingDraft] = useState<boolean>(false);
  const [copiedDraft, setCopiedDraft] = useState<boolean>(false);

  const toggleExpand = (id: string) =>
    setExpandedCards((prev) => ({ ...prev, [id]: !prev[id] }));

  // Each draft request takes a number; only the latest may write its result,
  // so a slow reply for an earlier tone (or post) cannot overwrite a newer one.
  const draftSeqRef = useRef(0);

  const requestDraft = async (post: MonitoredPost, tone: Tone, keepOnError: boolean) => {
    const seq = ++draftSeqRef.current;
    setIsGeneratingDraft(true);
    try {
      const result = await generateAiDraft(post, tone);
      if (seq === draftSeqRef.current) {
        setDraftText(result.draft);
        setDraftSource(result.source);
      }
    } catch (err) {
      if (seq !== draftSeqRef.current) return;
      if (!keepOnError) {
        setDraftText('');
        setDraftSource(null);
      }
      addToast(
        `${keepOnError ? 'Could not redraft in that tone' : 'Could not draft a reply'}: ${(err as Error)?.message || 'unknown error'}`,
        'error',
      );
    } finally {
      if (seq === draftSeqRef.current) setIsGeneratingDraft(false);
    }
  };

  const handleOpenAiDraft = (post: MonitoredPost) => {
    setAiDraftModalPost(post);
    setCopiedDraft(false);
    // The textarea stays empty while drafting (the status is shown beside it),
    // so a placeholder sentence can never be copied or sent as the reply.
    setDraftText('');
    setDraftSource(null);
    void requestDraft(post, draftTone, false);
  };

  const handleChangeTone = (tone: Tone) => {
    setDraftTone(tone);
    if (aiDraftModalPost) void requestDraft(aiDraftModalPost, tone, true);
  };

  const closeDraftModal = () => {
    draftSeqRef.current += 1; // drop any reply still in flight
    setAiDraftModalPost(null);
    setIsGeneratingDraft(false);
  };

  const handleCopyDraft = async () => {
    if (isGeneratingDraft || !draftText.trim()) return;
    try {
      await navigator.clipboard.writeText(draftText);
      addToast('Draft copied to clipboard.', 'success');
      setCopiedDraft(true);
      setTimeout(() => setCopiedDraft(false), 2000);
    } catch {
      addToast('Could not access the clipboard.', 'error');
    }
  };

  // Channels worth offering as a filter: the saved ones plus any that still
  // have stored mentions (e.g. News turned off after a few sweeps).
  const filterChannels = useMemo(
    () => ALL_CHANNELS.filter((c) => savedChannels.includes(c) || posts.some((p) => p.platform === c)),
    [savedChannels, posts],
  );

  const dismissedCount = useMemo(() => posts.filter((p) => p.status === 'dismissed').length, [posts]);

  const filteredPosts = useMemo(
    () =>
      posts.filter((post) => {
        // Workspace intent threshold (also applied server-side).
        if (savedMinIntentThreshold > 0 && (post.intent_score ?? 0) < savedMinIntentThreshold) {
          return false;
        }
        if (filterKeyword !== 'all' && post.matched_keyword.toLowerCase() !== filterKeyword.toLowerCase()) {
          return false;
        }
        if (filterPlatform !== 'all' && post.platform !== filterPlatform) {
          return false;
        }
        // "Active" hides dismissed mentions; the Dismissed filter shows them.
        if (filterStatus === 'all' ? post.status === 'dismissed' : post.status !== filterStatus) {
          return false;
        }
        if (filterSearch.trim()) {
          const q = filterSearch.toLowerCase();
          const matchBody = post.body?.toLowerCase().includes(q) ?? false;
          const matchAuthor = post.author_name?.toLowerCase().includes(q) ?? false;
          const matchHandle = post.author_handle?.toLowerCase().includes(q) ?? false;
          if (!matchBody && !matchAuthor && !matchHandle) return false;
        }
        return true;
      }),
    [posts, savedMinIntentThreshold, filterKeyword, filterPlatform, filterStatus, filterSearch],
  );

  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / itemsPerPage));
  // Clamped at render: dismissing, clearing or a sweep can shrink the list
  // under the current page, which used to render an empty page.
  const page = Math.min(Math.max(1, currentPage), totalPages);
  const paginatedPosts = useMemo(
    () => filteredPosts.slice((page - 1) * itemsPerPage, page * itemsPerPage),
    [filteredPosts, page],
  );
  const dayGroups = useMemo(() => groupByDay(paginatedPosts, now), [paginatedPosts, now]);

  const activeFilterCount =
    (filterPlatform !== 'all' ? 1 : 0) +
    (filterStatus !== 'all' ? 1 : 0) +
    (filterKeyword !== 'all' ? 1 : 0);

  const resetFilters = () => {
    setFilterKeyword('all');
    setFilterPlatform('all');
    setFilterStatus('all');
    setFilterSearch('');
    setCurrentPage(1);
  };

  const handleClearFeed = async () => {
    setIsClearing(true);
    const result = await clearFeed();
    setIsClearing(false);
    setConfirmClear(false);

    if (result.success) {
      addToast(
        `Cleared ${result.deleted ?? 0} mention${(result.deleted ?? 0) === 1 ? '' : 's'}.`,
        'success',
      );
    } else {
      addToast(result.error || 'Could not clear the feed.', 'error');
    }
  };

  const filterButton = (selected: boolean) =>
    `px-2.5 py-1 text-[11px] font-mono border-l first:border-l-0 border-[#e3e3de] transition-colors cursor-pointer ${
      selected ? 'bg-[#141414] text-white' : 'text-[#4a4a47] hover:bg-[#f6f6f4]'
    }`;

  return (
    <div className="max-w-4xl space-y-4">
      {/* ── Summary header ──────────────────────────────────────────────── */}
      <FeedSummary
        posts={posts}
        filteredCount={filteredPosts.length}
        minIntentThreshold={savedMinIntentThreshold}
        onToggleFilters={() => setShowFilters((v) => !v)}
        filtersOpen={showFilters}
        activeFilterCount={activeFilterCount}
        onExportCsv={() => exportPostsToCsv(filteredPosts)}
        onExportJson={() => exportPostsToJson(filteredPosts)}
        onClearFeed={() => setConfirmClear(true)}
        isClearing={isClearing}
      />

      {/* ── Search + filters ────────────────────────────────────────────── */}
      <div className="bg-white border border-[#e3e3de]">
        <div className="flex items-center gap-2 p-3">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-[#8a8a86] absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search mentions"
              value={filterSearch}
              onChange={(e) => {
                setFilterSearch(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Search mentions by text, author or handle..."
              className="w-full pl-9 pr-3 py-2 bg-[#f6f6f4] border border-transparent text-xs text-[#141414] placeholder:text-[#9b9b96] focus:outline-none focus:bg-white focus:border-[#141414] transition-all duration-150"
            />
          </div>
        </div>

        {/* Collapsible filter row */}
        {showFilters && (
          <div id="feed-filters" className="px-3 pb-3 pt-1 border-t border-[#f4f4f0] flex flex-wrap items-center gap-2">
            <span id="feed-filter-channel" className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mr-1">
              Channel
            </span>
            <div role="group" aria-labelledby="feed-filter-channel" className="inline-flex border border-[#e3e3de] bg-white">
              <button
                type="button"
                aria-pressed={filterPlatform === 'all'}
                onClick={() => {
                  setFilterPlatform('all');
                  setCurrentPage(1);
                }}
                className={filterButton(filterPlatform === 'all')}
              >
                All
              </button>
              {filterChannels.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={filterPlatform === p}
                  onClick={() => {
                    setFilterPlatform(p);
                    setCurrentPage(1);
                  }}
                  className={filterButton(filterPlatform === p)}
                >
                  {channelLabel(p)}
                </button>
              ))}
            </div>

            <span id="feed-filter-status" className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] ml-2 mr-1">
              Status
            </span>
            <div role="group" aria-labelledby="feed-filter-status" className="inline-flex flex-wrap border border-[#e3e3de] bg-white">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={filterStatus === s.id}
                  onClick={() => {
                    setFilterStatus(s.id);
                    setCurrentPage(1);
                  }}
                  className={`${filterButton(filterStatus === s.id)} uppercase`}
                >
                  {s.label}
                  {s.id === 'dismissed' && dismissedCount > 0 ? ` (${dismissedCount})` : ''}
                </button>
              ))}
            </div>

            <div className="relative ml-2">
              <select
                aria-label="Filter by keyword"
                value={filterKeyword}
                onChange={(e) => {
                  setFilterKeyword(e.target.value);
                  setCurrentPage(1);
                }}
                className="appearance-none bg-white border border-[#e3e3de] px-2.5 py-1 pr-7 text-[11px] font-mono text-[#141414] focus:outline-none focus:border-[#141414] cursor-pointer"
              >
                <option value="all">All keywords</option>
                {keywords.map((kw) => (
                  <option key={kw.id} value={kw.keyword}>
                    {kw.keyword}
                  </option>
                ))}
              </select>
              <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[#8a8a86] text-[9px]">
                ▼
              </span>
            </div>

            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={resetFilters}
                className="ml-auto inline-flex items-center gap-1 text-[11px] font-mono text-[#4a4a47] hover:text-[#141414] underline cursor-pointer"
              >
                <X className="w-3 h-3" aria-hidden="true" />
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Feed ─────────────────────────────────────────────────────────── */}
      {isLoadingPosts ? (
        <FeedSkeleton />
      ) : posts.length === 0 ? (
        <div className="bg-white border border-[#e3e3de] p-12 text-center space-y-4 max-w-lg mx-auto">
          <div className="w-11 h-11 bg-[#f6f6f4] border border-[#e3e3de] flex items-center justify-center mx-auto text-[#141414]">
            <Clock className="w-5 h-5 text-[#8a8a86]" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-bold text-[#141414]">No mentions yet</h2>
            <p className="text-xs text-[#8a8a86] font-mono leading-relaxed">
              Your next automated sweep:{' '}
              <span className="text-[#141414] font-semibold">
                {formatNextSweep(savedSweepTime, savedSweepCadence, new Date(now))}
              </span>
              , or you can run one now. It searches {savedChannels.map(channelLabel).join(', ')} for your{' '}
              {keywords.length} keyword{keywords.length === 1 ? '' : 's'}.
            </p>
          </div>
          <SweepButton variant="empty" onNavigateBilling={onNavigateBilling} />
        </div>
      ) : filteredPosts.length === 0 ? (
        <div className="bg-white border border-[#e3e3de] p-12 text-center space-y-3 max-w-md mx-auto">
          <p className="text-sm font-medium text-[#141414]">Nothing matches these filters</p>
          <p className="text-xs text-[#8a8a86] font-mono leading-relaxed">
            {savedMinIntentThreshold > 0
              ? `Your workspace threshold is ${savedMinIntentThreshold}% intent. Lower it in Settings, or clear the filters here.`
              : 'Try widening the channel, status or keyword filters.'}
          </p>
          <button
            type="button"
            onClick={resetFilters}
            className="text-xs font-mono text-[#141414] underline hover:no-underline cursor-pointer"
          >
            Clear all filters
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {dayGroups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <div className="flex items-center gap-3 mb-2.5">
                <h2 className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86] flex-shrink-0">
                  {group.label}
                </h2>
                <div className="flex-1 h-px bg-[#e3e3de]" />
                <span className="text-[11px] font-mono text-[#b5b5b0]">
                  {group.posts.length}
                </span>
              </div>

              <div className="space-y-2.5">
                {group.posts.map((post) => (
                  <FeedCard
                    key={post.id}
                    post={post}
                    now={now}
                    isExpanded={expandedCards[post.id] || false}
                    onToggleExpand={toggleExpand}
                    onStatusChange={updatePostStatus}
                    onOpenAiDraft={handleOpenAiDraft}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Pagination */}
      {filteredPosts.length > itemsPerPage && (
        <nav
          aria-label="Feed pages"
          className="flex items-center justify-between bg-white border border-[#e3e3de] px-4 py-3 text-xs font-mono text-[#8a8a86]"
        >
          <span>
            {(page - 1) * itemsPerPage + 1}–
            {Math.min(page * itemsPerPage, filteredPosts.length)} of{' '}
            {filteredPosts.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="px-2 py-1 border border-[#e3e3de] hover:bg-[#f6f6f4] disabled:opacity-30 disabled:cursor-not-allowed text-[#141414] cursor-pointer"
            >
              Prev
            </button>
            <span className="px-1 text-[#141414]" aria-current="page">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              className="px-2 py-1 border border-[#e3e3de] hover:bg-[#f6f6f4] disabled:opacity-30 disabled:cursor-not-allowed text-[#141414] cursor-pointer"
            >
              Next
            </button>
          </div>
        </nav>
      )}

      {/* ── Clear feed confirmation ──────────────────────────────────────── */}
      {confirmClear && (
        <ModalDialog
          title="Clear the whole feed?"
          onClose={() => setConfirmClear(false)}
          busy={isClearing}
          renderHeader={(titleId) => (
            <div className="px-5 pt-5 pb-4">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-red-50 border border-red-200 flex items-center justify-center flex-shrink-0">
                  <Trash2 className="w-4 h-4 text-red-600" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2 id={titleId} className="text-sm font-bold text-[#141414]">Clear the whole feed?</h2>
                  <p className="mt-1.5 text-xs text-[#4a4a47] leading-relaxed">
                    This permanently deletes all{' '}
                    <span className="font-semibold text-[#141414]">{posts.length}</span> stored
                    mentions, including anything you saved. Your keywords and settings are
                    untouched.
                  </p>
                  {feedRetentionDays > 0 && (
                    <p className="mt-2 text-[11px] font-mono text-[#8a8a86]">
                      Retention is set to {feedRetentionDays} days, so a future sweep will
                      also prune automatically.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        >
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#eeeeea] bg-[#fafaf9]">
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              disabled={isClearing}
              className="px-3.5 py-1.5 text-[11px] font-mono border border-[#e3e3de] bg-white text-[#4a4a47] hover:bg-[#f6f6f4] transition-all duration-150 cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleClearFeed()}
              disabled={isClearing}
              className="px-3.5 py-1.5 text-[11px] font-mono bg-red-600 hover:bg-red-700 text-white transition-all duration-150 cursor-pointer disabled:opacity-50 active:scale-[0.97]"
            >
              {isClearing ? 'Clearing...' : `Delete ${posts.length}`}
            </button>
          </div>
        </ModalDialog>
      )}

      {/* ── Outreach reply modal ──────────────────────────────────────────── */}
      {aiDraftModalPost && (
        <ModalDialog
          title="Outreach reply"
          onClose={closeDraftModal}
          className="max-w-lg"
          renderHeader={(titleId) => (
            <div className="flex items-center justify-between border-b border-[#eeeeea] px-5 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#141414]" aria-hidden="true" />
                <h2 id={titleId} className="text-sm font-bold text-[#141414]">Outreach reply</h2>
              </div>
              <button
                type="button"
                onClick={closeDraftModal}
                className="text-[#8a8a86] hover:text-[#141414] cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}
        >
          <div className="px-5 py-4 space-y-4">
            <div className="p-3 bg-[#f6f6f4] border border-[#eeeeea] text-xs space-y-1">
              <span className="text-[10px] font-mono text-[#8a8a86] uppercase block">
                Replying to
              </span>
              <p className="font-semibold text-[#141414]">
                {aiDraftModalPost.author_name}
                {aiDraftModalPost.author_handle ? ` (${aiDraftModalPost.author_handle})` : ''}
              </p>
              <p className="text-[11px] text-[#4a4a47] line-clamp-3">{aiDraftModalPost.body}</p>
            </div>

            <div className="space-y-1.5">
              <span id="draft-tone-label" className="text-[11px] font-mono uppercase text-[#4a4a47] block">
                Tone
              </span>
              <div role="group" aria-labelledby="draft-tone-label" className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs font-mono">
                {(['consultative', 'direct', 'professional', 'casual'] as const).map((tone) => (
                  <button
                    key={tone}
                    type="button"
                    aria-pressed={draftTone === tone}
                    onClick={() => handleChangeTone(tone)}
                    className={`py-1.5 text-center border capitalize transition-colors cursor-pointer ${
                      draftTone === tone
                        ? 'bg-[#141414] text-white border-[#141414]'
                        : 'bg-white text-[#4a4a47] border-[#e3e3de] hover:bg-[#f6f6f4]'
                    }`}
                  >
                    {tone}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="outreach-draft" className="text-[11px] font-mono uppercase text-[#4a4a47] block">
                  Draft
                </label>
                <span aria-live="polite" className="text-[10px] font-mono text-[#8a8a86]">
                  {isGeneratingDraft
                    ? 'Drafting…'
                    : draftSource === 'openai'
                    ? 'Written by AI · review before sending'
                    : draftSource === 'fallback'
                    ? 'Template: AI drafting is unavailable right now'
                    : ''}
                </span>
              </div>
              <textarea
                id="outreach-draft"
                rows={5}
                value={draftText}
                disabled={isGeneratingDraft}
                placeholder={isGeneratingDraft ? 'Drafting a reply…' : 'Write your reply'}
                onChange={(e) => setDraftText(e.target.value)}
                className={`w-full p-3 bg-white border border-[#e3e3de] text-xs leading-relaxed text-[#141414] focus:outline-none focus:border-[#141414] ${
                  isGeneratingDraft ? 'opacity-50' : ''
                }`}
              />
            </div>

            <div className="flex items-center justify-between">
              {safeHttpUrl(aiDraftModalPost.post_url) ? (
                <a
                  href={safeHttpUrl(aiDraftModalPost.post_url) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[11px] font-mono text-[#4a4a47] hover:text-[#141414]"
                >
                  Open original
                </a>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => void handleCopyDraft()}
                disabled={isGeneratingDraft || !draftText.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#141414] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {copiedDraft ? 'Copied' : 'Copy draft'}
              </button>
            </div>
          </div>
        </ModalDialog>
      )}
    </div>
  );
};
