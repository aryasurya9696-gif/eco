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
// message. Prices come from pricing_config, never from the client; a missing
// or disabled price blocks the send. Mail draws on purchased credits only
// (p_paid_only). A provider timeout is "uncertain": it is charged, not
// refunded, and an identical resend is blocked until the user confirms
// (confirm_resend: true). Provider error text never reaches the client.
//
// Secrets:
//   supabase secrets set RESEND_API_KEY=re_...
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.16';

const RESEND_BASE = 'https://api.resend.com';

// CORS: ALLOWED_ORIGIN is a comma-separated allow-list of exact origins
// (e.g. "https://app.example.com,https://www.example.com"). The request's
// Origin is echoed only when it is on the list. With nothing configured only
// local dev origins are allowed; "*" must be set explicitly to open it up.
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGIN') || '')
  .split(',')
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

/** A held send with the same content inside this window is treated as in flight. */
const IN_FLIGHT_WINDOW_MS = 5 * 60_000;
/** A send that timed out blocks an identical resend for this long unless confirmed. */
const UNCERTAIN_WINDOW_MS = 24 * 3600_000;
const SETTLE_ATTEMPTS = 3;

const UNCERTAIN_MESSAGE =
  "The mail server didn't confirm delivery in time, so this email may already have been sent. " +
  "Check the recipient's thread or your provider's Sent folder before sending it again.";
const UNCERTAIN_RESEND_MESSAGE =
  'An earlier attempt to send this exact email timed out and may have been delivered. ' +
  "Check your provider's Sent folder first; if it isn't there, confirm to send it again.";
const PAID_ONLY_MESSAGE =
  'Sending mail needs purchased credits — free welcome credits only cover feed sweeps. Top up in Billing.';

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

/**
 * The live price for a send, or null when there is none to charge: the row is
 * missing, disabled or unreadable. Like the sweeps, a missing price blocks the
 * operation; there is no hard-coded fallback.
 */
async function loadPrice(admin: any, kind: 'hosted' | 'connected'): Promise<{ credits: number; costUsd: number } | null> {
  const { data, error } = await admin
    .from('pricing_config')
    .select('credits, provider_cost_usd, enabled')
    .eq('operation', PRICE_OPS[kind])
    .maybeSingle();
  if (error) {
    console.error('[mail] pricing_config read failed:', error.code || 'error');
    return null;
  }
  if (!data || data.enabled !== true) return null;
  const credits = Number(data.credits);
  const costUsd = Number(data.provider_cost_usd ?? 0);
  if (!Number.isFinite(credits) || credits < 0) return null;
  return { credits, costUsd: Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0 };
}

/** Content hash of a send, so a retry with a fresh request id is still recognised. */
async function sendFingerprint(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\u0000')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ChargeRequest {
  userId: string;
  reservationId: string | null;
  credits: number;
  costUsd: number;
  idempotencyKey: string;
  operation: string;
  provider: string;
  providerCallId: string | null;
  outcome: 'success' | 'uncertain';
  errorCode?: string | null;
  note: string;
  metadata: Record<string, unknown>;
}

/**
 * Records the usage row, then settles the hold.
 *
 * The usage row is written first with the intended charge. If the settle then
 * fails (after retries) the hold stays open, and reap_stale_reservations sees
 * credits_charged > 0 on the linked row and SETTLES it instead of releasing it,
 * so a failed settle is never a free send. The caller is told the charge is
 * pending.
 */
