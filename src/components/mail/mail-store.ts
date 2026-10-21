import { useSyncExternalStore } from 'react';
import type { Mailbox, MailThread, MailMessage, MailFolder, MailDomain } from '../../types';
import { leadsStore } from '../leads/leads-store';
import { supabase } from '../../lib/supabase';
import { invokeFunction } from '../../lib/api';

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
  subject: string;
  body: string;
  fromMailboxId?: string;
  /** Set when the draft was resumed from the Drafts folder. */
  draftThreadId?: string | null;
}

export type SendResult = { success: true; threadId: string } | { success: false; error: string };

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
}

const MAILBOX_COLUMNS =
  'id, user_id, kind, provider, address, display_name, domain_id, status, pause_reason, daily_send_limit, sent_today, sent_today_date, is_default, created_at';
const DOMAIN_COLUMNS =
  'id, domain, status, provider, dkim_tokens, dns_records, inbound_provider, verified_at, last_checked_at';
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
      supabase.from('mail_domains').select(DOMAIN_COLUMNS).order('created_at'),
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
      threads: (thRes.data || []).map(toThread),
      activeMailboxId,
      composerDraft: this.state.composerDraft.fromMailboxId
        ? this.state.composerDraft
        : { ...this.state.composerDraft, fromMailboxId: activeMailboxId },
    });
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
  public async sendEmail(draft: ComposerDraft): Promise<SendResult> {
    const mailbox = this.state.mailboxes.find((m) => m.id === draft.fromMailboxId) || this.state.mailboxes[0];
    const blocker = mailboxSendBlocker(mailbox);
    if (blocker) return { success: false, error: blocker };

    let res: any;
    try {
      res = await invokeFunction('mail', {
        action: 'send',
        request_id: crypto.randomUUID(),
        mailbox_id: mailbox.id,
        to: draft.to.trim(),
        name: draft.name || '',
        company: draft.company || '',
        lead_id: draft.leadId || null,
        subject: draft.subject,
        body: draft.body,
        draft_thread_id: draft.draftThreadId || null,
      }, { timeoutMs: 60_000 });
    } catch (err) {
      return { success: false, error: errorMessage(err, 'The email could not be sent.') };
    }

    // Sent, but the server could not record it: reload what it did store.
    if (!res?.recorded || !res.thread) {
      this.patch({ isComposerOpen: false, composerDraft: { ...EMPTY_DRAFT, fromMailboxId: mailbox.id } });
      void this.reload();
      return { success: true, threadId: '' };
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
      activeMailboxId: mailbox.id,
      activeThreadId: applied.thread.id,
      activeFolder: 'sent',
      activeSubView: 'mailbox',
      searchQuery: '',
      filter: 'all',
      composerDraft: { ...EMPTY_DRAFT, fromMailboxId: mailbox.id },
    });

    // Mirror the outreach into the leads pipeline (the server already updated
    // the saved lead) so the lead row flips to 'contacted' without a refetch.
    if (draft.leadId) {
      try {
        leadsStore.setSavedLeads((prev) =>
          prev.map((l) => (l.id === draft.leadId || l.db_id === draft.leadId ? { ...l, status: 'contacted' } : l))
        );
      } catch {
        // leads store may not be initialised; ignore
      }
    }

    return { success: true, threadId: applied.thread.id };
  }

  public async sendQuickReply(threadId: string, replyBody: string): Promise<SendResult> {
    const thread = this.state.threads.find((t) => t.id === threadId);
    if (!thread) return { success: false, error: 'This conversation no longer exists.' };
    if (!replyBody.trim()) return { success: false, error: 'Write a reply first.' };

    const mailbox = this.state.mailboxes.find((m) => m.id === thread.mailbox_id);
    const blocker = mailboxSendBlocker(mailbox);
    if (blocker) return { success: false, error: blocker };

    let res: any;
    try {
      res = await invokeFunction('mail', {
        action: 'send',
        request_id: crypto.randomUUID(),
        thread_id: threadId,
        body: replyBody,
      }, { timeoutMs: 60_000 });
    } catch (err) {
      return { success: false, error: errorMessage(err, 'The reply could not be sent.') };
    }

    if (!res?.recorded || !res.thread) {
      void this.reload();
      return { success: true, threadId };
    }
    await this.loadMessages(threadId);
    const applied = this.applySent(res);
    this.patch({ mailboxes: applied.mailboxes, threads: applied.threads, messages: applied.messages });
    return { success: true, threadId };
  }

  public async addDomain(domainName: string): Promise<{ domain: MailDomain } | { error: string }> {
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
      const res = await invokeFunction<{ domain: MailDomain }>('mail', { action: 'add_domain', domain: cleanDomain });
      this.patch({ domains: [...this.state.domains, res.domain] });
      return { domain: res.domain };
    } catch (err) {
      return { error: errorMessage(err, 'Could not add the domain.') };
    }
  }

  /** Asks the provider to re-check the domain's DNS records. */
  public async verifyDomain(domainId: string): Promise<{ domain: MailDomain } | { error: string }> {
    try {
      const res = await invokeFunction<{ domain: MailDomain }>('mail', { action: 'verify_domain', domain_id: domainId });
      this.patch({ domains: this.state.domains.map((d) => (d.id === domainId ? res.domain : d)) });
      // Hosted mailboxes are paused or resumed with their domain.
      void this.reload();
      return { domain: res.domain };
    } catch (err) {
      return { error: errorMessage(err, 'Could not check DNS.') };
    }
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
