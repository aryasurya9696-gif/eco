import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEcho } from '../../context/EchoContext';
import type { MonitoredPost } from '../../types';
import { safeHttpUrl } from '../../lib/url';
import { FeedCard } from './FeedCard';
import { FeedSummary, FeedSkeleton } from './FeedSummary';
import { Search, X, Sparkles, Clock, Trash2 } from 'lucide-react';

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

export const FeedTab: React.FC = () => {
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
    runSweep,
    isSweeping,
    sweepTime,
    generateAiDraft,
    exportPostsToCsv,
    exportPostsToJson,
    enabledChannels,
    minIntentThreshold,
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

  // AI outreach modal
  const [aiDraftModalPost, setAiDraftModalPost] = useState<MonitoredPost | null>(null);
  const [draftTone, setDraftTone] = useState<
    'professional' | 'casual' | 'consultative' | 'direct'
  >('consultative');
  const [draftText, setDraftText] = useState<string>('');
  const [isGeneratingDraft, setIsGeneratingDraft] = useState<boolean>(false);
  const [copiedDraft, setCopiedDraft] = useState<boolean>(false);

  const toggleExpand = (id: string) =>
    setExpandedCards((prev) => ({ ...prev, [id]: !prev[id] }));

  // Each draft request takes a number; only the latest may write its result,
  // so a slow reply for an earlier tone (or post) cannot overwrite a newer one.
  const draftSeqRef = useRef(0);

  const handleOpenAiDraft = async (post: MonitoredPost) => {
    const seq = ++draftSeqRef.current;
    setAiDraftModalPost(post);
    setCopiedDraft(false);
    setIsGeneratingDraft(true);
    setDraftText('AI is drafting a personalised reply...');
    try {
      const text = await generateAiDraft(post, draftTone);
      if (seq === draftSeqRef.current) setDraftText(text);
    } catch (err) {
      if (seq !== draftSeqRef.current) return;
      setDraftText('');
      addToast(`Could not draft a reply: ${(err as Error)?.message || 'unknown error'}`, 'error');
    } finally {
      if (seq === draftSeqRef.current) setIsGeneratingDraft(false);
    }
  };

  const handleChangeTone = async (
    tone: 'professional' | 'casual' | 'consultative' | 'direct',
  ) => {
    setDraftTone(tone);
    if (aiDraftModalPost) {
      const seq = ++draftSeqRef.current;
      setIsGeneratingDraft(true);
      try {
        const text = await generateAiDraft(aiDraftModalPost, tone);
        if (seq === draftSeqRef.current) setDraftText(text);
      } catch (err) {
        // The previous draft stays; say why it did not change.
        if (seq === draftSeqRef.current) {
          addToast(`Could not redraft in that tone: ${(err as Error)?.message || 'unknown error'}`, 'error');
        }
      } finally {
        if (seq === draftSeqRef.current) setIsGeneratingDraft(false);
      }
    }
  };

  const handleCopyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draftText);
      addToast('Draft copied to clipboard.', 'success');
      setCopiedDraft(true);
      setTimeout(() => setCopiedDraft(false), 2000);
    } catch {
      addToast('Could not access the clipboard.', 'error');
    }
  };

  // Reset the platform filter if that channel was turned off in Settings.
  useEffect(() => {
    if (filterPlatform !== 'all' && !enabledChannels.includes(filterPlatform)) {
      setFilterPlatform('all');
    }
  }, [enabledChannels, filterPlatform, setFilterPlatform]);

  const filteredPosts = useMemo(
    () =>
      posts.filter((post) => {
        // Hide posts from channels the user turned off.
        if (enabledChannels.length > 0 && !enabledChannels.includes(post.platform)) {
          return false;
        }
        // Workspace intent threshold (also applied server-side).
        if (minIntentThreshold > 0 && (post.intent_score ?? 0) < minIntentThreshold) {
          return false;
        }
        if (filterKeyword !== 'all' && post.matched_keyword.toLowerCase() !== filterKeyword.toLowerCase()) {
          return false;
        }
        if (filterPlatform !== 'all' && post.platform !== filterPlatform) {
          return false;
        }
        if (filterStatus !== 'all' && post.status !== filterStatus) {
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
    [
      posts,
      enabledChannels,
      minIntentThreshold,
      filterKeyword,
      filterPlatform,
      filterStatus,
      filterSearch,
    ],
  );

  const totalPages = Math.ceil(filteredPosts.length / itemsPerPage) || 1;
  const paginatedPosts = filteredPosts.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage,
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

  return (
    <div className="max-w-4xl space-y-4">
      {/* ── Summary header ──────────────────────────────────────────────── */}
      <FeedSummary
        posts={posts}
        filteredCount={filteredPosts.length}
        minIntentThreshold={minIntentThreshold}
        onToggleFilters={() => setShowFilters((v) => !v)}
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
            <Search className="w-3.5 h-3.5 text-[#8a8a86] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
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
          <div className="px-3 pb-3 pt-1 border-t border-[#f4f4f0] flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mr-1">
              Channel
            </span>
            <div className="inline-flex border border-[#e3e3de] bg-white">
              <button
                type="button"
                onClick={() => {
                  setFilterPlatform('all');
                  setCurrentPage(1);
                }}
                className={`px-2.5 py-1 text-[11px] font-mono transition-colors cursor-pointer ${
                  filterPlatform === 'all'
                    ? 'bg-[#141414] text-white'
                    : 'text-[#4a4a47] hover:bg-[#f6f6f4]'
                }`}
              >
                All
              </button>
              {(['twitter', 'reddit', 'google'] as const)
                .filter((p) => enabledChannels.includes(p))
                .map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setFilterPlatform(p);
                      setCurrentPage(1);
                    }}
                    className={`px-2.5 py-1 text-[11px] font-mono border-l border-[#e3e3de] transition-colors cursor-pointer ${
                      filterPlatform === p
                        ? 'bg-[#141414] text-white'
                        : 'text-[#4a4a47] hover:bg-[#f6f6f4]'
                    }`}
                  >
                    {p === 'twitter' ? 'X' : p === 'reddit' ? 'Reddit' : 'Web'}
                  </button>
                ))}
            </div>

            <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] ml-2 mr-1">
              Status
            </span>
            <div className="inline-flex border border-[#e3e3de] bg-white">
              {(['all', 'new', 'saved', 'contacted'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setFilterStatus(s);
                    setCurrentPage(1);
                  }}
                  className={`px-2.5 py-1 text-[11px] font-mono border-l first:border-l-0 border-[#e3e3de] uppercase transition-colors cursor-pointer ${
                    filterStatus === s
                      ? 'bg-[#141414] text-white'
                      : 'text-[#4a4a47] hover:bg-[#f6f6f4]'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            <div className="relative ml-2">
              <select
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
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[#8a8a86] text-[9px]">
                ▼
              </span>
            </div>

            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={resetFilters}
                className="ml-auto inline-flex items-center gap-1 text-[11px] font-mono text-[#4a4a47] hover:text-[#141414] underline cursor-pointer"
              >
                <X className="w-3 h-3" />
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
            <Clock className="w-5 h-5 text-[#8a8a86]" />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-bold text-[#141414]">No mentions yet</h3>
            <p className="text-xs text-[#8a8a86] font-mono leading-relaxed">
              Your next automated sweep runs at{' '}
              <span className="text-[#141414] font-semibold">{sweepTime} UTC</span>, or you can
              run one now. It searches{' '}
              {enabledChannels
                .map((c) => (c === 'twitter' ? 'X' : c === 'google' ? 'Web' : c))
                .join(', ')}{' '}
              for your {keywords.length} keyword{keywords.length === 1 ? '' : 's'}.
            </p>
          </div>
          <button
            type="button"
            onClick={runSweep}
            disabled={isSweeping}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#141414] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer disabled:opacity-60"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{isSweeping ? 'Scanning...' : 'Run sweep now'}</span>
          </button>
        </div>
      ) : filteredPosts.length === 0 ? (
        <div className="bg-white border border-[#e3e3de] p-12 text-center space-y-3 max-w-md mx-auto">
          <p className="text-sm font-medium text-[#141414]">Nothing matches these filters</p>
          <p className="text-xs text-[#8a8a86] font-mono leading-relaxed">
            {minIntentThreshold > 0
              ? `Your workspace threshold is ${minIntentThreshold}% intent. Lower it in Settings, or clear the filters here.`
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
            <section key={group.label}>
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
        <div className="flex items-center justify-between bg-white border border-[#e3e3de] px-4 py-3 text-xs font-mono text-[#8a8a86]">
          <span>
            {(currentPage - 1) * itemsPerPage + 1}–
            {Math.min(currentPage * itemsPerPage, filteredPosts.length)} of{' '}
            {filteredPosts.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="px-2 py-1 border border-[#e3e3de] hover:bg-[#f6f6f4] disabled:opacity-30 disabled:cursor-not-allowed text-[#141414] cursor-pointer"
            >
              Prev
            </button>
            <span className="px-1 text-[#141414]">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="px-2 py-1 border border-[#e3e3de] hover:bg-[#f6f6f4] disabled:opacity-30 disabled:cursor-not-allowed text-[#141414] cursor-pointer"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* ── Clear feed confirmation ──────────────────────────────────────── */}
      {confirmClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs"
            onClick={() => !isClearing && setConfirmClear(false)}
          />
          <div className="relative w-full max-w-sm bg-white border border-[#e3e3de] shadow-2xl z-10">
            <div className="px-5 pt-5 pb-4">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-red-50 border border-red-200 flex items-center justify-center flex-shrink-0">
                  <Trash2 className="w-4 h-4 text-red-600" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-[#141414]">Clear the whole feed?</h3>
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
          </div>
        </div>
      )}

      {/* ── AI outreach modal ─────────────────────────────────────────────── */}
      {aiDraftModalPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs"
            onClick={() => setAiDraftModalPost(null)}
          />
          <div className="relative w-full max-w-lg bg-white border border-[#e3e3de] shadow-2xl z-10 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#eeeeea] px-5 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#141414]" />
                <h3 className="text-sm font-bold text-[#141414]">Outreach reply</h3>
              </div>
              <button
                type="button"
                onClick={() => setAiDraftModalPost(null)}
                className="text-[#8a8a86] hover:text-[#141414] cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 space-y-4">
              <div className="p-3 bg-[#f6f6f4] border border-[#eeeeea] text-xs space-y-1">
                <span className="text-[10px] font-mono text-[#8a8a86] uppercase block">
                  Replying to
                </span>
                <p className="font-semibold text-[#141414]">
                  {aiDraftModalPost.author_name}
                  {aiDraftModalPost.author_handle
                    ? ` (${aiDraftModalPost.author_handle})`
                    : ''}
                </p>
                <p className="text-[11px] text-[#4a4a47] line-clamp-3">
                  {aiDraftModalPost.body}
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-mono uppercase text-[#4a4a47] block">
                  Tone
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs font-mono">
                  {(['consultative', 'direct', 'professional', 'casual'] as const).map((tone) => (
                    <button
                      key={tone}
                      type="button"
                      onClick={() => void handleChangeTone(tone)}
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
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-mono uppercase text-[#4a4a47] block">
                    Draft
                  </label>
                  {isGeneratingDraft && (
                    <span className="text-[10px] font-mono text-[#8a8a86]">
                      generating...
                    </span>
                  )}
                </div>
                <textarea
                  rows={5}
                  value={draftText}
                  disabled={isGeneratingDraft}
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
                  disabled={!draftText}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#141414] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer disabled:opacity-50"
                >
                  {copiedDraft ? 'Copied' : 'Copy draft'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};