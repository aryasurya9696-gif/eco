/**
 * OpenAI Client for Echo AI Features
 * Powers:
 * 1. Semantic Buyer-Intent Keyword Suggestions
 * 2. Hyper-personalized AI Outreach Drafts
 */
import type { MonitoredPost } from '../types';

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Call OpenAI Chat Completion API with gpt-4o-mini
 */
async function callOpenAiChat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, temperature: number = 0.7): Promise<string | null> {
  const apiKey = OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature,
        max_tokens: 350,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn('[AI] OpenAI error response:', errText);
      return null;
    }

    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[AI] OpenAI request failed:', err);
    return null;
  }
}

/**
 * AI Keyword Suggester: Generates high-intent search phrases from user's Core Offer & Website
 */
export async function generateAiKeywordsFromOffer(
  offerText: string,
  website?: string
): Promise<string[]> {
  const cleanOffer = offerText?.trim() || '';
  if (!cleanOffer && !website) {
    return [
      'ai agents',
      'b2b lead gen',
      'sales automation',
      'outbound pipeline',
      'social listening',
      'buyer intent signal',
    ];
  }

  const prompt = `You are a B2B growth marketing and intent-data specialist.
Given the company's core offer and website below, generate 6 to 8 high-intent search keywords or phrases.
These phrases represent what potential customers search for on Twitter (X), Reddit, LinkedIn, or Google when looking for a solution that this company provides.

Company Core Offer: "${cleanOffer}"
Website: "${website || ''}"

Rules:
1. Focus on buyer intent keywords (e.g. tools, problems people ask for recommendations on, software categories).
2. Keep each phrase between 1 to 4 words.
3. Output ONLY a valid JSON array of strings in lowercase, with no markdown, backticks, or explanation.
Example output format: ["b2b sales automation", "lead qualification agent", "intent data tool", "outbound pipeline", "cold email alternative"]`;

  try {
    const responseText = await callOpenAiChat([
      { role: 'system', content: 'You generate high-converting buyer-intent keywords. Output valid JSON array only.' },
      { role: 'user', content: prompt },
    ], 0.6);

    if (responseText) {
      // Clean possible markdown code fences
      const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((k) => String(k).trim().toLowerCase()).slice(0, 8);
      }
    }
  } catch (err) {
    console.warn('[AI] Failed parsing OpenAI keywords, falling back to heuristic:', err);
  }

  // Heuristic Fallback
  return fallbackKeywordSuggestions(cleanOffer);
}

/**
 * AI Outreach Drafter: Drafts personalized replies to leads tailored to their post and tone
 */
export async function generateAiOutreachDraft(
  post: MonitoredPost,
  tone: 'professional' | 'casual' | 'consultative' | 'direct',
  userOffer?: string,
  userName?: string
): Promise<string> {
  const author = post.author_name ? post.author_name.split(' ')[0] : 'there';
  const postBody = post.body || '';
  const keyword = post.matched_keyword || 'this topic';

  const toneGuidelines: Record<string, string> = {
    consultative: 'Warm, advisory, helpful, and insightful. Offer genuine benchmark advice without a hard pitch.',
    direct: 'Concise, value-focused, and inviting. Highlight immediate relevancy and suggest a quick 5-min intro.',
    casual: 'Friendly, peer-to-peer founder tone, conversational, zero corporate jargon.',
    professional: 'Polite, articulate, executive-level, respectful of their time.',
  };

  const prompt = `Write a high-converting, personalized outreach reply to this social lead.

Lead Information:
- Platform: ${post.platform}
- Author: ${post.author_name || 'Prospect'} (${post.author_handle || ''})
- Matched Keyword: "${keyword}"
- Post Content: "${postBody}"

Sender Context:
- Sender Name: ${userName || 'Echo User'}
- Product/Offer: "${userOffer || 'High-intent lead monitoring and automation'}"
- Desired Tone: ${tone} (${toneGuidelines[tone] || toneGuidelines.consultative})

Rules:
1. Address the author by first name (${author}) if appropriate.
2. Directly reference their specific problem or topic from their post to prove this is not generic spam.
3. Keep it brief (2 to 4 sentences max).
4. Include a low-friction call-to-action (e.g. sharing a quick comparison, benchmark notes, or a 5-min chat).
5. Output ONLY the response message text, without quotes, subject lines, or placeholders like "[Your Name]".`;

  try {
    const responseText = await callOpenAiChat([
      { role: 'system', content: 'You are an elite B2B sales development representative writing personalized social outreach.' },
      { role: 'user', content: prompt },
    ], 0.7);

    if (responseText && responseText.length > 20) {
      return responseText.replace(/^["']|["']$/g, '').trim();
    }
  } catch (err) {
    console.warn('[AI] OpenAI draft generation failed, using template:', err);
  }

  // Fallback Template
  return fallbackAiDraft(post, tone);
}

/**
 * Heuristic fallback for keywords if AI fails or key is missing
 */
function fallbackKeywordSuggestions(clean: string): string[] {
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
  return [
    'ai agents',
    'b2b lead gen',
    'sales automation',
    'outbound pipeline',
    'crm workflow',
    'intent data',
    'social listening',
  ];
}

/**
 * Heuristic fallback for draft if AI fails or key is missing
 */
function fallbackAiDraft(
  post: MonitoredPost,
  tone: 'professional' | 'casual' | 'consultative' | 'direct'
): string {
  const author = post.author_name ? post.author_name.split(' ')[0] : 'there';
  const keyword = post.matched_keyword;

  switch (tone) {
    case 'casual':
      return `Hey ${author}, saw your post regarding ${keyword}. We actually tackled this exact problem recently. Would love to share our benchmark notes if you're open to a quick comparison!`;
    case 'consultative':
      return `Hi ${author}, your observation about ${keyword} is spot-on. Many teams struggle with this transition. We put together a brief workflow analysis on how to optimize this without bloatware — happy to share the breakdown if helpful!`;
    case 'direct':
      return `Hi ${author}, noticed your requirement for ${keyword}. Echo monitors these exact intent signals automatically. Are you available for a 5-minute walkthrough this Thursday at 2pm?`;
    case 'professional':
    default:
      return `Hello ${author}, I came across your post about ${keyword}. We specialize in solving this challenge with streamlined automation. I would welcome the opportunity to connect and exchange thoughts on your current architecture.`;
  }
}
