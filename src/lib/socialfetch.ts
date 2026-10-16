/**
 * Social Fetch API Client for Echo
 * Base URL: https://api.socialfetch.dev
 * Canonical docs: https://www.socialfetch.dev/docs
 */
import type { MonitoredPost, Platform } from '../types';

const SOCIAL_FETCH_BASE_URL = 'https://api.socialfetch.dev';
const SOCIAL_FETCH_API_KEY =
  import.meta.env.VITE_SOCIAL_FETCH_API_KEY ||
  'REMOVED_ROTATE_ME';

export interface SocialFetchWhoamiResponse {
  data: {
    user: {
      id: string;
      name: string;
      email: string;
    };
    workspace: {
      id: string;
      name: string;
      role: string;
      isPersonal: boolean;
    };
  };
  meta: {
    requestId: string;
    creditsCharged: number;
    version: string;
  };
}

export interface SocialFetchBalanceResponse {
  data: {
    balance: number;
    payg: number;
    paygSpendable: number;
    billingAlert: string;
    collectionStatus: string;
  };
  meta: {
    requestId: string;
    creditsCharged: number;
  };
}

/**
 * Perform authenticated request to Social Fetch API
 */
async function fetchSocialApi<T>(endpoint: string, options: RequestInit = {}): Promise<T | null> {
  const apiKey = SOCIAL_FETCH_API_KEY;
  if (!apiKey) {
    console.warn('[SocialFetch] No API key configured');
    return null;
  }

  const url = `${SOCIAL_FETCH_BASE_URL}${endpoint}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[SocialFetch] HTTP ${res.status} on ${endpoint}:`, errText);
      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    console.error(`[SocialFetch] Network error calling ${endpoint}:`, err);
    return null;
  }
}

/**
 * Validate Social Fetch authentication credentials
 */
export async function getSocialFetchWhoami(): Promise<SocialFetchWhoamiResponse | null> {
  return fetchSocialApi<SocialFetchWhoamiResponse>('/v1/whoami');
}

/**
 * Check remaining credits and balance
 */
export async function getSocialFetchBalance(): Promise<SocialFetchBalanceResponse | null> {
  return fetchSocialApi<SocialFetchBalanceResponse>('/v1/balance');
}

/**
 * Calculate buyer intent score based on keywords and linguistic patterns
 */
export function calculateIntentScore(text: string): number {
  if (!text) return 85;
  const lower = text.toLowerCase();
  
  const highIntentKeywords = [
    'looking for',
    'recommend',
    'recommendation',
    'alternative to',
    'switching from',
    'anyone using',
    'best tool for',
    'pricing',
    'buy',
    'budget',
    'quote',
    'need software',
    'any suggestions',
    'help choosing',
    'rfp',
    'demo',
  ];

  let score = 84;
  for (const phrase of highIntentKeywords) {
    if (lower.includes(phrase)) {
      score += 4;
    }
  }

  // Cap between 75 and 99
  return Math.min(99, Math.max(75, score));
}

/**
 * Search Reddit for buyer intent posts matching a keyword
 */
export async function fetchRedditPostsForKeyword(
  keyword: string,
  userId: string,
  keywordId?: string
): Promise<MonitoredPost[]> {
  const query = encodeURIComponent(keyword);
  const data = await fetchSocialApi<{
    data?: {
      posts?: Array<{
        id: string;
        title?: string | null;
        author?: string | null;
        subreddit?: string | null;
        url?: string | null;
        permalink?: string | null;
        bodyText?: string | null;
        score?: number | null;
        commentCount?: number | null;
        createdAt?: string | null;
      }>;
    };
  }>(`/v1/reddit/search?query=${query}&timeframe=week&sortBy=new`);

  if (!data?.data?.posts) return [];

  return data.data.posts.map((p) => {
    const fullText = `${p.title || ''} ${p.bodyText || ''}`.trim();
    const intent = calculateIntentScore(fullText);

    return {
      id: `reddit_${p.id}`,
      user_id: userId,
      keyword_id: keywordId,
      matched_keyword: keyword,
      platform: 'reddit' as Platform,
      channel_source: p.subreddit ? `r/${p.subreddit}` : 'r/reddit',
      post_url: p.permalink || p.url || `https://reddit.com/r/${p.subreddit || 'all'}`,
      author_name: p.author ? `u/${p.author}` : 'u/anonymous',
      author_handle: p.author ? `@${p.author}` : null,
      author_avatar_url: null,
      body: fullText,
      posted_at: p.createdAt || new Date().toISOString(),
      intent_score: intent,
      intent_level: intent >= 90 ? 'high' : intent >= 80 ? 'medium' : 'low',
      status: 'new',
      engagement: {
        likes: p.score ?? 0,
        comments: p.commentCount ?? 0,
      },
      created_at: new Date().toISOString(),
    };
  });
}

/**
 * Search X / Twitter for buyer intent tweets matching a keyword
 */
