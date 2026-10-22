import { useSyncExternalStore } from 'react';
import type { Mailbox, MailThread, MailMessage, MailFolder, MailDomain } from '../../types';
import { leadsStore } from '../leads/leads-store';
import { supabase } from '../../lib/supabase';
import { invokeFunction } from '../../lib/api';
import { walletStore } from '../../lib/wallet-store';

// ============================================================================
// Echo Mail Workspace Store
// ----------------------------------------------------------------------------
// Manages mailbox state, threads, conversation messages, compose drawer,
// and custom domains. Follows the same useSyncExternalStore pattern as
// leads-store.ts.
//
// Reads come straight from Supabase under RLS. Anything that sends, charges
// credits, stores a password or talks to the email provider goes through the
// `mail` edge function. Per-thread view state (star, folder, read) and thread
// deletes are written directly; RLS limits them to the user's own rows.
// ============================================================================

export interface ComposerDraft {
  leadId?: string | null;
  to: string;
  name?: string;
  company?: string;
  /** The lead's job title, for the AI writer. */
  title?: string;
  subject: string;
  body: string;
  fromMailboxId?: string;
  /** Set when the draft was resumed from the Drafts folder. */
  draftThreadId?: string | null;
}

/**
 * Why a send did not go through, so the UI can offer the right next step:
 *  - uncertain_resend: an identical send recently timed out and may have been
 *    delivered; the user may confirm a resend ("Send anyway").
 *  - uncertain: this attempt may already have been sent and was charged; no
 *    automatic retry is offered.
 *  - paid_credits_required: only welcome credits are left (Billing).
 *  - price_unavailable: sending is paused server-side.
 */
export type SendFailureKind =
  | 'uncertain_resend'
  | 'uncertain'
  | 'paid_credits_required'
  | 'price_unavailable'
  /** Echo's platform-wide daily sending cap is used up (429 platform_cap). */
  | 'platform_cap'
  /** A new Echo mailbox hit its warm-up daily limit. */
  | 'warmup'
  | 'error';

export type SendResult =
  | { success: true; threadId: string; chargePending?: boolean }
  | { success: false; error: string; kind: SendFailureKind };

export interface SendOptions {
  /** Resend although an identical send recently ended uncertain. */
  confirmResend?: boolean;
}

export const PAID_CREDITS_REQUIRED_MESSAGE =
  'Sending mail needs purchased credits — free welcome credits only cover feed sweeps.';
const UNCERTAIN_SEND_MESSAGE =
  'This email may already have been sent (and was charged). Check your Sent folder before sending it again.';
const UNCERTAIN_RESEND_FALLBACK =
  "An earlier attempt to send this exact email timed out and may have been delivered. Check your Sent folder first; if it isn't there, choose Send anyway.";
const PRICE_UNAVAILABLE_MESSAGE = 'Sending is temporarily unavailable. Please try again later.';
const PLATFORM_CAP_MESSAGE =
  "Echo has reached today's sending limit across all accounts, so this email was not sent. Please try again tomorrow.";
const WARMUP_MESSAGE =
  'New Echo addresses send up to 15 emails a day in their first week while they warm up. This email was not sent; try again tomorrow.';

type MailResponse =
  | { ok: true; data: any }
  | { ok: false; status: number; body: Record<string, any> | null; message: string; aborted?: boolean };
type SendResponse = MailResponse;

/**
 * Calls the mail function and keeps the error body. The shared
 * invokeFunction() reduces errors to a message (and rewrites any
 * duplicate_request to "Already in progress"), which loses flags such as
 * uncertain / paid_credits_required / platform_cap, or the suggestions a
 * taken mailbox name comes back with.
 */
async function invokeMail(payload: Record<string, unknown>, timeoutMs = 30_000): Promise<MailResponse> {
  if (!supabase) return { ok: false, status: 503, body: null, message: 'Mail requires a connected Supabase project.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { data, error } = await supabase.functions.invoke('mail', { body: payload, signal: controller.signal });
    if (!error) return { ok: true, data };
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      let body: Record<string, any> | null = null;
      try {
        body = await ctx.clone().json();
      } catch {
        body = null;
      }
      return { ok: false, status: ctx.status, body, message: String(body?.message || body?.error || '') };
    }
    return { ok: false, status: 500, body: null, message: error.message || '' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, status: 504, body: null, message: '', aborted: true };
    }
    return { ok: false, status: 500, body: null, message: (err as Error)?.message || '' };
  } finally {
    clearTimeout(timer);
  }
}

async function invokeSend(payload: Record<string, unknown>): Promise<SendResponse> {
  const res = await invokeMail(payload, 60_000);
  // No answer within the timeout: the provider may still have sent it.
  if (!res.ok && res.aborted) return { ...res, body: { uncertain: true } };
  return res;
}

const isWarmupRefusal = (res: Extract<MailResponse, { ok: false }>) => {
  const b = res.body || {};
  return Boolean(b.warmup || b.warm_up || b.warmup_limit || (res.status === 429 && /warm/i.test(res.message)));
};

