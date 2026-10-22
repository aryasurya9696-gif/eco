// ============================================================================
// mail-inbound: pure rules
// ----------------------------------------------------------------------------
// Everything here is deterministic and has no I/O beyond WebCrypto, so it can
// be tested without a database or a network: webhook signature verification,
// header parsing, subject normalisation, auto-reply and spam detection, and
// recipient matching.
// ============================================================================

const encoder = new TextEncoder();

// Replays outside this window are refused even with a valid signature.
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Signature (Svix / Standard Webhooks)
//
//   signed payload = "{id}.{timestamp}.{raw body}"
//   secret          = whsec_<base64>, prefix stripped, base64-decoded
//   header          = space-separated "v1,<base64 signature>" entries
//
// Resend sends svix-id / svix-timestamp / svix-signature; the Standard
// Webhooks names (webhook-*) are accepted too. Same approach as
// billing-webhook/index.ts.
// ---------------------------------------------------------------------------

export interface HeaderSource {
  get(name: string): string | null;
}

export interface VerifyResult {
  ok: boolean;
  reason: string;
  id: string | null;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function hmacSha256Base64(key: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export function webhookHeaders(headers: HeaderSource): { id: string | null; timestamp: string | null; signature: string | null } {
  return {
    id: headers.get('svix-id') ?? headers.get('webhook-id'),
    timestamp: headers.get('svix-timestamp') ?? headers.get('webhook-timestamp'),
    signature: headers.get('svix-signature') ?? headers.get('webhook-signature'),
  };
}

export async function verifyWebhookSignature(
  rawBody: string,
  headers: HeaderSource,
  secret: string,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  const { id, timestamp, signature } = webhookHeaders(headers);
  if (!secret) return { ok: false, reason: 'no_secret', id };
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers', id };

  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp', id };
  const ts = Number(timestamp);
  if (Math.abs(nowMs - ts * 1000) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'timestamp_outside_window', id };
  }

  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let key: Uint8Array;
  try {
    key = base64ToBytes(raw);
  } catch {
    return { ok: false, reason: 'bad_secret_encoding', id };
  }
  if (key.length === 0) return { ok: false, reason: 'bad_secret_encoding', id };

  const expected = await hmacSha256Base64(key, `${id}.${timestamp}.${rawBody}`);

  // Several signatures may be present during a secret rotation; any match wins.
  const candidates = signature
    .split(' ')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('v1,'))
    .map((p) => p.slice(3));
  if (candidates.length === 0) return { ok: false, reason: 'no_v1_signature', id };

  let matched = false;
  for (const c of candidates) {
    // No early exit, so the number of candidates checked is not observable.
    if (timingSafeEqual(c, expected)) matched = true;
  }
  return matched ? { ok: true, reason: 'ok', id } : { ok: false, reason: 'signature_mismatch', id };
}

// ---------------------------------------------------------------------------
// Headers
// Resend returns headers as an object. Keys are treated case-insensitively and
// a repeated header may come back as an array.
// ---------------------------------------------------------------------------

export type RawHeaders = Record<string, unknown> | null | undefined;

export function headerValue(headers: RawHeaders, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      const parts = v.filter((x): x is string => typeof x === 'string');
      return parts.length ? parts.join(' ') : null;
    }
    if (v !== null && v !== undefined) return String(v);
  }
  return null;
}

/** Every <message-id> token in an In-Reply-To / References value, in order, deduplicated. */
export function parseMessageIds(value: string | null | undefined, max = 50): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<([^<>\s]{1,500})>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const id = `<${m[1]}>`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  // Some clients send a bare id with no angle brackets.
  if (out.length === 0) {
    const bare = value.trim();
    if (/^[^\s<>]{1,500}@[^\s<>]{1,500}$/.test(bare)) out.push(`<${bare}>`);
  }
  // The most recent ancestors are at the end of References; keep those.
  return out.length > max ? out.slice(out.length - max) : out;
}

/** "<abc@host>" -> "abc". Used to match provider ids that are the id's local part. */
export function messageIdLocalPart(id: string): string | null {
  const m = /^<?([^@<>\s]+)@/.exec(id);
  return m ? m[1] : null;
}

/** Normalises a Message-ID for storage; falls back to a synthetic one keyed on the provider id. */
export function normaliseMessageId(raw: unknown, fallbackProviderId: string): string {
  if (typeof raw === 'string') {
    const ids = parseMessageIds(raw, 1);
    if (ids[0]) return ids[0].slice(0, 998);
  }
  return `<resend-inbound-${fallbackProviderId}@inbound.invalid>`;
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

const PREFIX_RE = /^\s*(?:(?:re|fw|fwd|aw|wg|sv|vs|antw|rif|tr|res|enc)\s*(?:\[\d+\])?\s*[:：]\s*|\[[^\]]{0,40}\]\s*)/i;

