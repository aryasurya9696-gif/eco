// ============================================================================
// Echo — Subscription plans, limits and the cost model behind them
// ----------------------------------------------------------------------------
// This module is the client-side source of truth for plan limits. The server
// keeps its own copy in public.plan_keyword_limit() /
// public.plan_max_channels() — keep the two in step when changing a limit.
//
// LIMITS ARE DERIVED FROM COST, NOT GUESSED
// Echo buys search on treg at the provider's own rate, billed per successful
// call, so what a workspace costs to serve is fully determined by how many
// keywords it tracks, how many channels it scans, and how often it sweeps.
// Every limit below is set where the worst-case month still clears a 90% gross
// margin, so no combination of settings a user can actually reach turns a
// subscription into a loss.
//
// Rates are treg's published prices (GET /catalog/endpoints/<id> ->
// endpoint.cost.usd), mirrored in the edge functions' TREG_COST_USD table.
// ============================================================================

export type PlanId = 'starter' | 'pro' | 'scale';
export type BillingInterval = 'month' | 'year';
export type ChannelId = 'twitter' | 'reddit' | 'google' | 'news';

/**
 * USD per successful provider call, worst case per channel.
 *
 * Reddit is the sum of both links in its chain: tikhub answers first, and when
 * it serves successfully but finds nothing the chain falls through to
 * scrapecreators, so a single keyword can cost both rates on the same sweep.
 * News is genuinely free, which is why it is always worth enabling.
 */
export const CHANNEL_COST_USD: Record<ChannelId, number> = {
  news: 0,
  google: 0.00015,
  twitter: 0.00075,
  reddit: 0.001 + 0.00188,
};

export const CHANNEL_LABEL: Record<ChannelId, string> = {
  twitter: 'X (Twitter)',
  reddit: 'Reddit',
  google: 'Web discussions',
  news: 'Press & news',
};

export interface SubscriptionPlan {
  id: PlanId;
  name: string;
  monthlyPrice: number;
  annualPricePerMonth: number;
  annualTotal: number;
  keywordLimit: number;
  /** Shortest interval the plan allows between sweeps. */
  sweepCadenceHours: number;
  aiDraftsEnabled: boolean;
  maxChannels: number;
  channels: string[];
  popular?: boolean;
  desc: string;
  features: string[];
}

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    monthlyPrice: 29,
    annualPricePerMonth: 24,
    annualTotal: 288,
    keywordLimit: 8,
    sweepCadenceHours: 24,
    aiDraftsEnabled: true,
    maxChannels: 3,
    channels: ['X (Twitter)', 'Reddit', 'Web discussions', 'Press & news'],
    desc: 'For a solo founder who needs to catch buyers without living in the feed.',
    features: [
      '8 tracked keywords',
      '1 sweep a day at your chosen hour',
      '3 of the 4 channels',
      'AI keyword auto-suggest',
      'AI outreach drafts',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    monthlyPrice: 79,
    annualPricePerMonth: 65,
    annualTotal: 780,
    keywordLimit: 20,
    sweepCadenceHours: 12,
    aiDraftsEnabled: true,
    maxChannels: 4,
    channels: ['X (Twitter)', 'Reddit', 'Web discussions', 'Press & news'],
    popular: true,
    desc: 'For a sales team running outbound on more than one surface.',
    features: [
      '20 tracked keywords',
      '2 sweeps a day',
      'All 4 channels',
      'AI keyword auto-suggest',
      'AI outreach drafts',
      'CSV & JSON lead export',
    ],
  },
  {
    id: 'scale',
    name: 'Scale',
    monthlyPrice: 199,
    annualPricePerMonth: 165,
    annualTotal: 1980,
    keywordLimit: 40,
    sweepCadenceHours: 6,
    aiDraftsEnabled: true,
    maxChannels: 4,
    channels: ['X (Twitter)', 'Reddit', 'Web discussions', 'Press & news'],
    desc: 'For agencies and outbound pods where coverage is the product.',
    features: [
      '40 tracked keywords',
      '4 sweeps a day',
      'All 4 channels',
      'AI keyword auto-suggest',
      'AI outreach drafts',
      'Unlimited CSV & JSON exports',
    ],
  },
];

export const getPlan = (id: PlanId): SubscriptionPlan =>
  SUBSCRIPTION_PLANS.find((p) => p.id === id) ?? SUBSCRIPTION_PLANS[0];

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

/**
 * What serving this plan at its own limits costs per month.
 *
 * Assumes the workspace picks the most expensive channels its plan allows and
 * that every Reddit call takes the fallback, which is the only figure worth
 * planning against. A lighter workspace costs strictly less.
 */
export function estimateMonthlyCostUsd(plan: SubscriptionPlan): number {
  // The cap keeps the N most expensive channels, because that is the ceiling a
  // user can actually push their bill to.
  const cappedChannels = (Object.keys(CHANNEL_COST_USD) as ChannelId[])
    .sort((a, b) => CHANNEL_COST_USD[b] - CHANNEL_COST_USD[a])
    .slice(0, plan.maxChannels);

  const perKeywordPerSweep = cappedChannels.reduce(
    (sum, ch) => sum + CHANNEL_COST_USD[ch],
    0,
  );
  const sweepsPerDay = 24 / plan.sweepCadenceHours;
  return perKeywordPerSweep * plan.keywordLimit * sweepsPerDay * 30;
}

/** Gross margin at full usage, 0..1. */
export function estimateGrossMargin(plan: SubscriptionPlan): number {
  return 1 - estimateMonthlyCostUsd(plan) / plan.monthlyPrice;
}

/** What the workspace is actually paying per dollar of search it consumes. */
export function costCoverageRatio(plan: SubscriptionPlan): number {
  return plan.monthlyPrice / estimateMonthlyCostUsd(plan);
}

/** Formats a dollar figure for the plan cards. Sub-cent amounts keep 2 dp. */
export function formatUsd(value: number): string {
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}
