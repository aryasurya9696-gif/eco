// ============================================================================
// Supabase Edge Function: social
// ----------------------------------------------------------------------------
// Connected X and Reddit accounts, and 1-click replies from the feed.
//
//   POST {action}            the signed-in user's requests (JWT checked here)
//     providers              which platforms are set up on this deployment
//     connect_start          returns the platform's consent URL
//     connect_finish         completes a connection after the consent screen
//     list_accounts          the user's connected accounts
//     disconnect             revokes the tokens and removes the account
//     reply                  posts a reply under a feed post
//   GET ?state&code          the OAuth redirect from X / Reddit
//
// Echo uses its own OAuth apps: treg's OAuth connections belong to a whole
// team, so through treg every Echo user would post as the same account. The
// tokens are kept in Supabase Vault (social_accounts.vault_secret_id).
//
// Connecting is two steps on purpose. The redirect stores nothing: it hands the
// code back to Echo in the consenting browser, whose signed-in user then calls
// connect_finish with it, and that is refused unless the same user started the
// connection. The code never reaches the server unless the person who gave
// consent is the one finishing, so a consent URL forwarded to someone else
// cannot attach their account to the sender's workspace.
//
// A reply is charged from the wallet like a mail send: credits held before
// the platform call, charged when the platform accepts it, released when it
// refuses. A call that times out is "uncertain": it may have been posted, so
// it is charged and the post stays blocked until the user confirms a resend
// (confirm_resend: true). Purchased credits only. A human always clicks Send
// on text they can see; nothing here posts on a schedule.
//
// Deploy with JWT verification OFF (the OAuth redirect carries no JWT); every
// POST action checks the caller's JWT itself and fails closed.
//
// Secrets:
//   X_CLIENT_ID, X_CLIENT_SECRET              X developer app (OAuth 2.0, confidential)
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET    Reddit "web app"
//   REDDIT_USER_AGENT                         e.g. web:echo:1.0 (by /u/yourname)
//   APP_ORIGIN                                where the browser returns after consent
// Redirect URI to register with both apps: <SUPABASE_URL>/functions/v1/social
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';
import {
  authorizeUrl,
  checkReplyText,
  FEED_PLATFORM,
  isSocialPlatform,
  needsRefresh,
  OAUTH,
  parseTokenResponse,
  pkceChallenge,
  PLATFORMS,
  randomToken,
  replyTarget,
  replyUrl,
  returnUrl,
  STALE_CLAIM_MS,
  tokenFailureKind,
  type SocialPlatform,
  type StoredTokens,
} from './rules.ts';

const ALLOWED_ORIGINS = [...(Deno.env.get('ALLOWED_ORIGIN') || '').split(','), Deno.env.get('APP_ORIGIN') || '']
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const o = origin.replace(/\/+$/, '');
  if (ALLOWED_ORIGINS.includes('*')) return '*';
  if (ALLOWED_ORIGINS.includes(o)) return o;
  if (ALLOWED_ORIGINS.length === 0 && DEV_ORIGIN_RE.test(o)) return o;
  return null;
}

function withCors(req: Request, res: Response): Response {
  const origin = allowedOrigin(req.headers.get('Origin'));
  if (origin) res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Vary', 'Origin');
  res.headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return res;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, message, ...extra }, status);
}

