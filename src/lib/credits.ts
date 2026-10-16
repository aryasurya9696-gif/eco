// ============================================================================
// Echo — client helpers for the credit meter
// ----------------------------------------------------------------------------
// Credits are the currency every metered provider call draws down. The prices
// live in public.billing_config under 'operation_pricing' so an admin can change
// them without a deploy; this module only mirrors the shape and the labels, and
// the server remains the authority for what a call actually costs.
//
// The distinction the UI must not blur: credits are what the customer spends,
// money is what we keep. A credit sold is not revenue until the search behind
// it has been delivered.
// ============================================================================

import type { PlanId } from './billing';

export interface CreditRate {
  creditsPerUsd: number;
}

export interface OperationPrice {
  credits: number;
  service_cost_usd: number;
  label?: string;
}

export interface BillingConfig {
  credit_rate?: CreditRate;
  operation_pricing?: Record<string, OperationPrice>;
  plan_grants?: Record<PlanId, number>;
  topup_packages?: TopUpPackage[];
}

export interface TopUpPackage {
  id: string;
  label: string;
  usd: number;
  bonus_credits: number;
}

export interface LedgerRow {
  id: number;
  delta: number;
  balance_after: number;
  kind: string;
  source: string;
  revenue_usd: number;
  service_cost_usd: number;
  note: string | null;
  created_at: string;
}

export interface PaymentRow {
  id: string;
  kind: string;
  status: string;
  gross_usd: number;
  fee_usd: number;
  net_usd: number;
  credits_granted: number;
  created_at: string;
}

/**
 * What a credit is worth in dollars at the current rate, and what one metered
 * call actually costs us. The gap between them is the margin on every call.
 */
export function creditValueUsd(creditsPerUsd: number): number {
  return creditsPerUsd > 0 ? 1 / creditsPerUsd : 0;
}

/** Margin on one metered operation, given the live conversion rate. */
export function marginForOperation(
  price: OperationPrice,
  creditsPerUsd: number,
): number | null {
  if (!creditsPerUsd) return null;
  const revenueUsd = price.credits / creditsPerUsd;
  if (revenueUsd <= 0) return null;
  return ((revenueUsd - price.service_cost_usd) / revenueUsd) * 100;
}

/** Credits a plan's monthly allowance buys, for the "you get this much" line. */
export function planAllowance(config: BillingConfig, plan: PlanId): number {
  return Number(config.plan_grants?.[plan] ?? 0);
}

/** Human label for a ledger kind. */
export const LEDGER_LABELS: Record<string, string> = {
  topup: 'Top-up',
  bonus: 'Bonus credits',
  subscription_grant: 'Plan allowance',
  usage: 'Usage',
  refund: 'Refund',
  adjustment: 'Adjustment',
  expiry: 'Expired',
};

export function ledgerLabel(row: Pick<LedgerRow, 'kind' | 'source'>): string {
  if (row.kind === 'usage') {
    const op = row.source.replace(/_/g, ' ');
    return op.charAt(0).toUpperCase() + op.slice(1);
  }
  return LEDGER_LABELS[row.kind] ?? row.kind;
}

/** Credits are integers to the user even though the column is numeric. */
export function formatCredits(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatUsd(value: number | null | undefined, digits = 2): string {
  const n = Number(value ?? 0);
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
