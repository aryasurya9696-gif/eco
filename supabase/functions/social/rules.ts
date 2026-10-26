// ============================================================================
// Pure helpers for the social function (unit tested in rules_test.ts).
// ============================================================================

export type SocialPlatform = 'x' | 'reddit';

export const PLATFORMS: readonly SocialPlatform[] = ['x', 'reddit'];

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return value === 'x' || value === 'reddit';
}

/** The feed's platform name for a social platform (monitored_posts.platform). */
export const FEED_PLATFORM: Record<SocialPlatform, string> = { x: 'twitter', reddit: 'reddit' };

/** OAuth 2.0 endpoints and scopes per platform. */
export const OAUTH = {
  x: {
    authorize: 'https://x.com/i/oauth2/authorize',
    token: 'https://api.x.com/2/oauth2/token',
    revoke: 'https://api.x.com/2/oauth2/revoke',
    me: 'https://api.x.com/2/users/me',
    // offline.access returns a refresh token; X access tokens last 2 hours.
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  },
  reddit: {
    authorize: 'https://www.reddit.com/api/v1/authorize',
    token: 'https://www.reddit.com/api/v1/access_token',
    revoke: 'https://www.reddit.com/api/v1/revoke_token',
    me: 'https://oauth.reddit.com/api/v1/me',
    scopes: ['identity', 'submit'],
  },
} as const;

/** Unpadded base64url of some bytes. */
export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A random URL-safe token: 32 bytes is 43 characters. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256 challenge for a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The consent-screen URL for a platform. */
export function authorizeUrl(
  platform: SocialPlatform,
  opts: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const cfg = OAUTH[platform];
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: cfg.scopes.join(' '),
    state: opts.state,
  });
  if (platform === 'x') {
    q.set('code_challenge', opts.challenge);
    q.set('code_challenge_method', 'S256');
  } else {
    // A refresh token, so the connection outlives the 1-hour access token.
    q.set('duration', 'permanent');
  }
  return `${cfg.authorize}?${q.toString()}`;
}

/** What is stored in Vault for one account. */
export interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  /** Epoch milliseconds. */
  expires_at: number;
}

/**
 * Tokens from an OAuth token response, or null when it carries no access
 * token. A refresh response may omit the refresh token (Reddit does), in which
 * case the previous one is kept.
 */
export function parseTokenResponse(json: any, now: number, previousRefresh: string | null = null): StoredTokens | null {
  const access = typeof json?.access_token === 'string' ? json.access_token : '';
  if (!access) return null;
  const ttl = Number(json?.expires_in);
  return {
    access_token: access,
    refresh_token: typeof json?.refresh_token === 'string' && json.refresh_token ? json.refresh_token : previousRefresh,
    expires_at: now + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600) * 1000,
  };
}

/** Refresh a minute early, so a token never expires mid-request. */
export function needsRefresh(tokens: StoredTokens, now: number): boolean {
  return tokens.expires_at - now < 60_000;
}

/**
 * The platform's id for the post a reply goes under, read from its URL:
 * X `/status/<digits>`, Reddit `/comments/<base36>` as its `t3_` fullname.
 */
export function replyTarget(feedPlatform: string, postUrl: string): { platform: SocialPlatform; id: string } | null {
  let url: URL;
  try {
    url = new URL(postUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|mobile|old|new)\./, '');
  if (feedPlatform === 'twitter' && (host === 'x.com' || host === 'twitter.com')) {
    const m = url.pathname.match(/\/status(?:es)?\/(\d{5,25})(?:\/|$)/);
    return m ? { platform: 'x', id: m[1] } : null;
  }
  if (feedPlatform === 'reddit' && (host === 'reddit.com' || host.endsWith('.reddit.com'))) {
    const m = url.pathname.match(/\/comments\/([a-z0-9]{3,12})(?:\/|$)/i);
    return m ? { platform: 'reddit', id: `t3_${m[1].toLowerCase()}` } : null;
  }
  return null;
}

export const MAX_REPLY_LENGTH: Record<SocialPlatform, number> = { x: 280, reddit: 10_000 };

/** Anything X would treat as a link. A post with one costs $0.20 instead of $0.015. */
const LINK_RE = /(https?:\/\/|www\.)\S|\b[a-z0-9-]+\.(com|net|org|io|co|ai|app|dev|me|ly|gg|xyz|so|to)\b/i;

/** The reply text to send, or why it cannot be sent. */
export function checkReplyText(platform: SocialPlatform, raw: unknown): { text: string } | { error: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { error: 'The reply is empty.' };
  const length = [...text].length;
  const max = MAX_REPLY_LENGTH[platform];
  if (length > max) return { error: `The reply is ${length} characters; ${platform === 'x' ? 'X' : 'Reddit'} allows ${max}.` };
  if (platform === 'x' && LINK_RE.test(text)) {
    return { error: 'Replies on X cannot contain links. Remove the link and send again.' };
  }
  return { text };
}

/** Public URL of a sent reply. */
export function replyUrl(platform: SocialPlatform, handle: string, id: string, permalink?: string | null): string {
  if (platform === 'x') return `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(id)}`;
  if (permalink && permalink.startsWith('/')) return `https://www.reddit.com${permalink}`;
  return `https://www.reddit.com/comments/${encodeURIComponent(id)}`;
}

/** Where the OAuth callback sends the browser back to: Settings, with the outcome in the query. */
export function returnUrl(appOrigin: string, outcome: { ok: true; platform: SocialPlatform } | { ok: false; reason: string }): string {
  const q = new URLSearchParams(
    outcome.ok ? { social: 'connected', platform: outcome.platform } : { social: 'error', reason: outcome.reason.slice(0, 60) },
  );
  return `${appOrigin.replace(/\/+$/, '')}/?${q.toString()}#dashboard/settings`;
}
