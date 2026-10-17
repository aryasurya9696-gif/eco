// ============================================================================
// BillingTab
// ----------------------------------------------------------------------------
// The customer's wallet: what they have, what it costs, what they have bought,
// and what their searches have actually cost us.
//
// No admin controls here and none reachable from this tab. Prices are shown, not
// editable — changing one is a deliberate act done outside the app, so there is
// no way to accidentally reprice a live customer by clicking something.
//
// The provider cost shown against a search is the figure treg reported for that
// call, not an estimate. That is what makes the margin on this screen real.
import React, { useCallback, useEffect, useState } from 'react';
import {
  fetchBalance,
  fetchHistory,
  fetchPackages,
  startCheckout,
  formatCredits,
  formatDate,
  formatDateTime,
  formatUsd,
  creditsToUsd,
  operationLabel,
  ledgerLabel,
  type History,
  type Package,
  type SweepQuote,
  type Wallet,
} from '../../lib/billing';
import {
  Wallet as WalletIcon,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  Loader2,
  X,
} from 'lucide-react';

const CHANNEL_LABEL: Record<string, string> = {
  twitter: 'X',
  reddit: 'Reddit',
  google: 'Web',
  news: 'News',
};

export const BillingTab: React.FC = () => {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [sweep, setSweep] = useState<SweepQuote | null>(null);
  const [packages, setPackages] = useState<Package[]>([]);
  const [history, setHistory] = useState<History>({ ledger: [], payments: [], usage: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Packages first: the balance's "worth $" line is derived from them, and
      // fetching them together would mean rendering a balance with no price for
      // a frame.
      const [pkgs, bal, hist] = await Promise.all([
        fetchPackages(),
        fetchBalance(),
        fetchHistory(),
      ]);
      setPackages(pkgs);
      setWallet(bal.wallet);
      setSweep(bal.sweep);
      setHistory(hist);
    } catch (err) {
      setError((err as Error)?.message ?? 'Could not load your billing details.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Returning from checkout. The webhook may not have landed yet, so this polls
  // rather than reading the wallet once and giving up.
  useEffect(() => {
    const returning = new URLSearchParams(window.location.search).get('billing');
    if (returning !== 'returned') return;
    const tries = [2000, 4000, 7000];
    const timers = tries.map((delay, i) =>
      setTimeout(() => {
        void load();
        if (i === tries.length - 1) {
          setNotice('Payment is processing. Credits appear as soon as it clears — usually within a minute.');
        }
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [load]);

  const buy = async (code: string) => {
    setBusyCode(code);
    setError(null);
    setNotice(null);
    try {
      const res = await startCheckout(code);
      if (res.ok && res.checkout_url) {
        // assign() rather than assigning href: this is a navigation away from
        // the app to the provider's hosted page, not a mutation of app state.
        window.location.assign(res.checkout_url);
        return;
      }
      // Not switched on yet, or the order could not be created. Say which,
      // rather than a generic failure the customer cannot act on.
      setError(res.message ?? res.error ?? 'Checkout could not be started.');
    } catch (err) {
      setError((err as Error)?.message ?? 'Checkout could not be started.');
    } finally {
      setBusyCode(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-[#8a8a86]">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    );
  }

  const worthUsd = wallet ? creditsToUsd(wallet.available, packages) : 0;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <header>
        <h1 className="text-lg font-medium text-[#141414]">Billing</h1>
        <p className="text-xs text-[#8a8a86] font-mono mt-1">
          Credits are prepaid and spent down as searches run. They do not expire.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-[#fdf2f2] border border-[#f0c4c4] text-xs text-[#8a2a2a]">
          <X className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 p-3 bg-[#f6f6f4] border border-[#e3e3de] text-xs text-[#4a4a47]">
          <RefreshCw className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* ---- Wallet ------------------------------------------------------- */}
      <section>
        <div className="border border-[#e3e3de] bg-white">
          <div className="p-5 border-b border-[#eeeeea] flex items-start justify-between gap-4">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] flex items-center gap-1.5">
                <WalletIcon className="w-3 h-3" /> Credit balance
              </span>
              <div className="flex items-baseline gap-2 mt-2">
                <span className="text-3xl font-mono font-medium text-[#141414]">
                  {formatCredits(wallet?.available ?? 0)}
                </span>
                <span className="text-xs text-[#8a8a86] font-mono">credits</span>
              </div>
              <p className="text-[11px] text-[#8a8a86] font-mono mt-1">
                worth {formatUsd(worthUsd)}
                {wallet && wallet.reserved > 0 && (
                  <> · {formatCredits(wallet.reserved)} held for a running sweep</>
                )}
              </p>
            </div>

            <button
              onClick={() => void load()}
              className="p-1.5 text-[#8a8a86] hover:text-[#141414] hover:bg-[#f6f6f4] border border-transparent hover:border-[#deded8] transition-colors cursor-pointer"
              title="Refresh"
              aria-label="Refresh billing"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Lifetime figures. Shown because a balance alone does not tell
              someone whether the product is paying for itself. */}
          <dl className="grid grid-cols-3 divide-x divide-[#eeeeea] text-center">
            <div className="p-3">
              <dt className="text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">Bought</dt>
              <dd className="text-sm font-mono text-[#141414] mt-1">
                {formatCredits(wallet?.lifetime_granted ?? 0)}
              </dd>
            </div>
            <div className="p-3">
              <dt className="text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">Spent</dt>
              <dd className="text-sm font-mono text-[#141414] mt-1">
                {formatCredits(wallet?.lifetime_consumed ?? 0)}
              </dd>
            </div>
            <div className="p-3">
              <dt className="text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">Searches run</dt>
              <dd className="text-sm font-mono text-[#141414] mt-1">{history.usage.length}</dd>
            </div>
          </dl>
        </div>

        {/* The sweep warning. Shown before it happens rather than as a failed
            search, because a sweep that silently stops looks like a provider
            outage and gets debugged in the wrong place. */}
        {sweep && !sweep.affordable && (
          <div className="mt-3 flex items-start gap-2 p-3 bg-[#fffaf0] border border-[#e8d9b0] text-xs text-[#6b5320]">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium">
                Not enough credits for your next sweep
              </p>
              <p className="font-mono text-[11px] mt-0.5">
                {formatCredits(sweep.credits)} needed for {sweep.keywords}{' '}
                keyword{sweep.keywords === 1 ? '' : 's'} across{' '}
                {sweep.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(', ')} ·{' '}
                {formatCredits(sweep.shortfall)} short
              </p>
            </div>
          </div>
        )}
      </section>

      {/* ---- Top up ------------------------------------------------------- */}
      <section>
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-3">
          Buy credits
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {packages.map((p) => (
            <div
              key={p.code}
              className="border border-[#e3e3de] bg-white p-4 flex flex-col hover:border-[#141414] transition-colors"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-mono font-medium text-[#141414]">
                  {formatUsd(p.gross_usd, { decimals: 0 })}
                </span>
                {p.bonus_credits > 0 && (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 bg-[#141414] text-white uppercase">
                    +{formatCredits(p.bonus_credits)} bonus
                  </span>
                )}
              </div>

              <p className="text-sm font-mono text-[#141414] mt-1.5">
                {formatCredits(p.total_credits)} credits
              </p>
              <p className="text-[10px] text-[#8a8a86] font-mono mt-0.5">
                {formatUsd(p.per_credit_usd)} per credit
              </p>

              <button
                onClick={() => void buy(p.code)}
                disabled={busyCode !== null}
                className="mt-4 w-full py-2 bg-[#141414] text-white text-xs hover:bg-[#2a2a2a] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center gap-1.5"
              >
                {busyCode === p.code ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <>Top up <ExternalLink className="w-3 h-3" /></>
                )}
              </button>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-[#8a8a86] font-mono mt-2">
          Credits do not expire and there is no subscription. What you buy is what
          you keep until you spend it.
        </p>
      </section>

      {/* ---- Recent searches ---------------------------------------------- */}
      <section>
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-3">
          Recent searches
        </h2>
        {history.usage.length === 0 ? (
          <p className="text-xs text-[#8a8a86] py-4">No searches yet.</p>
        ) : (
          <div className="border border-[#e3e3de] bg-white overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#eeeeea] text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">
                  <th className="text-left font-normal px-3 py-2">When</th>
                  <th className="text-left font-normal px-3 py-2">Channel</th>
                  <th className="text-right font-normal px-3 py-2">Credits</th>
                  <th className="text-right font-normal px-3 py-2">Cost to us</th>
                  <th className="text-left font-normal px-3 py-2 w-24">Result</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {history.usage.map((u) => (
                  <tr key={u.id} className="border-b border-[#f5f5f2] last:border-0">
                    <td className="px-3 py-2 text-[#8a8a86] whitespace-nowrap">
                      {formatDateTime(u.created_at)}
                    </td>
                    <td className="px-3 py-2 text-[#141414] whitespace-nowrap">
                      {operationLabel(u.operation)}
                    </td>
                    <td className="px-3 py-2 text-right text-[#141414]">
                      {u.credits_charged > 0 ? formatCredits(u.credits_charged) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-[#8a8a86]">
                      {formatUsd(u.provider_cost_usd)}
                    </td>
                    <td className="px-3 py-2">
                      <OutcomeBadge outcome={u.outcome} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[10px] text-[#8a8a86] font-mono mt-2">
          Cost to us is what the search provider reported for that call, not an
          estimate. A search that found nothing, or that the provider charged
          nothing for, is not billed.
        </p>
      </section>

      {/* ---- Payments ----------------------------------------------------- */}
      <section>
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-3">
          Payments
        </h2>
        {history.payments.length === 0 ? (
          <p className="text-xs text-[#8a8a86] py-4">No payments yet.</p>
        ) : (
          <div className="border border-[#e3e3de] bg-white overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#eeeeea] text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">
                  <th className="text-left font-normal px-3 py-2">Date</th>
                  <th className="text-left font-normal px-3 py-2">Package</th>
                  <th className="text-right font-normal px-3 py-2">Amount</th>
                  <th className="text-right font-normal px-3 py-2">Credits</th>
                  <th className="text-left font-normal px-3 py-2 w-28">Status</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {history.payments.map((p) => (
                  <tr key={p.id} className="border-b border-[#f5f5f2] last:border-0">
                    <td className="px-3 py-2 text-[#8a8a86] whitespace-nowrap">
                      {formatDate(p.created_at)}
                    </td>
                    <td className="px-3 py-2 text-[#141414]">{p.package_code}</td>
                    <td className="px-3 py-2 text-right text-[#141414]">
                      {formatUsd(p.gross_usd)}
                    </td>
                    <td className="px-3 py-2 text-right text-[#141414]">
                      {p.credits_granted > 0 ? formatCredits(p.credits_granted) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- Balance history ---------------------------------------------- */}
      {history.ledger.length > 0 && (
        <section>
          <h2 className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-3">
            Balance history
          </h2>
          <div className="border border-[#e3e3de] bg-white overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#eeeeea] text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">
                  <th className="text-left font-normal px-3 py-2">When</th>
                  <th className="text-left font-normal px-3 py-2">Type</th>
                  <th className="text-right font-normal px-3 py-2">Change</th>
                  <th className="text-right font-normal px-3 py-2">Balance</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {history.ledger.map((l) => (
                  <tr key={l.id} className="border-b border-[#f5f5f2] last:border-0">
                    <td className="px-3 py-2 text-[#8a8a86] whitespace-nowrap">
                      {formatDateTime(l.created_at)}
                    </td>
                    <td className="px-3 py-2 text-[#141414]">{ledgerLabel(l.kind)}</td>
                    <td
                      className={`px-3 py-2 text-right ${
                        l.delta >= 0 ? 'text-emerald-700' : 'text-[#141414]'
                      }`}
                    >
                      {l.delta >= 0 ? '+' : ''}
                      {formatCredits(l.delta)}
                    </td>
                    <td className="px-3 py-2 text-right text-[#8a8a86]">
                      {formatCredits(l.balance_after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};

const OutcomeBadge: React.FC<{ outcome: string }> = ({ outcome }) => {
  const map: Record<string, { label: string; cls: string }> = {
    success: { label: 'Found', cls: 'text-emerald-700' },
    free: { label: 'No charge', cls: 'text-[#8a8a86]' },
    upstream_failed: { label: 'Provider failed', cls: 'text-amber-700' },
    not_billed: { label: 'Not billed', cls: 'text-[#8a8a86]' },
    uncertain: { label: 'Pending', cls: 'text-amber-700' },
  };
  const m = map[outcome] ?? { label: outcome, cls: 'text-[#8a8a86]' };
  return <span className={`text-[10px] ${m.cls}`}>{m.label}</span>;
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { label: string; cls: string }> = {
    succeeded: { label: 'Paid', cls: 'text-emerald-700' },
    pending: { label: 'Processing', cls: 'text-amber-700' },
    created: { label: 'Started', cls: 'text-[#8a8a86]' },
    failed: { label: 'Failed', cls: 'text-[#8a2a2a]' },
    refunded: { label: 'Refunded', cls: 'text-[#8a2a2a]' },
  };
  const m = map[status] ?? { label: status, cls: 'text-[#8a8a86]' };
  return <span className={`text-[10px] ${m.cls}`}>{m.label}</span>;
};