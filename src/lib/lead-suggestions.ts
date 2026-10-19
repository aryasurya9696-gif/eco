// ============================================================================
// Lead search suggestions
// ----------------------------------------------------------------------------
// Local, instant and free: role autocomplete, "also try" related roles,
// industry keyword suggestions, and a small parser that turns a sentence into
// filters when the AI function is unavailable. Nothing here calls an API.
// ============================================================================

import { COUNTRIES } from '../components/leads/countries';
import type { LeadQueryFilters } from './ai';

export interface RoleSuggestion {
  title: string;
  group: string;
}

/** Common B2B job titles, grouped the way buyers think about seniority. */
const ROLE_GROUPS: Record<string, string[]> = {
  'Founders & owners': ['Founder', 'Co-Founder', 'Owner', 'Managing Partner', 'Partner', 'Managing Director', 'President'],
  'C-suite': [
    'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CRO', 'CPO', 'CIO', 'CISO', 'Chief Revenue Officer', 'Chief Marketing Officer',
    'Chief Technology Officer', 'Chief Product Officer', 'Chief People Officer', 'Chief Operating Officer',
  ],
  'VP & heads': [
    'VP Sales', 'VP Marketing', 'VP Engineering', 'VP Product', 'VP Operations', 'VP Finance', 'VP Business Development',
    'VP Customer Success', 'VP People', 'Head of Sales', 'Head of Marketing', 'Head of Growth', 'Head of Engineering',
    'Head of Product', 'Head of Operations', 'Head of Partnerships', 'Head of Customer Success', 'Head of Talent',
    'Head of HR', 'Head of Design', 'Head of Data', 'Head of Procurement', 'Head of IT',
  ],
  Directors: [
    'Sales Director', 'Marketing Director', 'Director of Engineering', 'Director of Product', 'Director of Operations',
    'Finance Director', 'IT Director', 'HR Director', 'Director of Business Development', 'Creative Director',
    'Director of Partnerships', 'Director of Customer Success', 'Procurement Director',
  ],
  Managers: [
    'Sales Manager', 'Marketing Manager', 'Engineering Manager', 'Product Manager', 'Operations Manager',
    'Account Manager', 'Project Manager', 'HR Manager', 'Recruitment Manager', 'Growth Manager',
    'Partnerships Manager', 'Customer Success Manager', 'Office Manager', 'Procurement Manager', 'IT Manager',
    'Brand Manager', 'Content Manager', 'Community Manager', 'Finance Manager',
  ],
  'Individual contributors': [
    'Account Executive', 'Business Development Representative', 'Sales Development Representative',
    'Software Engineer', 'Data Scientist', 'Product Designer', 'Recruiter', 'Talent Acquisition', 'Consultant',
    'Growth Marketer', 'Copywriter', 'Data Analyst', 'DevOps Engineer', 'Solutions Engineer',
  ],
};

export const ROLES: RoleSuggestion[] = Object.entries(ROLE_GROUPS).flatMap(([group, titles]) =>
  titles.map((title) => ({ title, group })),
);

/** Alternative titles for the same buyer. Shown as "Also try" after a pick. */
const RELATED: Record<string, string[]> = {
  founder: ['Co-Founder', 'CEO', 'Owner', 'Managing Director'],
  'co-founder': ['Founder', 'CEO', 'CTO'],
  ceo: ['Founder', 'Managing Director', 'President', 'Owner'],
  owner: ['Founder', 'CEO', 'Managing Director'],
  cto: ['VP Engineering', 'Head of Engineering', 'Co-Founder'],
  cmo: ['VP Marketing', 'Head of Marketing', 'Marketing Director'],
  cfo: ['VP Finance', 'Finance Director', 'Head of Finance'],
  coo: ['VP Operations', 'Head of Operations', 'Operations Manager'],
  cro: ['VP Sales', 'Head of Sales', 'Chief Revenue Officer'],
  'vp sales': ['Head of Sales', 'Sales Director', 'CRO'],
  'head of sales': ['VP Sales', 'Sales Director', 'Sales Manager'],
  'vp marketing': ['Head of Marketing', 'CMO', 'Marketing Director'],
  'head of marketing': ['VP Marketing', 'Marketing Director', 'Head of Growth'],
  'head of growth': ['Growth Manager', 'Head of Marketing', 'VP Marketing'],
  'vp engineering': ['CTO', 'Head of Engineering', 'Director of Engineering'],
  'engineering manager': ['Director of Engineering', 'Head of Engineering'],
  'product manager': ['Head of Product', 'Director of Product', 'VP Product'],
  'hr manager': ['Head of HR', 'HR Director', 'Chief People Officer'],
  recruiter: ['Talent Acquisition', 'Recruitment Manager', 'Head of Talent'],
  'marketing manager': ['Marketing Director', 'Head of Marketing', 'Growth Manager'],
  'sales manager': ['Sales Director', 'Head of Sales', 'Account Executive'],
};