export async function fetchTwitterPostsForKeyword(
  keyword: string,
  userId: string,
  keywordId?: string
): Promise<MonitoredPost[]> {
  const query = encodeURIComponent(keyword);
  const data = await fetchSocialApi<{
    data?: {
      tweets?: Array<{
        id: string;
        url?: string | null;
        text?: string | null;
        createdAt?: string | null;
        author?: {
          handle?: string | null;
          displayName?: string | null;
          avatarUrl?: string | null;
          metrics?: {
            followers?: number | null;
          };
        };
        metrics?: {
          likes?: number | null;
          retweets?: number | null;
          replies?: number | null;
          quotes?: number | null;
        };
      }>;
    };
  }>(`/v1/twitter/search?query=${query}`);

  if (!data?.data?.tweets) return [];

  return data.data.tweets.map((t) => {
    const text = t.text || '';
    const intent = calculateIntentScore(text);

    return {
      id: `tw_${t.id}`,
      user_id: userId,
      keyword_id: keywordId,
      matched_keyword: keyword,
      platform: 'twitter' as Platform,
      channel_source: 'X / Twitter Feed',
      post_url: t.url || `https://x.com/i/status/${t.id}`,
      author_name: t.author?.displayName || t.author?.handle || 'X User',
      author_handle: t.author?.handle ? `@${t.author.handle}` : null,
      author_avatar_url: t.author?.avatarUrl || null,
      body: text,
      posted_at: t.createdAt || new Date().toISOString(),
      intent_score: intent,
      intent_level: intent >= 90 ? 'high' : intent >= 80 ? 'medium' : 'low',
      status: 'new',
      engagement: {
        likes: t.metrics?.likes ?? 0,
        retweets: t.metrics?.retweets ?? 0,
        replies: t.metrics?.replies ?? 0,
      },
      created_at: new Date().toISOString(),
    };
  });
}

/**
 * Search Web / Discussions via Social Fetch
 */
export async function fetchWebPostsForKeyword(
  keyword: string,
  userId: string,
  keywordId?: string
): Promise<MonitoredPost[]> {
  const query = encodeURIComponent(keyword);
  const data = await fetchSocialApi<{
    data?: {
      results?: Array<{
        title?: string | null;
        url?: string | null;
        content?: string | null;
      }>;
    };
  }>(`/v1/web/search?query=${query}`);

  if (!data?.data?.results) return [];

  return data.data.results.map((r, idx) => {
    const text = `${r.title || ''} — ${r.content || ''}`.trim();
    const intent = calculateIntentScore(text);

    let domain = 'Web';
    try {
      if (r.url) domain = new URL(r.url).hostname.replace('www.', '');
    } catch {
      domain = 'Web';
    }

    return {
      id: `web_${Date.now()}_${idx}`,
      user_id: userId,
      keyword_id: keywordId,
      matched_keyword: keyword,
      platform: 'google' as Platform,
      channel_source: domain,
      post_url: r.url || 'https://google.com',
      author_name: r.title || 'Discussion Participant',
      author_handle: `@${domain}`,
      author_avatar_url: null,
      body: text,
      posted_at: new Date().toISOString(),
      intent_score: intent,
      intent_level: intent >= 90 ? 'high' : intent >= 80 ? 'medium' : 'low',
      status: 'new',
      engagement: {
        likes: 0,
        comments: 0,
      },
      created_at: new Date().toISOString(),
    };
  });
}

/**
 * Run a multi-platform live sweep using Social Fetch
 */
export async function performSocialFetchSweep(
  keywords: Array<{ id: string; keyword: string }>,
  userId: string,
  enabledChannels: Platform[] = ['twitter', 'reddit', 'google']
): Promise<MonitoredPost[]> {
  const allPosts: MonitoredPost[] = [];
  const seenUrls = new Set<string>();

  for (const kw of keywords) {
    try {
      const fetchTasks: Promise<MonitoredPost[]>[] = [];

      // Only trigger scrapers for channels enabled by the user
      if (enabledChannels.includes('reddit')) {
        fetchTasks.push(fetchRedditPostsForKeyword(kw.keyword, userId, kw.id));
      }
      if (enabledChannels.includes('twitter')) {
        fetchTasks.push(fetchTwitterPostsForKeyword(kw.keyword, userId, kw.id));
      }
      if (enabledChannels.includes('google')) {
        fetchTasks.push(fetchWebPostsForKeyword(kw.keyword, userId, kw.id));
      }

      const results = await Promise.allSettled(fetchTasks);

      const candidatePosts: MonitoredPost[] = [];
      for (const res of results) {
        if (res.status === 'fulfilled' && Array.isArray(res.value)) {
          candidatePosts.push(...res.value);
        }
      }

      for (const post of candidatePosts) {
        const normalizedUrl = post.post_url?.trim().toLowerCase();
        if (normalizedUrl && !seenUrls.has(normalizedUrl)) {
          seenUrls.add(normalizedUrl);
          allPosts.push(post);
        }
      }
    } catch (err) {
      console.error(`[SocialFetch] Failed to sweep keyword "${kw.keyword}":`, err);
    }
  }

  return allPosts;
}
