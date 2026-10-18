// ============================================================================
// Supabase Edge Function: ai
// ----------------------------------------------------------------------------
// Proxies OpenAI so the API key NEVER reaches the browser bundle.
//
// NOTE: this file is intentionally SELF-CONTAINED. Do not split shared helpers
// into an underscore-prefixed folder — Supabase's bundler skips `_`-prefixed
// directories and the relative import fails to resolve on deploy.
//
// Deploy:  supabase functions deploy ai
// Secret:  supabase secrets set OPENAI_API_KEY=sk-...
//
// Request body: { action: 'keywords' | 'draft', ...payload }
//   action=keywords -> { offerText, website?, existingKeywords?, channels?,
//                        slots?, lookbackHours? }
//                     -> { ok, icp, suggestions[], avoid[], source }
//   action=draft    -> { post, tone, userOffer?, userName? }
//                     -> { ok, draft, source }
// ============================================================================

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';

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

function fail(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

/**
 * Verifies the caller's Supabase JWT by round-tripping it through the auth API
 * with the *anon* key. Returns the authenticated user id, or null.
 *
 * We deliberately do NOT trust anything in the request body for identity.
 */
async function requireUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) return null;

  try {
    const res = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: anonKey },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

/** In-memory fixed-window rate limiter (per edge isolate). */
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = Deno.env.get('OPENAI_MODEL') || 'gpt-4o-mini';
/** Markdown code fence, built without a literal backtick sequence. */
const FENCE = String.fromCharCode(96).repeat(3);

const TONE_GUIDELINES: Record<string, string> = {
  consultative:
    'Warm, advisory, helpful, and insightful. Offer genuine benchmark advice without a hard pitch.',
  direct:
    'Concise, value-focused, and inviting. Highlight immediate relevancy and suggest a quick intro.',
  casual: 'Friendly, peer-to-peer founder tone, conversational, zero corporate jargon.',
  professional: 'Polite, articulate, executive-level, respectful of their time.',
};

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
// Kept as a whitelist because the model is asked to name them, and an invented
// channel name would be stored on a keyword row and then silently ignored by
// the sweep.
const CHANNELS = ['x', 'reddit', 'web', 'news'] as const;
type Channel = (typeof CHANNELS)[number];

function normaliseChannels(input: unknown): Channel[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<Channel>();
  for (const raw of input) {
    const s = String(raw).toLowerCase().trim();
    if (s === 'twitter' || s === 'x') out.add('x');
    else if (s === 'google') out.add('web');
    else if (s === 'linkedin' || s === 'facebook') continue; // not supported
    else if ((CHANNELS as readonly string[]).includes(s)) out.add(s as Channel);
  }
  return [...out];
}

/**
 * The phrases the sweep's intent scorer actually rewards. Suggesting keywords
 * built around these is what makes a suggestion score well instead of reading
 * as generic topical noise.
 */
const INTENT_SIGNALS = [
  'looking for', 'recommend', 'recommendation', 'alternative to', 'switching from',
  'anyone using', 'best tool for', 'best software for', 'pricing', 'how much does',
  'need software', 'any suggestions', 'help choosing', 'switching', 'migrating from',
];

const NOISE_PHRASES = [
  'hiring', 'job opening', 'free template', 'tutorial', 'how to build',
  'course', 'certification', 'salary', 'interview questions',
];

