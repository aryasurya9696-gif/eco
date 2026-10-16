import React from 'react';
import { PlatformBadge } from '../common/PlatformBadge';
import {
  Bookmark,
  CheckCircle2,
  Sparkles,
  ExternalLink,
  ChevronDown,
  Heart,
  Repeat2,
  MessageSquare,
} from 'lucide-react';
import type { MonitoredPost, LeadStatus } from '../../types';

interface FeedCardProps {
  post: MonitoredPost;
  now: number;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  onStatusChange: (id: string, status: LeadStatus) => void;
  onOpenAiDraft: (post: MonitoredPost) => void;
}

/**
 * Intent bands. MUST match the thresholds in the `social-search` and
 * `daily-sweep` edge functions (high >= 85, medium >= 60).
 */
type IntentBand = 'high' | 'medium' | 'low';

function intentBand(score: number): IntentBand {
  if (score >= 85) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

const BAND: Record<
  IntentBand,
  { rail: string; score: string; bar: string; label: string; glow: string }
> = {
  high: {
    rail: 'bg-gradient-to-b from-emerald-500 to-emerald-600',
    score: 'text-emerald-700',
    bar: 'bg-emerald-600',
    label: 'High intent',
    glow: 'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(5,150,105,0.25)]',
  },
  medium: {
    rail: 'bg-gradient-to-b from-amber-400 to-amber-500',
    score: 'text-amber-600',
    bar: 'bg-amber-500',
    label: 'Medium intent',
    glow: '',
  },
  low: {
    rail: 'bg-[#deded8]',
    score: 'text-[#a8a8a2]',
    bar: 'bg-[#cfcfc8]',
    label: 'Low intent',
    glow: '',
  },
};

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return 'unknown time';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown time';

  const diff = now - then;
  if (diff < 60_000) return 'just now';

  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const platformName = (p: MonitoredPost['platform']): string => {
  if (p === 'twitter') return 'X';
  if (p === 'reddit') return 'Reddit';
  if (p === 'google') return 'Web';
  if (p === 'linkedin') return 'LinkedIn';
  return 'News';
};

/** Small muted action button shared by the card footer. */
const GhostButton: React.FC<{
  onClick?: () => void;
  href?: string;
  title: string;
  active?: boolean;
  activeClass?: string;
  children: React.ReactNode;
}> = ({ onClick, href, title, active, activeClass, children }) => {
  const cls = `inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono border transition-all duration-150 active:scale-[0.97] ${
    active
      ? (activeClass ?? 'bg-[#141414] text-white border-[#141414]')
      : 'bg-white text-[#4a4a47] border-[#e3e3de] hover:border-[#b5b5b0] hover:bg-[#f6f6f4]'
  }`;

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} title={title} className={`${cls} cursor-pointer`}>
      {children}
    </button>
  );
};

