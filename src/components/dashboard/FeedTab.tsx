import React, { useState } from 'react';
import { useEcho } from '../../context/EchoContext';
import type { MonitoredPost } from '../../types';
import { PlatformBadge } from '../common/PlatformBadge';
import { 
  ExternalLink, 
  Search, 
  Heart, 
  MessageSquare, 
  Repeat, 
  Clock, 
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Download,
  Bookmark,
  CheckCircle,
  Copy,
  Check,
  Code,
  X
} from 'lucide-react';

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
    addToast,
  } = useEcho();

  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const [currentPage, setCurrentPage] = useState<number>(1);
  const itemsPerPage = 20;

  // Modals
  const [aiDraftModalPost, setAiDraftModalPost] = useState<MonitoredPost | null>(null);
  const [draftTone, setDraftTone] = useState<'professional' | 'casual' | 'consultative' | 'direct'>('consultative');
  const [draftText, setDraftText] = useState<string>('');
  const [isGeneratingDraft, setIsGeneratingDraft] = useState<boolean>(false);
  const [copiedDraft, setCopiedDraft] = useState<boolean>(false);

  const [inspectModalPost, setInspectModalPost] = useState<MonitoredPost | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedCards((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const getRelativeTime = (isoDate: string | null) => {
    if (!isoDate) return 'Recently';
    const diffMs = Date.now() - new Date(isoDate).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMin > 0) return `${diffMin}m ago`;
    return 'just now';
  };

  const handleOpenAiDraft = async (post: MonitoredPost) => {
    setAiDraftModalPost(post);
    setCopiedDraft(false);
    setIsGeneratingDraft(true);
    setDraftText('AI is crafting a personalized, high-converting outreach reply...');
    try {
      const text = await generateAiDraft(post, draftTone);
      setDraftText(text);
    } catch {
      setDraftText('');
    } finally {
      setIsGeneratingDraft(false);
    }
  };

  const handleChangeTone = async (tone: 'professional' | 'casual' | 'consultative' | 'direct') => {
    setDraftTone(tone);
    if (aiDraftModalPost) {
      setIsGeneratingDraft(true);
      try {
        const text = await generateAiDraft(aiDraftModalPost, tone);
        setDraftText(text);
      } catch {
        // preserve
      } finally {
        setIsGeneratingDraft(false);
      }
    }
  };

  const handleCopyDraft = () => {
    navigator.clipboard.writeText(draftText);
    setCopiedDraft(true);
    addToast('Outreach response copied to clipboard.', 'success');
    setTimeout(() => setCopiedDraft(false), 2000);
  };

  // Filter posts
  const filteredPosts = posts.filter((post) => {
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
  });

  const totalPages = Math.ceil(filteredPosts.length / itemsPerPage) || 1;
  const paginatedPosts = filteredPosts.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  return (
    <div className="space-y-6">
      {/* Top Filter & Actions Bar */}
      <div className="bg-[#ffffff] border border-[#e3e3de] p-4 flex flex-col gap-4">
        {/* Row 1: Source toggle, status filter, keyword selector */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* Platform Toggle */}
            <div className="inline-flex flex-wrap border border-[#e3e3de] bg-[#f6f6f4] p-0.5 text-xs font-mono">
              {(['all', 'twitter', 'linkedin', 'reddit', 'facebook', 'google'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setFilterPlatform(p);
                    setCurrentPage(1);
                  }}
                  className={`px-2.5 sm:px-3 py-1.5 transition-colors cursor-pointer ${
                    filterPlatform === p
                      ? 'bg-[#141414] text-white font-medium shadow-xs'
                      : 'text-[#4a4a47] hover:text-[#141414]'
                  }`}
                >
                  {p === 'all'
                    ? 'All Sources'
                    : p === 'twitter'
                    ? 'X'
                    : p === 'linkedin'
                    ? 'LinkedIn'
                    : p === 'reddit'
                    ? 'Reddit'
                    : p === 'facebook'
                    ? 'Facebook'
                    : 'Google'}
                </button>
              ))}
            </div>

            {/* Status Filter */}
            <div className="inline-flex border border-[#e3e3de] bg-[#ffffff] p-0.5 text-xs font-mono">
              {(['all', 'new', 'saved', 'contacted'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setFilterStatus(s);
                    setCurrentPage(1);
                  }}
                  className={`px-2.5 py-1.5 transition-colors cursor-pointer uppercase ${
                    filterStatus === s
                      ? 'bg-[#141414] text-white font-medium'
                      : 'text-[#8a8a86] hover:text-[#141414]'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Keyword Selector */}
            <div className="relative">
              <select
                value={filterKeyword}
                onChange={(e) => {
                  setFilterKeyword(e.target.value);
                  setCurrentPage(1);
                }}
                className="appearance-none bg-[#ffffff] border border-[#e3e3de] px-3 py-1.5 pr-8 text-xs font-mono text-[#141414] focus:outline-none focus:border-[#141414] cursor-pointer"
              >
                <option value="all">All Keywords ({keywords.length})</option>
                {keywords.map((kw) => (
                  <option key={kw.id} value={kw.keyword}>
                    {kw.keyword}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8a8a86] text-[10px]">
                ▼
              </div>
            </div>
          </div>

          {/* Right Export & Sweep Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => exportPostsToCsv(filteredPosts)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#ffffff] hover:bg-[#f6f6f4] border border-[#e3e3de] text-xs font-mono text-[#141414] transition-colors cursor-pointer"
              title="Export visible leads to CSV"
            >
              <Download className="w-3.5 h-3.5 text-[#8a8a86]" />
              <span className="hidden sm:inline">Export CSV</span>
            </button>

            <button
              onClick={() => exportPostsToJson(filteredPosts)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#ffffff] hover:bg-[#f6f6f4] border border-[#e3e3de] text-xs font-mono text-[#141414] transition-colors cursor-pointer"
              title="Export visible leads to JSON"
            >
              <Code className="w-3.5 h-3.5 text-[#8a8a86]" />
              <span className="hidden sm:inline">JSON</span>
            </button>
          </div>
        </div>

        {/* Row 2: Search */}
        <div className="relative w-full">
          <Search className="w-3.5 h-3.5 text-[#8a8a86] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={filterSearch}
            onChange={(e) => {
              setFilterSearch(e.target.value);
              setCurrentPage(1);
            }}
            placeholder="Search leads by keywords, body text, or author handle..."
            className="w-full pl-9 pr-3 py-2 bg-[#f6f6f4] border border-[#e3e3de] text-xs text-[#141414] placeholder:text-[#9b9b96] focus:outline-none focus:border-[#141414] transition-colors"
          />
        </div>
      </div>

      {/* Posts List */}
      {isLoadingPosts ? (
        <div className="space-y-4">
          {[1, 2, 3].map((n) => (
            <div key={n} className="bg-white border border-[#e3e3de] p-6 animate-pulse space-y-4">
              <div className="w-32 h-4 bg-[#eeeeea]" />
              <div className="w-full h-12 bg-[#eeeeea]" />
            </div>
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div className="bg-[#ffffff] border border-[#e3e3de] p-12 text-center space-y-4 max-w-xl mx-auto my-8">
          <div className="w-12 h-12 bg-[#f6f6f4] border border-[#e3e3de] flex items-center justify-center mx-auto text-[#141414]">
            <Clock className="w-5 h-5 text-[#8a8a86]" />
          </div>
          <div className="space-y-2">
            <h3 className="text-base font-semibold text-[#141414]">
              First Daily Sweep Scheduled
            </h3>
            <p className="text-xs text-[#8a8a86] font-mono leading-relaxed max-w-md mx-auto">
              Your first sweep runs at <span className="text-[#141414] font-semibold">{sweepTime} UTC</span>. Mentions will start showing up here once we've searched your active channels ({enabledChannels.map((c) => (c === 'twitter' ? 'X' : c === 'google' ? 'Web' : c.charAt(0).toUpperCase() + c.slice(1))).join(', ')}) for your keywords.
            </p>
          </div>
          <button
            onClick={runSweep}
            disabled={isSweeping}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#121212] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer shadow-xs"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{isSweeping ? 'Scanning Social Channels...' : 'Run Sweep Now'}</span>
          </button>
        </div>
      ) : filteredPosts.length === 0 ? (
        <div className="bg-[#ffffff] border border-[#e3e3de] p-12 text-center space-y-2 max-w-md mx-auto my-8">
          <p className="text-sm font-medium text-[#141414]">
            No mentions match these filters.
          </p>
          <button
            onClick={() => {
              setFilterKeyword('all');
              setFilterPlatform('all');
              setFilterStatus('all');
              setFilterSearch('');
            }}
            className="mt-3 text-xs font-mono text-[#141414] underline hover:no-underline cursor-pointer"
          >
            Reset all filters
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {paginatedPosts.map((post) => {
            const isExpanded = expandedCards[post.id] || false;
            const intent = post.intent_score || 85;

            return (
              <article
                key={post.id}
                className="bg-[#ffffff] border border-[#e3e3de] p-5 sm:p-6 transition-all hover:border-[#141414] group"
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="pt-0.5">
                      <PlatformBadge platform={post.platform} size={22} />
                    </div>

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-[#141414] truncate">
                          {post.author_name || 'Anonymous User'}
                        </span>
                        {post.author_handle && (
                          <span className="text-[11px] text-[#8a8a86] font-mono truncate">
                            {post.author_handle}
                          </span>
                        )}

                        {/* Channel Source (Subreddit, FB Group, Forum) */}
                        {post.channel_source && (
                          <span
                            className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono rounded-full border ${
                              post.platform === 'reddit'
                                ? 'bg-orange-50 text-orange-800 border-orange-200 font-semibold'
                                : post.platform === 'facebook'
                                ? 'bg-blue-50 text-blue-800 border-blue-200 font-semibold'
                                : 'bg-indigo-50 text-indigo-800 border-indigo-200 font-semibold'
                            }`}
                          >
                            {post.channel_source}
                          </span>
                        )}

                        {/* Matched keyword pill */}
                        <span className="inline-flex items-center px-2 py-0.5 bg-[#eeeeea] text-[#141414] text-[10px] font-mono rounded-full border border-[#deded8]">
                          matched: {post.matched_keyword}
                        </span>

                        {/* Intent score badge */}
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded-full border ${
                            intent >= 90
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200 font-medium'
                              : 'bg-[#f6f6f4] text-[#4a4a47] border-[#e3e3de]'
                          }`}
                        >
                          <Sparkles className="w-2.5 h-2.5" />
                          <span>{intent}% Intent</span>
                        </span>

                        {/* Lead Status pill */}
                        {post.status && post.status !== 'new' && (
                          <span className="inline-flex items-center px-2 py-0.5 bg-[#141414] text-white text-[9px] font-mono uppercase tracking-wider rounded-none">
                            {post.status}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right side: Timestamp & Original Link */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-[11px] font-mono text-[#8a8a86]">
                      {getRelativeTime(post.posted_at)}
                    </span>
                    <a
                      href={post.post_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-mono text-[#4a4a47] hover:text-[#141414] transition-colors"
                      title="Open original post in new tab"
                    >
                      <span>View original</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                {/* Post Body */}
                <div className="mt-2 text-xs sm:text-sm text-[#262626] leading-relaxed pl-8">
                  <p className={isExpanded ? '' : 'line-clamp-4'}>
                    {post.body}
                  </p>

                  {post.body && post.body.length > 220 && (
                    <button
                      type="button"
                      onClick={() => toggleExpand(post.id)}
                      className="mt-1.5 text-xs font-mono text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer"
                    >
                      {isExpanded ? 'Show less ↑' : 'Show more ↓'}
                    </button>
                  )}
                </div>

                {/* Footer with Phase 2 Action Buttons & Engagement */}
                <div className="mt-4 pt-3 border-t border-[#eeeeea] pl-8 flex flex-wrap items-center justify-between gap-4">
                  {/* Left: Engagement metrics */}
                  {post.engagement && (
                    <div className="flex items-center gap-5 text-[11px] font-mono text-[#8a8a86]">
                      {post.engagement.likes !== null && post.engagement.likes !== undefined && (
                        <span className="flex items-center gap-1.5">
                          <Heart className="w-3 h-3 text-[#9b9b96]" />
                          {post.engagement.likes}
                        </span>
                      )}
                      {(post.engagement.retweets !== null || post.engagement.reposts !== null) && (
                        <span className="flex items-center gap-1.5">
                          <Repeat className="w-3 h-3 text-[#9b9b96]" />
                          {post.engagement.retweets ?? post.engagement.reposts ?? 0}
                        </span>
                      )}
                      {(post.engagement.replies !== null || post.engagement.comments !== null) && (
                        <span className="flex items-center gap-1.5">
                          <MessageSquare className="w-3 h-3 text-[#9b9b96]" />
                          {post.engagement.replies ?? post.engagement.comments ?? 0}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Right: Lead Pipeline Actions & AI Drafter */}
                  <div className="flex items-center gap-2 ml-auto">
                    {/* Status toggles */}
                    <button
                      onClick={() =>
                        updatePostStatus(post.id, post.status === 'saved' ? 'new' : 'saved')
                      }
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono border transition-colors cursor-pointer ${
                        post.status === 'saved'
                          ? 'bg-[#141414] text-white border-[#141414]'
                          : 'bg-[#ffffff] text-[#4a4a47] border-[#e3e3de] hover:bg-[#f6f6f4]'
                      }`}
                      title="Save lead for follow-up"
                    >
                      <Bookmark className="w-3 h-3" />
                      <span>{post.status === 'saved' ? 'Saved' : 'Save'}</span>
                    </button>

                    <button
                      onClick={() =>
                        updatePostStatus(
                          post.id,
                          post.status === 'contacted' ? 'new' : 'contacted'
                        )
                      }
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono border transition-colors cursor-pointer ${
                        post.status === 'contacted'
                          ? 'bg-emerald-700 text-white border-emerald-700'
                          : 'bg-[#ffffff] text-[#4a4a47] border-[#e3e3de] hover:bg-[#f6f6f4]'
                      }`}
                      title="Mark as contacted"
                    >
                      <CheckCircle className="w-3 h-3" />
                      <span>{post.status === 'contacted' ? 'Contacted' : 'Contact'}</span>
                    </button>

                    {/* Inspect raw data modal trigger */}
                    <button
                      onClick={() => setInspectModalPost(post)}
                      className="p-1 text-[#8a8a86] hover:text-[#141414] border border-[#e3e3de] hover:bg-[#f6f6f4] transition-colors cursor-pointer"
                      title="Inspect lead metadata"
                    >
                      <Code className="w-3 h-3" />
                    </button>

                    {/* Generate AI Outreach draft */}
                    <button
                      onClick={() => handleOpenAiDraft(post)}
                      className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#141414] hover:bg-black text-white text-[11px] font-mono transition-colors cursor-pointer shadow-xs"
                    >
                      <Sparkles className="w-3 h-3 text-emerald-400" />
                      <span>AI Outreach Draft</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Pagination Footer */}
      {filteredPosts.length > itemsPerPage && (
        <div className="flex items-center justify-between bg-[#ffffff] border border-[#e3e3de] px-4 py-3 text-xs font-mono text-[#8a8a86]">
          <span>
            Showing {(currentPage - 1) * itemsPerPage + 1}–
            {Math.min(currentPage * itemsPerPage, filteredPosts.length)} of {filteredPosts.length} posts
          </span>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="p-1 border border-[#e3e3de] hover:bg-[#f6f6f4] disabled:opacity-30 disabled:cursor-not-allowed text-[#141414] cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-2 text-[#141414]">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="p-1 border border-[#e3e3de] hover:bg-[#f6f6f4] disabled:opacity-30 disabled:cursor-not-allowed text-[#141414] cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* PHASE 2: AI OUTREACH DRAFT MODAL */}
      {aiDraftModalPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs"
            onClick={() => setAiDraftModalPost(null)}
          />
          <div className="relative w-full max-w-lg bg-white border border-[#e3e3de] p-6 shadow-2xl z-10 space-y-4">
            <div className="flex items-center justify-between border-b border-[#eeeeea] pb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#141414]" />
                <h3 className="text-sm font-bold text-[#141414]">
                  AI Outreach Response Generator
                </h3>
              </div>
              <button
                onClick={() => setAiDraftModalPost(null)}
                className="text-[#8a8a86] hover:text-[#141414] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Target context */}
            <div className="p-3 bg-[#f6f6f4] border border-[#e3e3de] text-xs space-y-1">
              <span className="text-[10px] font-mono text-[#8a8a86] uppercase block">
                Target Lead
              </span>
              <p className="font-semibold text-[#141414]">
                {aiDraftModalPost.author_name} ({aiDraftModalPost.author_handle})
              </p>
              <p className="text-[11px] text-[#4a4a47] line-clamp-2">
                "{aiDraftModalPost.body}"
              </p>
            </div>

            {/* Tone selector */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-mono uppercase text-[#4a4a47] block">
                Response Tone
              </label>
              <div className="grid grid-cols-4 gap-1.5 text-xs font-mono">
                {(['consultative', 'direct', 'professional', 'casual'] as const).map((tone) => (
                  <button
                    key={tone}
                    type="button"
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

            {/* Editable Response Area */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-mono uppercase text-[#4a4a47] block">
                  Generated Outreach Draft
                </label>
                {isGeneratingDraft && (
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 border border-emerald-200">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    GPT-4o Generating...
                  </span>
                )}
              </div>
              <textarea
                rows={4}
                value={draftText}
                disabled={isGeneratingDraft}
                onChange={(e) => setDraftText(e.target.value)}
                className={`w-full p-3 bg-white border border-[#e3e3de] text-xs leading-relaxed text-[#141414] focus:outline-none focus:border-[#141414] transition-opacity ${
                  isGeneratingDraft ? 'opacity-60 animate-pulse' : 'opacity-100'
                }`}
              />
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2">
              <a
                href={aiDraftModalPost.post_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-mono text-[#4a4a47] hover:text-[#141414]"
              >
                <span>Open original post to reply</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>

              <button
                type="button"
                onClick={handleCopyDraft}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#121212] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer"
              >
                {copiedDraft ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Response</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RAW JSON / INSPECTION MODAL */}
      {inspectModalPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs"
            onClick={() => setInspectModalPost(null)}
          />
          <div className="relative w-full max-w-2xl bg-white border border-[#e3e3de] p-6 shadow-2xl z-10 space-y-4 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-[#eeeeea] pb-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Code className="w-4 h-4 text-[#141414]" />
                <h3 className="text-sm font-bold text-[#141414]">
                  Lead Details & Metadata
                </h3>
              </div>
              <button
                onClick={() => setInspectModalPost(null)}
                className="text-[#8a8a86] hover:text-[#141414] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto bg-[#141414] p-4 text-[#eeeeea] font-mono text-[11px] leading-relaxed">
              <pre>{JSON.stringify(inspectModalPost, null, 2)}</pre>
            </div>

            <div className="flex justify-end pt-2 flex-shrink-0">
              <button
                onClick={() => setInspectModalPost(null)}
                className="px-4 py-1.5 bg-[#f6f6f4] hover:bg-[#ecece7] border border-[#e3e3de] text-xs font-mono text-[#141414] cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