async function chat(
  apiKey: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  opts: { temperature: number; maxTokens: number; jsonMode?: boolean },
): Promise<string | null> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      // Structured output rather than parsing prose: the old version did
      // JSON.parse on whatever came back and silently fell back to heuristics
      // whenever the model added a sentence of preamble.
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!res.ok) {
    console.warn('[ai] OpenAI error:', res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

// ---------------------------------------------------------------------------
// Website extraction
// ---------------------------------------------------------------------------
// The offer text alone is often two lines of marketing copy. The page itself is
// where the actual category, competitors and vocabulary live, so a short slice
// of it is worth far more to the model than any prompt engineering.
//
// This fetches a URL the caller supplied, so it is the classic SSRF shape and
// the guard below is not optional: only public internet addresses are fetched.

function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0.0.0.0' || h === '::') return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

async function extractSite(url: string, timeoutMs = 6000): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (isPrivateAddress(parsed.hostname)) return '';

  // Resolve first: a public hostname can still point at an internal address,
  // and the resolved address is what actually gets connected to.
  try {
    const records = await Deno.resolveDns(parsed.hostname, 'A');
    if (
      records.type === 'A' &&
      records.answers.some((a: { value: string }) => isPrivateAddress(a.value))
    ) {
      return '';
    }
  } catch {
    return ''; // fail closed rather than fetch an unverified target
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'EchoBot/1.0 (+keyword research)', Accept: 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const html = (await res.text()).slice(0, 120_000);

    const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html)?.[1] ?? '';
    const desc =
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,400})["']/i.exec(html)?.[1] ??
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{0,400})["']/i.exec(html)?.[1] ??
      '';
    const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]{0,120}?)<\/h[12]>/gi)]
      .map((m) => stripTags(m[1]))
      .filter(Boolean)
      .slice(0, 12);

    return [
      title ? `Title: ${stripTags(title)}` : '',
      desc ? `Description: ${stripTags(desc)}` : '',
      headings.length ? `Headings: ${headings.join(' | ')}` : '',
    ].filter(Boolean).join('\n').slice(0, 1500);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Suggestion shaping
// ---------------------------------------------------------------------------

interface Suggestion {
  phrase: string;
  intent: 'high' | 'medium' | 'low';
  score: number;
  channels: Channel[];
  why: string;
}