export const FeedCard: React.FC<FeedCardProps> = ({
  post,
  now,
  isExpanded,
  onToggleExpand,
  onStatusChange,
  onOpenAiDraft,
}) => {
  const score = post.intent_score ?? 0;
  const band = intentBand(score);
  const style = BAND[band];
  const body = post.body ?? '';
  const isLong = body.length > 240;
  const isSaved = post.status === 'saved';
  const isContacted = post.status === 'contacted';

  return (
    <article
      className={`group relative bg-white border pl-5 pr-5 py-4 sm:py-5 transition-all duration-200 ease-out ${
        isSaved ? 'border-[#c9c9c2]' : 'border-[#e8e8e3]'
      } hover:border-[#d0d0ca] hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_20px_-10px_rgba(0,0,0,0.15)] ${
        band === 'high' ? style.glow : ''
      }`}
    >
      {/* Intent rail — colour-codes the card while scrolling */}
      <span
        className={`absolute left-0 top-0 bottom-0 w-[3px] ${style.rail} transition-all duration-300`}
        aria-hidden
      />

      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <PlatformBadge platform={post.platform} size={18} />
            <span className="text-[13.5px] font-semibold text-[#141414] tracking-[-0.01em] truncate">
              {post.author_name || 'Unknown author'}
            </span>
            {post.author_handle && (
              <span className="text-[11.5px] text-[#9b9b96] font-mono truncate hidden sm:inline">
                {post.author_handle}
              </span>
            )}
            {isContacted && (
              <span className="inline-flex items-center gap-1 text-[9.5px] font-mono uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 flex-shrink-0">
                <CheckCircle2 className="w-2.5 h-2.5" />
                Contacted
              </span>
            )}
          </div>

          {/* Context: where it came from and WHY it matched */}
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[11px] font-mono text-[#9b9b96]">
            {isSaved && (
              <span className="inline-flex items-center gap-1 text-[#141414] font-medium">
                <Bookmark className="w-2.5 h-2.5" />
                Saved
              </span>
            )}
            <span>{platformName(post.platform)}</span>
            {post.channel_source && post.channel_source !== platformName(post.platform) && (
              <>
                <Dot />
                <span className="text-[#5f5f5a]">{post.channel_source}</span>
              </>
            )}
            <Dot />
            <span>
              matched <span className="text-[#5f5f5a]">“{post.matched_keyword}”</span>
            </span>
            <Dot />
            {/* Web-search results carry no date at all, so say so rather than
                implying "today" via a stamped created_at. */}
            <span className={post.posted_at ? undefined : 'text-[#a8a8a2]'}>
              {post.posted_at ? relativeTime(post.posted_at, now) : 'date unknown'}
            </span>
          </div>
        </div>

        {/* ── Intent score ────────────────────────────────────────────── */}
        <div className="text-right flex-shrink-0 w-[74px]">
          <div className="flex items-baseline justify-end gap-0.5">
            <span className={`text-[19px] font-bold font-mono leading-none ${style.score}`}>
              {score}
            </span>
            <span className="text-[9.5px] text-[#c9c9c2] font-mono">/100</span>
          </div>
          <div className="mt-1.5 w-full h-1 bg-[#f0f0ec] overflow-hidden">
            <div
              className={`h-full ${style.bar} transition-all duration-500`}
              style={{ width: `${score}%` }}
            />
          </div>
          <div className={`mt-1 text-[9.5px] font-mono tracking-wide ${style.score}`}>
            {style.label}
          </div>
        </div>
      </div>

      {/* ── Body: the reason the card was opened ─────────────────────── */}
      {body && (
        <div className="mt-3.5">
          <p
            className={`text-[13.5px] leading-[1.65] text-[#2a2a28] ${
              isExpanded ? '' : 'line-clamp-3'
            }`}
          >
            {body}
          </p>
          {isLong && (
            <button
              type="button"
              onClick={() => onToggleExpand(post.id)}
              className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-wider text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer"
            >
              {isExpanded ? 'Show less' : 'Show more'}
              <ChevronDown
                className={`w-3 h-3 transition-transform duration-200 ${
                  isExpanded ? 'rotate-180' : ''
                }`}
              />
            </button>
          )}
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <div className="mt-4 pt-3 border-t border-[#f4f4f0] flex items-center justify-between gap-3">
        <div className="flex items-center gap-3.5 text-[11px] font-mono text-[#c9c9c2]">
          {post.engagement?.likes != null && post.engagement.likes > 0 && (
            <span className="flex items-center gap-1 transition-colors group-hover:text-[#9b9b96]">
              <Heart className="w-3 h-3" />
              {post.engagement.likes}
            </span>
          )}
          {(post.engagement?.retweets ?? post.engagement?.reposts) ? (
            <span className="flex items-center gap-1 transition-colors group-hover:text-[#9b9b96]">
              <Repeat2 className="w-3 h-3" />
              {post.engagement?.retweets ?? post.engagement?.reposts ?? 0}
            </span>
          ) : null}
          {(post.engagement?.replies ?? post.engagement?.comments) ? (
            <span className="flex items-center gap-1 transition-colors group-hover:text-[#9b9b96]">
              <MessageSquare className="w-3 h-3" />
              {post.engagement?.replies ?? post.engagement?.comments ?? 0}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          <GhostButton
            title={isSaved ? 'Remove from saved' : 'Save for follow-up'}
            active={isSaved}
            onClick={() => onStatusChange(post.id, isSaved ? 'new' : 'saved')}
          >
            <Bookmark className="w-3 h-3" />
            <span className="hidden sm:inline">{isSaved ? 'Saved' : 'Save'}</span>
          </GhostButton>

          <GhostButton
            title={isContacted ? 'Mark as not contacted' : 'Mark as contacted'}
            active={isContacted}
            activeClass="bg-emerald-700 text-white border-emerald-700"
            onClick={() => onStatusChange(post.id, isContacted ? 'new' : 'contacted')}
          >
            <CheckCircle2 className="w-3 h-3" />
            <span className="hidden sm:inline">
              {isContacted ? 'Contacted' : 'Contact'}
            </span>
          </GhostButton>

          <button
            type="button"
            onClick={() => onOpenAiDraft(post)}
            title="Generate an AI outreach reply"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#141414] hover:bg-black text-white text-[11px] font-mono transition-all duration-150 cursor-pointer active:scale-[0.97]"
          >
            <Sparkles className="w-3 h-3 text-emerald-400" />
            <span className="hidden sm:inline">Draft reply</span>
          </button>

          <GhostButton title="Open the original post" href={post.post_url}>
            <ExternalLink className="w-3 h-3" />
          </GhostButton>
        </div>
      </div>
    </article>
  );
};

/** Tiny separator used in the context line. */
const Dot = () => <span className="text-[#deded8] select-none">·</span>;