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
// Request body: { action: 'keywords' | 'draft' | 'lead-filters', ...payload }
//   action=keywords -> { offerText, website?, existingKeywords?, channels?,
//                        slots?, lookbackHours? }
//                     -> { ok, icp, suggestions[], avoid[], source }
//   action=draft    -> { post, tone, userOffer?, userName? }
//                     -> { ok, draft, source }
//   action=lead-filters -> { description }
//                     -> { ok, filters: { title, keywords[], country, location, company }, source }
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


// ---------------------------------------------------------------------------
// Lead search filters (action=lead-filters)
// ---------------------------------------------------------------------------

interface LeadFilters {
  title: string;
  keywords: string[];
  country: string;
  location: string;
  company: string;
}

const ISO_CODES = (
  'AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL ' +
  'CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FR GA GB GD GE GH GI GL GM GN GQ GR GT GY HK HN HR ' +
  'HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MK ' +
  'ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ OM PA PE PG PH PK PL PR PS PT PY QA RO RS RU RW SA SC SD ' +
  'SE SG SI SK SL SN SO SR SV SY SZ TD TG TH TJ TM TN TR TT TW TZ UA UG US UY UZ VE VN YE ZA ZM ZW'
).split(' ');

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US', 'u.s.': 'US', america: 'US', 'united states': 'US', us: 'US',
  uk: 'GB', 'u.k.': 'GB', britain: 'GB', england: 'GB', 'united kingdom': 'GB',
  uae: 'AE', emirates: 'AE', india: 'IN', bharat: 'IN',
};

let countryNames: Map<string, string> | null = null;
function countryLookup(): Map<string, string> {
  if (countryNames) return countryNames;
  countryNames = new Map(Object.entries(COUNTRY_ALIASES));
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    for (const code of ISO_CODES) {
      const name = names.of(code);
      if (name && name !== code) countryNames.set(name.toLowerCase(), code);
    }
  } catch {
    // Aliases only.
  }
  return countryNames;
}

const TITLE_WORDS = [
  'co-founder', 'cofounder', 'founder', 'ceo', 'cto', 'cfo', 'coo', 'cmo', 'cro', 'owner', 'president', 'partner',
  'managing director', 'vp sales', 'vp marketing', 'vp engineering', 'head of sales', 'head of marketing',
  'head of growth', 'head of engineering', 'head of product', 'sales director', 'marketing director',
  'engineering manager', 'product manager', 'sales manager', 'marketing manager', 'recruiter', 'hr manager',
  'account executive', 'business development', 'director', 'manager', 'engineer', 'consultant',
];

const KEYWORD_WORDS = [
  'saas', 'fintech', 'ai', 'artificial intelligence', 'ecommerce', 'e-commerce', 'healthtech', 'healthcare', 'edtech',
  'real estate', 'insurance', 'logistics', 'marketing agency', 'agency', 'cybersecurity', 'crypto', 'web3', 'b2b',
  'manufacturing', 'retail', 'hospitality', 'legal', 'consulting', 'construction', 'automotive', 'gaming', 'media',
  'biotech', 'climate', 'hr tech', 'martech', 'devtools', 'startup', 'restaurant', 'd2c',
];

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Ceo|Cto|Cfo|Coo|Cmo|Cro|Vp|Hr)\b/g, (m) => m.toUpperCase());
}

/** Bounds and validates whatever the model (or the heuristic) produced. */
function cleanLeadFilters(raw: any): LeadFilters {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
  let country = str(raw?.country, 40).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) country = countryLookup().get(country.toLowerCase()) ?? '';
  if (country && !ISO_CODES.includes(country)) country = '';
  let location = str(raw?.location, 80);
  // The country is its own filter; repeating it as the location ANDs twice.
  if (location && countryLookup().get(location.toLowerCase()) === country) location = '';
  const keywords = Array.isArray(raw?.keywords)
    ? [...new Set(raw.keywords.map((k: unknown) => str(k, 40).toLowerCase()).filter(Boolean))].slice(0, 5) as string[]
    : [];
  return {
    title: str(raw?.title, 80),
    keywords,
    country,
    location,
    company: str(raw?.company, 80),
  };
}

/** No-AI fallback: pulls a known title, keywords, country, city and domain out of the text. */
function heuristicLeadFilters(text: string): LeadFilters {
  const lower = ` ${text.toLowerCase()} `;
  const title = TITLE_WORDS.find((t) => lower.includes(` ${t}`)) ?? '';
  // Whole words, singular or plural ("restaurant" matches "restaurants").
  const keywords = KEYWORD_WORDS.filter((k) => new RegExp(`[^a-z]${k.replace(/[-]/g, '\\-')}s?[^a-z]`).test(lower)).slice(0, 5);
  let country = '';
  for (const [name, code] of countryLookup()) {
    if (name.length > 2 && lower.includes(` ${name}`)) {
      country = code;
      break;
    }
  }
  const inMatch = text.match(/\bin\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,2})/);
  let location = inMatch ? inMatch[1] : '';
  if (location && countryLookup().has(location.toLowerCase())) {
    country = country || countryLookup().get(location.toLowerCase())!;
    location = '';
  }
  const domain = text.match(/\b([a-z0-9-]+\.(?:com|io|co|ai|so|in|net|org|app|dev))\b/i)?.[1] ?? '';
  return cleanLeadFilters({
    // List entries are singular and matched as prefixes, so "founders" -> "Founder".
    title: title ? titleCase(title) : '',
    keywords,
    country,
    location,
    company: domain,
  });
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

  // ---- Lead search filters from a sentence -------------------------------
  // "Founders of SaaS startups in Bangalore" -> { title, keywords, country,
  // location, company }. Everything returned is validated, so a model that
  // invents a field or a non-ISO country cannot reach the leads search.
  if (action === 'lead-filters') {
    const description = String(body?.description ?? '').trim().slice(0, 300);
    if (description.length < 3) return fail('Describe who you want to find.');

    const fallback = heuristicLeadFilters(description);
    if (!apiKey) return json({ ok: true, filters: fallback, source: 'fallback' });

    try {
      const text = await chat(
        apiKey,
        [
          {
            role: 'system',
            content:
              'You turn a B2B prospecting request into search filters. Reply with one JSON object only: ' +
              '{"title": string, "keywords": string[], "country": string, "location": string, "company": string}. ' +
              'title = one job title (e.g. "Founder", "VP Sales"), empty if none. keywords = up to 5 short industry or ' +
              'topic terms (e.g. "saas", "fintech"), no job titles, no locations. country = ISO 3166-1 alpha-2 code or "". ' +
              'location = a city, state or region in plain text or "" (never the country itself). company = a company ' +
              'name or domain only if one is named, else "". Never invent details that are not in the request.',
          },
          { role: 'user', content: description },
        ],
        { temperature: 0, maxTokens: 200, jsonMode: true },
      );
      if (text) {
        const parsed = JSON.parse(text.split(FENCE + 'json').join('').split(FENCE).join('').trim());
        const filters = cleanLeadFilters(parsed);
        if (filters.title || filters.keywords.length || filters.country || filters.location || filters.company) {
          return json({ ok: true, filters, source: 'openai' });
        }
      }
    } catch (err) {
      console.warn('[ai] lead-filters failed:', err);
    }
    return json({ ok: true, filters: fallback, source: 'fallback' });
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

  return fail('Unknown action');
});
