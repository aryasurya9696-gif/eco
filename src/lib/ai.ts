/**
 * AI feature client (OpenAI via the `ai` Edge Function)
 * ----------------------------------------------------------------------------
 * The OpenAI key lives in the Edge Function environment. If the function is not
 * deployed, or the key is not set, `generateAiKeywordsFromOffer` returns
 * heuristic suggestions and `generateAiOutreachDraft` returns a template. Both
 * responses carry a `source` so the UI can say which one it got.
 */
import type { MonitoredPost } from '../types';
import { invokeFunction } from './api';

export type DraftTone = 'professional' | 'casual' | 'consultative' | 'direct';

/** Mirrors the channel ids the sweep functions accept. */
export type SuggestionChannel = 'x' | 'reddit' | 'web' | 'news';

export interface KeywordSuggestion {
  phrase: string;
  intent: 'high' | 'medium' | 'low';
  /** 0-97, same scale the sweep's intent scorer produces. */
  score: number;
  channels: SuggestionChannel[];
  /** Short reason this phrase is worth tracking. */
  why: string;
}

export interface KeywordSuggestionResult {
  /** One line naming who the model thinks this is for. */
  icp: string;
  suggestions: KeywordSuggestion[];
  /** Phrases that would drag in noise for this product. */
  avoid: string[];
  source: 'openai' | 'fallback';
}

export interface KeywordRequestContext {
  /** Keywords already tracked, so the model never repeats them. */
  existingKeywords?: string[];
  /** Channels the workspace actually scans. */
  channels?: string[];
  /** How many keywords the plan still allows. */
  slots?: number;
  lookbackHours?: number;
}

interface KeywordResponse extends KeywordSuggestionResult {
  ok: boolean;
}

interface DraftResponse {
  ok: boolean;
  draft: string;
  source: 'openai' | 'fallback';
}

/**
 * Buyer-intent keyword suggestions derived from the user's core offer, the
 * content of their own website, and the channels their plan scans.
 */
export async function generateAiKeywordsFromOffer(
  offerText: string,
  website?: string,
  ctx: KeywordRequestContext = {},
): Promise<KeywordSuggestionResult> {
  const fallback = (): KeywordSuggestionResult => fallbackKeywordSuggestions(
    offerText?.trim() ?? '',
    new Set((ctx.existingKeywords ?? []).map((k) => k.toLowerCase().trim())),
    ctx.channels ?? [],
    ctx.slots ?? 10,
  );

  try {
    const res = await invokeFunction<KeywordResponse>(
      'ai',
      {
        action: 'keywords',
        offerText,
        website,
        existingKeywords: ctx.existingKeywords,
        channels: ctx.channels,
        slots: ctx.slots,
        lookbackHours: ctx.lookbackHours,
      },
      { fallback, timeoutMs: 30000 },
    );

    if (Array.isArray(res?.suggestions) && res.suggestions.length > 0) {
      return {
        icp: res.icp ?? '',
        suggestions: res.suggestions
          .map((s) => ({
            phrase: String(s?.phrase ?? '').trim().toLowerCase(),
            intent: (s?.intent === 'high' || s?.intent === 'medium' ? s.intent : 'low') as
              | 'high' | 'medium' | 'low',
            score: Number(s?.score) || 0,
            channels: Array.isArray(s?.channels) ? s.channels : [],
            why: String(s?.why ?? '').trim(),
          }))
          .filter((s) => s.phrase.length > 0),
        avoid: Array.isArray(res.avoid) ? res.avoid : [],
        source: res.source ?? 'fallback',
      };
    }
  } catch (err) {
    console.warn('[ai] keyword suggestions unavailable, using heuristics:', err);
  }
  return fallback();
}

/**
 * Personalized outreach reply for a single lead.
 */
export async function generateAiOutreachDraft(
  post: MonitoredPost,
  tone: DraftTone,
  userOffer?: string,
  userName?: string,
): Promise<string> {
  const fallback = () => fallbackAiDraft(post, tone);

  try {
    const res = await invokeFunction<DraftResponse>(
      'ai',
      {
        action: 'draft',
        tone,
        userOffer,
        userName,
        post: {
          platform: post.platform,
          author_name: post.author_name,
          author_handle: post.author_handle,
          body: post.body,
          matched_keyword: post.matched_keyword,
        },
      },
      { fallback, timeoutMs: 25000 },
    );
    if (res?.draft && res.draft.length > 20) return res.draft;
  } catch (err) {
    console.warn('[ai] draft generation unavailable, using template:', err);
  }
  return fallback();
}