/** Maps a refused send onto what the user is told and offered. */
function sendFailure(res: Extract<SendResponse, { ok: false }>, fallback: string): Extract<SendResult, { success: false }> {
  const b = res.body || {};
  if (res.status === 409 && b.uncertain) {
    return { success: false, kind: 'uncertain_resend', error: res.message || UNCERTAIN_RESEND_FALLBACK };
  }
  if (res.status === 504 || b.uncertain) return { success: false, kind: 'uncertain', error: UNCERTAIN_SEND_MESSAGE };
  if (b.paid_credits_required) return { success: false, kind: 'paid_credits_required', error: PAID_CREDITS_REQUIRED_MESSAGE };
  if (res.status === 503 && b.price_unavailable) return { success: false, kind: 'price_unavailable', error: PRICE_UNAVAILABLE_MESSAGE };
  if (b.platform_cap) return { success: false, kind: 'platform_cap', error: PLATFORM_CAP_MESSAGE };
  if (isWarmupRefusal(res)) {
    const serverMsg = /warm/i.test(res.message) && res.message.includes(' ') ? res.message : '';
    return { success: false, kind: 'warmup', error: serverMsg || WARMUP_MESSAGE };
  }
  if (b.duplicate_request) return { success: false, kind: 'error', error: 'Already in progress — this email is still being sent.' };
  if (b.rate_limited) return { success: false, kind: 'error', error: res.message || 'Too many requests. Please try again in a minute.' };
  return { success: false, kind: 'error', error: res.message || fallback };
}

/** The charge may settle a moment after the send: re-read the wallet now and again shortly. */
function refreshWalletAfterSend(chargePending: boolean) {
  void walletStore.refresh();
  if (chargePending) window.setTimeout(() => void walletStore.refresh(), 5_000);
}

export type AppPasswordProvider = 'google' | 'microsoft' | 'zoho' | 'custom';

const EMPTY_DRAFT: ComposerDraft = {
  to: '',
  name: '',
  company: '',
  leadId: null,
  subject: '',
  body: '',
  draftThreadId: null,
};

const snippetOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160);

const hasDraftContent = (d: ComposerDraft) => Boolean(d.to.trim() || d.subject.trim() || d.body.trim());

const errorMessage = (err: unknown, fallback: string) => (err instanceof Error && err.message) || fallback;

/** Why a mailbox can't send right now, or null when it can. */
export function mailboxSendBlocker(mailbox: Mailbox | undefined): string | null {
  if (!mailbox) return 'Connect a mailbox before sending.';
  if (mailbox.status === 'needs_reauth') return `${mailbox.address} needs to be reconnected before it can send.`;
  if (mailbox.status !== 'active') return `${mailbox.address} is ${mailbox.status} and can't send right now.`;
  if (mailbox.sent_today >= mailbox.daily_send_limit) {
    return `${mailbox.address} reached its daily limit (${mailbox.daily_send_limit}). Use another mailbox or send tomorrow.`;
  }
  return null;
}

/** Mirrors mail.send.hosted / mail.send.connected in pricing_config. */
export const sendCostFor = (mailbox: Mailbox | undefined) => (mailbox?.kind === 'hosted' ? 0.1 : 0.05);

/** mail_config: whether Echo-hosted addresses are on, and how many the user has. */
export interface MailConfig {
  shared_domain: string | null;
  max_echo_mailboxes: number;
  echo_mailboxes_used: number;
}

export type MailboxNameReason = 'invalid' | 'reserved' | 'taken' | 'too_short';

export type MailboxNameCheck =
  | { ok: true; available: boolean; reason?: MailboxNameReason; address: string; suggestions: string[] }
  | { ok: false; error: string; rateLimited?: boolean };

export type ClaimEchoResult =
  | { mailbox: Mailbox | null }
  | {
      error: string;
      code: 'taken' | 'invalid' | 'limit_reached' | 'platform_unavailable' | 'error';
      reason?: MailboxNameReason;
      suggestions?: string[];
    };

/** What add_domain reports about where the domain's DNS is hosted. */
export interface DomainSetupInfo {
  dns_provider?: { id: string; name: string; dns_url: string | null } | null;
  domain_connect?: { supported: boolean; provider_name?: string } | null;
  /** The address the user asked to have created once the domain verifies. */
  local_part?: string;
}

export const MAILBOX_NAME_REASON_COPY: Record<MailboxNameReason, string> = {
  invalid: 'Use letters, numbers, dots, dashes or underscores.',
  reserved: "That name is reserved. Try another.",
  taken: 'That address is taken.',
  too_short: 'Use at least 3 characters.',
};

const DOMAIN_SETUP_STORAGE_KEY = 'echo_mail_domain_setup';