/** Strips any number of Re:/Fwd:/[list] prefixes, collapses whitespace, lowercases. */
export function normaliseSubject(subject: string | null | undefined): string {
  let s = String(subject ?? '');
  for (let i = 0; i < 20; i++) {
    const next = s.replace(PREFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export interface Party {
  address: string;
  name: string | null;
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** "Jane Doe <Jane@Example.com>" -> { address: "jane@example.com", name: "Jane Doe" }. */
export function parseAddress(input: unknown): Party | null {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const addr = typeof o.address === 'string' ? o.address : typeof o.email === 'string' ? o.email : null;
    if (!addr) return null;
    const p = parseAddress(addr);
    if (!p) return null;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : p.name;
    return { address: p.address, name };
  }
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  const angle = /^(.*)<([^<>]+)>\s*$/.exec(s);
  let address: string;
  let name: string | null = null;
  if (angle) {
    address = angle[2].trim();
    const n = angle[1].trim().replace(/^"(.*)"$/, '$1').trim();
    name = n || null;
  } else {
    address = s;
  }
  address = address.toLowerCase();
  if (!EMAIL_RE.test(address) || address.length > 320) return null;
  return { address, name: name ? name.slice(0, 200) : null };
}

/** Accepts an array (strings or {address,name}) or a comma-separated string. */
export function parseAddressList(input: unknown, max = 100): Party[] {
  let items: unknown[] = [];
  if (Array.isArray(input)) items = input;
  else if (typeof input === 'string') items = splitAddressHeader(input);
  const out: Party[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const p = parseAddress(item);
    if (p && !seen.has(p.address)) {
      seen.add(p.address);
      out.push(p);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** Splits on commas that are not inside quotes or angle brackets. */
function splitAddressHeader(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let depth = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') depth++;
    else if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !quoted && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * The first recipient (in the order given: to, then cc, then received_for)
 * that is one of our mailbox addresses. Comparison is case-insensitive.
 */
export function matchRecipient(recipients: string[], mailboxAddresses: string[]): string | null {
  const ours = new Set(mailboxAddresses.map((a) => a.trim().toLowerCase()));
  for (const r of recipients) {
    const a = r.trim().toLowerCase();
    if (ours.has(a)) return a;
  }
  return null;
}

/** Addresses out of a thread's participants jsonb (array of strings or {address,name}). */
export function participantAddresses(participants: unknown): string[] {
  return parseAddressList(Array.isArray(participants) ? participants : []).map((p) => p.address);
}

/** Participants with `party` appended when not already present. */
export function withParticipant(participants: unknown, party: Party): unknown[] {
  const list = Array.isArray(participants) ? [...participants] : [];
  if (participantAddresses(list).includes(party.address)) return list;
  list.push({ address: party.address, name: party.name });
  return list;
}

/** Escapes LIKE wildcards so an address can be matched exactly with ilike. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const AUTO_SUBJECT_RE =
  /^\s*(?:auto(?:matic)?[\s-]*reply|autoreply|auto[\s-]*response|out of (?:the )?office|ooo\b|away from (?:the )?office|on vacation|on leave|abwesenheit|absence|r[ée]ponse automatique|automatische antwort|respuesta autom[áa]tica|risposta automatica)/i;

/** RFC 3834 Auto-Submitted, vendor headers, and out-of-office subjects. */
export function isAutoReply(headers: RawHeaders, subject: string | null | undefined): boolean {
  const autoSubmitted = headerValue(headers, 'auto-submitted');
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') return true;
  if (headerValue(headers, 'x-autoreply') || headerValue(headers, 'x-autorespond')) return true;
  const precedence = (headerValue(headers, 'precedence') ?? '').trim().toLowerCase();
  if (precedence === 'auto_reply') return true;
  // Strip one Re:/Fwd: layer: "Automatic reply: Re: hello" and "Re: Out of office".
  const s = String(subject ?? '').replace(PREFIX_RE, '');
  return AUTO_SUBJECT_RE.test(s) || AUTO_SUBJECT_RE.test(String(subject ?? ''));
}

/** Spam verdict from the headers a receiving MTA adds. */
export function isSpam(headers: RawHeaders, extra?: { spam?: unknown; spam_verdict?: unknown }): boolean {
  if (extra?.spam === true) return true;
  const verdict = typeof extra?.spam_verdict === 'string' ? extra.spam_verdict.toLowerCase() : '';
  if (verdict === 'fail' || verdict === 'spam') return true;
  const flag = (headerValue(headers, 'x-spam-flag') ?? '').trim().toLowerCase();
  if (flag === 'yes' || flag === 'true') return true;
  const status = (headerValue(headers, 'x-spam-status') ?? '').trim().toLowerCase();
  if (/^yes\b/.test(status)) return true;
  const ses = (headerValue(headers, 'x-ses-spam-verdict') ?? '').trim().toUpperCase();
  if (ses === 'FAIL') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Rough plain text from HTML, for the snippet only (never rendered). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** First ~200 chars of the new content: quoted lines and "On ... wrote:" dropped. */
export function snippetOf(text: string, max = 200): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*On .{0,300} wrote:\s*$/i.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    kept.push(line);
  }
  const s = kept.join(' ').replace(/\s+/g, ' ').trim();
  const base = s || text.replace(/\s+/g, ' ').trim();
  return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}

/** Event names this function acts on, mapped to the delivery-event RPC's vocabulary. */
export function deliveryEventOf(type: string): 'bounced' | 'complained' | 'delivered' | null {
  switch (type) {
    case 'email.bounced': return 'bounced';
    case 'email.complained': return 'complained';
    case 'email.delivered': return 'delivered';
    default: return null;
  }
}
