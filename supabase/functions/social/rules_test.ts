import { createHash } from 'node:crypto';
import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  authorizeUrl,
  checkReplyText,
  needsRefresh,
  parseTokenResponse,
  pkceChallenge,
  randomToken,
  replyTarget,
  replyUrl,
  returnUrl,
  tokenFailureKind,
} from './rules.ts';

Deno.test('pkceChallenge: unpadded base64url SHA-256 of the verifier (RFC 7636 S256)', async () => {
  const verifier = randomToken(48);
  assertEquals(await pkceChallenge(verifier), createHash('sha256').update(verifier).digest('base64url'));
  assert(/^[A-Za-z0-9_-]{43}$/.test(randomToken(32)));
});

Deno.test('authorizeUrl: PKCE for X, permanent duration for Reddit', () => {
  const opts = { clientId: 'cid', redirectUri: 'https://p.supabase.co/functions/v1/social', state: 's'.repeat(43), challenge: 'ch' };
  const x = new URL(authorizeUrl('x', opts));
  assertEquals(x.origin + x.pathname, 'https://x.com/i/oauth2/authorize');
  assertEquals(x.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(x.searchParams.get('scope'), 'tweet.read tweet.write users.read offline.access');
  const r = new URL(authorizeUrl('reddit', opts));
  assertEquals(r.searchParams.get('duration'), 'permanent');
  assertEquals(r.searchParams.get('code_challenge'), null);
});

Deno.test('parseTokenResponse: keeps the old refresh token when a refresh omits it', () => {
  assertEquals(parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 7200 }, 1000), {
    access_token: 'a',
    refresh_token: 'r',
    expires_at: 1000 + 7_200_000,
  });
  assertEquals(parseTokenResponse({ access_token: 'b', expires_in: 3600 }, 0, 'old')?.refresh_token, 'old');
  assertEquals(parseTokenResponse({ error: 'invalid_grant' }, 0), null);
  assert(needsRefresh({ access_token: 'a', refresh_token: null, expires_at: 30_000 }, 0));
  assert(!needsRefresh({ access_token: 'a', refresh_token: null, expires_at: 120_000 }, 0));
});

Deno.test('replyTarget: X status id and Reddit t3_ fullname from the post URL', () => {
  assertEquals(replyTarget('twitter', 'https://x.com/jane/status/1790000000000000001'), { platform: 'x', id: '1790000000000000001' });
  assertEquals(replyTarget('twitter', 'https://mobile.twitter.com/jane/status/1790000000000000001/photo/1'), {
    platform: 'x',
    id: '1790000000000000001',
  });
  assertEquals(replyTarget('reddit', 'https://www.reddit.com/r/SaaS/comments/1V7Z1M7/need_a_crm/'), { platform: 'reddit', id: 't3_1v7z1m7' });
  assertEquals(replyTarget('reddit', 'https://evil.example/r/x/comments/abc123/'), null);
  assertEquals(replyTarget('google', 'https://x.com/jane/status/1790000000000000001'), null);
  assertEquals(replyTarget('twitter', 'not a url'), null);
});

Deno.test('checkReplyText: length per platform; links refused on X only', () => {
  assertEquals(checkReplyText('x', '  Happy to help!  '), { text: 'Happy to help!' });
  assert('error' in checkReplyText('x', ''));
  assert('error' in checkReplyText('x', 'a'.repeat(281)));
  assert('error' in checkReplyText('x', 'see https://acme.com'));
  assert('error' in checkReplyText('x', 'try acme.io today'));
  assertEquals(checkReplyText('reddit', 'see https://acme.com'), { text: 'see https://acme.com' });
  assert('text' in checkReplyText('reddit', 'a'.repeat(5000)));
});

Deno.test('replyUrl and returnUrl', () => {
  assertEquals(replyUrl('x', 'jane', '123'), 'https://x.com/jane/status/123');
  assertEquals(replyUrl('reddit', 'jane', 'abc', '/r/SaaS/comments/x/y/abc/'), 'https://www.reddit.com/r/SaaS/comments/x/y/abc/');
  assertEquals(returnUrl('https://app.example/', { finish: 'abc' }), 'https://app.example/?social=finish&state=abc#dashboard/settings');
  assertEquals(returnUrl('https://app.example', { error: 'denied' }), 'https://app.example/?social=error&reason=denied#dashboard/settings');
});

Deno.test('tokenFailureKind: only a dead grant forces a reconnect', () => {
  assertEquals(tokenFailureKind(400, { error: 'invalid_grant' }), 'invalid');
  assertEquals(tokenFailureKind(401, null), 'invalid');
  assertEquals(tokenFailureKind(200, { error: 'invalid_grant' }), 'invalid');
  assertEquals(tokenFailureKind(503, null), 'transient');
  assertEquals(tokenFailureKind(429, { error: 'rate_limited' }), 'transient');
  assertEquals(tokenFailureKind(null, null), 'transient');
});
