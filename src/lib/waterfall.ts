import type { MonitoredPost } from '../types';

export interface WaterfallTier {
  name: string;
  endpoint: string;
  pricePerHitUsd: number;
  missesFree: boolean;
  color: string;
}

export const WATERFALL_PROVIDERS: WaterfallTier[] = [
  { name: 'QuickEnrich', endpoint: 'quickenrich.people.email.find', pricePerHitUsd: 0.0048, missesFree: true, color: '#2f7d5b' },
  { name: 'TryKitt', endpoint: 'trykitt.people.email.find', pricePerHitUsd: 0.0050, missesFree: true, color: '#2f6aa8' },
  { name: 'AI Ark', endpoint: 'aiark.people.email.find', pricePerHitUsd: 0.0053, missesFree: true, color: '#6a4fa3' },
  { name: 'Tomba', endpoint: 'tomba.people.email.find', pricePerHitUsd: 0.0089, missesFree: true, color: '#a65a2e' },
  { name: 'LeadsForge', endpoint: 'leadsforge.people.email.find', pricePerHitUsd: 0.0245, missesFree: true, color: '#8a6d16' },
];

export interface EnrichedLeadResult {
  contact_name: string;
  company_name: string;
  company_domain: string;
  verified_email: string;
  email_status: 'verified' | 'catch_all' | 'not_found';
  enrichment_provider: string;
  linkedin_url: string;
  cost_usd: number;
  waterfall_log: {
    tier: string;
    status: 'hit' | 'miss' | 'skipped';
    cost_usd: number;
    latency_ms: number;
  }[];
}

/**
 * Derives a clean professional domain from post author or text
 */
function deriveCompanyAndDomain(post: MonitoredPost): { company: string; domain: string } {
  // If post has a raw domain or channel info
  const text = `${post.author_name || ''} ${post.author_handle || ''} ${post.body || ''}`.toLowerCase();
  
  // Extract potential domain if mentioned in post
  const domainMatch = text.match(/([a-z0-9-]+\.(?:com|io|co|ai|org|net|app|dev))/i);
  if (domainMatch && !['twitter.com', 'x.com', 'reddit.com', 'google.com'].includes(domainMatch[1].toLowerCase())) {
    const rawDom = domainMatch[1].toLowerCase();
    const cleanComp = rawDom.split('.')[0].replace(/[^a-z0-9]/g, ' ');
    return {
      company: cleanComp.charAt(0).toUpperCase() + cleanComp.slice(1) + ' Inc.',
      domain: rawDom,
    };
  }

  // Derive from clean author name / handle
  let seed = (post.author_name || post.author_handle || 'Founder').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (seed.length < 3) seed = 'growth';

  const tlds = ['.io', '.co', '.ai', '.com'];
  const tld = tlds[Math.abs(hashString(seed)) % tlds.length];
  const companyName = (post.author_name || 'Founder').replace(/@/g, '').trim();

  return {
    company: `${companyName} Ventures`,
    domain: `${seed}ventures${tld}`,
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/**
 * Runs the waterfall enrichment simulation according to Cascade PRD
 */
export async function executeWaterfallEnrichment(
  post: MonitoredPost,
  _userId?: string
): Promise<EnrichedLeadResult> {
  // Simulate network latency (200-500ms) for realistic UX
  await new Promise((resolve) => setTimeout(resolve, 400));

  const { company, domain } = deriveCompanyAndDomain(post);

  // Generate clean name
  let name = post.author_name || 'Alex Morgan';
  if (name.startsWith('@') || name.toLowerCase().includes('reddit') || name.toLowerCase().includes('user')) {
    const names = ['David Vance', 'Sarah Jenkins', 'Marcus Chen', 'Elena Rostova', 'Michael Brooks', 'Priya Sharma'];
    name = names[Math.abs(hashString(post.id)) % names.length];
  }

  const cleanFirst = name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
  const cleanLast = (name.split(' ')[1] || 'founder').toLowerCase().replace(/[^a-z]/g, '');
  const emailUsername = `${cleanFirst}.${cleanLast}`;
  const verifiedEmail = `${emailUsername}@${domain}`;

  // Deterministically select winning waterfall tier (usually Tier 1 QuickEnrich or Tier 2 Kitt)
  const tierIndex = Math.abs(hashString(post.id + 'tier')) % 3; // 0 (QuickEnrich), 1 (TryKitt), or 2 (AI Ark)
  const winningTier = WATERFALL_PROVIDERS[tierIndex];

  const waterfallLog = WATERFALL_PROVIDERS.map((p, idx) => {
    if (idx < tierIndex) {
      return {
        tier: p.name,
        status: 'miss' as const,
        cost_usd: 0, // misses are free in Cascade!
        latency_ms: 120 + idx * 40,
      };
    } else if (idx === tierIndex) {
      return {
        tier: p.name,
        status: 'hit' as const,
        cost_usd: p.pricePerHitUsd,
        latency_ms: 190,
      };
    } else {
      return {
        tier: p.name,
        status: 'skipped' as const,
        cost_usd: 0,
        latency_ms: 0,
      };
    }
  });

  return {
    contact_name: name,
    company_name: company,
    company_domain: domain,
    verified_email: verifiedEmail,
    email_status: 'verified',
    enrichment_provider: winningTier.name,
    linkedin_url: `https://www.linkedin.com/in/${cleanFirst}-${cleanLast}-${Math.floor(100 + Math.random() * 899)}/`,
    cost_usd: winningTier.pricePerHitUsd,
    waterfall_log: waterfallLog,
  };
}
