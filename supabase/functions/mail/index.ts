// ============================================================================
// Supabase Edge Function: mail
// ----------------------------------------------------------------------------
// Echo Mail: mailboxes, domains, drafts and sending.
//
//   hosted mailboxes       send through Resend, from a domain verified there
//   app-password mailboxes send over SMTPS (port 465) with the user's own
//                          provider; the password is kept in Supabase Vault
//
// Every send is charged from the wallet with the same two-phase hold the Leads
// feature uses (wallet_reserve -> wallet_settle / wallet_release): the credits
// are held before the provider call and charged only when it accepts the
// message. Prices come from pricing_config, never from the client.
//
// Secrets:
//   supabase secrets set RESEND_API_KEY=re_...
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.16';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';
const RESEND_BASE = 'https://api.resend.com';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
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

// ---------------------------------------------------------------------------
// Limits and validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/;

const MAX_SUBJECT = 300;
const MAX_BODY = 50_000;
const MAX_NAME = 120;
const SMTP_TIMEOUT_MS = 20_000;
const RESEND_TIMEOUT_MS = 20_000;

/** Sends per day for a new mailbox. Hosted domains start low to warm up. */
const HOSTED_DAILY_LIMIT = 40;
const CONNECTED_DAILY_LIMIT = 150;

const PRICE_OPS = { hosted: 'mail.send.hosted', connected: 'mail.send.connected' } as const;
const PRICE_FALLBACK = { hosted: 0.1, connected: 0.05 } as const;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const clampText = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Display names go into a From header: no quotes, angle brackets or line breaks. */
const cleanName = (v: unknown) =>
  clampText(v, MAX_NAME).replace(/[\r\n"<>]/g, ' ').replace(/\s+/g, ' ').trim();

const cleanEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 254) : '');

/** Subjects go into a header too. */
const cleanSubject = (v: unknown) => clampText(v, MAX_SUBJECT).replace(/[\r\n]+/g, ' ').trim();

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Plain text -> safe HTML, built here rather than trusted from the client. */
const textToHtml = (text: string) =>
  text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br/>')}</p>`)
    .join('');

const snippetOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160);

const formatFrom = (name: string, address: string) => (name ? `"${name}" <${address}>` : address);

function cleanDomainName(raw: unknown): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .slice(0, 253);
}

// ---------------------------------------------------------------------------
// Rate limits (take_rate_limit). Fail closed: these guard paid sends and SMTP
// logins against someone else's provider.
// ---------------------------------------------------------------------------

interface RateLimit {
  bucket: string;
  limit: number;
  windowSeconds: number;
  message: string;
}

const RATE_LIMITS = {
  send: { bucket: 'mail.send', limit: 200, windowSeconds: 3600, message: 'You have sent 200 emails in the last hour. Please wait a bit and try again.' },
  sendBurst: { bucket: 'mail.send.burst', limit: 5, windowSeconds: 10, message: 'Sending too fast. Please wait a few seconds and try again.' },
  connect: { bucket: 'mail.connect', limit: 10, windowSeconds: 3600, message: 'Too many connection attempts. Please try again later.' },
  domain: { bucket: 'mail.domain', limit: 30, windowSeconds: 3600, message: 'Too many domain requests. Please try again in a few minutes.' },
  write: { bucket: 'mail.write', limit: 300, windowSeconds: 3600, message: 'Too many changes in the last hour. Please try again later.' },
} satisfies Record<string, RateLimit>;