function shapeSuggestions(raw: unknown, allowedChannels: Channel[], existing: Set<string>): Suggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const phrase = String(item?.phrase ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    // 1-4 words keeps a keyword a keyword; longer phrases match almost nothing.
    if (!phrase || phrase.split(' ').length > 5) continue;
    if (seen.has(phrase) || existing.has(phrase)) continue;
    seen.add(phrase);

    const intent = item?.intent === 'high' || item?.intent === 'medium' ? item.intent : 'low';
    const score = Math.max(0, Math.min(97, Math.round(Number(item?.score) || 0)));
    // Never suggest a channel the workspace does not scan.
    const channels = normaliseChannels(item?.channels).filter((c) => allowedChannels.includes(c));
    const why = String(item?.why ?? '').slice(0, 140).trim();

    out.push({ phrase, intent, score, channels, why });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heuristic fallback
// ---------------------------------------------------------------------------
// Reached whenever OpenAI is unavailable or the key is not set. Derives
// category nouns from the offer text and pairs them with the buyer's task
// wording, instead of returning one of three fixed lists regardless of product.

/**
 * Ordered most-specific first. The first two entries used broad patterns, so
 * "agent inbox for B2B sales teams" resolved to `ai agent` and the keywords came
 * out two degrees away from what the product actually does.
 */
const CATEGORY_HINTS: Array<{ match: RegExp; core: string[] }> = [
  { match: /\b(shared inbox|team inbox|customer inbox|inbox)\b/i, core: ['shared inbox', 'team inbox'] },
  { match: /\b(helpdesk|support desk|support ticket|ticketing)\b/i, core: ['helpdesk', 'ticketing system'] },
  { match: /\b(agentic|ai agents?|llm|agent framework)\b/i, core: ['ai agent', 'agentic workflow'] },
  { match: /\b(sdr|outbound|prospecting)\b/i, core: ['outbound sales', 'sdr workflow'] },
  { match: /\b(sales team|sales tool|sales automation|b2b lead)\b/i, core: ['b2b sales tool', 'sales automation'] },
  { match: /\bcrm\b/i, core: ['crm workflow', 'crm automation'] },
  { match: /\b(email|newsletter|campaign|outreach)\b/i, core: ['email outreach', 'email automation'] },
  { match: /\b(api|webhook|integration|sync|developer)\b/i, core: ['developer api', 'workflow integration'] },
  { match: /\b(scrap|crawl|monitor|listening|tracking)\b/i, core: ['social listening', 'monitoring tool'] },
  { match: /\b(seo|keyword|rank)\b/i, core: ['seo tool', 'keyword tracking'] },
  { match: /\b(schedule|calendar|booking|meeting)\b/i, core: ['scheduling tool', 'calendar automation'] },
  { match: /\b(analytics|dashboard|reporting)\b/i, core: ['analytics tool', 'reporting dashboard'] },
];

function fallbackSuggestions(
  offerText: string,
  existing: Set<string>,
  allowed: Channel[],
  slots: number,
): Suggestion[] {
  const text = offerText.trim();
  const matched = CATEGORY_HINTS.filter((h) => h.match.test(text)).flatMap((h) => h.core);
  // Two categories, not three: the smallest plan allows 5 keywords and a third
  // set only filled the list with near-duplicates of the weakest category.
  const cats = (matched.length ? matched : ['b2b saas tool', 'workflow software']).slice(0, 2);

  const out: Suggestion[] = [];
  const seen = new Set<string>();

  const push = (phrase: string, intent: Suggestion['intent'], score: number, why: string) => {
    const key = phrase.toLowerCase();
    if (!key || seen.has(key) || existing.has(key)) return;
    seen.add(key);
    out.push({ phrase: key, intent, score, channels: allowed.slice(0, 2), why });
  };

  cats.forEach((cat, i) => {
    const base = 76 - i * 6;
    push(cat, i === 0 ? 'high' : 'medium', base, 'Matches how buyers name the category');
    push(`alternative to ${cat}`, 'high', base + 4, 'Comparison shoppers ask for this directly');
    push(`${cat} pricing`, 'high', base + 2, 'Pricing questions signal an active evaluation');
  });

  push(`how to evaluate a ${cats[0]}`, 'medium', 58, 'Research-stage buyers search this before deciding');
  push(`is there a better ${cats[0]}`, 'medium', 56, 'Open-ended dissatisfaction phrasing');

  // The workspace cannot track more than `slots` keywords, so returning a longer
  // list only pushes work back onto the user.
  return out.slice(0, slots);
}

// ---------------------------------------------------------------------------
// Ideal customer profile
// ---------------------------------------------------------------------------
// A model asked for JSON will usually comply and occasionally will not: it adds
// a sentence of preamble, returns the object inside a code fence, drops a key,
// or answers with a single string where a document was asked for. Each of those
// is handled by normalisation here rather than by a try/catch around the render,
// because the consumer is an editable card and a card that throws takes the whole
// tab with it.

const ICP_SYSTEM_PROMPT = [
  "You are a B2B go-to-market strategist. From a company's website and its own description,",
  'define who is most likely to buy, in terms a data provider can search.',
  'Use only the inputs. Be specific: real industries, real job titles, employee ranges,',
  'countries. Prefer one tight segment over a broad one. If the user stated a segment, start',
  'there and refine it. List your assumptions. Return only JSON matching the schema.',
  '',
  'Severity is about what an assumption would cost the reader if it is wrong, not',
  'how sure you are that it is true. Use high when a wrong assumption would send',
  'the search at entirely the wrong people, medium when it would skew it, low',
  'when it is a caveat about coverage. If an assumption genuinely would not change',
  'the results, leave it out — a list of three real ones is worth more than ten',
  'hedges.',
  '',
  'Schema:',
  '{',
  '  "summary": string,',
  '  "segments": [{',
  '    "name": string,',
  '    "industries": string[],',
  '    "keywords": string[],',
  '    "excludeKeywords": string[],',
  '    "countries": string[],',
  '    "employeeRange": [number, number],',
  '    "targetTitles": string[],',
  '    "seniority": string[],',
  '    "whyTheyBuy": string,',
  '    "pains": string[],',
  '    "openingAngle": string',
  '  }],',
  '  "primarySegment": number,',
  '  "assumptions": [{ "text": string, "severity": "high"|"medium"|"low", "why": string }],',
  '  "confidence": number',
  '}',
].join('\n');

/**
 * Pulls the first balanced JSON object out of a string that may be wrapped in
 * prose or a code fence.
 *
 * Scans for brace depth rather than counting characters, and tracks string state
 * so a brace inside a value — "use {braces} like this" — does not end the object
 * early.
 */
function parseJsonLoose(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to a brace scan */
  }

  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function asStringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .slice(0, max);
}

