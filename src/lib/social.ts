/**
 * Connected social accounts and 1-click replies
 * ----------------------------------------------------------------------------
 * Talks to the `social` edge function. The accounts list is shared by Settings
 * (connect / disconnect) and the feed's reply dialog (who to reply as), so it
 * lives in one small store rather than in either component.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { invokeFunction } from './api';
import { supabase, isConfigured } from './supabase';
import type { Platform } from '../types';

export type SocialPlatform = 'x' | 'reddit';

export interface SocialAccount {
  id: string;
  platform: SocialPlatform;
  handle: string;
  status: 'active' | 'needs_reauth';
  daily_reply_cap: number;
  last_used_at: string | null;
  created_at: string;
}

export const SOCIAL_LABEL: Record<SocialPlatform, string> = { x: 'X', reddit: 'Reddit' };

/** The social platform a feed post can be replied on, if any. */
export function replyPlatformOf(platform: Platform): SocialPlatform | null {
  if (platform === 'twitter') return 'x';
  if (platform === 'reddit') return 'reddit';
  return null;
}

/** Same limits the server applies (supabase/functions/social/rules.ts). */
export const MAX_REPLY_LENGTH: Record<SocialPlatform, number> = { x: 280, reddit: 10_000 };
const LINK_RE = /(https?:\/\/|www\.)\S|\b[a-z0-9-]+\.(com|net|org|io|co|ai|app|dev|me|ly|gg|xyz|so|to)\b/i;

/** Why a reply cannot be sent as written, or null when it can. */
export function replyTextProblem(platform: SocialPlatform, text: string): string | null {
  const t = text.trim();
  if (!t) return 'Write a reply first.';
  const length = [...t].length;
  if (length > MAX_REPLY_LENGTH[platform]) return `${length - MAX_REPLY_LENGTH[platform]} characters over the ${SOCIAL_LABEL[platform]} limit.`;
  if (platform === 'x' && LINK_RE.test(t)) return 'Replies on X cannot contain links.';
  return null;
}

interface SocialState {
  accounts: SocialAccount[];
  /** Platforms with an OAuth app configured on the server. */
  platforms: SocialPlatform[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

let state: SocialState = { accounts: [], platforms: [], loaded: false, loading: false, error: null };
let inflight: Promise<void> | null = null;
/** Bumped by reset(): a request started before it must not write afterwards. */
let generation = 0;
const listeners = new Set<() => void>();

function setState(next: Partial<SocialState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export const socialStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: (): SocialState => state,

  /** Loads accounts and configured platforms. Concurrent calls share one request. */
  load(force = false): Promise<void> {
    if (inflight) return inflight;
    if (state.loaded && !force) return Promise.resolve();
    setState({ loading: true });
    const gen = generation;
    inflight = Promise.all([
      invokeFunction<{ ok: boolean; accounts?: SocialAccount[] }>('social', { action: 'list_accounts' }),
      invokeFunction<{ ok: boolean; platforms?: SocialPlatform[] }>('social', { action: 'providers' }),
    ])
      .then(([accounts, providers]) => {
        if (gen !== generation) return;
        setState({ accounts: accounts?.accounts ?? [], platforms: providers?.platforms ?? [], loaded: true, error: null });
      })
      .catch((err: unknown) => {
        if (gen !== generation) return;
        setState({ loaded: true, error: (err as Error)?.message || 'Could not load connected accounts.' });
      })
      .finally(() => {
        if (gen !== generation) return;
        setState({ loading: false });
        inflight = null;
      });
    return inflight;
  },

  /** Sends the browser to the platform's consent screen; it comes back to Settings. */
  async connect(platform: SocialPlatform): Promise<void> {
    const res = await invokeFunction<{ ok: boolean; url?: string }>('social', { action: 'connect_start', platform });
    if (!res?.url) throw new Error('Could not start the connection.');
    window.location.assign(res.url);
  },

  /** Completes a connection after the consent screen (the signed-in user must be the one who started it). */
  async finish(state: string): Promise<{ platform: SocialPlatform; handle: string }> {
    const res = await invokeFunction<{ ok: boolean; platform: SocialPlatform; handle: string }>('social', {
      action: 'connect_finish',
      state,
    });
    await socialStore.load(true);
    return res;
  },

  async disconnect(accountId: string): Promise<void> {
    await invokeFunction('social', { action: 'disconnect', account_id: accountId });
    setState({ accounts: state.accounts.filter((a) => a.id !== accountId) });
  },

  /** Posts a reply under a feed post. Throws ApiError with the server's message on refusal. */
  async reply(postId: string, text: string, accountId?: string, confirmResend = false) {
    const res = await invokeFunction<{ ok: boolean; reply_url: string; credits_charged: number; handle: string }>('social', {
      action: 'reply',
      post_id: postId,
      text,
      account_id: accountId,
      confirm_resend: confirmResend || undefined,
    });
    void socialStore.load(true);
    return res;
  },

  reset() {
    generation++;
    inflight = null;
    state = { accounts: [], platforms: [], loaded: false, loading: false, error: null };
    for (const l of listeners) l();
  },
};

export function useSocialAccounts(enabled = true): SocialState {
  const snap = useSyncExternalStore(socialStore.subscribe, socialStore.getSnapshot, socialStore.getSnapshot);
  useEffect(() => {
    if (enabled) void socialStore.load();
  }, [enabled]);
  return snap;
}

/** Replies already sent, by feed post id. Read straight from the table (RLS: own rows). */
export async function loadSentReplies(): Promise<Record<string, string>> {
  if (!isConfigured || !supabase) return {};
  const { data, error } = await supabase
    .from('social_replies')
    .select('post_id, reply_url')
    .eq('status', 'sent')
    .not('post_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error || !data) return {};
  const out: Record<string, string> = {};
  for (const row of data) if (row.post_id && row.reply_url) out[row.post_id] = row.reply_url;
  return out;
}
