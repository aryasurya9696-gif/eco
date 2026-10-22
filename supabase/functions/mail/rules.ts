// ============================================================================
// Pure helpers for the mail function: mailbox names, DNS provider detection
// and Domain Connect URLs. No I/O here, so every rule is unit-tested in
// rules_test.ts. The reserved list mirrors public.mail_is_reserved_local_part()
// in 20261129_platform_mailboxes.sql; keep the two in step.
// ============================================================================

/** Minimum length of an Echo mailbox name ("rahul" ok, "rk" not). */
export const MIN_LOCAL_PART = 3;
export const MAX_LOCAL_PART = 64;

/** Echo mailboxes: letters, digits, dot, dash, underscore; no "+" sub-addressing. */
const ECHO_LOCAL_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

export const RESERVED_LOCAL_PARTS: readonly string[] = [
  'admin', 'administrator', 'root', 'support', 'abuse', 'postmaster', 'hostmaster',
  'webmaster', 'noreply', 'no-reply', 'billing', 'security', 'info', 'hello', 'sales',
  'team', 'echo', 'help', 'contact', 'mail', 'mailer-daemon', 'privacy', 'legal', 'press',
];

/** Separators are ignored, so "no.reply", "mailer_daemon" and "ad-min" are caught too. */
const squash = (s: string) => s.toLowerCase().replace(/[._-]/g, '');
const RESERVED_SQUASHED = new Set(RESERVED_LOCAL_PARTS.map(squash));

export function isReservedLocalPart(local: string): boolean {
  return RESERVED_SQUASHED.has(squash(String(local || '')));
}

export type LocalPartReason = 'invalid' | 'reserved' | 'too_short';