async function enforceRateLimits(admin: any, userId: string, limits: RateLimit[]): Promise<Response | null> {
  for (const rl of limits) {
    const { data, error } = await admin.rpc('take_rate_limit', {
      p_user_id: userId,
      p_bucket: rl.bucket,
      p_limit: rl.limit,
      p_window_seconds: rl.windowSeconds,
    });
    if (error) {
      console.error('[mail] take_rate_limit failed:', error.message);
      return fail('The service is busy. Please try again in a moment.', 503, { rate_limited: true });
    }
    if (data !== true) return fail(rl.message, 429, { rate_limited: true });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row shapes returned to the client. Server-only columns never leave here.
// ---------------------------------------------------------------------------

const MAILBOX_COLUMNS =
  'id, user_id, kind, provider, address, display_name, domain_id, status, pause_reason, daily_send_limit, sent_today, sent_today_date, is_default, created_at';
const DOMAIN_COLUMNS =
  'id, user_id, domain, status, provider, dkim_tokens, dns_records, inbound_provider, verified_at, last_checked_at, created_at';
const THREAD_COLUMNS = '*, user_leads(status)';

function shapeThread(row: any) {
  if (!row) return row;
  const { user_leads, ...rest } = row;
  return { ...rest, lead_pipeline_status: user_leads?.status ?? undefined };
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

async function loadPrice(admin: any, kind: 'hosted' | 'connected'): Promise<{ credits: number; costUsd: number }> {
  const { data } = await admin
    .from('pricing_config')
    .select('credits, provider_cost_usd, enabled')
    .eq('operation', PRICE_OPS[kind])
    .maybeSingle();
  if (!data || data.enabled === false) return { credits: PRICE_FALLBACK[kind], costUsd: 0 };
  return { credits: Number(data.credits ?? PRICE_FALLBACK[kind]), costUsd: Number(data.provider_cost_usd ?? 0) };
}

async function walletAvailable(admin: any, userId: string): Promise<number> {
  const { data } = await admin.from('wallet').select('balance, reserved').eq('user_id', userId).maybeSingle();
  if (!data) return 0;
  return Math.max(0, Number(data.balance ?? 0) - Number(data.reserved ?? 0));
}

const fmtCredits = (n: number) => String(Number(n.toFixed(2)));

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

class ProviderError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

async function resend(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new ProviderError('Hosted sending is not configured yet (missing RESEND_API_KEY).', 503);
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(RESEND_BASE + path, {
      method: init.method || 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new ProviderError(err?.name === 'TimeoutError' ? 'The email provider timed out.' : 'Could not reach the email provider.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof data?.message === 'string' ? data.message.slice(0, 300) : `Email provider error (${res.status}).`;
    throw new ProviderError(msg, res.status >= 500 ? 502 : res.status === 429 ? 429 : 400);
  }
  return data;
}

type DnsRecord = { type: string; host: string; value: string; status: 'verified' | 'pending' | 'missing' };

/** Resend's record list -> the DNS table the Domains panel renders. */
function mapResendRecords(domain: string, records: any[]): DnsRecord[] {
  const out: DnsRecord[] = (Array.isArray(records) ? records : []).map((r) => {
    const name = String(r?.name || '');
    const host = !name || name === '@' ? domain : name.endsWith(domain) ? name : `${name}.${domain}`;
    const value = r?.type === 'MX' && r?.priority != null ? `${r.priority} ${r.value}` : String(r?.value || '');
    const s = String(r?.status || '');
    const status: DnsRecord['status'] = s === 'verified' ? 'verified' : s === 'failed' ? 'missing' : 'pending';
    return { type: String(r?.type || 'TXT'), host, value, status };
  });
  return out;
}

/** DMARC is not tracked by Resend, but inbox providers expect one. */
async function dmarcRecord(domain: string): Promise<DnsRecord> {
  const rec: DnsRecord = { type: 'TXT', host: `_dmarc.${domain}`, value: 'v=DMARC1; p=none;', status: 'pending' };
  try {
    const txt = await Deno.resolveDns(`_dmarc.${domain}`, 'TXT');
    if (txt.some((parts) => parts.join('').toLowerCase().startsWith('v=dmarc1'))) rec.status = 'verified';
  } catch {
    // NXDOMAIN or resolver unavailable: leave it pending.
  }
  return rec;
}

function mapDomainStatus(s: string): 'pending' | 'verifying' | 'verified' | 'failed' {
  if (s === 'verified') return 'verified';
  if (s === 'failed') return 'failed';
  if (s === 'pending' || s === 'temporary_failure') return 'verifying';
  return 'pending';
}

// ---------------------------------------------------------------------------
// SMTP (app-password mailboxes)
// Supabase Edge Functions block outbound ports 25 and 587, so only implicit
// TLS on 465 works. Microsoft 365 offers STARTTLS on 587 only.
// ---------------------------------------------------------------------------

const SMTP_HOSTS: Record<string, string[]> = {
  google: ['smtp.gmail.com'],
  // Zoho is region- and plan-specific; the first host that accepts the login wins.
  zoho: ['smtp.zoho.com', 'smtppro.zoho.com', 'smtp.zoho.in', 'smtppro.zoho.in', 'smtp.zoho.eu', 'smtppro.zoho.eu'],
};

function smtpTransport(host: string, user: string, pass: string) {
  return nodemailer.createTransport({
    host,
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
}

function smtpErrorMessage(err: any): string {
  const code = String(err?.code || '');
  const response = String(err?.response || err?.message || '');
  if (code === 'EAUTH' || /535|534|authentication/i.test(response)) {
    return 'The email provider rejected that login. Check the address and app password.';
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ECONNREFUSED') {
    return 'Could not connect to the mail server on port 465.';
  }
  return response.replace(/\s+/g, ' ').slice(0, 200) || 'The mail server refused the message.';
}

/** Tries each host and returns the first one that accepts the login. */
async function verifySmtpLogin(hosts: string[], user: string, pass: string): Promise<{ host: string } | { error: string }> {
  let lastError = 'Could not connect to the mail server.';
  for (const host of hosts) {
    const transport = smtpTransport(host, user, pass);
    try {
      await transport.verify();
      return { host };
    } catch (err: any) {
      lastError = smtpErrorMessage(err);
    } finally {
      transport.close();
    }
  }
  return { error: lastError };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('Method not allowed', 405);
  try {
    return await handleRequest(req);
  } catch (err: any) {
    console.error('[mail] unhandled error:', err?.name || 'error', String(err?.message || '').slice(0, 200));
    return fail('Internal error', 500);
  }
});

async function handleRequest(req: Request): Promise<Response> {
  const userId = await requireUserId(req);
  if (!userId) return fail('Unauthorized', 401);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail('Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid JSON body');

  switch (body.action) {
    case 'connect_app_password':
      return connectAppPassword(admin, userId, body);
    case 'create_hosted_mailbox':
      return createHostedMailbox(admin, userId, body);
    case 'remove_mailbox':
      return removeMailbox(admin, userId, body);
    case 'set_default_mailbox':
      return setDefaultMailbox(admin, userId, body);
    case 'add_domain':
      return addDomain(admin, userId, body);
    case 'verify_domain':
      return verifyDomain(admin, userId, body);
    case 'remove_domain':
      return removeDomain(admin, userId, body);
    case 'save_draft':
      return saveDraft(admin, userId, body);
    case 'send':
      return send(admin, userId, body);
    default:
      return fail('Unknown action');
  }
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

async function isFirstMailbox(admin: any, userId: string): Promise<boolean> {
  const { count } = await admin.from('mailboxes').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  return (count ?? 0) === 0;
}

async function connectAppPassword(admin: any, userId: string, body: any): Promise<Response> {
  const address = cleanEmail(body.address);
  const displayName = cleanName(body.display_name);
  const provider = String(body.provider || '');
  const password = typeof body.password === 'string' ? body.password.replace(/\s+/g, '') : '';

  if (!EMAIL_RE.test(address)) return fail('Enter a valid email address.');
  if (!displayName) return fail('Enter the name recipients should see.');
  if (!['google', 'microsoft', 'zoho', 'custom'].includes(provider)) return fail('Choose a provider.');
  if (password.length < 8 || password.length > 256) return fail('That password looks too short.');
  if (provider === 'microsoft') {
    return fail(
      'Microsoft 365 / Outlook only accepts app passwords over port 587, which Echo’s servers can’t use. Connect Gmail or Zoho, or send from a hosted domain.',
      422,
    );
  }

  let hosts: string[];
  if (provider === 'custom') {
    const host = cleanDomainName(body.smtp_host);
    if (!DOMAIN_RE.test(host)) return fail('Enter your SMTP server, e.g. smtp.yourcompany.com.');
    hosts = [host];
  } else {
    hosts = SMTP_HOSTS[provider];
  }

  const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.connect]);
  if (limited) return limited;

  const { data: existing } = await admin
    .from('mailboxes')
    .select('id')
    .eq('user_id', userId)
    .eq('address', address)
    .maybeSingle();
  if (existing) return fail(`${address} is already connected.`, 409);

  // Prove the login works before keeping the password.
  const verified = await verifySmtpLogin(hosts, address, password);
  if ('error' in verified) return fail(verified.error, 422);

  const { data: secretId, error: vaultError } = await admin.rpc('store_mailbox_secret', {
    p_secret: password,
    p_name: `mailbox:${userId}:${crypto.randomUUID()}`,
  });
  if (vaultError || !secretId) {
    console.error('[mail] vault store failed:', vaultError?.message);
    return fail('Could not store the password securely. Please try again.', 500);
  }

  const first = await isFirstMailbox(admin, userId);
  const { data: mailbox, error } = await admin
    .from('mailboxes')
    .insert({
      user_id: userId,
      kind: 'app_password',
      provider,
      address,
      display_name: displayName,
      smtp_host: verified.host,
      smtp_port: 465,
      smtp_user: address,
      vault_secret_id: secretId,
      daily_send_limit: CONNECTED_DAILY_LIMIT,
      is_default: first,
    })
    .select(MAILBOX_COLUMNS)
    .single();
  if (error) {
    await admin.rpc('delete_mailbox_secret', { p_secret_id: secretId });
    if (error.code === '23505') return fail(`${address} is already connected.`, 409);
    console.error('[mail] mailbox insert failed:', error.message);
    return fail('Could not save the mailbox.', 500);
  }
  return json({ ok: true, mailbox });
}

async function createHostedMailbox(admin: any, userId: string, body: any): Promise<Response> {
  if (!isUuid(body.domain_id)) return fail('Choose a domain.');
  const localPart = String(body.local_part || '').trim().toLowerCase();
  const displayName = cleanName(body.display_name);
  if (!LOCAL_PART_RE.test(localPart) || localPart.includes('..')) return fail('Enter a valid address, e.g. alex.');
  if (!displayName) return fail('Enter the name recipients should see.');

  const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.write]);
  if (limited) return limited;

  const { data: domain } = await admin
    .from('mail_domains')
    .select('id, domain, status')
    .eq('id', body.domain_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!domain) return fail('Domain not found.', 404);
  if (domain.status !== 'verified') return fail(`${domain.domain} isn't verified yet. Finish the DNS setup first.`, 409);

  const address = `${localPart}@${domain.domain}`;
  const first = await isFirstMailbox(admin, userId);
  const { data: mailbox, error } = await admin
    .from('mailboxes')
    .insert({
      user_id: userId,
      kind: 'hosted',
      provider: 'resend',
      address,
      display_name: displayName,
      domain_id: domain.id,
      daily_send_limit: HOSTED_DAILY_LIMIT,
      is_default: first,
    })
    .select(MAILBOX_COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') return fail(`${address} already exists.`, 409);
    console.error('[mail] hosted mailbox insert failed:', error.message);
    return fail('Could not create the mailbox.', 500);
  }
  return json({ ok: true, mailbox });
}

async function removeMailbox(admin: any, userId: string, body: any): Promise<Response> {
  if (!isUuid(body.mailbox_id)) return fail('Mailbox not found.', 404);
  const { data: removed, error } = await admin
    .from('mailboxes')
    .delete()
    .eq('id', body.mailbox_id)
    .eq('user_id', userId)
    .select('id, is_default')
    .maybeSingle();
  if (error) {
    console.error('[mail] mailbox delete failed:', error.message);
    return fail('Could not disconnect the mailbox.', 500);
  }
  if (!removed) return fail('Mailbox not found.', 404);

  // Keep exactly one default while any mailbox remains.
  let defaultId: string | null = null;
  if (removed.is_default) {
    const { data: next } = await admin
      .from('mailboxes')
      .select('id')
      .eq('user_id', userId)
      .order('created_at')
      .limit(1)
      .maybeSingle();
    if (next) {
      await admin.from('mailboxes').update({ is_default: true }).eq('id', next.id);
      defaultId = next.id;
    }
  }
  return json({ ok: true, default_mailbox_id: defaultId });
}

async function setDefaultMailbox(admin: any, userId: string, body: any): Promise<Response> {
  if (!isUuid(body.mailbox_id)) return fail('Mailbox not found.', 404);
  const { data: mb } = await admin.from('mailboxes').select('id').eq('id', body.mailbox_id).eq('user_id', userId).maybeSingle();
  if (!mb) return fail('Mailbox not found.', 404);
  await admin.from('mailboxes').update({ is_default: false }).eq('user_id', userId).neq('id', mb.id);
  await admin.from('mailboxes').update({ is_default: true }).eq('id', mb.id);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

async function addDomain(admin: any, userId: string, body: any): Promise<Response> {
  const domain = cleanDomainName(body.domain);
  if (!DOMAIN_RE.test(domain)) return fail('Enter a valid domain, e.g. trycompany.com');

  const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.domain]);
  if (limited) return limited;

  const { data: taken } = await admin.from('mail_domains').select('user_id').ilike('domain', domain).maybeSingle();
  if (taken) {
    return fail(taken.user_id === userId ? `${domain} is already added.` : `${domain} is already registered to another Echo workspace.`, 409);
  }

  let created: any;
  try {
    created = await resend('/domains', { method: 'POST', body: { name: domain } });
  } catch (err: any) {
    return fail(err instanceof ProviderError ? err.message : 'Could not add the domain.', err?.status || 502);
  }

  const records = [...mapResendRecords(domain, created?.records), await dmarcRecord(domain)];
  const { data: row, error } = await admin
    .from('mail_domains')
    .insert({
      user_id: userId,
      domain,
      status: mapDomainStatus(String(created?.status || '')),
      provider: 'resend',
      provider_domain_id: created?.id ?? null,
      dkim_tokens: [],
      dns_records: records,
      inbound_provider: 'none',
      last_checked_at: new Date().toISOString(),
    })
    .select(DOMAIN_COLUMNS)
    .single();
  if (error) {
    // Don't leave an orphan behind at Resend.
    if (created?.id) await resend(`/domains/${created.id}`, { method: 'DELETE' }).catch(() => {});
    if (error.code === '23505') return fail(`${domain} is already added.`, 409);
    console.error('[mail] domain insert failed:', error.message);
    return fail('Could not save the domain.', 500);
  }
  return json({ ok: true, domain: row });
}

async function verifyDomain(admin: any, userId: string, body: any): Promise<Response> {
  if (!isUuid(body.domain_id)) return fail('Domain not found.', 404);
  const { data: dom } = await admin
    .from('mail_domains')
    .select('id, domain, status, provider_domain_id, verified_at')
    .eq('id', body.domain_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!dom?.provider_domain_id) return fail('Domain not found.', 404);

  const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.domain]);
  if (limited) return limited;

  let current: any;
  try {
    if (dom.status !== 'verified') {
      await resend(`/domains/${dom.provider_domain_id}/verify`, { method: 'POST' });
    }
    current = await resend(`/domains/${dom.provider_domain_id}`);
  } catch (err: any) {
    return fail(err instanceof ProviderError ? err.message : 'Could not check DNS.', err?.status || 502);
  }

  const status = mapDomainStatus(String(current?.status || ''));
  const records = [...mapResendRecords(dom.domain, current?.records), await dmarcRecord(dom.domain)];
  const { data: row, error } = await admin
    .from('mail_domains')
    .update({
      status,
      dns_records: records,
      verified_at: status === 'verified' ? dom.verified_at || new Date().toISOString() : null,
      last_checked_at: new Date().toISOString(),
    })
    .eq('id', dom.id)
    .select(DOMAIN_COLUMNS)
    .single();
  if (error) return fail('Could not save the DNS check.', 500);

  // Hosted mailboxes stop sending while their domain is not verified.
  await admin
    .from('mailboxes')
    .update({ status: status === 'verified' ? 'active' : 'paused', pause_reason: status === 'verified' ? null : 'domain_unverified' })
    .eq('domain_id', dom.id)
    .eq('kind', 'hosted')
    .in('status', status === 'verified' ? ['paused'] : ['active']);

  return json({ ok: true, domain: row });
}