interface IcpSegment {
  name: string;
  industries: string[];
  keywords: string[];
  excludeKeywords: string[];
  countries: string[];
  employeeRange: [number, number] | null;
  targetTitles: string[];
  seniority: string[];
  whyTheyBuy: string;
  pains: string[];
  openingAngle: string;
}

interface IcpDocument {
  summary: string;
  segments: IcpSegment[];
  primarySegment: number;
  assumptions: IcpAssumption[];
  confidence: number;
}

export interface IcpAssumption {
  text: string;
  severity: 'high' | 'medium' | 'low';
  /** Why it matters if it is wrong. Empty when the model did not say. */
  why: string;
}

/**
 * Coerces whatever came back into the documented shape.
 *
 * Returns null when there is nothing usable, because the caller retries on null
 * and then falls back to something honest. A partial segment with a name and
 * some titles is worth more than none, so missing lists become empty lists
 * rather than failing the document: the card shows an empty chip row the user can
 * fill, which is a smaller problem than no card at all.
 */
function normaliseIcp(raw: unknown): IcpDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;

  const rawSegments = Array.isArray(doc.segments) ? doc.segments : [];

  const segments: IcpSegment[] = rawSegments
    .slice(0, 5)
    .map((s) => {
      const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      const range =
        Array.isArray(o.employeeRange) && o.employeeRange.length >= 2
          ? ([num(o.employeeRange[0], 1), num(o.employeeRange[1], 1000)] as [number, number])
          : null;

      return {
        name: str(o.name, 120),
        industries: asStringList(o.industries, 20),
        keywords: asStringList(o.keywords, 40),
        excludeKeywords: asStringList(o.excludeKeywords, 20),
        // ISO-2 in practice, so uppercased and truncated rather than trusted.
        countries: asStringList(o.countries, 12).map((c) => c.toUpperCase().slice(0, 3)),
        // An inverted range is dropped rather than sorted: the model probably
        // meant the two ends the other way round, and quietly swapping them would
        // search a band the user never described.
        employeeRange: range && range[0] <= range[1] ? range : null,
        targetTitles: asStringList(o.targetTitles, 20),
        seniority: asStringList(o.seniority, 10),
        whyTheyBuy: str(o.whyTheyBuy, 400),
        pains: asStringList(o.pains, 8),
        openingAngle: str(o.openingAngle, 300),
      };
    })
    .filter((s) => s.name || s.targetTitles.length || s.keywords.length);

  if (segments.length === 0) return null;

  const claimed = num(doc.primarySegment, 0);

  return {
    summary: str(doc.summary, 400),
    segments,
    primarySegment: claimed >= 0 && claimed < segments.length ? claimed : 0,
    assumptions: asAssumptions(doc.assumptions, 10),
    confidence: clamp01(num(doc.confidence, 0.5)),
  };
}

/**
 * Reads the assumptions, whichever shape they arrive in.
 *
 * Two shapes, deliberately. The documented one is an object with a severity and a
 * reason. The one already stored is a bare string, and a reader that accepts only
 * the new shape would quietly empty every existing profile's assumption list —
 * which is the sort of thing that looks like the AI getting better and is actually
 * data being dropped.
 *
 * A bare string is recorded at medium rather than high or low. Medium is the
 * honest default because it is the one that means "look at this", and the reason
 * is left empty because inventing one would be worse than not having it.
 */
