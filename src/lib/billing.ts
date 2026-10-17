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
  /** Credits that came through a settled payment. Excludes free grants. */
  credits_purchased: number;
  /** Credits that were given away — the welcome grant, or any future promo. */
  credits_free: number;
  /**
   * Every search ever run, counted on the server.
   *
   * Not derivable from the recent-searches list, which the API caps at 50 rows
   * for rendering. Counting that array would read 50 to anyone past 50 searches,
   * which is exactly backwards: the heaviest users are the ones checking.
   */
  search_count: number;
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

/**
 * Money for display.
 *
 * A single search costs around $0.001, so a plain two-decimal format renders
 * every cost as $0.00 and the whole column is meaningless. But going to eight
 * decimals to compensate is worse: $0.00100000 is noise pretending to be
 * precision, and the trailing zeros are storage format, not information.
 *
 * So: enough decimals to show the first meaningful digit, and no more. A reddit
 * call reads $0.001, a web search $0.00015, and a card payment $10.00. Zero
 * stays $0.00 rather than becoming $0, because this is a currency column.
 */
export function formatUsd(n: number, opts: { decimals?: number } = {}): string {
  if (opts.decimals !== undefined) return `$${n.toFixed(opts.decimals)}`;

  const abs = Math.abs(n);
  if (abs === 0) return '$0.00';
  if (abs >= 0.01) return `$${n.toFixed(2)}`;

  // Smallest non-zero digit decides how many decimals are worth showing.
  const magnitude = Math.floor(Math.log10(abs));
  const decimals = Math.min(Math.max(-magnitude + 2, 2), 6);

  // toFixed pads to the requested precision, which is how $0.001 arrives as
  // $0.00100. Those zeros are storage format, not precision, so they go — while
  // still keeping two decimals, because a currency column showing $25.5 rather
  // than $25.50 reads as a typo.
  let s = n.toFixed(decimals);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) {
      s += '00';
    } else {
      const frac = s.split('.')[1].length;
      if (frac < 2) s += '0'.repeat(2 - frac);
    }
  }
  return `$${s}`;
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