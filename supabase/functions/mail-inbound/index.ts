// ============================================================================
// Supabase Edge Function: mail-inbound
// ----------------------------------------------------------------------------
// Receives Resend webhooks:
//
//   email.received    a reply (or any mail) to one of our hosted mailboxes.
//                     The webhook carries metadata only, so the full message
//                     is fetched from the Receiving API, threaded, and stored.
//   email.bounced     \
//   email.complained   > forwarded to mail_record_delivery_event().
//   email.delivered   /
//   anything else     acknowledged and ignored.
//
// Authentication is the Svix / Standard Webhooks signature over the raw body
// (RESEND_WEBHOOK_SECRET, whsec_...). JWT verification is OFF: Resend has no
// Supabase session. Fails closed: no secret or a bad signature -> 401.
//
// Nothing about the message (bodies, addresses, provider errors) is returned to
// the caller or written to the logs; logs carry ids and short codes only.
//
// Deploy:  node scripts/deploy-functions.cjs mail-inbound
// Secrets: RESEND_WEBHOOK_SECRET, RESEND_API_KEY
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';
import {
  deliveryEventOf,
  escapeLike,
  headerValue,
  htmlToText,
  isAutoReply,
  isSpam,
  matchRecipient,
  messageIdLocalPart,
  normaliseMessageId,
  normaliseSubject,
  parseAddress,
  parseAddressList,
  parseMessageIds,
  participantAddresses,
  snippetOf,
  verifyWebhookSignature,
  withParticipant,
  type Party,
} from './rules.ts';

const RESEND_API = 'https://api.resend.com';
const SUBJECT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_CHARS = 1_000_000;
const SAFE_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Marks a failure as permanent: the delivery is closed, not retried. */
class FinalError extends Error {}

// deno-lint-ignore no-explicit-any
type Admin = any;

interface Mailbox {
  id: string;
  user_id: string;
  address: string;
}

interface Thread {
  id: string;
  user_id: string;
  mailbox_id: string;
  lead_id: string | null;
  folder: string;
  unread_count: number;
  participants: unknown;
  has_attachments: boolean;
  subject: string;
  last_message_at: string;
}

const THREAD_COLUMNS =
  'id, user_id, mailbox_id, lead_id, folder, unread_count, participants, has_attachments, subject, last_message_at';