async function chargeSend(
  admin: any,
  r: ChargeRequest,
): Promise<{ creditsCharged: number; balanceAfter: number | null; pending: boolean }> {
  const intended = r.reservationId ? r.credits : 0;
  const usageRow = {
    user_id: r.userId,
    idempotency_key: r.idempotencyKey,
    operation: r.operation,
    provider: r.provider,
    provider_call_id: r.providerCallId,
    provider_cost_usd: r.costUsd,
    credits_charged: intended,
    outcome: r.outcome,
    error_code: r.errorCode ?? null,
    reservation_id: r.reservationId,
    metadata: { ...r.metadata, settle: r.reservationId ? 'pending' : 'none' },
  };
  const { error: usageError } = await admin.from('api_usage').upsert(usageRow, { onConflict: 'idempotency_key' });
  if (usageError) console.error('[mail] usage record failed:', usageError.code || 'error');

  if (!r.reservationId) return { creditsCharged: 0, balanceAfter: null, pending: false };

  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
    const { data: settled, error } = await admin.rpc('wallet_settle', {
      p_reservation_id: r.reservationId,
      p_credits_charged: r.credits,
      p_provider_cost: r.costUsd,
      p_idempotency_key: r.idempotencyKey,
      p_note: r.note,
      p_metadata: { ...r.metadata, outcome: r.outcome },
    });
    if (!error && settled?.ok) {
      const charged = Number(settled.credits_charged ?? 0);
      await admin
        .from('api_usage')
        .update({ credits_charged: charged, metadata: { ...usageRow.metadata, settle: 'done' } })
        .eq('idempotency_key', r.idempotencyKey)
        .then(({ error: e }: any) => e && console.error('[mail] usage update failed:', e.code || 'error'));
      return {
        creditsCharged: charged,
        balanceAfter: settled.balance_after != null ? Number(settled.balance_after) : null,
        pending: false,
      };
    }
    if (!error && settled?.error === 'reservation_already_finalised' && settled?.status === 'settled') {
      // An earlier attempt went through even though its reply was lost.
      return { creditsCharged: r.credits, balanceAfter: null, pending: false };
    }
    if (!error) {
      // Not found or released: nothing left to retry. This is a lost charge.
      console.error('[mail] wallet_settle refused:', settled?.error || 'unknown', 'reservation', r.reservationId);
      break;
    }
    console.error(`[mail] wallet_settle failed (attempt ${attempt}/${SETTLE_ATTEMPTS}):`, error.code || 'error');
    if (attempt < SETTLE_ATTEMPTS) await pause(250 * attempt);
  }
  // Left held on purpose: the reaper settles it from the usage row above.
  console.error('[mail] settle pending, left for the reaper. reservation', r.reservationId);
  return { creditsCharged: intended, balanceAfter: null, pending: true };
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

/**
 * A provider failure. `message` is always one of our own generic, client-safe
 * strings; the provider's text is never put in it. `code` is a short token for
 * the logs. `uncertain` means the provider may have accepted the message.
 */
class ProviderError extends Error {
  constructor(message: string, public status = 502, public code = 'provider_error', public uncertain = false) {
    super(message);
  }
}