async function removeDomain(admin: any, userId: string, body: any): Promise<Response> {
  if (!isUuid(body.domain_id)) return fail('Domain not found.', 404);
  const { data: dom } = await admin
    .from('mail_domains')
    .select('id, provider_domain_id')
    .eq('id', body.domain_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!dom) return fail('Domain not found.', 404);

  if (dom.provider_domain_id) {
    await resend(`/domains/${dom.provider_domain_id}`, { method: 'DELETE' }).catch((e: any) =>
      console.error('[mail] resend domain delete failed:', e?.message),
    );
  }
  // Hosted mailboxes on it can no longer send.
  await admin
    .from('mailboxes')
    .update({ status: 'disabled', pause_reason: 'domain_removed' })
    .eq('domain_id', dom.id)
    .eq('kind', 'hosted');
  await admin.from('mail_domains').delete().eq('id', dom.id);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** A lead id the client sent, kept only when it is one of this user's saved leads. */
async function ownedLeadId(admin: any, userId: string, leadId: unknown): Promise<string | null> {
  if (!isUuid(leadId)) return null;
  const { data } = await admin.from('user_leads').select('id').eq('id', leadId).eq('user_id', userId).maybeSingle();
  return data?.id ?? null;
}

async function ownedMailbox(admin: any, userId: string, mailboxId: unknown) {
  if (!isUuid(mailboxId)) return null;
  const { data } = await admin
    .from('mailboxes')
    .select('id, kind, provider, address, display_name, status, domain_id, smtp_host, smtp_port, smtp_user, vault_secret_id')
    .eq('id', mailboxId)
    .eq('user_id', userId)
    .maybeSingle();
  return data;
}

async function saveDraft(admin: any, userId: string, body: any): Promise<Response> {
  // The client picks the thread id, so a draft resumed before its first save
  // finished still lands on the same row.
  if (!isUuid(body.thread_id)) return fail('Invalid draft.');
  const mailbox = await ownedMailbox(admin, userId, body.mailbox_id);
  if (!mailbox) return fail('Connect a mailbox before saving drafts.', 404);

  const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.write]);
  if (limited) return limited;

  const to = cleanEmail(body.to);
  const name = cleanName(body.name);
  const subject = cleanSubject(body.subject);
  const text = clampText(body.body, MAX_BODY);
  const participants = to ? [{ ...(name ? { name } : {}), address: to }] : [];
  const leadId = await ownedLeadId(admin, userId, body.lead_id);
  const now = new Date().toISOString();

  const { data: existing } = await admin.from('mail_threads').select('id, user_id, folder').eq('id', body.thread_id).maybeSingle();
  if (existing && (existing.user_id !== userId || existing.folder !== 'drafts')) return fail('Invalid draft.', 409);

  const thread = {
    id: body.thread_id,
    user_id: userId,
    mailbox_id: mailbox.id,
    lead_id: leadId,
    lead_name: name || null,
    lead_company: cleanName(body.company) || null,
    subject,
    snippet: snippetOf(text),
    participants,
    folder: 'drafts',
    unread_count: 0,
    last_message_at: now,
  };
  const { data: savedThread, error: threadError } = await admin
    .from('mail_threads')
    .upsert(thread, { onConflict: 'id' })
    .select(THREAD_COLUMNS)
    .single();
  if (threadError) {
    console.error('[mail] draft thread save failed:', threadError.message);
    return fail('Could not save the draft.', 500);
  }

  await admin.from('mail_messages').delete().eq('thread_id', thread.id);
  const { data: message, error: msgError } = await admin
    .from('mail_messages')
    .insert({
      thread_id: thread.id,
      user_id: userId,
      mailbox_id: mailbox.id,
      lead_id: leadId,
      direction: 'out',
      status: 'draft',
      from_addr: mailbox.address,
      to_addrs: participants,
      subject,
      snippet: thread.snippet,
      text_body: text,
      html_body: '',
    })
    .select('*')
    .single();
  if (msgError) {
    console.error('[mail] draft message save failed:', msgError.message);
    return fail('Could not save the draft.', 500);
  }
  return json({ ok: true, thread: shapeThread(savedThread), message });
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function send(admin: any, userId: string, body: any): Promise<Response> {
  const requestId = typeof body.request_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.request_id) ? body.request_id : null;
  if (!requestId) return fail('Missing request id.');

  const text = clampText(body.body, MAX_BODY).trim();
  if (!text) return fail('Your message is empty.');

  // A reply continues an existing thread; a new message starts one.
  const replyThreadId = isUuid(body.thread_id) ? body.thread_id : null;
  let replyThread: any = null;
  let mailboxId = body.mailbox_id;
  let to: { name?: string; address: string }[];
  let subject: string;
  let leadId: string | null;
  let inReplyTo: string | null = null;
  let references: string | null = null;

  if (replyThreadId) {
    const { data } = await admin.from('mail_threads').select('*').eq('id', replyThreadId).eq('user_id', userId).maybeSingle();
    if (!data || data.folder === 'drafts') return fail('This conversation no longer exists.', 404);
    replyThread = data;
    mailboxId = data.mailbox_id;
    to = (Array.isArray(data.participants) ? data.participants : [])
      .filter((p: any) => EMAIL_RE.test(String(p?.address || '')))
      .slice(0, 20);
    if (to.length === 0) return fail('This conversation has no recipient to reply to.');
    subject = /^re:/i.test(data.subject) ? data.subject : `Re: ${data.subject}`;
    leadId = data.lead_id;

    const { data: prior } = await admin
      .from('mail_messages')
      .select('message_id_header, references_hdr')
      .eq('thread_id', replyThreadId)
      .not('message_id_header', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prior?.message_id_header) {
      inReplyTo = prior.message_id_header;
      references = [prior.references_hdr, prior.message_id_header].filter(Boolean).join(' ').slice(-2000);
    }
  } else {
    const address = cleanEmail(body.to);
    if (!EMAIL_RE.test(address)) return fail('Please specify a valid recipient email address.');
    subject = cleanSubject(body.subject);
    if (!subject) return fail('Please add a subject line for your email.');
    const name = cleanName(body.name);
    to = [{ ...(name ? { name } : {}), address }];
    leadId = await ownedLeadId(admin, userId, body.lead_id);
  }

  const mailbox = await ownedMailbox(admin, userId, mailboxId);
  if (!mailbox) return fail('Connect a mailbox before sending.', 404);
  if (mailbox.status === 'needs_reauth') return fail(`${mailbox.address} needs to be reconnected before it can send.`, 409);
  if (mailbox.status !== 'active') return fail(`${mailbox.address} is ${mailbox.status} and can't send right now.`, 409);

  let fromDomain = mailbox.address.split('@')[1];
  if (mailbox.kind === 'hosted') {
    const { data: dom } = await admin.from('mail_domains').select('domain, status').eq('id', mailbox.domain_id).maybeSingle();
    if (!dom || dom.status !== 'verified') return fail(`The domain for ${mailbox.address} isn't verified.`, 409);
    fromDomain = dom.domain;
  } else if (mailbox.kind !== 'app_password') {
    return fail('This mailbox type cannot send yet.', 409);
  }

  const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.sendBurst, RATE_LIMITS.send]);
  if (limited) return limited;

  // 1. Daily limit slot.
  const { data: slot, error: slotError } = await admin.rpc('mail_take_send_slot', { p_mailbox_id: mailbox.id, p_user_id: userId });
  if (slotError) {
    console.error('[mail] send slot failed:', slotError.message);
    return fail('The service is busy. Please try again in a moment.', 503);
  }
  if (!slot?.ok) {
    if (slot?.error === 'daily_limit') {
      return fail(
        `${mailbox.address} reached its daily limit (${slot.daily_send_limit}). Use another mailbox or send tomorrow.`,
        429,
        { daily_limit: true },
      );
    }
    return fail('Mailbox not found.', 404);
  }
  const returnSlot = () => admin.rpc('mail_return_send_slot', { p_mailbox_id: mailbox.id, p_user_id: userId });

  // 2. Credit hold.
  const priceKind = mailbox.kind === 'hosted' ? 'hosted' : 'connected';
  const price = await loadPrice(admin, priceKind);
  const idempotencyKey = `mail:send:${userId}:${requestId}`;
  let reservationId: string | null = null;
  if (price.credits > 0) {
    const { data: hold, error: holdError } = await admin.rpc('wallet_reserve', {
      p_user_id: userId,
      p_credits: price.credits,
      p_idempotency_key: idempotencyKey,
      p_context: { feature: 'mail', operation: PRICE_OPS[priceKind], mailbox_id: mailbox.id },
    });
    if (holdError) {
      await returnSlot();
      console.error('[mail] wallet_reserve failed:', holdError.message);
      return fail('Billing is unavailable right now. Please try again.', 503);
    }
    if (!hold?.ok) {
      await returnSlot();
      const available = Number(hold?.available ?? 0);
      return fail(
        `Not enough credits: this email costs ${fmtCredits(price.credits)} credit${price.credits === 1 ? '' : 's'} and you have ${fmtCredits(available)}. Top up in Billing.`,
        402,
        { insufficient_credits: true, required: price.credits, available },
      );
    }
    if (hold.duplicate) {
      await returnSlot();
      return fail('Already in progress — this email is still being sent.', 409, { duplicate_request: true });
    }
    reservationId = hold.reservation_id;
  }

  // 3. Deliver.
  const fromName = cleanName(mailbox.display_name);
  const html = textToHtml(text);
  let messageIdHeader: string | null = `<${crypto.randomUUID()}@${fromDomain}>`;
  let providerMessageId: string | null = null;
  try {
    if (mailbox.kind === 'hosted') {
      const headers: Record<string, string> = {};
      if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
      if (references) headers['References'] = references;
      const sent = await resend('/emails', {
        method: 'POST',
        idempotencyKey,
        body: {
          from: formatFrom(fromName, mailbox.address),
          to: to.map((p) => p.address),
          subject,
          text,
          html,
          // Resend assigns its own Message-ID, so ours is not sent or stored.
          ...(Object.keys(headers).length ? { headers } : {}),
        },
      });
      providerMessageId = typeof sent?.id === 'string' ? sent.id : null;
      messageIdHeader = null;
    } else {
      const { data: password } = await admin.rpc('get_mailbox_secret', { p_secret_id: mailbox.vault_secret_id });
      if (!password) throw new ProviderError('The saved password for this mailbox is missing. Reconnect it.', 409);
      const transport = smtpTransport(mailbox.smtp_host, mailbox.smtp_user || mailbox.address, password);
      try {
        const info = await transport.sendMail({
          from: formatFrom(fromName, mailbox.address),
          to: to.map((p) => (p.name ? formatFrom(cleanName(p.name), p.address) : p.address)),
          subject,
          text,
          html,
          messageId: messageIdHeader!,
          ...(inReplyTo ? { inReplyTo } : {}),
          ...(references ? { references } : {}),
        });
        providerMessageId = typeof info?.messageId === 'string' ? info.messageId : null;
      } catch (err: any) {
        if (String(err?.code) === 'EAUTH') {
          await admin.from('mailboxes').update({ status: 'needs_reauth' }).eq('id', mailbox.id);
          throw new ProviderError(`${mailbox.address} rejected the saved app password. Reconnect it in Accounts.`, 409);
        }
        throw new ProviderError(smtpErrorMessage(err));
      } finally {
        transport.close();
      }
    }
  } catch (err: any) {
    // Nothing was delivered: give the credits and the slot back.
    if (reservationId) {
      await admin.rpc('wallet_release', { p_reservation_id: reservationId, p_reason: 'mail: send failed' });
    }
    await returnSlot();
    const message = err instanceof ProviderError ? err.message : 'The email could not be sent.';
    console.error('[mail] send failed:', String(err?.message || '').slice(0, 200));
    return fail(message, err instanceof ProviderError ? err.status : 502);
  }

  // 4. Charge.
  let creditsCharged = 0;
  let balanceAfter: number | null = null;
  if (reservationId) {
    const { data: settled, error: settleError } = await admin.rpc('wallet_settle', {
      p_reservation_id: reservationId,
      p_credits_charged: price.credits,
      p_provider_cost: price.costUsd,
      p_idempotency_key: idempotencyKey,
      p_note: `Email sent (${priceKind === 'hosted' ? 'hosted' : 'connected mailbox'})`,
      p_metadata: { feature: 'mail', operation: PRICE_OPS[priceKind] },
    });
    if (settleError) console.error('[mail] wallet_settle failed:', settleError.message);
    creditsCharged = Number(settled?.credits_charged ?? 0);
    balanceAfter = settled?.balance_after != null ? Number(settled.balance_after) : null;
  }
  await admin.from('api_usage').insert({
    user_id: userId,
    idempotency_key: idempotencyKey,
    operation: PRICE_OPS[priceKind],
    provider: mailbox.kind === 'hosted' ? 'resend' : 'smtp',
    provider_call_id: providerMessageId,
    provider_cost_usd: price.costUsd,
    credits_charged: creditsCharged,
    outcome: 'success',
    reservation_id: reservationId,
    metadata: { feature: 'mail' },
  }).then(({ error }: any) => error && console.error('[mail] usage record failed:', error.message));

  // 5. Record. The email is already out, so a failure here is logged, not refunded.
  const now = new Date().toISOString();
  const snippet = snippetOf(text);
  let threadId: string;
  if (replyThread) {
    threadId = replyThread.id;
    await admin.from('mail_threads').update({ snippet, last_message_at: now }).eq('id', threadId);
  } else {
    const { data: newThread, error } = await admin
      .from('mail_threads')
      .insert({
        user_id: userId,
        mailbox_id: mailbox.id,
        lead_id: leadId,
        lead_name: to[0].name || null,
        lead_company: cleanName(body.company) || null,
        subject,
        snippet,
        participants: to,
        folder: 'sent',
        last_message_at: now,
      })
      .select('id')
      .single();
    if (error || !newThread) {
      console.error('[mail] sent thread insert failed:', error?.message);
      return json({ ok: true, recorded: false, credits_charged: creditsCharged, balance_after: balanceAfter });
    }
    threadId = newThread.id;
  }

  const { data: message, error: msgError } = await admin
    .from('mail_messages')
    .insert({
      thread_id: threadId,
      user_id: userId,
      mailbox_id: mailbox.id,
      lead_id: leadId,
      direction: 'out',
      status: 'sent',
      from_addr: mailbox.address,
      to_addrs: to,
      subject,
      snippet,
      text_body: text,
      html_body: html,
      message_id_header: messageIdHeader,
      in_reply_to: inReplyTo,
      references_hdr: references,
      provider_message_id: providerMessageId,
      credits_charged: creditsCharged,
      sent_at: now,
    })
    .select('*')
    .single();
  if (msgError) console.error('[mail] sent message insert failed:', msgError.message);

  // A sent draft leaves the Drafts folder.
  if (isUuid(body.draft_thread_id)) {
    await admin.from('mail_threads').delete().eq('id', body.draft_thread_id).eq('user_id', userId).eq('folder', 'drafts');
  }
  if (leadId) {
    await admin.from('user_leads').update({ status: 'contacted', updated_at: now }).eq('id', leadId).eq('user_id', userId).eq('status', 'new');
  }

  const [{ data: thread }, { data: freshMailbox }] = await Promise.all([
    admin.from('mail_threads').select(THREAD_COLUMNS).eq('id', threadId).single(),
    admin.from('mailboxes').select(MAILBOX_COLUMNS).eq('id', mailbox.id).single(),
  ]);

  return json({
    ok: true,
    recorded: true,
    thread: shapeThread(thread),
    message,
    mailbox: freshMailbox,
    credits_charged: creditsCharged,
    balance_after: balanceAfter,
  });
}