/** Verifies the caller's JWT server-side. */
async function requireUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) return null;
  try {
    const res = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: anonKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_TIMEOUT_MS = 15_000;
const STATE_TTL_MS = 10 * 60_000;
/** How long one request may hold an account's refresh lease. */
const REFRESH_LEASE_MS = 30_000;
const PRICE_OP: Record<SocialPlatform, string> = { x: 'social.reply.x', reddit: 'social.reply.reddit' };
/** What the platform charges Echo per reply (X bills the app owner per post). */
const PROVIDER_COST_USD: Record<SocialPlatform, number> = { x: 0.015, reddit: 0 };
const PLATFORM_LABEL: Record<SocialPlatform, string> = { x: 'X', reddit: 'Reddit' };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/social`;
const APP_ORIGIN = (Deno.env.get('APP_ORIGIN') || '').replace(/\/+$/, '');
const REDDIT_USER_AGENT = Deno.env.get('REDDIT_USER_AGENT') || 'web:echo-social:1.0';

function clientCredentials(platform: SocialPlatform): { id: string; secret: string } | null {
  const prefix = platform === 'x' ? 'X' : 'REDDIT';
  const id = Deno.env.get(`${prefix}_CLIENT_ID`) || '';
  const secret = Deno.env.get(`${prefix}_CLIENT_SECRET`) || '';
  return id && secret ? { id, secret } : null;
}

function basicAuth(c: { id: string; secret: string }): string {
  return `Basic ${btoa(`${c.id}:${c.secret}`)}`;
}

/** Headers every Reddit call needs; Reddit throttles requests without a descriptive User-Agent. */
function platformHeaders(platform: SocialPlatform, extra: Record<string, string> = {}): Record<string, string> {
  return platform === 'reddit' ? { 'User-Agent': REDDIT_USER_AGENT, ...extra } : extra;
}

function admin() {
  return createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
}
type Admin = ReturnType<typeof admin>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// OAuth token handling
// ---------------------------------------------------------------------------

type TokenResult = { tokens: StoredTokens } | { error: 'invalid' | 'transient' };

/** POSTs a form to a platform's token endpoint. */
async function tokenRequest(
  platform: SocialPlatform,
  form: Record<string, string>,
  previousRefresh: string | null = null,
): Promise<TokenResult> {
  const creds = clientCredentials(platform);
  if (!creds) return { error: 'transient' };
  try {
    const res = await fetch(OAUTH[platform].token, {
      method: 'POST',
      headers: platformHeaders(platform, {
        Authorization: basicAuth(creds),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      }),
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.warn(`[social] ${platform} token request failed: ${res.status}`);
      return { error: tokenFailureKind(res.status, body) };
    }
    const tokens = parseTokenResponse(body, Date.now(), previousRefresh);
    return tokens ? { tokens } : { error: tokenFailureKind(res.status, body) };
  } catch (err: any) {
    console.warn(`[social] ${platform} token request error:`, err?.name || err?.message);
    return { error: 'transient' };
  }
}

/** The platform's id and handle for the account behind a token. */
async function whoAmI(platform: SocialPlatform, accessToken: string): Promise<{ id: string; handle: string } | null> {
  try {
    const res = await fetch(OAUTH[platform].me, {
      headers: platformHeaders(platform, { Authorization: `Bearer ${accessToken}` }),
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const me = platform === 'x' ? body?.data : body;
    const id = String(me?.id ?? '');
    const handle = String((platform === 'x' ? me?.username : me?.name) ?? '');
    return id && handle ? { id: id.slice(0, 100), handle: handle.slice(0, 100) } : null;
  } catch {
    return null;
  }
}

async function readTokens(db: Admin, secretId: string): Promise<StoredTokens | null> {
  const { data: raw, error } = await db.rpc('get_social_secret', { p_secret_id: secretId });
  if (error || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

/**
 * A usable access token for an account, refreshed when it is about to expire.
 *
 * X refresh tokens are single-use, so two requests refreshing at once would
 * strand the account: only the holder of a short lease
 * (social_accounts.refreshing_until) refreshes, and the others wait and
 * re-read the tokens it saved. Only a dead grant marks the account
 * needs_reauth; a timeout or 5xx is reported as `transient`.
 */
async function accessTokenFor(db: Admin, account: any): Promise<string | 'reauth' | 'transient'> {
  if (!account.vault_secret_id) return 'reauth';
  for (let attempt = 0; attempt < 6; attempt++) {
    const tokens = await readTokens(db, account.vault_secret_id);
    if (!tokens) return 'reauth';
    if (!needsRefresh(tokens, Date.now())) return tokens.access_token;
    if (!tokens.refresh_token) break;

    const now = new Date();
    const { data: lease } = await db
      .from('social_accounts')
      .update({ refreshing_until: new Date(now.getTime() + REFRESH_LEASE_MS).toISOString() })
      .eq('id', account.id)
      .or(`refreshing_until.is.null,refreshing_until.lt."${now.toISOString()}"`)
      .select('id');
    if (!lease?.length) {
      // Another request is refreshing: wait for the tokens it saves.
      await sleep(1000);
      if (attempt === 5) return 'transient';
      continue;
    }
    // Re-read under the lease: a refresh that finished between the first read
    // and taking the lease has already rotated the refresh token.
    const current = await readTokens(db, account.vault_secret_id);
    if (current && !needsRefresh(current, Date.now())) {
      await db.from('social_accounts').update({ refreshing_until: null }).eq('id', account.id);
      return current.access_token;
    }
    if (current?.refresh_token) tokens.refresh_token = current.refresh_token;

    const platform = account.platform as SocialPlatform;
    const result = await tokenRequest(
      platform,
      { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, ...(platform === 'x' ? { client_id: clientCredentials('x')?.id ?? '' } : {}) },
      tokens.refresh_token,
    );
    if ('error' in result) {
      await db.from('social_accounts').update({ refreshing_until: null }).eq('id', account.id);
      if (result.error === 'transient') return 'transient';
      break;
    }
    // The rotated refresh token must be saved, or the account is dead at the next refresh.
    let saved = false;
    for (let i = 0; i < 3 && !saved; i++) {
      const { error } = await db.rpc('update_social_secret', {
        p_secret_id: account.vault_secret_id,
        p_secret: JSON.stringify(result.tokens),
      });
      saved = !error;
      if (error) console.error('[social] token refresh not saved:', error.message);
    }
    await db.from('social_accounts').update({ refreshing_until: null }).eq('id', account.id);
    if (!saved) break;
    return result.tokens.access_token;
  }
  await db.from('social_accounts').update({ status: 'needs_reauth', updated_at: new Date().toISOString() }).eq('id', account.id);
  return 'reauth';
}

// ---------------------------------------------------------------------------
// OAuth redirect (GET, no JWT): parks the code and sends the browser home
// ---------------------------------------------------------------------------

async function handleCallback(url: URL): Promise<Response> {
  const redirect = (outcome: Parameters<typeof returnUrl>[1]) =>
    APP_ORIGIN
      ? new Response(null, { status: 302, headers: { Location: returnUrl(APP_ORIGIN, outcome) } })
      : json(outcome, 'error' in outcome ? 400 : 200);

  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!state || state.length > 128) return redirect({ error: 'invalid_state' });

  if (url.searchParams.get('error') || !code || code.length > 2000) {
    await admin().from('social_oauth_states').delete().eq('state', state);
    return redirect({ error: 'denied' });
  }
  return redirect({ finish: state, code });
}

/** Exchanges the code for the user who started the connection, in the browser that gave consent. */
async function connectFinish(db: Admin, userId: string, body: any): Promise<Response> {
  const state = typeof body.state === 'string' ? body.state : '';
  const code = typeof body.code === 'string' ? body.code : '';
  if (!state || state.length > 128 || !code || code.length > 2000) return fail('Invalid connection request.');
  // Single use: deleted as it is read.
  const { data: rows } = await db.from('social_oauth_states').delete().eq('state', state).select();
  const pending = rows?.[0];
  if (!pending || Date.now() - Date.parse(pending.created_at) > STATE_TTL_MS) {
    return fail('This connection expired. Please connect again.', 410, { reason: 'expired' });
  }
  if (pending.user_id !== userId) {
    return fail('This connection was started from a different Echo account. Nothing was connected.', 403, { reason: 'wrong_user' });
  }
  const platform = pending.platform as SocialPlatform;

  const exchanged = await tokenRequest(platform, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    ...(platform === 'x' ? { code_verifier: pending.code_verifier, client_id: clientCredentials('x')?.id ?? '' } : {}),
  });
  if ('error' in exchanged) return fail(`${PLATFORM_LABEL[platform]} did not confirm the connection. Please try again.`, 502);
  const tokens = exchanged.tokens;
  const me = await whoAmI(platform, tokens.access_token);
  if (!me) return fail(`Could not read your ${PLATFORM_LABEL[platform]} profile. Please try again.`, 502);

  // Reconnecting the same account replaces its tokens; the old secret is dropped.
  const { data: existing } = await db
    .from('social_accounts')
    .select('id, vault_secret_id')
    .eq('user_id', userId)
    .eq('platform', platform)
    .eq('external_user_id', me.id)
    .maybeSingle();
  const { data: secretId, error: secretErr } = await db.rpc('store_social_secret', {
    p_secret: JSON.stringify(tokens),
    p_name: null,
  });
  if (secretErr || !secretId) return fail('Could not save the connection. Please try again.', 500);

  const row = {
    user_id: userId,
    platform,
    handle: me.handle,
    external_user_id: me.id,
    vault_secret_id: secretId,
    scopes: [...OAUTH[platform].scopes],
    status: 'active',
    refreshing_until: null,
    updated_at: new Date().toISOString(),
  };
  const { error: saveErr } = existing
    ? await db.from('social_accounts').update(row).eq('id', existing.id)
    : await db.from('social_accounts').insert(row);
  if (saveErr) {
    await db.rpc('delete_social_secret', { p_secret_id: secretId });
    return fail('Could not save the connection. Please try again.', 500);
  }
  if (existing?.vault_secret_id) await db.rpc('delete_social_secret', { p_secret_id: existing.vault_secret_id });
  return json({ ok: true, platform, handle: me.handle });
}

// ---------------------------------------------------------------------------
// Billing and limits (same two-phase hold as leads and mail)
// ---------------------------------------------------------------------------

async function loadPrice(db: Admin, platform: SocialPlatform): Promise<number | null> {
  const { data, error } = await db.from('pricing_config').select('credits, enabled').eq('operation', PRICE_OP[platform]).maybeSingle();
  const credits = Number(data?.credits);
  if (error || !data?.enabled || !Number.isFinite(credits) || credits < 0) return null;
  return credits;
}

async function takeSlot(db: Admin, userId: string, bucket: string, limit: number, windowSeconds: number): Promise<boolean | null> {
  const { data, error } = await db.rpc('take_rate_limit', {
    p_user_id: userId,
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error('[social] take_rate_limit failed:', error.message);
    return null;
  }
  return data === true;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleAction(userId: string, body: any): Promise<Response> {
  const db = admin();
  const action = body?.action;

  if (action === 'providers') {
    return json({ ok: true, platforms: PLATFORMS.filter((p) => clientCredentials(p) !== null) });
  }

  if (action === 'connect_start') {
    const platform = body.platform;
    if (!isSocialPlatform(platform)) return fail('Unknown platform.');
    const creds = clientCredentials(platform);
    if (!creds || !SUPABASE_URL || !APP_ORIGIN) return fail(`${PLATFORM_LABEL[platform]} is not set up on this workspace yet.`, 503);
    const ok = await takeSlot(db, userId, 'social.connect', 20, 3600);
    if (ok === null) return fail('The service is busy. Please try again in a moment.', 503);
    if (!ok) return fail('Too many connection attempts. Please try again later.', 429);

    const state = randomToken(32);
    const verifier = randomToken(48);
    // Old, abandoned handshakes for this user go first.
    await db.from('social_oauth_states').delete().eq('user_id', userId).lt('created_at', new Date(Date.now() - STATE_TTL_MS).toISOString());
    const { error } = await db.from('social_oauth_states').insert({ state, user_id: userId, platform, code_verifier: verifier });
    if (error) return fail('Could not start the connection. Please try again.', 500);
    return json({
      ok: true,
      url: authorizeUrl(platform, { clientId: creds.id, redirectUri: REDIRECT_URI, state, challenge: await pkceChallenge(verifier) }),
    });
  }

  if (action === 'connect_finish') return connectFinish(db, userId, body);

  if (action === 'list_accounts') {
    const { data, error } = await db
      .from('social_accounts')
      .select('id, platform, handle, status, daily_reply_cap, last_used_at, created_at')
      .eq('user_id', userId)
      .order('created_at');
    if (error) return fail('Could not load your accounts.', 500);
    return json({ ok: true, accounts: data ?? [] });
  }

  if (action === 'disconnect') {
    if (typeof body.account_id !== 'string' || !UUID_RE.test(body.account_id)) return fail('account_id is required.');
    const { data: account } = await db
      .from('social_accounts')
      .select('*')
      .eq('id', body.account_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!account) return fail('Account not found.', 404);

    // Best effort: revoke at the platform too, so the token is dead even if
    // the Vault copy somehow survived.
    const platform = account.platform as SocialPlatform;
    const creds = clientCredentials(platform);
    const tokens = creds && account.vault_secret_id ? await readTokens(db, account.vault_secret_id) : null;
    if (creds && tokens) {
      try {
        await fetch(OAUTH[platform].revoke, {
          method: 'POST',
          headers: platformHeaders(platform, {
            Authorization: basicAuth(creds),
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
          body: new URLSearchParams({
            token: tokens.refresh_token || tokens.access_token,
            token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token',
            ...(platform === 'x' ? { client_id: creds.id } : {}),
          }).toString(),
          signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
        });
      } catch {
        // The row and its Vault secret are removed regardless.
      }
    }
    // The delete trigger removes the Vault secret.
    const { error } = await db.from('social_accounts').delete().eq('id', account.id).eq('user_id', userId);
    if (error) return fail('Could not disconnect the account.', 500);
    return json({ ok: true });
  }

  if (action === 'reply') return reply(db, userId, body);

  return fail(`Unknown action: ${String(action).slice(0, 50)}`);
}

const UNCERTAIN_MESSAGE =
  'The platform did not answer in time, so the reply may already be posted (it was charged). Check the post first; press Send again only if it is not there.';

async function reply(db: Admin, userId: string, body: any): Promise<Response> {
  if (typeof body.post_id !== 'string' || !UUID_RE.test(body.post_id)) return fail('post_id is required.');

  // 1. The post, the platform's id for it, and the text.
  const { data: post } = await db
    .from('monitored_posts')
    .select('id, platform, post_url, status')
    .eq('id', body.post_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!post) return fail('Post not found.', 404);
  const target = replyTarget(post.platform, post.post_url);
  if (!target) return fail('Replies can only be sent to X and Reddit posts.', 400, { unsupported: true });
  const platform = target.platform;
  const checked = checkReplyText(platform, body.text);
  if ('error' in checked) return fail(checked.error);

  // 2. The account to post as: the one asked for, else the first active one.
  let query = db.from('social_accounts').select('*').eq('user_id', userId).eq('platform', platform);
  if (typeof body.account_id === 'string' && UUID_RE.test(body.account_id)) query = query.eq('id', body.account_id);
  const { data: accounts } = await query.order('created_at').limit(5);
  const account = (accounts ?? []).find((a: any) => a.status === 'active');
  if (!account) {
    return fail(`Connect your ${PLATFORM_LABEL[platform]} account in Settings to reply from Echo.`, 409, {
      needs_account: true,
      reauth: (accounts ?? []).length > 0,
    });
  }

  const price = await loadPrice(db, platform);
  if (price === null) return fail('Replies are temporarily unavailable (pricing is not configured).', 503);

  const burst = await takeSlot(db, userId, 'social.reply.burst', 3, 10);
  if (burst === null) return fail('The service is busy. Please try again in a moment.', 503);
  if (!burst) return fail('Too many replies at once. Please wait a few seconds.', 429, { rate_limited: true });

  // 3. Earlier attempts on this post. A claim whose request died is treated
  // as uncertain (it may have been posted); an uncertain one blocks a resend
  // until the user confirms it.
  await db
    .from('social_replies')
    .update({ status: 'uncertain', error_code: 'abandoned', updated_at: new Date().toISOString() })
    .eq('post_id', post.id)
    .eq('status', 'sending')
    .lt('created_at', new Date(Date.now() - STALE_CLAIM_MS).toISOString());
  const { data: earlier } = await db
    .from('social_replies')
    .select('id, status, reply_url')
    .eq('post_id', post.id)
    .in('status', ['sending', 'sent', 'uncertain']);
  const live = earlier ?? [];
  const sentBefore = live.find((r: any) => r.status === 'sent');
  if (sentBefore) return fail('You have already replied to this post.', 409, { already_replied: true, reply_url: sentBefore.reply_url });
  if (live.some((r: any) => r.status === 'sending')) {
    return fail('This reply is already being sent. Please wait a moment.', 409, { in_flight: true });
  }
  if (live.some((r: any) => r.status === 'uncertain')) {
    if (body.confirm_resend !== true) return fail(UNCERTAIN_MESSAGE, 409, { uncertain: true });
    await db
      .from('social_replies')
      .update({ status: 'failed', error_code: 'resend_confirmed', updated_at: new Date().toISOString() })
      .eq('post_id', post.id)
      .eq('status', 'uncertain');
  }

  // 4. Claim the post. The partial unique index allows one live reply per post.
  const { data: claimed, error: claimErr } = await db
    .from('social_replies')
    .insert({ user_id: userId, post_id: post.id, account_id: account.id, platform, body: checked.text })
    .select('id')
    .single();
  if (claimErr || !claimed) {
    if (claimErr?.code === '23505') return fail('This reply is already being sent. Please wait a moment.', 409, { in_flight: true });
    return fail('Could not send the reply. Please try again.', 500);
  }
  const replyId = claimed.id as string;
  const finish = (fields: Record<string, unknown>) =>
    db.from('social_replies').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', replyId);

  // 5. Hold the price.
  const holdKey = `social_reply:${userId}:${replyId}`;
  const { data: hold, error: holdErr } = await db.rpc('wallet_reserve', {
    p_user_id: userId,
    p_credits: price,
    p_idempotency_key: holdKey,
    p_context: { feature: 'social_reply', platform },
    p_paid_only: true,
  });
  const reserve = hold as any;
  if (holdErr || !reserve?.ok) {
    await finish({ status: 'failed', error_code: 'insufficient_credits' });
    if (holdErr) return fail('Could not reserve credits. Please try again.', 503);
    const required = reserve?.required ?? price;
    const available = reserve?.available ?? 0;
    return fail(`Not enough credits for this reply. Needed: ${required}, available: ${available}.`, 402, {
      insufficient_credits: true,
      required,
      available,
    });
  }
  const reservationId: string | null = typeof reserve.reservation_id === 'string' ? reserve.reservation_id : null;
  const release = (reason: string) =>
    reservationId ? db.rpc('wallet_release', { p_reservation_id: reservationId, p_reason: reason }) : Promise.resolve();
  const settle = (note: string) =>
    reservationId
      ? db.rpc('wallet_settle', {
          p_reservation_id: reservationId,
          p_credits_charged: price,
          p_provider_cost: PROVIDER_COST_USD[platform],
          p_idempotency_key: holdKey,
          p_note: note,
        })
      : Promise.resolve({ error: null });

  // 6. The account's daily cap, counted only for replies that go to the platform.
  const capOk = await takeSlot(db, userId, `social.reply.${account.id}`, account.daily_reply_cap, 86_400);
  if (capOk !== true) {
    await finish({ status: 'failed', error_code: capOk === null ? 'busy' : 'daily_cap' });
    await release('social reply: limit');
    return capOk === null
      ? fail('The service is busy. Please try again in a moment.', 503)
      : fail(`@${account.handle} has reached its ${account.daily_reply_cap} replies for today.`, 429, { rate_limited: true });
  }

  // 7. Post it.
  const accessToken = await accessTokenFor(db, account);
  if (accessToken === 'reauth' || accessToken === 'transient') {
    await finish({ status: 'failed', error_code: accessToken === 'reauth' ? 'needs_reauth' : 'token_unavailable' });
    await release('social reply: no usable token');
    return accessToken === 'reauth'
      ? fail(`Reconnect @${account.handle} in Settings, then try again.`, 409, { needs_account: true, reauth: true })
      : fail(`${PLATFORM_LABEL[platform]} is not responding right now. Nothing was charged; please try again.`, 503);
  }

  const started = Date.now();
  let res: Response | null = null;
  let resJson: any = null;
  try {
    res =
      platform === 'x'
        ? await fetch('https://api.x.com/2/tweets', {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: checked.text, reply: { in_reply_to_tweet_id: target.id } }),
            signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
          })
        : await fetch('https://oauth.reddit.com/api/comment', {
            method: 'POST',
            headers: platformHeaders('reddit', {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            }),
            body: new URLSearchParams({ api_type: 'json', thing_id: target.id, text: checked.text }).toString(),
            signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
          });
    resJson = await res.json().catch(() => null);
  } catch (err: any) {
    console.warn('[social] reply request error:', err?.name || err?.message);
  }

  // Reddit answers 200 with errors in the body (e.g. RATELIMIT, THREAD_LOCKED).
  const redditErrors: any[] = platform === 'reddit' ? resJson?.json?.errors ?? [] : [];
  const created = platform === 'x' ? resJson?.data : resJson?.json?.data?.things?.[0]?.data;
  const sent = Boolean(res?.ok && redditErrors.length === 0 && created?.id);
  // No answer, or a success status whose body could not be read: it may have been posted.
  const uncertain = !sent && (!res || (res.ok && redditErrors.length === 0));

  await db.from('api_usage').upsert(
    {
      user_id: userId,
      idempotency_key: `social:reply:${replyId}`,
      operation: PRICE_OP[platform],
      provider: platform,
      provider_call_id: created?.id ? String(created.id) : null,
      provider_cost_usd: sent || uncertain ? PROVIDER_COST_USD[platform] : 0,
      credits_charged: sent || uncertain ? price : 0,
      revenue_usd: 0,
      outcome: uncertain ? 'uncertain' : sent ? 'success' : 'not_billed',
      http_status: res?.status ?? null,
      duration_ms: Date.now() - started,
      reservation_id: reservationId,
      metadata: { feature: 'social_reply' },
    },
    { onConflict: 'idempotency_key', ignoreDuplicates: true },
  );
  await db.from('social_accounts').update({ last_used_at: new Date().toISOString() }).eq('id', account.id);

  if (uncertain) {
    await finish({ status: 'uncertain', error_code: res ? 'unreadable_response' : 'timeout', credits_charged: price });
    const { error } = await settle(`Replied on ${PLATFORM_LABEL[platform]} as @${account.handle} (unconfirmed)`);
    if (error) console.error('[social] wallet_settle failed:', error.message);
    return fail(UNCERTAIN_MESSAGE, 504, { uncertain: true });
  }

  if (!sent) {
    const code = res!.status === 401 ? 'unauthorized' : redditErrors[0]?.[0] ? String(redditErrors[0][0]).slice(0, 50) : `http_${res!.status}`;
    await finish({ status: 'failed', error_code: code });
    await release(`social reply failed: ${code}`);
    if (res!.status === 401) {
      await db.from('social_accounts').update({ status: 'needs_reauth' }).eq('id', account.id);
      return fail(`Reconnect @${account.handle} in Settings, then try again.`, 409, { needs_account: true, reauth: true });
    }
    const message =
      res!.status === 403 || res!.status === 404
        ? 'This post no longer accepts replies (it was deleted, or the author limited who can reply). Nothing was charged.'
        : code === 'RATELIMIT'
          ? 'Reddit is rate-limiting this account. Please wait a few minutes. Nothing was charged.'
          : `${PLATFORM_LABEL[platform]} did not accept the reply. Nothing was charged.`;
    return fail(message, 502, { reply_failed: true, error_code: code });
  }

  // 8. Sent: record it, move the post to Contacted, charge.
  const url = replyUrl(platform, account.handle, String(created.id), created?.permalink ?? null);
  await finish({ status: 'sent', external_reply_id: String(created.id), reply_url: url, credits_charged: price });
  await db.from('monitored_posts').update({ status: 'contacted' }).eq('id', post.id).eq('user_id', userId);
  const { error: settleErr } = await settle(`Replied on ${PLATFORM_LABEL[platform]} as @${account.handle}`);
  if (settleErr) console.error('[social] wallet_settle failed:', settleErr.message);

  return json({ ok: true, reply_url: url, credits_charged: price, handle: account.handle, platform, feed_platform: FEED_PLATFORM[platform] });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return withCors(req, new Response(null, { status: 204 }));
  try {
    if (req.method === 'GET') return await handleCallback(new URL(req.url));
    if (req.method !== 'POST') return withCors(req, fail('Method not allowed', 405));
    const userId = await requireUserId(req);
    if (!userId) return withCors(req, fail('Unauthorized', 401));
    let body: any;
    try {
      body = await req.json();
    } catch {
      return withCors(req, fail('Invalid JSON body'));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return withCors(req, fail('Invalid JSON body'));
    return withCors(req, await handleAction(userId, body));
  } catch (err: any) {
    console.error('[social] unhandled error:', err?.name || 'error', String(err?.message || '').slice(0, 200));
    return withCors(req, fail('Internal error', 500));
  }
});