// ---------------------------------------------------------------------------
// Resend Receiving API
// GET https://api.resend.com/emails/receiving/{id}
// https://resend.com/docs/api-reference/emails/retrieve-received-email
// ---------------------------------------------------------------------------
async function fetchReceivedEmail(emailId: string): Promise<any> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('resend_key_missing');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } catch {
    throw new Error('resend_fetch_network');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) {
    await res.body?.cancel();
    throw new FinalError('resend_email_not_found');
  }
  if (!res.ok) {
    await res.body?.cancel();
    // 401/403 is a config problem; 429/5xx is transient. Both are retried by
    // Resend once fixed / recovered, so neither is final.
    throw new Error(`resend_fetch_${res.status}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Every Echo mailbox a message is for, at most one per user.
 *
 * Only hosted mailboxes receive through this webhook, and only on a domain
 * that may receive for them: the shared platform domain, or a verified domain
 * owned by the same user. A connected Gmail/SMTP mailbox, or an address on a
 * domain someone else registered, never matches, so a forged To: header
 * cannot drop mail into another workspace.
 */
async function findMailboxes(admin: Admin, recipients: string[]): Promise<Mailbox[]> {
  const out: Mailbox[] = [];
  const seenUsers = new Set<string>();
  for (const addr of [...new Set(recipients.map((a) => a.toLowerCase()))].slice(0, 20)) {
    const { data, error } = await admin
      .from('mailboxes')
      .select('id, user_id, address, kind, domain_id')
      .ilike('address', escapeLike(addr))
      .eq('kind', 'hosted')
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw new Error(`mailbox_lookup: ${error.code ?? 'error'}`);
    const mb = data?.[0];
    if (!mb || seenUsers.has(mb.user_id) || !mb.domain_id) continue;
    const { data: domain, error: domainError } = await admin
      .from('mail_domains')
      .select('user_id, is_platform, status')
      .eq('id', mb.domain_id)
      .maybeSingle();
    if (domainError) throw new Error(`domain_lookup: ${domainError.code ?? 'error'}`);
    if (!domain || domain.status !== 'verified' || !(domain.is_platform || domain.user_id === mb.user_id)) continue;
    seenUsers.add(mb.user_id);
    out.push({ id: mb.id, user_id: mb.user_id, address: mb.address } as Mailbox);
  }
  return out;
}

async function threadById(admin: Admin, id: string, userId: string): Promise<Thread | null> {
  const { data, error } = await admin
    .from('mail_threads').select(THREAD_COLUMNS).eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`thread_lookup: ${error.code ?? 'error'}`);
  return (data as Thread) ?? null;
}

/** In-Reply-To / References -> a message we stored (same user) -> its thread. */
async function threadByHeaders(admin: Admin, userId: string, ids: string[]): Promise<Thread | null> {
  if (!ids.length) return null;
  const { data, error } = await admin
    .from('mail_messages')
    .select('thread_id, created_at')
    .eq('user_id', userId)
    .in('message_id_header', ids)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`header_lookup: ${error.code ?? 'error'}`);
  if (data?.[0]?.thread_id) return await threadById(admin, data[0].thread_id, userId);

  // Hosted sends store Resend's id rather than a Message-ID. If the provider
  // ever uses that id as the Message-ID local part, this still threads.
  const locals = ids.map(messageIdLocalPart).filter((x): x is string => !!x && SAFE_ID_RE.test(x));
  if (!locals.length) return null;
  const { data: byProvider, error: e2 } = await admin
    .from('mail_messages')
    .select('thread_id, created_at')
    .eq('user_id', userId)
    .in('provider_message_id', locals)
    .order('created_at', { ascending: false })
    .limit(1);
  if (e2) throw new Error(`provider_lookup: ${e2.code ?? 'error'}`);
  if (byProvider?.[0]?.thread_id) return await threadById(admin, byProvider[0].thread_id, userId);
  return null;
}

/** Same normalised subject, sender already a participant, active in the last 30 days. */
async function threadBySubject(admin: Admin, mailbox: Mailbox, subject: string, sender: string): Promise<Thread | null> {
  const norm = normaliseSubject(subject);
  if (!norm) return null;
  const since = new Date(Date.now() - SUBJECT_THREAD_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from('mail_threads')
    .select(THREAD_COLUMNS)
    .eq('user_id', mailbox.user_id)
    .eq('mailbox_id', mailbox.id)
    .gte('last_message_at', since)
    .order('last_message_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`subject_lookup: ${error.code ?? 'error'}`);
  for (const t of (data ?? []) as Thread[]) {
    if (normaliseSubject(t.subject) !== norm) continue;
    if (participantAddresses(t.participants).includes(sender)) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// email.received
// ---------------------------------------------------------------------------

async function handleReceived(admin: Admin, data: any): Promise<{ status: 'processed' | 'ignored'; note: string | null }> {
  const emailId = typeof data?.email_id === 'string' ? data.email_id : null;
  if (!emailId || !SAFE_ID_RE.test(emailId)) return { status: 'ignored', note: 'no_email_id' };

  // The envelope recipients (received_for) say who the message was really
  // delivered to; the To/Cc headers are only used when the envelope is
  // missing. Known from the webhook itself, so an unknown recipient is dropped
  // before spending a Receiving API call.
  const recipientsOf = (envelope: Party[], headerTo: Party[], headerCc: Party[]) =>
    (envelope.length ? envelope : [...headerTo, ...headerCc]).map((p) => p.address);
  const metaRecipients = recipientsOf(
    parseAddressList(data?.received_for), parseAddressList(data?.to), parseAddressList(data?.cc),
  );
  let mailboxes = metaRecipients.length ? await findMailboxes(admin, metaRecipients) : [];
  if (metaRecipients.length && !mailboxes.length) {
    console.log(`[mail-inbound] ${emailId}: no mailbox for recipient - dropped`);
    return { status: 'ignored', note: 'unknown_recipient' };
  }

  const email = await fetchReceivedEmail(emailId);
  const headers = (email?.headers && typeof email.headers === 'object') ? email.headers : {};

  const to = parseAddressList(email?.to ?? data?.to);
  const cc = parseAddressList(email?.cc ?? data?.cc);
  const receivedFor = parseAddressList(email?.received_for ?? data?.received_for);
  if (!mailboxes.length) {
    const recipients = recipientsOf(receivedFor, to, cc);
    mailboxes = recipients.length ? await findMailboxes(admin, recipients) : [];
  }
  if (!mailboxes.length) {
    console.log(`[mail-inbound] ${emailId}: no mailbox for recipient - dropped`);
    return { status: 'ignored', note: 'unknown_recipient' };
  }

  const sender: Party | null =
    parseAddress(headerValue(headers, 'from')) ?? parseAddress(email?.from ?? data?.from);
  if (!sender) return { status: 'ignored', note: 'no_sender' };
  const from: Party = sender;

  // No line breaks: a reply reuses this subject as a header.
  const subject = String(email?.subject ?? data?.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 998);
  const messageId = normaliseMessageId(email?.message_id ?? data?.message_id ?? headerValue(headers, 'message-id'), emailId);

  const inReplyToRaw = headerValue(headers, 'in-reply-to');
  const referencesRaw = headerValue(headers, 'references');
  const inReplyIds = parseMessageIds(inReplyToRaw);
  const refIds = parseMessageIds(referencesRaw);
  const threadIds = [...new Set([...inReplyIds, ...refIds.slice().reverse()])].slice(0, 50);

  const autoReply = isAutoReply(headers, subject);
  const spam = isSpam(headers, email);

  const text = String(email?.text ?? '').slice(0, MAX_BODY_CHARS);
  const html = String(email?.html ?? '').slice(0, MAX_BODY_CHARS);
  const snippet = snippetOf(text || htmlToText(html));
  const receivedAt = typeof email?.created_at === 'string' ? email.created_at : new Date().toISOString();
  const attachments: any[] = Array.isArray(email?.attachments) ? email.attachments : [];

  // One copy per Echo user the message was delivered to (a mail can cc two
  // customers, or one Echo user can write to another).
  const notes: string[] = [];
  for (const mailbox of mailboxes) {
    const note = await storeFor(mailbox);
    if (note) notes.push(note);
  }
  return { status: 'processed', note: notes.length ? notes.join(',').slice(0, 200) : null };

  async function storeFor(mailbox: Mailbox): Promise<string | null> {
  // Redelivery of a message this user already has (another webhook id). The
  // check is per user: the same Message-ID is legitimately stored once for
  // the from's Sent copy and once for each Echo recipient.
  {
    const { data: dup, error } = await admin
      .from('mail_messages').select('id')
      .eq('user_id', mailbox.user_id).eq('message_id_header', messageId).limit(1);
    if (error) throw new Error(`dup_lookup: ${error.code ?? 'error'}`);
    if (dup?.length) return 'duplicate_message';
  }

  // 1. Thread.
  let thread = await threadByHeaders(admin, mailbox.user_id, threadIds);
  if (!thread) thread = await threadBySubject(admin, mailbox, subject, from.address);
  let createdThread = false;
  if (!thread) {
    const { data: created, error } = await admin
      .from('mail_threads')
      .insert({
        user_id: mailbox.user_id,
        mailbox_id: mailbox.id,
        subject,
        snippet,
        participants: [{ address: from.address, name: from.name }],
        folder: spam ? 'spam' : 'inbox',
        unread_count: 0,
        has_attachments: false,
        last_message_at: receivedAt,
      })
      .select(THREAD_COLUMNS)
      .single();
    if (error || !created) throw new Error(`thread_insert: ${error?.code ?? 'error'}`);
    thread = created as Thread;
    createdThread = true;
  }

  // 2. Message.
  const { data: msg, error: msgError } = await admin
    .from('mail_messages')
    .insert({
      thread_id: thread.id,
      user_id: mailbox.user_id,
      mailbox_id: mailbox.id,
      lead_id: thread.lead_id,
      direction: 'in',
      status: 'received',
      is_auto_reply: autoReply,
      from_addr: from.address,
      to_addrs: to,
      cc_addrs: cc,
      subject,
      snippet,
      text_body: text,
      // Raw: the client sanitises with DOMPurify before rendering.
      html_body: html,
      message_id_header: messageId,
      in_reply_to: inReplyIds[0] ?? null,
      references_hdr: refIds.length ? refIds.join(' ').slice(-2000) : null,
      provider_message_id: emailId,
      received_at: receivedAt,
    })
    .select('id')
    .single();
  if (msgError || !msg) {
    if (createdThread) await admin.from('mail_threads').delete().eq('id', thread.id);
    if (msgError?.code === '23505') return 'duplicate_message';
    throw new Error(`message_insert: ${msgError?.code ?? 'error'}`);
  }

  // 3. Attachments (metadata only; content is fetched on demand later).
  let attachmentNote: string | null = null;
  const attRows = attachments
    .filter((a) => a && typeof a === 'object')
    .slice(0, 50)
    .map((a) => ({
      message_id: msg.id,
      user_id: mailbox.user_id,
      filename: String(a.filename ?? 'attachment').slice(0, 255),
      content_type: String(a.content_type ?? 'application/octet-stream').slice(0, 255),
      size_bytes: Number.isFinite(Number(a.size)) ? Math.max(0, Math.trunc(Number(a.size))) : 0,
      // No provider-id column: the Resend reference is kept here under a
      // scheme that is clearly not a Storage path.
      storage_path: `resend://receiving/${emailId}/attachments/${String(a.id ?? '')}`.slice(0, 500),
    }));
  if (attRows.length) {
    const { error } = await admin.from('mail_attachments').insert(attRows);
    if (error) {
      attachmentNote = `attachments_failed:${error.code ?? 'error'}`;
      console.warn(`[mail-inbound] ${emailId}: attachment metadata not stored (${error.code ?? 'error'})`);
    }
  }

  // 4. Thread state.
  const folder = createdThread
    ? thread.folder
    : (['archive', 'sent'].includes(thread.folder) ? 'inbox' : thread.folder);
  const newer = !thread.last_message_at || Date.parse(receivedAt) >= Date.parse(thread.last_message_at);
  const { error: thErr } = await admin
    .from('mail_threads')
    .update({
      unread_count: (Number(thread.unread_count) || 0) + 1,
      ...(newer ? { last_message_at: receivedAt, snippet } : {}),
      folder,
      participants: withParticipant(thread.participants, from),
      has_attachments: thread.has_attachments || attRows.length > 0,
    })
    .eq('id', thread.id);
  if (thErr) console.warn(`[mail-inbound] ${emailId}: thread update failed (${thErr.code ?? 'error'})`);

  // 5. Lead: a human reply moves it to 'replied'. A lead the user dismissed
  //    stays dismissed; auto-replies and spam never count.
  if (thread.lead_id && !autoReply && !spam) {
    const { error } = await admin
      .from('user_leads')
      .update({ status: 'replied', updated_at: new Date().toISOString() })
      .eq('id', thread.lead_id)
      .eq('user_id', mailbox.user_id)
      .in('status', ['new', 'contacted']);
    if (error) console.warn(`[mail-inbound] ${emailId}: lead update failed (${error.code ?? 'error'})`);
  }

  console.log(
    `[mail-inbound] received ${emailId} thread=${thread.id} new_thread=${createdThread} ` +
    `auto=${autoReply} spam=${spam} attachments=${attRows.length}`,
  );
  return attachmentNote;
  }
}

