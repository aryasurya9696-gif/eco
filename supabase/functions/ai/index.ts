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
//   action=keywords -> { offerText, website? }                  -> { keywords: string[] }
//   action=draft    -> { post, tone, userOffer?, userName? }   -> { draft: string }
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
const MAX_TOKENS = 350;
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

async function chat(
  apiKey: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  temperature: number,
): Promise<string | null> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: MAX_TOKENS }),
  });

  if (!res.ok) {
    console.warn('[ai] OpenAI error:', res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

/** Heuristic fallback — used whenever OpenAI is unavailable. */
function fallbackKeywords(clean: string): string[] {
  const lower = clean.toLowerCase();
  if (lower.includes('agent') || lower.includes('ai')) {
    return ['autonomous ai agents', 'ai lead qualification', 'ai sales workflow', 'agentic outbound', 'crm ai enrichment'];
  }
  if (lower.includes('sales') || lower.includes('lead') || lower.includes('outbound')) {
    return ['b2b lead gen', 'outbound pipeline', 'sales automation', 'buyer intent signal', 'cold outreach alternative'];
  }
  if (lower.includes('dev') || lower.includes('api') || lower.includes('code')) {
    return ['developer api', 'backend workflow', 'serverless automation', 'automation webhook', 'social scraping api'];
  }
  return ['ai agents', 'b2b lead gen', 'sales automation', 'outbound pipeline', 'crm workflow', 'intent data', 'social listening'];
}

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
  if (!apiKey) return fail('AI features are not configured on this deployment.', 503);

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

    if (!offerText && !website) {
      return json({ ok: true, keywords: fallbackKeywords(''), source: 'fallback' });
    }

    const prompt = [
      'You are a B2B growth marketing and intent-data specialist.',
      "Given the company's core offer and website below, generate 6 to 8 high-intent search keywords or phrases.",
      'These phrases represent what potential customers search for on X (Twitter), Reddit, LinkedIn or the web when looking for a solution this company provides.',
      '',
      'Company Core Offer: "' + offerText + '"',
      'Website: "' + website + '"',
      '',
      'Rules:',
      '1. Focus on buyer intent keywords (tools, problems people ask for recommendations on, software categories).',
      '2. Keep each phrase between 1 and 4 words.',
      '3. Output ONLY a valid JSON array of strings in lowercase, no markdown or explanation.',
    ].join('\n');

    try {
      const text = await chat(
        apiKey,
        [
          {
            role: 'system',
            content: 'You generate high-converting buyer-intent keywords. Output a valid JSON array only.',
          },
          { role: 'user', content: prompt },
        ],
        0.6,
      );
      if (text) {
        const cleaned = text
          .split(FENCE + 'json')
          .join('')
          .split(FENCE)
          .join('')
          .trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const keywords = parsed
            .map((k: unknown) => String(k).trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 8);
          return json({ ok: true, keywords, source: 'openai' });
        }
      }
    } catch (err) {
      console.warn('[ai] keyword generation failed:', err);
    }

    return json({ ok: true, keywords: fallbackKeywords(offerText), source: 'fallback' });
  }

  // ---- Outreach draft ----------------------------------------------------
  if (action === 'draft') {
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
        0.7,
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