/**
 * Heuristic suggestions, mirrored from the edge function. Pairing category nouns
 * with buyer task wording ("alternative to X", "X pricing") is what makes these
 * score better than a bare category noun, and it works without any API key.
 */
export function fallbackKeywordSuggestions(
  clean: string,
  existing: Set<string> = new Set(),
  channels: string[] = [],
  slots = 10,
): KeywordSuggestionResult {
  const lower = clean.toLowerCase();
  const allowed: SuggestionChannel[] = [];
  for (const raw of channels) {
    const s = raw.toLowerCase();
    if (s === 'twitter' || s === 'x') allowed.push('x');
    else if (s === 'google') allowed.push('web');
    else if (s === 'reddit' || s === 'news') allowed.push(s as SuggestionChannel);
  }

  const CATEGORY_HINTS: Array<{ match: RegExp; core: string[] }> = [
    { match: /\b(shared inbox|team inbox|customer inbox|inbox)\b/i, core: ['shared inbox', 'team inbox'] },
    { match: /\b(helpdesk|support desk|support ticket|ticketing)\b/i, core: ['helpdesk', 'ticketing system'] },
    { match: /\b(agentic|ai agents?|llm|agent framework)\b/i, core: ['ai agent', 'agentic workflow'] },
    { match: /\b(sdr|outbound|prospecting)\b/i, core: ['outbound sales', 'sdr workflow'] },
    { match: /\b(sales team|sales tool|sales automation|b2b lead)\b/i, core: ['b2b sales tool', 'sales automation'] },
    { match: /\bcrm\b/i, core: ['crm workflow', 'crm automation'] },
    { match: /\b(email|newsletter|campaign|outreach)\b/i, core: ['email outreach', 'email automation'] },
    { match: /\b(api|webhook|integration|sync|developer)\b/i, core: ['developer api', 'workflow integration'] },
    { match: /\b(scrap|crawl|monitor|listening|tracking)\b/i, core: ['social listening', 'monitoring tool'] },
    { match: /\b(seo|keyword|rank)\b/i, core: ['seo tool', 'keyword tracking'] },
  ];

  const matched = CATEGORY_HINTS.filter((h) => h.match.test(lower)).flatMap((h) => h.core);
  // Two categories: the smallest plan allows 5 keywords, and a third set only
  // filled the list with near-duplicates of the weakest one.
  const cats = (matched.length ? matched : ['b2b saas tool', 'workflow software']).slice(0, 2);

  const suggestions: KeywordSuggestion[] = [];
  const seen = new Set<string>();
  const push = (phrase: string, intent: 'high' | 'medium' | 'low', score: number, why: string) => {
    const key = phrase.toLowerCase();
    if (!key || seen.has(key) || existing.has(key)) return;
    seen.add(key);
    suggestions.push({ phrase: key, intent, score, channels: allowed.slice(0, 2), why });
  };

  cats.forEach((cat, i) => {
    const base = 76 - i * 6;
    push(cat, i === 0 ? 'high' : 'medium', base, 'Matches how buyers name the category');
    push(`alternative to ${cat}`, 'high', base + 4, 'Comparison shoppers ask for this');
    push(`${cat} pricing`, 'high', base + 2, 'Pricing means an active evaluation');
  });
  push(`how to evaluate a ${cats[0]}`, 'medium', 58, 'Research-stage buyers search this');
  push(`is there a better ${cats[0]}`, 'medium', 56, 'Open-ended dissatisfaction');

  return {
    icp: '',
    suggestions: suggestions.slice(0, slots),
    avoid: ['hiring', 'job opening', 'free template', 'tutorial'],
    source: 'fallback',
  };
}

/**
 * Template outreach reply — used when the AI function is unreachable.
 */
function fallbackAiDraft(post: MonitoredPost, tone: DraftTone): string {
  const author = post.author_name ? post.author_name.split(' ')[0] : 'there';
  const keyword = post.matched_keyword || 'this topic';

  switch (tone) {
    case 'casual':
      return `Hey ${author}, saw your post regarding ${keyword}. We actually tackled this exact problem recently. Would love to share our benchmark notes if you are open to a quick comparison!`;
    case 'consultative':
      return `Hi ${author}, your observation about ${keyword} is spot-on. Many teams struggle with this transition. We put together a brief workflow analysis on how to optimize this without bloatware — happy to share the breakdown if helpful!`;
    case 'direct':
      return `Hi ${author}, noticed your requirement for ${keyword}. Are you available for a quick 5-minute walkthrough this week?`;
    case 'professional':
    default:
      return `Hello ${author}, I came across your post about ${keyword}. We specialize in solving this challenge with streamlined automation. I would welcome the opportunity to connect and exchange thoughts on your current architecture.`;
  }
}