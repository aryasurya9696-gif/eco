// ============================================================================
// Echo — Subscription plans and limits
// ----------------------------------------------------------------------------
// This module is the single source of truth for plan limits on the client.
// The server keeps its own copy in public.plan_keyword_limit() — keep the two
// in sync when changing a limit.
// ============================================================================

export type PlanId = 'starter' | 'pro' | 'scale';
export type BillingInterval = 'month' | 'year';

export interface SubscriptionPlan {
  id: PlanId;
  name: string;
  monthlyPrice: number;
  annualPricePerMonth: number;
  annualTotal: number;
  keywordLimit: number;
  sweepCadence: string;
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
    keywordLimit: 5,
    sweepCadence: '24h',
    aiDraftsEnabled: false,
    maxChannels: 2,
    channels: ['X (Twitter)', 'Web Discussions'],
    desc: 'Ideal for solo founders monitoring core brand mentions.',
    features: [
      'Up to 5 tracked keywords',
      'Daily 24h sweep cadence',
      '2 monitored channels',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    monthlyPrice: 79,
    annualPricePerMonth: 65,
    annualTotal: 780,
    keywordLimit: 10,
    sweepCadence: '12h',
    aiDraftsEnabled: true,
    maxChannels: 5,
    channels: ['X (Twitter)', 'Reddit', 'Web Discussions', 'News'],
    popular: true,
    desc: 'For high-growth B2B sales teams and outbound agencies.',
    features: [
      'Up to 10 tracked keywords',
      'Accelerated 12h sweep radar',
      'All 5 social & web channels',
      'AI outreach pitch drafter',
      'AI keyword auto-suggest',
      'CSV & JSON lead export',
    ],
  },
  {
    id: 'scale',
    name: 'Scale',
    monthlyPrice: 199,
    annualPricePerMonth: 165,
    annualTotal: 1980,
    keywordLimit: 25,
    sweepCadence: '6h',
    aiDraftsEnabled: true,
    maxChannels: 5,
    channels: ['All channels + custom feeds'],
    desc: 'Deep market intelligence and high-volume lead pipelines.',
    features: [
      'Up to 25 tracked keywords',
      'Real-time 6h accelerated radar',
      'All channels',
      'Unlimited CSV & JSON exports',
      'AI keyword auto-suggest + pitch drafter',
      'Dedicated account rep',
    ],
  },
];

export const getPlan = (id: PlanId): SubscriptionPlan =>
  SUBSCRIPTION_PLANS.find((p) => p.id === id) ?? SUBSCRIPTION_PLANS[0];