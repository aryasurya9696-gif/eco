// ============================================================================
// Billing client
// ----------------------------------------------------------------------------
// Reads the wallet, the packages on offer, and the histories behind them.
//
// No prices live here. Packages and per-operation charges are fetched from the
// server on every load, because a hardcoded price on the client is a price that
// will eventually disagree with the one charged — and the disagreement is always
// discovered by a customer rather than by us.
//
// Formatting lives here too, so the credit balance reads the same way in the
// sidebar, the wallet card and the usage table.
// ============================================================================

import { invokeFunction } from './api';

export interface Wallet {
  balance: number;
  reserved: number;
  /** What can actually be spent: balance minus anything held for a live sweep. */
  available: number;
  lifetime_granted: number;
  lifetime_consumed: number;
  recognised_revenue_usd: number;
  service_cost_usd: number;
}

export interface SweepQuote {
  keywords: number;
  channels: string[];
  credits: number;
  affordable: boolean;
  shortfall: number;
}

export interface Package {
  code: string;
  display_name: string;
  gross_usd: number;
  credits: number;
  bonus_credits: number;
  currency: string;
  total_credits: number;
  per_credit_usd: number;
}

export type UsageOutcome = 'success' | 'free' | 'upstream_failed' | 'not_billed' | 'uncertain';

export interface LedgerEntry {
  id: number;
  delta: number;
  balance_after: number;
  kind: string;
  revenue_usd: number;
  service_cost_usd: number;
  note: string | null;
  created_at: string;
}

export interface UsageEntry {
  id: number;
  operation: string;
  provider_cost_usd: number;
  credits_charged: number;
  revenue_usd: number;
  outcome: UsageOutcome;
  calls: number;
  created_at: string;
}

export interface PaymentEntry {
  id: string;
  package_code: string;
  gross_usd: number;
  currency: string;
  credits_granted: number;
  status: 'created' | 'pending' | 'succeeded' | 'failed' | 'refunded';
  created_at: string;
  settled_at: string | null;
}

export interface History {
  ledger: LedgerEntry[];
  payments: PaymentEntry[];
  usage: UsageEntry[];
}

interface BalanceResponse {
  ok: boolean;
  wallet: Wallet;
  sweep: SweepQuote;
}

interface PackagesResponse {
  ok: boolean;
  packages: Package[];
}

interface HistoryResponse extends History {
  ok: boolean;
}

interface CheckoutResponse {
  ok: boolean;
  order_id?: string;
  checkout_url?: string | null;
  error?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function fetchBalance(): Promise<BalanceResponse> {
  return invokeFunction<BalanceResponse>('billing', { action: 'balance' });
}

export async function fetchPackages(): Promise<Package[]> {
  const res = await invokeFunction<PackagesResponse>('billing', { action: 'packages' });
  return res.packages ?? [];
}

export async function fetchHistory(): Promise<History> {
  const res = await invokeFunction<HistoryResponse>('billing', { action: 'history' });
  return { ledger: res.ledger ?? [], payments: res.payments ?? [], usage: res.usage ?? [] };
}

export async function startCheckout(packageCode: string): Promise<CheckoutResponse> {
  return invokeFunction<CheckoutResponse>('billing', {
    action: 'checkout',
    packageCode,
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Credits are whole numbers in practice but stay numeric, so never floor one. */
export function formatCredits(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function formatUsd(n: number, opts: { decimals?: number } = {}): string {
  const d = opts.decimals ?? 2;
  // Sub-cent costs are the normal case here — a single search costs around
  // $0.001 — so eight decimals by default keeps the number meaningful instead
  // of rendering as $0.00.
  const decimals = opts.decimals ?? (n !== 0 && Math.abs(n) < 0.01 ? 8 : d);
  return `$${n.toFixed(decimals)}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const OPERATION_LABEL: Record<string, string> = {
  'treg.twitter.search': 'Twitter',
  'treg.reddit.search': 'Reddit',
  'treg.web.search': 'Web',
  'treg.news.search': 'Press & news',
};

export function operationLabel(operation: string): string {
  return OPERATION_LABEL[operation] ?? operation;
}

/**
 * What a search is worth, derived from the packages rather than assumed.
 *
 * Used only for the "worth $" line next to a balance. It is explicitly not used
 * to charge anything — the price that matters is the one in pricing_config, and
 * mixing the two is how a display figure starts contradicting an invoice.
 */
export function creditsToUsd(credits: number, packages: Package[]): number {
  if (packages.length === 0) return 0;
  const cheapest = packages.reduce((min, p) => (p.per_credit_usd < min.per_credit_usd ? p : min));
  return credits * cheapest.per_credit_usd;
}

export function ledgerLabel(kind: string): string {
  switch (kind) {
    case 'topup': return 'Top-up';
    case 'grant': return 'Credits added';
    case 'bonus': return 'Bonus';
    case 'usage': return 'Search';
    case 'refund': return 'Refund';
    case 'reversal': return 'Reversed';
    case 'expiry': return 'Expired';
    default: return 'Adjustment';
  }
}