export function normalizeLocalPart(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

/** Validates an Echo mailbox name. Returns the normalised name or why it is refused. */
export function validateLocalPart(raw: unknown): { ok: true; local: string } | { ok: false; reason: LocalPartReason; local: string } {
  const local = normalizeLocalPart(raw);
  if (local.length < MIN_LOCAL_PART) {
    // A short name made of valid characters is "too short"; junk is "invalid".
    return { ok: false, reason: local && /^[a-z0-9._-]*$/.test(local) ? 'too_short' : 'invalid', local };
  }
  if (local.length > MAX_LOCAL_PART || !ECHO_LOCAL_RE.test(local) || /[._-]{2,}/.test(local)) {
    return { ok: false, reason: 'invalid', local };
  }
  if (isReservedLocalPart(local)) return { ok: false, reason: 'reserved', local };
  return { ok: true, local };
}

/** Lower-case slug of a name or company: "Rahul K. Sharma" -> ["rahul","k","sharma"]. */
function words(v: unknown): string[] {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** "https://www.acme-labs.io/x" -> "acmelabs" (first label of the host). */
export function companyFromWebsite(website: unknown): string {
  const host = String(website ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#:].*$/, '');
  const label = host.split('.')[0] || '';
  return label.replace(/[^a-z0-9]/g, '');
}

export interface SuggestionContext {
  fullName?: string | null;
  company?: string | null;
}

/**
 * Candidate names, best first, for a requested name that is taken or refused.
 * Every candidate passes validateLocalPart; the caller still filters out the
 * ones already taken and returns at most 4.
 */
export function suggestionCandidates(requested: unknown, ctx: SuggestionContext = {}): string[] {
  const nameWords = words(ctx.fullName);
  const companyWord = words(ctx.company).join('').slice(0, 20);
  let base = normalizeLocalPart(requested).replace(/[^a-z0-9._-]/g, '').replace(/[._-]{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '');
  if (base.length < MIN_LOCAL_PART || isReservedLocalPart(base)) base = nameWords[0] || '';
  base = base.slice(0, 40);

  const first = nameWords[0] || '';
  const last = nameWords.length > 1 ? nameWords[nameWords.length - 1] : '';
  const out: string[] = [];
  const push = (c: string) => {
    const v = validateLocalPart(c);
    if (v.ok && !out.includes(v.local)) out.push(v.local);
  };

  if (base) {
    if (last && !base.includes(last)) {
      push(`${base}.${last[0]}`);
      push(`${base}.${last}`);
    }
    if (first && last && base !== first) push(`${first}.${last}`);
    if (companyWord && !base.includes(companyWord)) push(`${base}-${companyWord}`);
    for (let n = 2; n <= 9; n++) push(`${base}${n}`);
    push(`${base}.mail`);
  }
  if (first) {
    push(first);
    if (last) {
      push(`${first}.${last}`);
      push(`${first}${last[0]}`);
    }
    if (companyWord) push(`${first}-${companyWord}`);
  }
  return out.filter((c) => c !== normalizeLocalPart(requested));
}

// ---------------------------------------------------------------------------
// DNS provider detection from NS records
// ---------------------------------------------------------------------------

export interface DnsProvider {
  id: string;
  name: string;
  dns_url: string | null;
}

const PROVIDERS: { id: string; name: string; ns: RegExp; url: ((d: string) => string) | null }[] = [
  { id: 'cloudflare', name: 'Cloudflare', ns: /\.ns\.cloudflare\.com$/, url: (d) => `https://dash.cloudflare.com/?to=/:account/${d}/dns/records` },
  { id: 'godaddy', name: 'GoDaddy', ns: /(^|\.)domaincontrol\.com$/, url: (d) => `https://dcc.godaddy.com/control/dnsmanagement?domainName=${d}` },
  { id: 'namecheap', name: 'Namecheap', ns: /(^|\.)registrar-servers\.com$/, url: (d) => `https://ap.www.namecheap.com/Domains/DomainControlPanel/${d}/advancedns` },
  { id: 'hostinger', name: 'Hostinger', ns: /(^|\.)(dns-parking\.com|hostinger\.[a-z.]+)$/, url: (d) => `https://hpanel.hostinger.com/domain/${d}/dns` },
  { id: 'route53', name: 'Amazon Route 53', ns: /(^|\.)awsdns-\d+\.[a-z.]+$/, url: () => 'https://console.aws.amazon.com/route53/v2/hostedzones' },
  { id: 'google', name: 'Google Cloud DNS', ns: /(^|\.)googledomains\.com$/, url: () => 'https://console.cloud.google.com/net-services/dns/zones' },
  { id: 'ionos', name: 'IONOS', ns: /(^|\.)ui-dns\.(com|de|org|biz)$/, url: () => 'https://my.ionos.com/domains' },
  { id: 'bluehost', name: 'Bluehost', ns: /(^|\.)bluehost\.com$/, url: () => 'https://my.bluehost.com/hosting/app#/domains' },
  { id: 'digitalocean', name: 'DigitalOcean', ns: /(^|\.)digitalocean\.com$/, url: (d) => `https://cloud.digitalocean.com/networking/domains/${d}` },
  { id: 'vercel', name: 'Vercel', ns: /(^|\.)vercel-dns\.com$/, url: () => 'https://vercel.com/dashboard/domains' },
  { id: 'squarespace', name: 'Squarespace', ns: /(^|\.)squarespacedns\.com$/, url: (d) => `https://account.squarespace.com/domains/managed/${d}/dns/dns-settings` },
  { id: 'porkbun', name: 'Porkbun', ns: /(^|\.)porkbun\.com$/, url: () => 'https://porkbun.com/account/domainsSpeedy' },
];

/** Maps a domain's NS host names to its DNS provider; 'other' when unknown. */
export function detectDnsProvider(nameservers: string[], domain: string): DnsProvider {
  const hosts = (Array.isArray(nameservers) ? nameservers : []).map((h) => String(h).toLowerCase().replace(/\.$/, ''));
  for (const p of PROVIDERS) {
    if (hosts.some((h) => p.ns.test(h))) return { id: p.id, name: p.name, dns_url: p.url ? p.url(encodeURIComponent(domain)) : null };
  }
  return { id: 'other', name: 'Other', dns_url: null };
}

// ---------------------------------------------------------------------------
// Domain Connect (https://github.com/Domain-Connect/spec)
// ---------------------------------------------------------------------------

/**
 * The `_domainconnect` TXT value is a host plus optional path, e.g.
 * "api.cloudflare.com/client/v4/dns/domainconnect". Returns the settings URL,
 * or null when the value is not a plain public-looking https host/path.
 */
export function domainConnectSettingsUrl(txtValue: string, domain: string): string | null {
  const v = String(txtValue || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const m = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)(\/[A-Za-z0-9._~\/-]*)?$/i.exec(v);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^[0-9.]+$/.test(host)) return null;
  return `https://${host}${m[5] || ''}/v2/${encodeURIComponent(domain)}/settings`;
}

/** `urlSyncUX` from a settings document, only when it is an https URL. */
export function syncUxBase(settings: any): string | null {
  const u = typeof settings?.urlSyncUX === 'string' ? settings.urlSyncUX.trim().replace(/\/+$/, '') : '';
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(u)) return null;
  return u;
}

export interface ApplyUrlInput {
  urlSyncUX: string;
  providerId: string;
  serviceId: string;
  domain: string;
  host?: string;
  vars: Record<string, string>;
  redirectUri?: string;
  state?: string;
}

/**
 * Query string of the synchronous apply call, without sig/key. Parameters are
 * sorted so the string is deterministic: it is exactly what gets signed.
 */
export function domainConnectApplyQuery(input: Omit<ApplyUrlInput, 'urlSyncUX' | 'providerId' | 'serviceId'>): string {
  const params: [string, string][] = [['domain', input.domain]];
  if (input.host) params.push(['host', input.host]);
  for (const [k, v] of Object.entries(input.vars)) params.push([k, v]);
  if (input.redirectUri) params.push(['redirect_uri', input.redirectUri]);
  if (input.state) params.push(['state', input.state]);
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** Full apply URL; `sig`/`key` are appended when the template requires signing. */
export function buildDomainConnectApplyUrl(input: ApplyUrlInput, signature?: { sig: string; key: string }): string {
  const base =
    `${input.urlSyncUX.replace(/\/+$/, '')}/v2/domainTemplates/providers/` +
    `${encodeURIComponent(input.providerId)}/services/${encodeURIComponent(input.serviceId)}/apply`;
  let q = domainConnectApplyQuery(input);
  if (signature) q += `&sig=${encodeURIComponent(signature.sig)}&key=${encodeURIComponent(signature.key)}`;
  return `${base}?${q}`;
}

export interface TemplateRecord {
  type: string;
  host: string;
  value: string;
}

/**
 * Template variables for echo.mail-sending from the domain's DNS table (FQDN
 * hosts, MX values as "<priority> <host>"). Null when any record is missing.
 */
export function domainConnectVars(domain: string, records: TemplateRecord[]): Record<string, string> | null {
  const rel = (host: string) => {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    if (h === domain) return '@';
    return h.endsWith('.' + domain) ? h.slice(0, -(domain.length + 1)) : h;
  };
  const mxHost = (value: string) => String(value || '').trim().split(/\s+/).pop() || '';
  const list = Array.isArray(records) ? records : [];
  const dkim = list.find((r) => r.type === 'TXT' && /_domainkey/.test(r.host));
  const spf = list.find((r) => r.type === 'TXT' && /^v=spf1/i.test(r.value) && rel(r.host) !== '@');
  const bounce = list.find((r) => r.type === 'MX' && rel(r.host) !== '@');
  const inbound = list.find((r) => r.type === 'MX' && rel(r.host) === '@');
  // Every template variable must be supplied, or the provider refuses the apply.
  if (!dkim || !spf || !bounce || !inbound) return null;
  return {
    dkimHost: rel(dkim.host),
    dkimValue: dkim.value,
    sendHost: rel(spf.host),
    spfValue: spf.value,
    bounceMx: mxHost(bounce.value),
    inboundMx: mxHost(inbound.value),
  };
}
