/**
 * AI feature client (OpenAI via the `ai` Edge Function)
 * ----------------------------------------------------------------------------
 * The OpenAI key lives in the Edge Function environment. If the function is not
 * deployed, `generateAiKeywordsFromOffer` falls back to local heuristics and
 * `generateAiOutreachDraft` falls back to a template.
 */
import type { MonitoredPost } from '../types';
import { invokeFunction } from './api';

export type DraftTone = 'professional' | 'casual' | 'consultative' | 'direct';

interface KeywordResponse {
  ok: boolean;
  keywords: string[];
  source: 'openai' | 'fallback';
}

interface DraftResponse {
  ok: boolean;
  draft: string;
  source: 'openai' | 'fallback';
}

/**
 * Semantic buyer-intent keyword suggestions derived from the user's core offer.
 */
export async function generateAiKeywordsFromOffer(
  offerText: string,
  website?: string,
): Promise<string[]> {
  const fallback = () => fallbackKeywordSuggestions(offerText?.trim() ?? '');

  try {
    const res = await invokeFunction<KeywordResponse>(
      'ai',
      { action: 'keywords', offerText, website },
      { fallback, timeoutMs: 20000 },
    );
    if (Array.isArray(res?.keywords) && res.keywords.length > 0) {
      return res.keywords.map((k) => String(k).trim().toLowerCase()).slice(0, 8);
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
 * Heuristic keyword suggestions — used when the AI function is unreachable.
 */
export function fallbackKeywordSuggestions(clean: string): string[] {
  const lower = clean.toLowerCase();
  if (lower.includes('agent') || lower.includes('ai')) {
    return [
      'autonomous ai agents',
      'ai lead qualification',
      'ai sales workflow',
      'agentic outbound',
      'crm ai enrichment',
    ];
  }
  if (lower.includes('sales') || lower.includes('lead') || lower.includes('outbound')) {
    return [
      'b2b lead gen',
      'outbound pipeline',
      'sales automation',
      'buyer intent signal',
      'cold outreach alternative',
    ];
  }
  if (lower.includes('dev') || lower.includes('api') || lower.includes('code')) {
    return [
      'developer api',
      'backend workflow',
      'serverless automation',
      'automation webhook',
      'social scraping api',
    ];
  }
  return [
    'ai agents',
    'b2b lead gen',
    'sales automation',
    'outbound pipeline',
    'crm workflow',
    'intent data',
    'social listening',
  ];
}

/**
 * Template outreach reply — used when the AI function is unreachable.
 */
function fallbackAiDraft(post: MonitoredPost, tone: DraftTone): string {
  const author = post.author_name ? post.author_name.split(' ')[0] : 'there';
  const keyword = post.matched_keyword || 'this topic';

  switch (tone) {
    case 'casual':
      return `Hey ${author}, saw your post regarding ${keyword}. We actually tackled this exact problem recently. Would love to share our benchmark notes if you're open to a quick comparison!`;
    case 'consultative':
      return `Hi ${author}, your observation about ${keyword} is spot-on. Many teams struggle with this transition. We put together a brief workflow analysis on how to optimize this without bloatware — happy to share the breakdown if helpful!`;
    case 'direct':
      return `Hi ${author}, noticed your requirement for ${keyword}. Are you available for a quick 5-minute walkthrough this week?`;
    case 'professional':
    default:
      return `Hello ${author}, I came across your post about ${keyword}. We specialize in solving this challenge with streamlined automation. I would welcome the opportunity to connect and exchange thoughts on your current architecture.`;
  }
}