// ---------------------------------------------------------------------------
// Delivery events
// ---------------------------------------------------------------------------

/** A delivery event for a message we have not stored yet is retried for this long. */
const DELIVERY_RETRY_WINDOW_MS = 30 * 60_000;

async function handleDelivery(
  admin: Admin,
  event: 'bounced' | 'complained' | 'delivered',
  data: any,
  createdAt: unknown,
): Promise<{ status: 'processed' | 'ignored'; note: string | null }> {
  const emailId = typeof data?.email_id === 'string' ? data.email_id : null;
  if (!emailId || !SAFE_ID_RE.test(emailId)) return { status: 'ignored', note: 'no_email_id' };

  const { data: out, error } = await admin.rpc('mail_record_delivery_event', {
    p_provider_message_id: emailId,
    p_event: event,
  });
  if (error) {
    // Deployed before the migration that creates the RPC: acknowledge, so
    // Resend does not retry for days, and leave a trace in webhook_events.
    if (error.code === 'PGRST202' || error.code === '42883') {
      console.warn(`[mail-inbound] mail_record_delivery_event missing; ${event} for ${emailId} not recorded`);
      return { status: 'ignored', note: 'rpc_missing' };
    }
    throw new Error(`delivery_rpc: ${error.code ?? 'error'}`);
  }
  if (out?.error === 'message_not_found') {
    // A fast webhook can beat the send's own row insert. Retried for a while
    // (Resend redelivers on a non-2xx) so a bounce still counts.
    const age = Date.now() - Date.parse(String(createdAt ?? ''));
    if (Number.isFinite(age) && age < DELIVERY_RETRY_WINDOW_MS) throw new Error('message_not_found_yet');
    return { status: 'processed', note: 'message_not_found' };
  }
  console.log(`[mail-inbound] ${event} ${emailId} matched=${out?.matched ?? out?.ok ?? '-'}`);
  return { status: 'processed', note: null };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET') ?? '';
  if (!secret) {
    console.error('[mail-inbound] RESEND_WEBHOOK_SECRET not set - refusing');
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  // Signed bytes: must be the raw body, not a re-serialisation.
  const rawBody = await req.text();
  const verified = await verifyWebhookSignature(rawBody, req.headers, secret);
  if (!verified.ok || !verified.id) {
    console.warn(`[mail-inbound] rejected: ${verified.reason}`);
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const eventType = String(event?.type ?? 'unknown').slice(0, 100);
  const data = event?.data ?? {};

  const handled = eventType === 'email.received' || deliveryEventOf(eventType) !== null;
  if (!handled) return json({ ok: true, ignored: true });

  const admin: Admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // webhook_events.webhook_id is unique across providers; prefix keeps Resend
  // ids from ever colliding with Dodo's. Only ids go into the stored payload:
  // the metadata carries addresses and subjects, which do not belong there.
  const webhookId = `resend:${verified.id}`.slice(0, 200);
  const { data: claim, error: claimError } = await admin.rpc('webhook_claim', {
    p_provider: 'resend',
    p_webhook_id: webhookId,
    p_event_type: eventType,
    p_payload: { type: eventType, created_at: event?.created_at ?? null, email_id: data?.email_id ?? null },
    p_lease: '5 minutes',
  });
  if (claimError) {
    console.error(`[mail-inbound] could not record event (${claimError.code ?? 'error'})`);
    return json({ ok: false, error: 'record_failed' }, 500);
  }
  if (claim?.claimed !== true) {
    if (claim?.in_flight) return json({ ok: false, error: 'in_flight' }, 409);
    return json({ ok: true, duplicate: true });
  }

  const markEvent = (status: 'processed' | 'failed' | 'ignored', lastError: string | null = null) =>
    admin.from('webhook_events')
      .update({
        status,
        last_error: lastError,
        claimed_at: null,
        processed_at: status === 'failed' ? null : new Date().toISOString(),
      })
      .eq('webhook_id', webhookId);

  try {
    const delivery = deliveryEventOf(eventType);
    const result = delivery
      ? await handleDelivery(admin, delivery, data, event?.created_at)
      : await handleReceived(admin, data);
    await markEvent(result.status, result.note);
    return json({ ok: true });
  } catch (err) {
    const code = String((err as Error)?.message ?? 'error').slice(0, 200);
    if (err instanceof FinalError) {
      await markEvent('ignored', code);
      console.warn(`[mail-inbound] ${verified.id} ${eventType}: ${code}`);
      return json({ ok: true });
    }
    console.error(`[mail-inbound] ${verified.id} ${eventType} failed: ${code}`);
    // Failed and 500, so Resend retries and webhook_claim lets the retry in.
    await markEvent('failed', code);
    return json({ ok: false, error: 'processing_failed' }, 500);
  }
});