async function resend(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) {
    console.error('[mail] RESEND_API_KEY is not set');
    throw new ProviderError('Hosted sending is not available right now.', 503, 'not_configured');
  }
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
    if (err?.name === 'TimeoutError') {
      // The request may have reached Resend and been accepted.
      throw new ProviderError('The email provider did not respond in time.', 504, 'timeout', true);
    }
    throw new ProviderError('Could not reach the email provider. Please try again.', 502, 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Resend's error `name` (e.g. "validation_error") is a code, safe to log; its message is not echoed.
    const code = typeof data?.name === 'string' ? data.name.replace(/[^a-z0-9_]/gi, '').slice(0, 60) : '';
    console.warn('[mail] resend error:', res.status, code || 'unknown');
    if (res.status === 429) throw new ProviderError('The email provider is busy. Please try again in a minute.', 429, code || 'http_429');
    if (res.status >= 500) throw new ProviderError('The email provider is unavailable right now. Please try again.', 502, code || `http_${res.status}`);
    throw new ProviderError('The email provider rejected the request.', 400, code || `http_${res.status}`);
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

/**
 * Watches the SMTP conversation (client command lines only, never the message
 * or the credentials, and nothing is logged) so a failure can be classified:
 * before DATA nothing was handed over; after it the server may have accepted
 * the message.
 */
interface SmtpTrace {
  sawCommand: boolean;
  dataSent: boolean;
}

function traceLogger(trace: SmtpTrace) {
  const noop = () => {};
  return {
    trace: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug: (entry: any, message: unknown) => {
      if (entry?.tnx !== 'client') return;
      trace.sawCommand = true;
      if (typeof message === 'string' && /^DATA\b/i.test(message)) trace.dataSent = true;
    },
  };
}

/**
 * `connectAddress` pins the TCP connection to an address that was already
 * checked as public, so a rebinding DNS answer cannot swap it for an internal
 * one between the check and the connect. TLS still verifies the certificate
 * against the hostname (servername).
 */
function smtpTransport(host: string, user: string, pass: string, connectAddress?: string, trace?: SmtpTrace) {
  return nodemailer.createTransport({
    host: connectAddress || host,
    port: 465,
    secure: true,
    auth: { user, pass },
    tls: { servername: host },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    ...(trace ? { logger: traceLogger(trace), transactionLog: true } : {}),
  } as any);
}

interface SmtpFailure {
  message: string;
  code: string;
  auth: boolean;
  uncertain: boolean;
}

/**
 * Generic, client-safe description of an SMTP error. The server's banner and
 * response text never leave the function and are not logged; only nodemailer's
 * error code and the numeric reply code are.
 */
function classifySmtpError(err: any, trace?: SmtpTrace): SmtpFailure {
  const code = String(err?.code || 'unknown').replace(/[^A-Z0-9_]/gi, '').slice(0, 30);
  const reply = Number(err?.responseCode);
  const tag = Number.isFinite(reply) ? `${code}:${reply}` : code;
  const failure = (message: string, uncertain = false, auth = false): SmtpFailure => ({ message, code: tag, auth, uncertain });

  if (code === 'EAUTH' || reply === 535 || reply === 534) {
    return failure('The email provider rejected that login. Check the address and app password.', false, true);
  }
  // The server answered with a rejection: nothing was accepted.
  if (Number.isFinite(reply) && reply >= 400) {
    return failure(
      reply >= 500 ? 'The mail server refused the message.' : 'The mail server temporarily refused the message. Please try again later.',
    );
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return failure('The mail server refused the message.');
  if (code === 'EDNS' || code === 'ECONNREFUSED' || code === 'ETLS') return failure('Could not connect to the mail server on port 465.');

  // A timeout or dropped connection with no reply. After DATA (or when the
  // conversation could not be observed at all) the message may have been accepted.
  const dropped = code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ECONNRESET';
  if (trace && (trace.dataSent || (dropped && !trace.sawCommand))) return failure(UNCERTAIN_MESSAGE, true);
  if (dropped) return failure('Could not connect to the mail server on port 465.');
  return failure('The mail server refused the message.');
}

// A user-supplied SMTP host must not point the function at private, loopback,
// link-local or cloud-metadata addresses (SSRF). Same range tables as the ai
// function's isSafeTarget, kept self-contained (one implementation per file).

/** Parses dotted-quad IPv4 into four octets, or null. */
function parseV4(h: string): number[] | null {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

function isPrivateV4(o: number[]): boolean {
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return true; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expands an IPv6 literal into eight 16-bit groups, or null if it is not one. */
function parseV6(h: string): number[] | null {
  if (!h.includes(':')) return null;
  let s = h.split('%')[0];
  const tail = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) {
    const o = parseV4(tail[1]);
    if (!o) return null;
    s = s.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPrivateV6(g: number[]): boolean {
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateV4(v4); // mapped / compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(v4); // NAT64
  return false;
}

/** True for any name or address literal that must not be connected to. */
function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  const v4 = parseV4(h);
  if (v4) return isPrivateV4(v4);
  const v6 = parseV6(h);
  if (v6) return isPrivateV6(v6);
  // Numeric shorthands (2130706433, 0x7f.1) resolve differently per resolver.
  if (/^[0-9.]+$/.test(h) || /^0x/i.test(h) || h.includes(':')) return true;
  return false;
}

/**
 * Resolves a hostname and returns one address to connect to, or null when it
 * has no records or ANY record is non-public (fails closed). IPv4 preferred.
 */
async function resolvePublicAddress(host: string): Promise<string | null> {
  if (isPrivateAddress(host)) return null;
  const [a, aaaa] = await Promise.allSettled([Deno.resolveDns(host, 'A'), Deno.resolveDns(host, 'AAAA')]);
  const v4 = a.status === 'fulfilled' ? a.value : [];
  const v6 = aaaa.status === 'fulfilled' ? aaaa.value : [];
  const all = [...v4, ...v6];
  if (all.length === 0 || all.some((ip) => isPrivateAddress(ip))) return null;
  return v4[0] ?? v6[0];
}

/** Tries each host and returns the first one that accepts the login. */
async function verifySmtpLogin(
  hosts: string[],
  user: string,
  pass: string,
  pinned: Record<string, string> = {},
): Promise<{ host: string } | { error: string }> {
  let lastError = 'Could not connect to the mail server.';
  for (const host of hosts) {
    const transport = smtpTransport(host, user, pass, pinned[host]);
    try {
      await transport.verify();
      return { host };
    } catch (err: any) {
      const failure = classifySmtpError(err);
      console.warn('[mail] smtp verify failed:', failure.code);
      lastError = failure.message;
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
  if (req.method === 'OPTIONS') return withCors(req, new Response(null, { status: 204 }));
  if (req.method !== 'POST') return withCors(req, fail('Method not allowed', 405));
  try {
    return withCors(req, await handleRequest(req));
  } catch (err: any) {
    // Name and code only: an error message can carry a provider's response text.
    console.error('[mail] unhandled error:', err?.name || 'error', String(err?.code || ''));
    return withCors(req, fail('Internal error', 500));
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
  const pinned: Record<string, string> = {};
  if (provider === 'custom') {
    const host = cleanDomainName(body.smtp_host);
    if (!DOMAIN_RE.test(host)) return fail('Enter your SMTP server, e.g. smtp.yourcompany.com.');
    const smtpIp = await resolvePublicAddress(host);
    if (!smtpIp) return fail('That SMTP server does not resolve to a public address.');
    pinned[host] = smtpIp;
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
  const verified = await verifySmtpLogin(hosts, address, password, pinned);
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
      console.error('[mail] resend domain delete failed:', e?.code || 'error'),
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
  let smtpConnectAddress: string | undefined;
  if (mailbox.kind === 'hosted') {
    const { data: dom } = await admin.from('mail_domains').select('domain, status').eq('id', mailbox.domain_id).maybeSingle();
    if (!dom || dom.status !== 'verified') return fail(`The domain for ${mailbox.address} isn't verified.`, 409);
    fromDomain = dom.domain;
  } else if (mailbox.kind === 'app_password') {
    // A custom host is re-checked at send time (its DNS may have changed since
    // it was connected) and the connection is pinned to the checked address.
    if (mailbox.provider === 'custom' || !Object.values(SMTP_HOSTS).flat().includes(String(mailbox.smtp_host))) {
      const ip = await resolvePublicAddress(String(mailbox.smtp_host || ''));
      if (!ip) return fail(`The SMTP server for ${mailbox.address} does not resolve to a public address. Reconnect it in Accounts.`, 409);
      smtpConnectAddress = ip;
    }
  } else {
    return fail('This mailbox type cannot send yet.', 409);
  }

  const priceKind = mailbox.kind === 'hosted' ? 'hosted' : 'connected';
  const operation = PRICE_OPS[priceKind];
  const providerName = mailbox.kind === 'hosted' ? 'resend' : 'smtp';

  // Retries arrive with a fresh request id, so a repeat of the same email is
  // recognised by its content. An earlier identical send that timed out (and
  // may have been delivered) blocks a resend until the user confirms.
  const fingerprint = await sendFingerprint([
    mailbox.id,
    replyThreadId || '',
    to.map((p) => p.address.toLowerCase()).sort().join(','),
    subject,
    text,
  ]);
  if (body.confirm_resend !== true) {
    const { data: unsure, error: unsureError } = await admin
      .from('api_usage')
      .select('id')
      .eq('user_id', userId)
      .eq('outcome', 'uncertain')
      .in('operation', Object.values(PRICE_OPS))
      .eq('metadata->>fingerprint', fingerprint)
      .gte('created_at', new Date(Date.now() - UNCERTAIN_WINDOW_MS).toISOString())
      .limit(1);
    if (unsureError) {
      console.error('[mail] uncertain-send lookup failed:', unsureError.code || 'error');
      return fail('The service is busy. Please try again in a moment.', 503);
    }
    if (unsure?.length) return fail(UNCERTAIN_RESEND_MESSAGE, 409, { uncertain: true, duplicate_request: true });
  }

  // A missing or disabled price blocks the send, as it does for sweeps.
  const price = await loadPrice(admin, priceKind);
  if (!price) {
    console.error('[mail] no enabled price for', operation);
    return fail('Sending is paused right now. Please try again later.', 503, { price_unavailable: true });
  }

  const limited = await enforceRateLimits(admin, userId, [RATE_LIMITS.sendBurst, RATE_LIMITS.send]);
  if (limited) return limited;

  // 1. Daily limit slot.
  const { data: slot, error: slotError } = await admin.rpc('mail_take_send_slot', { p_mailbox_id: mailbox.id, p_user_id: userId });
  if (slotError) {
    console.error('[mail] send slot failed:', slotError.code || 'error');
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

  // 2. Credit hold. Mail is paid-only: welcome credits cover feed sweeps alone.
  const idempotencyKey = `mail:send:${userId}:${requestId}`;
  let reservationId: string | null = null;
  if (price.credits > 0) {
    const { data: hold, error: holdError } = await admin.rpc('wallet_reserve', {
      p_user_id: userId,
      p_credits: price.credits,
      p_idempotency_key: idempotencyKey,
      p_context: { feature: 'mail', operation, mailbox_id: mailbox.id, fingerprint },
      p_paid_only: true,
    });
    if (holdError) {
      await returnSlot();
      console.error('[mail] wallet_reserve failed:', holdError.code || 'error');
      return fail('Billing is unavailable right now. Please try again.', 503);
    }
    if (!hold?.ok) {
      await returnSlot();
      const available = Number(hold?.available ?? 0);
      // Short on purchased credits while the wallet as a whole could cover it:
      // the rest is welcome credit, which mail can't use.
      const paidShort =
        /paid|welcome|bonus|free/i.test(String(hold?.error || '')) ||
        (await walletAvailable(admin, userId)) >= price.credits;
      if (paidShort) {
        return fail(PAID_ONLY_MESSAGE, 402, {
          insufficient_credits: true,
          paid_credits_required: true,
          required: price.credits,
          available,
        });
      }
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

    // Two identical sends racing (double click, client retry after its own
    // timeout): only the oldest open hold for this content goes ahead.
    const { data: twins, error: twinError } = await admin
      .from('reservations')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('status', 'held')
      .eq('context->>fingerprint', fingerprint)
      .gte('created_at', new Date(Date.now() - IN_FLIGHT_WINDOW_MS).toISOString())
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1);
    if (twinError) console.error('[mail] in-flight lookup failed:', twinError.code || 'error');
    if (!twinError && twins?.[0] && twins[0].id !== reservationId) {
      await admin.rpc('wallet_release', { p_reservation_id: reservationId, p_reason: 'mail: duplicate of an in-flight send' });
      await returnSlot();
      return fail('This email is already being sent. Wait a moment before trying again.', 409, { duplicate_request: true });
    }
  }

  // 3. Deliver.
  const fromName = cleanName(mailbox.display_name);
  const html = textToHtml(text);
  let messageIdHeader: string | null = `<${crypto.randomUUID()}@${fromDomain}>`;
  let providerMessageId: string | null = null;
  const usageMeta = { feature: 'mail', fingerprint, mailbox_id: mailbox.id };
  try {
    if (mailbox.kind === 'hosted') {
      const headers: Record<string, string> = {};
      if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
      if (references) headers['References'] = references;
      const sent = await resend('/emails', {
        method: 'POST',
        // Same key as the hold: a retry of this request id is deduplicated by Resend too.
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
      if (!password) throw new ProviderError('The saved password for this mailbox is missing. Reconnect it.', 409, 'no_secret');
      const trace: SmtpTrace = { sawCommand: false, dataSent: false };
      const transport = smtpTransport(mailbox.smtp_host, mailbox.smtp_user || mailbox.address, password, smtpConnectAddress, trace);
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
        const failure = classifySmtpError(err, trace);
        if (failure.auth) {
          await admin.from('mailboxes').update({ status: 'needs_reauth' }).eq('id', mailbox.id);
          throw new ProviderError(`${mailbox.address} rejected the saved app password. Reconnect it in Accounts.`, 409, failure.code);
        }
        throw new ProviderError(failure.message, failure.uncertain ? 504 : 502, failure.code, failure.uncertain);
      } finally {
        transport.close();
      }
    }
  } catch (err: any) {
    const pe = err instanceof ProviderError ? err : null;
    console.error('[mail] send failed:', providerName, pe?.code || err?.name || 'error', pe?.uncertain ? '(uncertain)' : '');

    if (pe?.uncertain) {
      // The provider may have accepted it. Not refunded: settled as uncertain
      // (the daily slot stays used) and an identical resend is blocked until
      // the user confirms it did not arrive.
      const charge = await chargeSend(admin, {
        userId,
        reservationId,
        credits: price.credits,
        costUsd: price.costUsd,
        idempotencyKey,
        operation,
        provider: providerName,
        providerCallId: null,
        outcome: 'uncertain',
        errorCode: pe.code,
        note: `Email send unconfirmed (${priceKind === 'hosted' ? 'hosted' : 'connected mailbox'})`,
        metadata: usageMeta,
      });
      return fail(UNCERTAIN_MESSAGE, 504, {
        uncertain: true,
        credits_charged: charge.creditsCharged,
        balance_after: charge.balanceAfter,
        ...(charge.pending ? { charge_pending: true } : {}),
      });
    }

    // Nothing was delivered: give the credits and the slot back.
    if (reservationId) {
      await admin.rpc('wallet_release', { p_reservation_id: reservationId, p_reason: 'mail: send failed' });
    }
    await returnSlot();
    return fail(pe ? pe.message : 'The email could not be sent.', pe ? pe.status : 502);
  }

  // 4. Charge. A failed settle is retried, then left for the reaper to settle
  // from the usage row; the send is never free.
  const charge = await chargeSend(admin, {
    userId,
    reservationId,
    credits: price.credits,
    costUsd: price.costUsd,
    idempotencyKey,
    operation,
    provider: providerName,
    providerCallId: providerMessageId,
    outcome: 'success',
    note: `Email sent (${priceKind === 'hosted' ? 'hosted' : 'connected mailbox'})`,
    metadata: usageMeta,
  });
  const creditsCharged = charge.creditsCharged;
  const balanceAfter = charge.balanceAfter;
  const chargeExtra = charge.pending ? { charge_pending: true } : {};

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
      return json({ ok: true, recorded: false, credits_charged: creditsCharged, balance_after: balanceAfter, ...chargeExtra });
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
    ...chargeExtra,
  });
}