function asAssumptions(v: unknown, limit: number): IcpAssumption[] {
  if (!Array.isArray(v)) return [];

  const out: IcpAssumption[] = [];

  for (const item of v.slice(0, limit)) {
    if (typeof item === 'string') {
      const text = item.trim().slice(0, 300);
      if (text) out.push({ text, severity: 'medium', why: '' });
      continue;
    }

    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;

    const text = str(o.text, 300);
    if (!text) continue;

    const raw = String(o.severity ?? '').toLowerCase();
    const severity =
      raw === 'high' || raw === 'medium' || raw === 'low' ? raw : 'medium';

    out.push({ text, severity, why: str(o.why, 300) });
  }

  // Worst first. The panel's whole job is to be scannable, and an ordered list of
  // equal-looking rows is not scannable.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * The word-budgeted page text.
 *
 * Whole pages only, in the order given, until the budget is spent. A page cut
 * mid-sentence teaches the model that the site is written in fragments, and the
 * last page is usually the least important one anyway.
 */
function condensePages(pages: unknown[]): { text: string; usedPages: number } {
  const BUDGET_WORDS = 15000;
  let used = 0;
  const out: string[] = [];

  for (const p of pages.slice(0, 8)) {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const title = str(o.title, 120);
    const body = str(o.markdown ?? o.text ?? o.content, 60000);
    if (!body) continue;

    const words = body.split(/\s+/).filter(Boolean);
    if (used + words.length > BUDGET_WORDS) break;

    used += words.length;
    out.push((title ? '## ' + title + '\n\n' : '') + body);
  }

  return { text: out.join('\n\n').trim(), usedPages: out.length };
}

const REGION_CODES: Record<string, string> = {
  uk: 'GB',
  'united kingdom': 'GB',
  britain: 'GB',
  us: 'US',
  'united states': 'US',
  usa: 'US',
  canada: 'CA',
  australia: 'AU',
  ireland: 'IE',
  india: 'IN',
  eu: 'DE',
  'european union': 'DE',
};

function regionToCode(r: string): string | null {
  return REGION_CODES[r.trim().toLowerCase()] ?? null;
}

/** Size chips map to an employee range, or to nothing when the chip is unrecognised. */
function sizeToRange(size: string | undefined): [number, number] | null {
  if (!size) return null;
  const m = size.match(/(\d[\d,]*)\s*-\s*(\d[\d,]*)/);
  if (!m) return null;

  const lo = Number(m[1].replace(/,/g, ''));
  const hi = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [lo, hi];
}

/**
 * The no-AI path.
 *
 * Built only from what the user typed. Nothing here is inferred: a country, a job
 * title or an industry that a word list made up would be sent to a real provider
 * and billed for, and the user would be shown a segment that quietly decided who
 * they sell to. So the segment stays exactly as narrow as their own answer.
 *
 * The response is flagged `source: 'fallback'` for the same reason: the UI can
 * say the model did not answer, instead of presenting this as a finished ICP.
 */
function fallbackIcpDocument(input: {
  website: string;
  offer: string;
  regions: string[];
  sizes: string[];
  pricePoint: string;
  hypothesis: string;
  note: string;
}): IcpDocument {
  const nameParts = [input.pricePoint, input.regions[0], input.sizes[0]].filter(Boolean);
  const subject = input.hypothesis || input.offer || input.website || 'this product';

  return {
    summary: subject.slice(0, 300),
    segments: [
      {
        name: [subject.slice(0, 60), ...nameParts].filter(Boolean).join(' · '),
        industries: [],
        keywords: input.offer
          ? input.offer
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 12)
          : [],
        excludeKeywords: [],
        // Only the regions the user actually picked. Defaulting to anything would
        // be the model's guess wearing the model's clothes.
        countries: input.regions.map(regionToCode).filter((c): c is string => Boolean(c)),
        employeeRange: sizeToRange(input.sizes[0]),
        // The three titles that cover most small-firm buying decisions.
        targetTitles: ['CEO', 'Founder', 'Owner'],
        seniority: ['owner', 'c_suite'],
        whyTheyBuy: input.hypothesis.slice(0, 300),
        pains: [],
        openingAngle: '',
      },
    ],
    primarySegment: 0,
    assumptions: [
      {
        // High, and it is the only assumption in this product that has ever been
        // high. Nothing else on this panel can cost the reader as much: every
        // other assumption is a guess about who to search for, and this one is
        // the profile not having been written by anything at all.
        text: 'Built from your own answers because the AI did not respond. Add industries and job titles before running.',
        severity: 'high',
        why: 'Nothing here was inferred from your site, so this will be a much broader search than a generated profile.',
      },
    ],
    confidence: 0.2,
  };
}