function readStoredSetup(): Record<string, DomainSetupInfo> {
  try {
    const raw = window.localStorage.getItem(DOMAIN_SETUP_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredSetup(value: Record<string, DomainSetupInfo>) {
  try {
    window.localStorage.setItem(DOMAIN_SETUP_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage is a convenience only */
  }
}

/** Pulls provider details out of a response that may carry them at the top level or on the domain. */
function extractSetup(res: any): DomainSetupInfo | null {
  const src = res?.dns_provider || res?.domain_connect ? res : res?.domain;
  if (!src || (!src.dns_provider && !src.domain_connect)) return null;
  return {
    dns_provider: src.dns_provider ?? null,
    domain_connect: src.domain_connect ?? null,
  };
}

function mergeServerSetup(local: Record<string, DomainSetupInfo>, rows: any[]): Record<string, DomainSetupInfo> {
  const merged = { ...local };
  for (const row of rows) {
    if (!row?.id) continue;
    const server: DomainSetupInfo = {};
    if (row.dns_provider) server.dns_provider = row.dns_provider;
    if (row.domain_connect) server.domain_connect = row.domain_connect;
    if (row.auto_local_part) server.local_part = row.auto_local_part;
    if (Object.keys(server).length) merged[row.id] = { ...merged[row.id], ...server };
  }
  return merged;
}

export type MailSubView = 'mailbox' | 'domains' | 'accounts';
export type ThreadFilter = 'all' | 'unread' | 'leads';

interface MailState {
  userId: string | null;
  /** True while the workspace is first loading from the server. */
  loading: boolean;
  loadError: string | null;
  activeSubView: MailSubView;
  mailboxes: Mailbox[];
  activeMailboxId: string;
  activeFolder: MailFolder;
  activeThreadId: string | null;
  searchQuery: string;
  filter: ThreadFilter;
  threads: MailThread[];
  messages: Record<string, MailMessage[]>;
  domains: MailDomain[];
  isComposerOpen: boolean;
  composerDraft: ComposerDraft;
  /** null until mail_config has answered. */
  mailConfig: MailConfig | null;
  mailConfigLoading: boolean;
  /** Provider / Domain Connect details per domain id, from add_domain. */
  domainSetup: Record<string, DomainSetupInfo>;
  /** Set when another view asks Accounts to open the "own inbox" dialog. */
  connectInboxRequested: boolean;
}

const MAILBOX_COLUMNS =
  'id, user_id, kind, provider, address, display_name, domain_id, status, pause_reason, daily_send_limit, sent_today, sent_today_date, is_default, created_at';
const DOMAIN_COLUMNS =
  'id, domain, status, provider, dkim_tokens, dns_records, inbound_provider, verified_at, last_checked_at, dns_provider, domain_connect, auto_local_part';
const THREAD_COLUMNS = '*, user_leads(status)';

/** sent_today only counts for today's (UTC) date; the server resets it lazily. */
function toMailbox(row: any): Mailbox {
  const today = new Date().toISOString().slice(0, 10);
  const { sent_today_date, created_at: _createdAt, ...rest } = row;
  return { ...rest, sent_today: sent_today_date === today ? Number(row.sent_today) || 0 : 0 };
}

function toThread(row: any): MailThread {
  const { user_leads, ...rest } = row;
  return { ...rest, lead_pipeline_status: row.lead_pipeline_status ?? user_leads?.status ?? undefined };
}

const pickDefault = (mailboxes: Mailbox[]) => (mailboxes.find((m) => m.is_default) || mailboxes[0])?.id || '';

const emptyState = (userId: string | null): MailState => ({
  userId,
  loading: Boolean(userId),
  loadError: null,
  activeSubView: 'mailbox',
  mailboxes: [],
  activeMailboxId: '',
  activeFolder: 'inbox',
  activeThreadId: null,
  searchQuery: '',
  filter: 'all',
  threads: [],
  messages: {},
  domains: [],
  isComposerOpen: false,
  composerDraft: { ...EMPTY_DRAFT },
  mailConfig: null,
  mailConfigLoading: false,
  domainSetup: userId ? readStoredSetup() : {},
  connectInboxRequested: false,
});

class MailStore {
  private state: MailState = emptyState(null);

  private listeners = new Set<() => void>();
  private notifyTimeout: any = null;
  /** Bumped on every init so a slow load for a previous user is ignored. */
  private loadGeneration = 0;

  private notify() {
    if (this.notifyTimeout) clearTimeout(this.notifyTimeout);
    this.notifyTimeout = setTimeout(() => {
      this.listeners.forEach((listener) => listener());
    }, 0);
  }

  private patch(fields: Partial<MailState>) {
    this.state = { ...this.state, ...fields };
    this.notify();
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public getSnapshot = (): MailState => {
    return this.state;
  };

  public init(userId: string | null) {
    if (this.state.userId === userId) return;
    // Reset to a clean workspace for the new user so one account never sees
    // another account's mail state.
    this.state = emptyState(userId);
    this.notify();
    if (userId) void this.reload();
  }

  /** Loads mailboxes, domains and the thread list for the signed-in user. */
  public async reload() {
    const userId = this.state.userId;
    if (!userId) return;
    const generation = ++this.loadGeneration;
    if (!supabase) {
      this.patch({ loading: false, loadError: 'Mail requires a connected Supabase project.' });
      return;
    }

    const [mbRes, domRes, thRes] = await Promise.all([
      supabase.from('mailboxes').select(MAILBOX_COLUMNS).order('created_at'),
      // The shared Echo domain is readable by everyone; it is not the user's to manage.
      supabase.from('mail_domains').select(DOMAIN_COLUMNS).eq('is_platform', false).order('created_at'),
      supabase.from('mail_threads').select(THREAD_COLUMNS).order('last_message_at', { ascending: false }).limit(500),
    ]);
    if (generation !== this.loadGeneration || this.state.userId !== userId) return;

    const error = mbRes.error || domRes.error || thRes.error;
    if (error) {
      console.error('[mail] load failed:', error.message);
      this.patch({ loading: false, loadError: 'Could not load your mail. Please refresh to try again.' });
      return;
    }

    const mailboxes = (mbRes.data || []).map(toMailbox);
    const activeMailboxId = mailboxes.some((m) => m.id === this.state.activeMailboxId)
      ? this.state.activeMailboxId
      : pickDefault(mailboxes);
    this.patch({
      loading: false,
      loadError: null,
      mailboxes,
      domains: (domRes.data || []) as MailDomain[],
      // Provider details are stored server-side; they win over this browser's cache.
      domainSetup: mergeServerSetup(this.state.domainSetup, domRes.data || []),
      threads: (thRes.data || []).map(toThread),
      activeMailboxId,
      // An open composer picks its own mailbox once they load; replacing the
      // draft under it would reset what the user has typed.
      composerDraft: this.state.composerDraft.fromMailboxId || this.state.isComposerOpen
        ? this.state.composerDraft
        : { ...this.state.composerDraft, fromMailboxId: activeMailboxId },
    });
  }

  private refreshing = false;

  /**
   * Re-reads the thread list so replies that arrived since the last load show
   * up. Threads whose latest message changed drop their cached messages; the
   * open one is reloaded in place.
   */
  public async refreshThreads() {
    const userId = this.state.userId;
    if (!userId || !supabase || this.state.loading || this.refreshing) return;
    this.refreshing = true;
    const generation = this.loadGeneration;
    try {
      const { data, error } = await supabase
        .from('mail_threads')
        .select(THREAD_COLUMNS)
        .order('last_message_at', { ascending: false })
        .limit(500);
      if (error || generation !== this.loadGeneration || this.state.userId !== userId) return;

      const fresh = (data || []).map(toThread);
      const freshIds = new Set(fresh.map((t) => t.id));
      const before = new Map(this.state.threads.map((t) => [t.id, t]));
      // Keep drafts saved in the last two minutes whose save may not have landed yet.
      const recentCutoff = Date.now() - 2 * 60_000;
      const pendingDrafts = this.state.threads.filter(
        (t) => !freshIds.has(t.id) && t.folder === 'drafts' && Date.parse(t.created_at) > recentCutoff
      );

      const messages = { ...this.state.messages };
      let activeChanged = false;
      for (const t of fresh) {
        const prev = before.get(t.id);
        if (prev && prev.last_message_at !== t.last_message_at && messages[t.id]) {
          delete messages[t.id];
          if (t.id === this.state.activeThreadId) activeChanged = true;
        }
      }
      const threads = [...pendingDrafts, ...fresh];
      // The open thread is being read, so new replies in it count as read.
      const activeId = this.state.activeThreadId;
      this.patch({
        threads: activeId ? threads.map((t) => (t.id === activeId ? { ...t, unread_count: 0 } : t)) : threads,
        messages,
      });
      if (activeId && activeChanged) {
        const active = fresh.find((t) => t.id === activeId);
        if (active && active.unread_count > 0) void this.writeThread(activeId, { unread_count: 0 }, threads);
        void this.loadMessages(activeId);
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async loadMessages(threadId: string): Promise<MailMessage[]> {
    if (this.state.messages[threadId] || !supabase) return this.state.messages[threadId] || [];
    const { data, error } = await supabase
      .from('mail_messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[mail] message load failed:', error.message);
      return [];
    }
    const messages = (data || []) as MailMessage[];
    this.patch({ messages: { ...this.state.messages, [threadId]: messages } });
    return messages;
  }

  /** Writes a thread's view state; reverts the optimistic change on failure. */
  private async writeThread(threadId: string, fields: Partial<MailThread>, previous: MailThread[]) {
    if (!supabase) return;
    const { error } = await supabase.from('mail_threads').update(fields).eq('id', threadId);
    if (error) {
      console.error('[mail] thread update failed:', error.message);
      this.patch({ threads: previous });
    }
  }

  public setActiveSubView(view: MailSubView) {
    this.patch({ activeSubView: view });
  }

  public setActiveMailbox(mailboxId: string) {
    this.patch({
      activeMailboxId: mailboxId,
      activeThreadId: null,
      composerDraft: { ...this.state.composerDraft, fromMailboxId: mailboxId },
    });
  }

  public setActiveFolder(folder: MailFolder) {
    this.patch({ activeFolder: folder, activeThreadId: null });
  }

  public setActiveThread(threadId: string | null) {
    if (!threadId) {
      this.patch({ activeThreadId: null });
      return;
    }

    const previous = this.state.threads;
    const thread = previous.find((t) => t.id === threadId);
    // Mark as read when opened
    this.patch({
      activeThreadId: threadId,
      threads: previous.map((t) => (t.id === threadId ? { ...t, unread_count: 0 } : t)),
    });
    if (thread && thread.unread_count > 0) void this.writeThread(threadId, { unread_count: 0 }, previous);
    void this.loadMessages(threadId);
  }

  public toggleActiveThread(threadId: string) {
    if (this.state.activeThreadId === threadId) {
      this.setActiveThread(null);
    } else {
      this.setActiveThread(threadId);
    }
  }

  public setSearchQuery(q: string) {
    this.patch({ searchQuery: q });
  }

  public setFilter(f: ThreadFilter) {
    this.patch({ filter: f });
  }

  public toggleStar(threadId: string) {
    const previous = this.state.threads;
    const thread = previous.find((t) => t.id === threadId);
    if (!thread) return;
    this.patch({ threads: previous.map((t) => (t.id === threadId ? { ...t, starred: !t.starred } : t)) });
    void this.writeThread(threadId, { starred: !thread.starred }, previous);
  }

  public moveThread(threadId: string, folder: MailFolder) {
    const previous = this.state.threads;
    this.patch({
      threads: previous.map((t) => (t.id === threadId ? { ...t, folder } : t)),
      activeThreadId: this.state.activeThreadId === threadId ? null : this.state.activeThreadId,
    });
    void this.writeThread(threadId, { folder }, previous);
  }

  /** Permanently removes a thread (used from Trash, and for discarded drafts). */
  public deleteThread(threadId: string) {
    const previous = this.state.threads;
    const { [threadId]: _removed, ...messages } = this.state.messages;
    this.patch({
      threads: previous.filter((t) => t.id !== threadId),
      messages,
      activeThreadId: this.state.activeThreadId === threadId ? null : this.state.activeThreadId,
    });
    if (!supabase) return;
    void supabase
      .from('mail_threads')
      .delete()
      .eq('id', threadId)
      .then(({ error }) => {
        if (error) {
          console.error('[mail] thread delete failed:', error.message);
          this.patch({ threads: previous });
        }
      });
  }

  public openComposer(initialDraft?: Partial<ComposerDraft>) {
    this.patch({
      isComposerOpen: true,
      composerDraft: {
        to: initialDraft?.to || '',
        name: initialDraft?.name || '',
        company: initialDraft?.company || '',
        title: initialDraft?.title || '',
        leadId: initialDraft?.leadId || null,
        subject: initialDraft?.subject || (initialDraft?.company ? `Quick intro // ${initialDraft.company}` : ''),
        body: initialDraft?.body || '',
        fromMailboxId: initialDraft?.fromMailboxId || this.state.activeMailboxId,
        draftThreadId: initialDraft?.draftThreadId || null,
      },
    });
  }

  /** Re-opens a thread from the Drafts folder in the composer. */
  public async openDraft(threadId: string) {
    const thread = this.state.threads.find((t) => t.id === threadId);
    if (!thread) return;
    const draftMsg = (await this.loadMessages(threadId)).slice(-1)[0];
    const recipient = thread.participants[0];
    this.openComposer({
      to: recipient?.address || '',
      name: thread.lead_name || recipient?.name || '',
      company: thread.lead_company || '',
      leadId: thread.lead_id || null,
      subject: thread.subject,
      body: draftMsg?.text_body ?? thread.snippet,
      fromMailboxId: thread.mailbox_id,
      draftThreadId: thread.id,
    });
  }

  /**
   * Closes the composer. When the in-progress draft has content it is kept in
   * the Drafts folder so nothing typed is lost; returns true in that case.
   */
  public closeComposer(draft?: ComposerDraft): boolean {
    const saved = draft && hasDraftContent(draft) ? this.saveDraft(draft) : false;
    this.patch({
      isComposerOpen: false,
      composerDraft: { ...EMPTY_DRAFT, fromMailboxId: this.state.activeMailboxId },
    });
    return saved;
  }

  /** Closes the composer and throws the draft away, including its Drafts copy. */
  public discardComposer() {
    const draftId = this.state.composerDraft.draftThreadId;
    if (draftId && this.state.threads.some((t) => t.id === draftId)) this.deleteThread(draftId);
    this.patch({
      isComposerOpen: false,
      composerDraft: { ...EMPTY_DRAFT, fromMailboxId: this.state.activeMailboxId },
    });
  }

  /**
   * Shows the draft in Drafts at once and persists it in the background. The
   * thread id is chosen here, so a draft reopened before its save finishes
   * still updates the same row.
   */
  public saveDraft(draft: ComposerDraft): boolean {
    const mailbox = this.state.mailboxes.find((m) => m.id === draft.fromMailboxId) || this.state.mailboxes[0];
    if (!mailbox) return false;
    const now = new Date().toISOString();
    const threadId = draft.draftThreadId || crypto.randomUUID();
    const existing = this.state.threads.find((t) => t.id === threadId);
    const participants = draft.to.trim() ? [{ name: draft.name || undefined, address: draft.to.trim() }] : [];

    const thread: MailThread = {
      id: threadId,
      user_id: this.state.userId || '',
      mailbox_id: mailbox.id,
      lead_id: draft.leadId || null,
      lead_name: draft.name || null,
      lead_company: draft.company || null,
      subject: draft.subject.trim(),
      snippet: snippetOf(draft.body),
      participants,
      folder: 'drafts',
      unread_count: 0,
      starred: existing?.starred ?? false,
      has_attachments: false,
      last_message_at: now,
      created_at: existing?.created_at ?? now,
    };
    const message: MailMessage = {
      id: `draft_${threadId}`,
      thread_id: threadId,
      user_id: thread.user_id,
      mailbox_id: mailbox.id,
      lead_id: draft.leadId || null,
      direction: 'out',
      status: 'draft',
      from_addr: mailbox.address,
      to_addrs: participants,
      subject: thread.subject,
      snippet: thread.snippet,
      text_body: draft.body,
      html_body: '',
      created_at: now,
    };

    this.state = {
      ...this.state,
      threads: existing
        ? this.state.threads.map((t) => (t.id === threadId ? thread : t))
        : [thread, ...this.state.threads],
      messages: { ...this.state.messages, [threadId]: [message] },
    };

    void invokeFunction<{ thread: any; message: MailMessage }>('mail', {
      action: 'save_draft',
      thread_id: threadId,
      mailbox_id: mailbox.id,
      lead_id: draft.leadId || null,
      to: draft.to.trim(),
      name: draft.name || '',
      company: draft.company || '',
      subject: draft.subject,
      body: draft.body,
    })
      .then((res) => {
        // Ignore a save that finished after the draft was sent or discarded.
        if (!this.state.threads.some((t) => t.id === threadId && t.folder === 'drafts')) return;
        this.patch({
          threads: this.state.threads.map((t) => (t.id === threadId ? toThread(res.thread) : t)),
          messages: { ...this.state.messages, [threadId]: [res.message] },
        });
      })
      .catch((err) => console.error('[mail] draft save failed:', errorMessage(err, 'unknown error')));
    return true;
  }

  public updateDraft(fields: Partial<ComposerDraft>) {
    this.patch({ composerDraft: { ...this.state.composerDraft, ...fields } });
  }

  /** Puts a server-confirmed send into state: thread, message and mailbox counter. */
  private applySent(res: { thread: any; message: MailMessage | null; mailbox: any }) {
    const thread = toThread(res.thread);
    const existing = this.state.messages[thread.id];
    const messages = res.message
      ? { ...this.state.messages, [thread.id]: [...(existing || []), res.message] }
      : this.state.messages;
    return {
      thread,
      threads: [thread, ...this.state.threads.filter((t) => t.id !== thread.id)],
      messages,
      mailboxes: res.mailbox
        ? this.state.mailboxes.map((m) => (m.id === res.mailbox.id ? toMailbox(res.mailbox) : m))
        : this.state.mailboxes,
    };
  }

  /**
   * Sends the email through the `mail` edge function, which enforces the
   * mailbox's daily limit, charges the credits and delivers it. On success the
   * thread shows in Sent and the composer closes.
   */
  public async sendEmail(draft: ComposerDraft, opts: SendOptions = {}): Promise<SendResult> {
    const mailbox = this.state.mailboxes.find((m) => m.id === draft.fromMailboxId) || this.state.mailboxes[0];
    const blocker = mailboxSendBlocker(mailbox);
    if (blocker) return { success: false, kind: 'error', error: blocker };

    // A fresh request id each attempt; "Send anyway" resends the same content
    // with confirm_resend, which the server matches by fingerprint.
    const sent = await invokeSend({
      action: 'send',
      request_id: crypto.randomUUID(),
      mailbox_id: mailbox!.id,
      to: draft.to.trim(),
      name: draft.name || '',
      company: draft.company || '',
      lead_id: draft.leadId || null,
      subject: draft.subject,
      body: draft.body,
      draft_thread_id: draft.draftThreadId || null,
      ...(opts.confirmResend ? { confirm_resend: true } : {}),
    });
    if (!sent.ok) {
      // A refused send releases its hold; an uncertain one was charged.
      refreshWalletAfterSend(Boolean(sent.body?.charge_pending));
      return sendFailure(sent, 'The email could not be sent.');
    }
    const res = sent.data;
    const chargePending = Boolean(res?.charge_pending);
    // A send is a charging action: the balance drops everywhere.
    refreshWalletAfterSend(chargePending);

    // Sent, but the server could not record it: reload what it did store.
    if (!res?.recorded || !res.thread) {
      this.patch({ isComposerOpen: false, composerDraft: { ...EMPTY_DRAFT, fromMailboxId: mailbox!.id } });
      void this.reload();
      return { success: true, threadId: '', chargePending };
    }

    const applied = this.applySent(res);
    this.patch({
      mailboxes: applied.mailboxes,
      // A sent draft leaves the Drafts folder.
      threads: applied.threads.filter((t) => t.id !== draft.draftThreadId),
      messages: applied.messages,
      isComposerOpen: false,
      // Jump to the sent thread: it must be visible in the list, so switch to
      // the sending mailbox and drop any search/filter that could hide it.
      activeMailboxId: mailbox!.id,
      activeThreadId: applied.thread.id,
      activeFolder: 'sent',
      activeSubView: 'mailbox',
      searchQuery: '',
      filter: 'all',
      composerDraft: { ...EMPTY_DRAFT, fromMailboxId: mailbox!.id },
    });

    // Mirror the outreach into the leads pipeline and the Prospector rows
    // (the server already updated the saved lead) so both flip to
    // 'contacted' without a refetch.
    if (draft.leadId) leadsStore.markContacted(draft.leadId);

    return { success: true, threadId: applied.thread.id, chargePending };
  }

  public async sendQuickReply(threadId: string, replyBody: string, opts: SendOptions = {}): Promise<SendResult> {
    const thread = this.state.threads.find((t) => t.id === threadId);
    if (!thread) return { success: false, kind: 'error', error: 'This conversation no longer exists.' };
    if (!replyBody.trim()) return { success: false, kind: 'error', error: 'Write a reply first.' };

    const mailbox = this.state.mailboxes.find((m) => m.id === thread.mailbox_id);
    const blocker = mailboxSendBlocker(mailbox);
    if (blocker) return { success: false, kind: 'error', error: blocker };

    const sent = await invokeSend({
      action: 'send',
      request_id: crypto.randomUUID(),
      thread_id: threadId,
      body: replyBody,
      ...(opts.confirmResend ? { confirm_resend: true } : {}),
    });
    if (!sent.ok) {
      refreshWalletAfterSend(Boolean(sent.body?.charge_pending));
      return sendFailure(sent, 'The reply could not be sent.');
    }
    const res = sent.data;
    const chargePending = Boolean(res?.charge_pending);
    refreshWalletAfterSend(chargePending);

    if (!res?.recorded || !res.thread) {
      void this.reload();
      return { success: true, threadId, chargePending };
    }
    await this.loadMessages(threadId);
    const applied = this.applySent(res);
    this.patch({ mailboxes: applied.mailboxes, threads: applied.threads, messages: applied.messages });
    return { success: true, threadId, chargePending };
  }

  private setDomainSetup(domainId: string, info: DomainSetupInfo) {
    const domainSetup = { ...this.state.domainSetup, [domainId]: { ...this.state.domainSetup[domainId], ...info } };
    this.patch({ domainSetup });
    writeStoredSetup(domainSetup);
  }

  public async addDomain(domainName: string, localPart?: string): Promise<{ domain: MailDomain } | { error: string }> {
    const cleanLocal = (localPart || '').trim().toLowerCase();
    if (cleanLocal && !/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(cleanLocal)) {
      return { error: 'The address can use letters, numbers, dots, dashes and underscores.' };
    }
    const cleanDomain = domainName
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(cleanDomain)) {
      return { error: 'Enter a valid domain, e.g. trycompany.com' };
    }
    if (this.state.domains.some((d) => d.domain === cleanDomain)) {
      return { error: `${cleanDomain} is already added.` };
    }
    try {
      const res = await invokeFunction<{ domain: MailDomain }>('mail', {
        action: 'add_domain',
        domain: cleanDomain,
        ...(cleanLocal ? { local_part: cleanLocal } : {}),
      });
      this.patch({ domains: [...this.state.domains, res.domain] });
      const setup = extractSetup(res);
      if (setup || cleanLocal) this.setDomainSetup(res.domain.id, { ...setup, ...(cleanLocal ? { local_part: cleanLocal } : {}) });
      return { domain: res.domain };
    } catch (err) {
      return { error: errorMessage(err, 'Could not add the domain.') };
    }
  }

  /** Asks the provider to re-check the domain's DNS records. */
  public async verifyDomain(domainId: string): Promise<{ domain: MailDomain } | { error: string }> {
    const previous = this.state.domains.find((d) => d.id === domainId);
    try {
      const res = await invokeFunction<{ domain: MailDomain }>('mail', { action: 'verify_domain', domain_id: domainId });
      this.patch({ domains: this.state.domains.map((d) => (d.id === domainId ? res.domain : d)) });
      const setup = extractSetup(res);
      if (setup) this.setDomainSetup(domainId, setup);
      // Hosted mailboxes are paused, resumed or auto-created with their
      // domain; only a status change can move them, so a background poll that
      // finds nothing new does not reload the whole workspace.
      if (!previous || previous.status !== res.domain.status) void this.reload();
      return { domain: res.domain };
    } catch (err) {
      return { error: errorMessage(err, 'Could not check DNS.') };
    }
  }

  /** The signed Domain Connect URL that applies the DNS records at the user's provider. */
  public async domainConnectUrl(
    domainId: string
  ): Promise<{ url: string } | { error: string; notConfigured?: boolean }> {
    const res = await invokeMail({ action: 'domain_connect_url', domain_id: domainId });
    if (res.ok) {
      const url = res.data?.url;
      if (typeof url === 'string' && /^https:\/\//i.test(url)) return { url };
      return { error: 'Automatic setup returned no link. Follow the steps below instead.' };
    }
    if (res.status === 501 || res.body?.not_configured) {
      this.setDomainSetup(domainId, { domain_connect: { supported: false } });
      return { notConfigured: true, error: "Automatic setup isn't available for this domain yet. Follow the steps below." };
    }
    return { error: res.message || 'Could not start automatic setup.' };
  }

  // --------------------------------------------------------------------------
  // Echo-hosted mailboxes on the shared domain
  // --------------------------------------------------------------------------

  /** Loads mail_config once per session (pass force to re-read the counter). */
  public async loadMailConfig(force = false) {
    if (!this.state.userId || this.state.mailConfigLoading) return;
    if (this.state.mailConfig && !force) return;
    const userId = this.state.userId;
    this.patch({ mailConfigLoading: true });
    const res = await invokeMail({ action: 'mail_config' }, 15_000);
    if (this.state.userId !== userId) return;
    if (res.ok && res.data) {
      const d = res.data;
      this.patch({
        mailConfigLoading: false,
        mailConfig: {
          shared_domain: typeof d.shared_domain === 'string' && d.shared_domain ? d.shared_domain : null,
          max_echo_mailboxes: Number(d.max_echo_mailboxes) || 3,
          echo_mailboxes_used: Number(d.echo_mailboxes_used) || 0,
        },
      });
    } else {
      // Not deployed yet or unreachable: Echo addresses show as "coming soon".
      if (!res.ok) console.error('[mail] mail_config failed:', res.status, res.message);
      this.patch({
        mailConfigLoading: false,
        mailConfig: this.state.mailConfig || { shared_domain: null, max_echo_mailboxes: 3, echo_mailboxes_used: 0 },
      });
    }
  }

  /** Live availability for an Echo address while the user types. */
  public async checkMailboxName(localPart: string): Promise<MailboxNameCheck> {
    const res = await invokeMail({ action: 'check_mailbox_name', local_part: localPart.trim().toLowerCase() }, 10_000);
    if (res.ok) {
      const d = res.data || {};
      return {
        ok: true,
        available: Boolean(d.available),
        reason: d.reason,
        address: String(d.address || ''),
        suggestions: Array.isArray(d.suggestions) ? d.suggestions.map(String).slice(0, 4) : [],
      };
    }
    if (res.status === 429 || res.body?.rate_limited) {
      return { ok: false, rateLimited: true, error: 'Checking too fast — pause a moment.' };
    }
    return { ok: false, error: res.message || "Couldn't check that name." };
  }

  /** Claims local@shared_domain for the user, sent and received through Echo. */
  public async claimEchoMailbox(localPart: string, displayName: string): Promise<ClaimEchoResult> {
    const res = await invokeMail({
      action: 'claim_echo_mailbox',
      local_part: localPart.trim().toLowerCase(),
      display_name: displayName.trim(),
    });
    if (res.ok) {
      const row = res.data?.mailbox;
      const mailbox = row ? this.addMailbox(row) : null;
      // Pick up is_default / limits as stored, and the new "x of 3" counter.
      void this.reload();
      void this.loadMailConfig(true);
      return { mailbox };
    }
    const b = res.body || {};
    const suggestions = Array.isArray(b.suggestions) ? b.suggestions.map(String).slice(0, 4) : [];
    if (res.status === 409 || b.taken) {
      return { code: 'taken', reason: 'taken', suggestions, error: 'That address was just taken. Pick another.' };
    }
    if (res.status === 422 || b.reason) {
      const reason = (b.reason as MailboxNameReason) || 'invalid';
      return { code: 'invalid', reason, suggestions, error: MAILBOX_NAME_REASON_COPY[reason] || res.message || 'That name can’t be used.' };
    }
    if (res.status === 429 && b.limit_reached) {
      void this.loadMailConfig(true);
      const max = this.state.mailConfig?.max_echo_mailboxes || 3;
      return { code: 'limit_reached', error: `You already have ${max} Echo addresses — the most one account can have.` };
    }
    if (res.status === 503 || b.platform_unavailable) {
      return { code: 'platform_unavailable', error: 'Echo email is temporarily unavailable. Please try again in a few minutes.' };
    }
    if (res.status === 429 || b.rate_limited) {
      return { code: 'error', error: 'Too many requests. Please try again in a minute.' };
    }
    return { code: 'error', error: res.message || 'Could not create the address.' };
  }

  /** Opens Accounts with the "use your own inbox" dialog showing. */
  public requestConnectInbox() {
    this.patch({ activeSubView: 'accounts', connectInboxRequested: true });
  }

  public clearConnectInboxRequest() {
    if (this.state.connectInboxRequested) this.patch({ connectInboxRequested: false });
  }

  public async removeDomain(domainId: string): Promise<{ ok: true } | { error: string }> {
    const previous = this.state.domains;
    this.patch({ domains: previous.filter((d) => d.id !== domainId) });
    try {
      await invokeFunction('mail', { action: 'remove_domain', domain_id: domainId });
      void this.reload();
      return { ok: true };
    } catch (err) {
      this.patch({ domains: previous });
      return { error: errorMessage(err, 'Could not remove the domain.') };
    }
  }

  private addMailbox(row: any): Mailbox {
    const mailbox = toMailbox(row);
    this.patch({
      mailboxes: [...this.state.mailboxes, mailbox],
      activeMailboxId: mailbox.id,
      composerDraft: { ...this.state.composerDraft, fromMailboxId: mailbox.id },
    });
    return mailbox;
  }

  /**
   * Connects Gmail / Zoho / custom SMTP. The server checks the login before
   * keeping the password, and stores it in Vault; it never comes back here.
   */
  public async connectAppPasswordMailbox(
    address: string,
    displayName: string,
    provider: AppPasswordProvider,
    password: string,
    smtpHost?: string
  ): Promise<{ mailbox: Mailbox } | { error: string }> {
    const clean = address.trim().toLowerCase();
    if (this.state.mailboxes.some((m) => m.address.toLowerCase() === clean)) {
      return { error: `${clean} is already connected.` };
    }
    try {
      const res = await invokeFunction<{ mailbox: any }>('mail', {
        action: 'connect_app_password',
        address: clean,
        display_name: displayName.trim(),
        provider,
        password,
        smtp_host: smtpHost || '',
      }, { timeoutMs: 60_000 });
      return { mailbox: this.addMailbox(res.mailbox) };
    } catch (err) {
      return { error: errorMessage(err, 'Could not connect the mailbox.') };
    }
  }

  /** Creates an address on a verified domain, sent through Echo's provider. */
  public async createHostedMailbox(
    domainId: string,
    localPart: string,
    displayName: string
  ): Promise<{ mailbox: Mailbox } | { error: string }> {
    try {
      const res = await invokeFunction<{ mailbox: any }>('mail', {
        action: 'create_hosted_mailbox',
        domain_id: domainId,
        local_part: localPart.trim().toLowerCase(),
        display_name: displayName.trim(),
      });
      return { mailbox: this.addMailbox(res.mailbox) };
    } catch (err) {
      return { error: errorMessage(err, 'Could not create the mailbox.') };
    }
  }

  public setDefaultMailbox(mailboxId: string) {
    const previous = this.state.mailboxes;
    this.patch({ mailboxes: previous.map((m) => ({ ...m, is_default: m.id === mailboxId })) });
    invokeFunction('mail', { action: 'set_default_mailbox', mailbox_id: mailboxId }).catch((err) => {
      console.error('[mail] set default failed:', errorMessage(err, 'unknown error'));
      this.patch({ mailboxes: previous });
    });
  }

  /** Disconnects a mailbox and drops its conversations. */
  public async removeMailbox(mailboxId: string): Promise<boolean> {
    try {
      await invokeFunction('mail', { action: 'remove_mailbox', mailbox_id: mailboxId });
    } catch (err) {
      console.error('[mail] remove mailbox failed:', errorMessage(err, 'unknown error'));
      return false;
    }
    const remaining = this.state.mailboxes.filter((m) => m.id !== mailboxId);
    if (remaining.length > 0 && !remaining.some((m) => m.is_default)) {
      remaining[0] = { ...remaining[0], is_default: true };
    }
    const fallbackId = pickDefault(remaining);
    const wasActive = this.state.activeMailboxId === mailboxId;
    const activeMailboxId = wasActive ? fallbackId : this.state.activeMailboxId;
    this.patch({
      mailboxes: remaining,
      threads: this.state.threads.filter((t) => t.mailbox_id !== mailboxId),
      activeMailboxId,
      activeThreadId: wasActive ? null : this.state.activeThreadId,
      composerDraft:
        this.state.composerDraft.fromMailboxId === mailboxId
          ? { ...this.state.composerDraft, fromMailboxId: activeMailboxId }
          : this.state.composerDraft,
    });
    return true;
  }
}

export const mailStore = new MailStore();

export function useMailStore(): MailState {
  return useSyncExternalStore(mailStore.subscribe, mailStore.getSnapshot);
}
