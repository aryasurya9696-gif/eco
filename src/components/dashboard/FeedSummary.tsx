import React from 'react';
import { TrendingUp, Flame, Minus, Filter, Download, Code, Trash2 } from 'lucide-react';
import type { MonitoredPost } from '../../types';

interface FeedSummaryProps {
  posts: MonitoredPost[];
  filteredCount: number;
  minIntentThreshold: number;
  onToggleFilters: () => void;
  activeFilterCount: number;
  onExportCsv: () => void;
  onExportJson: () => void;
  onClearFeed: () => void;
  isClearing: boolean;
}

type Band = 'high' | 'medium' | 'low';

/** MUST match the thresholds in the social-search / daily-sweep functions. */
function bandOf(score: number): Band {
  if (score >= 85) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

const BAND_COLOR: Record<Band, string> = {
  high: 'bg-emerald-600',
  medium: 'bg-amber-500',
  low: 'bg-[#d6d6cf]',
};

export const FeedSummary: React.FC<FeedSummaryProps> = ({
  posts,
  filteredCount,
  minIntentThreshold,
  onToggleFilters,
  activeFilterCount,
  onExportCsv,
  onExportJson,
  onClearFeed,
  isClearing,
}) => {
  const counts: Record<Band, number> = { high: 0, medium: 0, low: 0 };
  const daySet = new Set<string>();

  for (const p of posts) {
    counts[bandOf(p.intent_score ?? 0)] += 1;
    if (p.posted_at) daySet.add(p.posted_at.slice(0, 10));
  }

  const total = posts.length;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const isFiltered = filteredCount !== total;

  return (
    <div className="bg-white border border-[#e3e3de]">
      {/* ── Title row ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <h1 className="text-sm font-bold tracking-tight text-[#141414]">Mentions</h1>
          <p className="mt-0.5 text-[11px] font-mono text-[#8a8a86]">
            {isFiltered ? (
              <>
                <span className="text-[#141414] font-medium">{filteredCount}</span> of{' '}
                {total} shown
                {minIntentThreshold > 0 && ` · ${minIntentThreshold}+ intent`}
              </>
            ) : (
              <>
                {total} tracked across {daySet.size} day{daySet.size === 1 ? '' : 's'}
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={onToggleFilters}
            title="Toggle filters"
            className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 border text-[11px] font-mono transition-all duration-150 cursor-pointer active:scale-[0.97] ${
              activeFilterCount > 0
                ? 'border-[#141414] bg-[#141414] text-white'
                : 'border-[#e3e3de] bg-white text-[#4a4a47] hover:border-[#b5b5b0] hover:bg-[#f6f6f4]'
            }`}
          >
            <Filter className="w-3 h-3" />
            <span className="hidden sm:inline">Filters</span>
            {activeFilterCount > 0 && (
              <span className="ml-0.5 w-4 h-4 flex items-center justify-center bg-emerald-500 text-white text-[9px] rounded-full">
                {activeFilterCount}
              </span>
            )}
          </button>

          <div className="hidden sm:flex items-center gap-1.5">
            <button
              type="button"
              onClick={onExportCsv}
              title={filteredCount === 0 ? 'Nothing to export' : 'Export as CSV'}
              disabled={filteredCount === 0}
              className="p-1.5 border border-[#e3e3de] bg-white text-[#4a4a47] hover:border-[#b5b5b0] hover:bg-[#f6f6f4] transition-all duration-150 cursor-pointer active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-[#e3e3de]"
            >
              <Download className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={onExportJson}
              title={filteredCount === 0 ? 'Nothing to export' : 'Export as JSON'}
              disabled={filteredCount === 0}
              className="p-1.5 border border-[#e3e3de] bg-white text-[#4a4a47] hover:border-[#b5b5b0] hover:bg-[#f6f6f4] transition-all duration-150 cursor-pointer active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-[#e3e3de]"
            >
              <Code className="w-3 h-3" />
            </button>
          </div>

          <button
            type="button"
            onClick={onClearFeed}
            disabled={isClearing || total === 0}
            title="Delete every mention in this workspace"
            className="p-1.5 border border-[#e3e3de] bg-white text-[#b04a4a] hover:border-[#d98d8d] hover:bg-red-50 transition-all duration-150 cursor-pointer active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-[#e3e3de] disabled:text-[#b04a4a]"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* ── Intent distribution ────────────────────────────────────────── */}
      {total > 0 && (
        <div className="px-5 pb-4">
          <div className="flex items-center gap-3">
            <TrendingUp className="w-3 h-3 text-[#b5b5b0] flex-shrink-0" />

            <div className="flex-1 h-1.5 flex gap-0.5 overflow-hidden">
              {(['high', 'medium', 'low'] as const).map((band) =>
                counts[band] > 0 ? (
                  <div
                    key={band}
                    className={`h-full ${BAND_COLOR[band]} transition-all duration-500`}
                    style={{ width: `${pct(counts[band])}%` }}
                    title={`${counts[band]} ${band} intent`}
                  />
                ) : null,
              )}
            </div>

            <div className="flex items-center gap-2.5 flex-shrink-0 text-[10px] font-mono">
              <span className="flex items-center gap-1 text-emerald-700" title="High intent (85+)">
                <Flame className="w-2.5 h-2.5" />
                {counts.high}
              </span>
              <span className="flex items-center gap-1 text-amber-600" title="Medium intent (60-84)">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                {counts.medium}
              </span>
              <span className="flex items-center gap-1 text-[#a8a8a2]" title="Low intent (<60)">
                <Minus className="w-2.5 h-2.5" />
                {counts.low}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/** Shimmering placeholder card used while posts load. */
export const FeedSkeleton: React.FC = () => (
  <div className="space-y-2.5">
    {[0, 1, 2].map((i) => (
      <div
        key={i}
        className="relative overflow-hidden bg-white border border-[#e3e3de] pl-5 pr-5 py-4 sm:py-5"
        style={{ animationDelay: `${i * 120}ms` }}
      >
        <div className="relative z-10 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded bg-[#f0f0ec]" />
            <div className="h-3 w-32 bg-[#f0f0ec]" />
          </div>
          <div className="h-2.5 w-48 bg-[#f4f4f0]" />
          <div className="h-3 w-full bg-[#f4f4f0]" />
          <div className="h-3 w-3/4 bg-[#f4f4f0]" />
        </div>
        <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/70 to-transparent animate-[shimmer_1.6s_infinite]" />
        <style>{`@keyframes shimmer { 100% { transform: translateX(100%); } }`}</style>
      </div>
    ))}
  </div>
);