function fallbackIcp(offerText: string): string {
  const t = offerText.trim();
  if (!t) return 'B2B teams with a shared inbox or sales workflow';
  const words = t.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 12);
  return words.length ? words.join(' ') : 'B2B software buyers';
}

// ---------------------------------------------------------------------------
// Outreach draft
// ---------------------------------------------------------------------------

function fallbackDraft(
  post: { author_name?: string | null; matched_keyword?: string | null },
  tone: string,
): string {
  const author = post.author_name ? post.author_name.split(' ')[0] : 'there';
  const keyword = post.matched_keyword || 'this topic';

  switch (tone) {
    case 'casual':
      return 'Hey ' + author + ', saw your post regarding ' + keyword + '. We actually tackled this exact problem recently. Would love to share our benchmark notes if you are open to a quick comparison!';
    case 'consultative':
      return 'Hi ' + author + ', your observation about ' + keyword + ' is spot-on. Many teams struggle with this transition. We put together a brief workflow analysis on how to optimize this without bloatware — happy to share the breakdown if helpful!';
    case 'direct':
      return 'Hi ' + author + ', noticed your requirement for ' + keyword + '. Are you available for a quick 5-minute walkthrough?';
    case 'professional':
    default:
      return 'Hello ' + author + ', I came across your post about ' + keyword + '. We specialize in solving this challenge with streamlined automation. I would welcome the opportunity to connect and exchange thoughts on your current architecture.';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  const userId = await requireUserId(req);
  if (!userId) return fail('Unauthorized', 401);

  // 40 AI calls / hour / user — prevents runaway spend from a leaked session.
  if (!rateLimit('ai:' + userId, 40, 60 * 60 * 1000)) {
    return fail('AI rate limit reached. Please try again later.', 429);
  }

  const apiKey = Deno.env.get('OPENAI_API_KEY');

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail('Invalid JSON body');
  }

  const action = body?.action;

  // ---- Keyword suggestions ----------------------------------------------
  if (action === 'keywords') {
    const offerText = String(body?.offerText ?? '').trim().slice(0, 600);
    const website = String(body?.website ?? '').trim().slice(0, 200);
    const existing = new Set<string>(
      (Array.isArray(body?.existingKeywords) ? (body.existingKeywords as unknown[]) : [])
        .map((k) => String(k).toLowerCase().trim())
        .filter(Boolean),
    );
    const allowedChannels = normaliseChannels(body?.channels);
    const slots = Math.max(1, Math.min(25, Number(body?.slots) || 10));
    const lookbackHours = Math.max(1, Math.min(8760, Number(body?.lookbackHours) || 24));

    // Real page content beats more prompt engineering.
    const siteText = website ? await extractSite(website) : '';

    if (!offerText && !siteText) {
      const suggestions = fallbackSuggestions('', existing, allowedChannels, slots);
      return json({
        ok: true, icp: fallbackIcp(''), suggestions,
        avoid: [...NOISE_PHRASES].slice(0, 5), source: 'fallback',
        site_fetched: siteText.length > 0,
      });
    }

    if (!apiKey) {
      console.warn('[ai] OPENAI_API_KEY not set — serving heuristic suggestions.');
      const suggestions = fallbackSuggestions(offerText, existing, allowedChannels, slots);
      return json({
        ok: true, icp: fallbackIcp(offerText), suggestions,
        avoid: [...NOISE_PHRASES].slice(0, 5), source: 'fallback',
        site_fetched: siteText.length > 0,
      });
    }

    const channelNote = allowedChannels.length
      ? `Channels this workspace scans: ${allowedChannels.join(', ')}. Only suggest these.`
      : '';

    const prompt = [
      'You are a demand-generation strategist who specialises in finding the exact search phrases',
      'buyers use when they are actively evaluating software.',
      '',
      '## Product',
      offerText ? `Core offer: "${offerText}"` : '',
      siteText ? `From their website:\n${siteText}` : '',
      '',
      '## Workspace context',
      channelNote,
      `At most ${slots} keywords can be tracked, so rank strictly by expected lead value.`,
      `The sweep looks back ${lookbackHours} hours, so favour phrases people post about now.`,
      existing.size ? `Already tracked (do not repeat): ${[...existing].join(', ')}` : '',
      '',
      '## What makes a good keyword here',
      `- Strong: the phrasing a buyer uses while evaluating — e.g. "${INTENT_SIGNALS.slice(0, 6).join('", "')}".`,
      '- Weak: bare category nouns ("marketing software") — too broad, everyone matches.',
      '- Weak: top-of-funnel education ("what is a CRM") — nobody is buying yet.',
      '',
      '## Mix',
      `- 2 or 3 broad category phrases for reach.`,
      `- ${slots - 2 > 3 ? slots - 2 : 5} or more long-tail buying phrases ("alternative to X", "best X for Y", "X pricing").`,
      '',
      '## Output',
      'A JSON object, no prose, with exactly these keys:',
      '{',
      '  "icp": "one sentence naming who buys this and in what situation",',
      '  "keywords": [',
      '    {',
      '      "phrase": "lowercase, 1-4 words",',
      '      "intent": "high | medium | low",',
      '      "score": 0-97,',
      '      "channels": ["x","reddit","web","news"],',
      '      "why": "max 12 words on who searches this and why they are ready"',
      '    }',
      '  ],',
      '  "avoid": ["phrases that would pull in noise for this product"]',
      '}',
      '',
      `Order keywords.best first. Return at least ${Math.min(slots, 10)} keywords.`,
    ].filter(Boolean).join('\n');

    try {
      const text = await chat(
        apiKey,
        [
          {
            role: 'system',
            content:
              'You are a demand-generation strategist. You reply with a single valid JSON object and nothing else.',
          },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.75, maxTokens: 1600, jsonMode: true },
      );

      if (text) {
        const cleaned = text.split(FENCE + 'json').join('').split(FENCE).join('').trim();
        const parsed = JSON.parse(cleaned);
        const suggestions = shapeSuggestions(parsed?.keywords, allowedChannels, existing);
        if (suggestions.length > 0) {
          return json({
            ok: true,
            icp: String(parsed?.icp ?? '').slice(0, 220) || fallbackIcp(offerText),
            suggestions: suggestions.slice(0, slots),
            avoid: Array.isArray(parsed?.avoid)
              ? parsed.avoid.map((a: unknown) => String(a).toLowerCase().slice(0, 40)).slice(0, 6)
              : [],
            source: 'openai',
            site_fetched: siteText.length > 0,
          });
        }
      }
    } catch (err) {
      console.warn('[ai] keyword generation failed:', err);
    }

    const suggestions = fallbackSuggestions(offerText, existing, allowedChannels, slots);
    return json({
      ok: true, icp: fallbackIcp(offerText), suggestions,
      avoid: [...NOISE_PHRASES].slice(0, 5), source: 'fallback',
      site_fetched: siteText.length > 0,
    });
  }

  // ---- Outreach draft ----------------------------------------------------
  if (action === 'draft') {
    if (!apiKey) return json({ ok: true, draft: fallbackDraft(body?.post ?? {}, 'consultative'), source: 'fallback' });

    const post = body?.post ?? {};
    const tone = String(body?.tone ?? 'consultative');
    const postBody = String(post.body ?? '').slice(0, 1500);
    const keyword = post.matched_keyword || 'this topic';
    const firstName = post.author_name ? String(post.author_name).split(' ')[0] : 'there';

    const prompt = [
      'Write a high-converting, personalized outreach reply to this social lead.',
      '',
      'Lead Information:',
      '- Platform: ' + (post.platform ?? 'social'),
      '- Author: ' + (post.author_name || 'Prospect') + ' (' + (post.author_handle || '') + ')',
      '- Matched Keyword: "' + keyword + '"',
      '- Post Content: "' + postBody + '"',
      '',
      'Sender Context:',
      '- Sender Name: ' + (body?.userName || 'Echo User'),
      '- Product/Offer: "' + (body?.userOffer || 'High-intent lead monitoring and automation') + '"',
      '- Desired Tone: ' + tone + ' (' + (TONE_GUIDELINES[tone] || TONE_GUIDELINES.consultative) + ')',
      '',
      'Rules:',
      '1. Address the author by first name (' + firstName + ') if appropriate.',
      '2. Reference their specific problem or topic from their post so this is not generic spam.',
      '3. Keep it brief (2 to 4 sentences max).',
      '4. Include a low-friction call to action.',
      '5. Output ONLY the message text, without quotes, subject lines or placeholders.',
    ].join('\n');

    try {
      const text = await chat(
        apiKey,
        [
          {
            role: 'system',
            content:
              'You are an elite B2B sales development representative writing personalized social outreach.',
          },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.7, maxTokens: 350 },
      );
      if (text && text.length > 20) {
        return json({
          ok: true,
          draft: text.replace(/^["']|["']$/g, '').trim(),
          source: 'openai',
        });
      }
    } catch (err) {
      console.warn('[ai] draft generation failed:', err);
    }

    return json({ ok: true, draft: fallbackDraft(post, tone), source: 'fallback' });
  }

  // ---- Ideal customer profile ----------------------------------------------
  if (action === 'icp') {
    const website = String(body?.website ?? '').trim().slice(0, 300);
    const offer = String(body?.offer ?? '').trim().slice(0, 400);
    const note = String(body?.note ?? '').trim().slice(0, 200);

    // The form answers beyond website and offer. Kept as a loose object rather
    // than a schema, because these are chips the UI sends and new chips get
    // added without a migration; unknown keys are ignored rather than rejected.
    const answers = (body?.inputs ?? {}) as Record<string, unknown>;

    const regions = asStringList(answers.regions, 12);
    const sizes = asStringList(answers.sizes, 12);
    const pricePoint = str(answers.pricePoint, 60);
    const hypothesis = str(answers.whoBuys, 300);

    const pages = Array.isArray(body?.pages) ? body.pages : [];
    const { text: siteText, usedPages } = condensePages(pages);

    if (!offer && !siteText && !hypothesis) {
      return fail('Need at least a website, an offer, or a description of who buys it.', 400);
    }

    const prompt = [
      website ? `Website: ${website}` : '',
      offer ? `What they sell, in their words: ${offer}` : '',
      pricePoint ? `Price point: ${pricePoint}` : '',
      hypothesis ? `Who the user thinks buys it: ${hypothesis}` : '',
      regions.length ? `Regions they care about: ${regions.join(', ')}` : '',
      sizes.length ? `Company sizes they care about: ${sizes.join(', ')}` : '',
      note ? `They asked to adjust the previous one: ${note}` : '',
      siteText ? `\n\nPages read from their site\n\n---\n\n${siteText}\n\n---` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    // jsonMode plus a schema check, then one retry. A model that emits prose or a
    // half object is a normal outcome rather than an exception, and the retry
    // costs one call; giving up here would show the user a blank card for a
    // reason that has nothing to do with their product.
    // Checked here rather than left to fail inside chat(): without the guard a
    // missing key would cost two requests that both come back 401 before reaching
    // the same fallback below.
    if (!apiKey) {
      console.warn('[ai] OPENAI_API_KEY not set — building the ICP from the form answers.');
    }

    for (let attempt = 0; apiKey && attempt < 2; attempt++) {
      try {
        const text = await chat(
          apiKey,
          [
            { role: 'system', content: ICP_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          { temperature: 0.3, maxTokens: 1400, jsonMode: true },
        );

        const icp = text ? normaliseIcp(parseJsonLoose(text)) : null;

        if (icp) {
          return json({
            ok: true,
            icp,
            source: 'openai',
            pages_read: usedPages,
          });
        }

        console.warn(`[ai] icp attempt ${attempt + 1} produced no usable segment`);
      } catch (err) {
        console.warn('[ai] icp generation failed:', err);
      }
    }

    return json({
      ok: true,
      icp: fallbackIcpDocument({
        website,
        offer,
        regions,
        sizes,
        pricePoint,
        hypothesis,
        note,
      }),
      source: 'fallback',
      pages_read: usedPages,
    });
  }
  return fail('Unknown action');
});