/** Industry / topic keywords that narrow a search well. */
export const KEYWORD_SUGGESTIONS = [
  'SaaS', 'B2B', 'Fintech', 'AI', 'Machine learning', 'E-commerce', 'D2C', 'Marketplace', 'Healthtech', 'Healthcare',
  'Edtech', 'Proptech', 'Real estate', 'Insurance', 'Insurtech', 'Banking', 'Payments', 'Crypto', 'Web3',
  'Cybersecurity', 'Cloud', 'DevTools', 'Data analytics', 'Martech', 'Adtech', 'HR tech', 'Recruiting', 'Legal tech',
  'Logistics', 'Supply chain', 'Manufacturing', 'Automotive', 'Electric vehicles', 'Climate tech', 'Energy',
  'Construction', 'Retail', 'Fashion', 'Beauty', 'Food & beverage', 'Restaurants', 'Hospitality', 'Travel',
  'Gaming', 'Media', 'Publishing', 'Marketing agency', 'Digital agency', 'Consulting', 'IT services', 'Outsourcing',
  'Biotech', 'Pharma', 'Medical devices', 'Telecom', 'Agritech', 'Nonprofit', 'Government', 'Education', 'Startup',
];

/** Search examples for the empty state; each one fills the filters. */
export const EXAMPLE_SEARCHES = [
  'Founders of SaaS startups in Bangalore',
  'VP Sales at fintech companies in London',
  'Marketing managers at e-commerce brands in the US',
  'CTOs of healthtech companies in Germany',
  'Owners of restaurants in Dubai',
];

function score(text: string, q: string): number {
  const t = text.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.split(/[\s-]+/).some((w) => w.startsWith(q))) return 2;
  if (t.includes(q)) return 3;
  return -1;
}

/** Best-matching roles for what the user has typed so far. */
export function suggestRoles(query: string, limit = 8): RoleSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return ROLES.filter((r) => ['Founder', 'CEO', 'VP Sales', 'Head of Marketing', 'CTO', 'Owner', 'Marketing Manager', 'HR Manager'].includes(r.title));
  return ROLES.map((r) => ({ r, s: score(r.title, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.r.title.length - b.r.title.length)
    .slice(0, limit)
    .map((x) => x.r);
}

/** "Also try" titles for a chosen role; empty when we know none. */
export function relatedRoles(title: string): string[] {
  const key = title.trim().toLowerCase();
  if (RELATED[key]) return RELATED[key];
  const group = ROLES.find((r) => r.title.toLowerCase() === key)?.group;
  if (!group) return [];
  return ROLES.filter((r) => r.group === group && r.title.toLowerCase() !== key)
    .slice(0, 3)
    .map((r) => r.title);
}

/** Keyword suggestions matching the input, excluding ones already chosen. */
export function suggestKeywords(query: string, chosen: string[], limit = 10): string[] {
  const q = query.trim().toLowerCase();
  const taken = new Set(chosen.map((c) => c.toLowerCase()));
  return KEYWORD_SUGGESTIONS.filter((k) => !taken.has(k.toLowerCase()))
    .map((k) => ({ k, s: q ? score(k, q) : 0 }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .slice(0, limit)
    .map((x) => x.k);
}

// ---------------------------------------------------------------------------
// Local sentence parser (fallback for the AI "describe your customer" box)
// ---------------------------------------------------------------------------

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US', 'u.s.': 'US', america: 'US', uk: 'GB', 'u.k.': 'GB', britain: 'GB', england: 'GB', uae: 'AE', emirates: 'AE',
};

/** Same rules as the ai function's fallback, so both paths agree. */
export function parseLeadQueryLocally(text: string): LeadQueryFilters {
  const lower = ` ${text.toLowerCase()} `;
  const titles = [...ROLES].sort((a, b) => b.title.length - a.title.length);
  const title = titles.find((r) => lower.includes(` ${r.title.toLowerCase()}`))?.title ?? '';
  const keywords = KEYWORD_SUGGESTIONS.filter((k) =>
    new RegExp(`[^a-z]${k.toLowerCase().replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}s?[^a-z]`).test(lower),
  ).slice(0, 5);

  const countries = new Map<string, string>(Object.entries(COUNTRY_ALIASES));
  COUNTRIES.forEach((c) => countries.set(c.name.toLowerCase(), c.code));
  let country = '';
  for (const [name, code] of countries) {
    if (name.length > 2 && lower.includes(` ${name}`)) {
      country = code;
      break;
    }
  }
  const inMatch = text.match(/\bin\s+(?:the\s+)?([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,2})/);
  let location = inMatch ? inMatch[1] : '';
  const asCountry = countries.get(location.toLowerCase());
  if (location && asCountry) {
    country = country || asCountry;
    location = '';
  }
  const company = text.match(/\b([a-z0-9-]+\.(?:com|io|co|ai|so|in|net|org|app|dev))\b/i)?.[1] ?? '';
  return { title, keywords, country, location, company };
}
