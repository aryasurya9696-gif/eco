// ============================================================================
// BillingTab
// ----------------------------------------------------------------------------
// The customer's wallet: what they have, what it costs, and what they have
// bought and spent. Internal provider costs are never shown or fetched here.
//
// No admin controls here and none reachable from this tab. Prices are shown, not
// editable — changing one is a deliberate act done outside the app, so there is
// no way to accidentally reprice a live customer by clicking something.
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

  /**
   * The package picked on the landing page, carried over in sessionStorage.
   *
   * Someone who chose "Buy 500 credits" on the pricing section should not arrive
   * here to be asked to choose again.
   *
   * Read in a lazy state initialiser rather than an effect: it is a one-time read
   * of an external value, which is what initialisation is for, and an effect would
   * cost an extra render pass to arrive at the same place.
   *
   * The clearing is a separate effect that sets no state. Doing both in the
   * initialiser would be impure, and React re-runs initialisers under StrictMode,
   * so a second run would find the key already gone and lose the highlight.
   */
  const [intendedCode] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('echo_intended_package');
    } catch {
      // Storage unavailable. The tab works fine without the hint.
      return null;
    }
  });

  useEffect(() => {
    // Consumed once. A later visit should not keep flagging a package they have
    // since ignored or already bought.
    try {
      if (sessionStorage.getItem('echo_intended_package')) {
        sessionStorage.removeItem('echo_intended_package');
      }
    } catch {
      // Nothing to do; the hint simply persists until the tab is closed.
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    // Settled, not all. These are three independent concerns, and one failing
    // query used to blank the page — including the balance, which had already
    // arrived fine. A customer should still see their credits because a payments
    // history query timed out.
    const [pkgRes, balRes, histRes] = await Promise.allSettled([
      fetchPackages(),
      fetchBalance(),
      fetchHistory(),
    ]);

    const failures: string[] = [];

    if (pkgRes.status === 'fulfilled') {
      setPackages(pkgRes.value);
    } else {
      failures.push('packages');
    }

    if (balRes.status === 'fulfilled' && balRes.value?.wallet) {
      setWallet(balRes.value.wallet);
      setSweep(balRes.value.sweep);
    } else {
      failures.push('balance');
    }

    if (histRes.status === 'fulfilled') {
      setHistory(histRes.value);
    } else {
      failures.push('history');
    }

    if (failures.length > 0) {
      setError(
        failures.length === 3
          ? 'Could not load your billing details.'
          : `Could not load: ${failures.join(', ')}. The rest is up to date.`,
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Returning from checkout (`/?billing=returned#dashboard/billing`). The
  // webhook may not have landed yet, so this polls rather than reading the
  // wallet once and giving up. Older links carried the flag inside the hash
  // (`#dashboard/billing?billing=returned`), so that form is accepted too.
  const [returnedFromCheckout] = useState<boolean>(() => {
    const fromSearch = new URLSearchParams(window.location.search).get('billing');
    const hashQuery = window.location.hash.split('?')[1] ?? '';
    const fromHash = new URLSearchParams(hashQuery).get('billing');
    return fromSearch === 'returned' || fromHash === 'returned';
  });

  useEffect(() => {
    if (!returnedFromCheckout) return;
    // Strip the flag so a refresh or a bookmark does not replay the notice.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('billing');
      const [hashPath, hashQuery = ''] = url.hash.split('?');
      const hashParams = new URLSearchParams(hashQuery);
      hashParams.delete('billing');
      const rest = hashParams.toString();
      url.hash = rest ? `${hashPath}?${rest}` : hashPath;
      window.history.replaceState(window.history.state, '', url.toString());
    } catch {
      // Cosmetic only.
    }
  }, [returnedFromCheckout]);

  useEffect(() => {
    if (!returnedFromCheckout) return;
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
  }, [load, returnedFromCheckout]);

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

          {/* Lifetime figures.
              "Bought" counts only credits that came through a settled payment.
              The alternative was lifetime_granted, which includes the welcome
              grant — so a workspace that has never paid anything would be told
              it had bought 200 credits, which the bank statement would
              contradict. Free credits are shown as their own figure rather than
              quietly folded into a purchase total.
              "Searches run" is a real count from the server, not the length of
              the recent list, which is capped at 50 for rendering and would
              therefore read 50 to exactly the people with the most usage. */}
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[#eeeeea] text-center">
            <div className="bg-white p-3">
              <dt className="text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">Bought</dt>
              <dd className="text-sm font-mono text-[#141414] mt-1">
                {formatCredits(wallet?.credits_purchased ?? 0)}
              </dd>
            </div>
            <div className="bg-white p-3">
              <dt className="text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">Free</dt>
              <dd className="text-sm font-mono text-[#141414] mt-1">
                {formatCredits(wallet?.credits_free ?? 0)}
              </dd>
            </div>
            <div className="bg-white p-3">
              <dt className="text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">Spent</dt>
              <dd className="text-sm font-mono text-[#141414] mt-1">
                {formatCredits(wallet?.lifetime_consumed ?? 0)}
              </dd>
            </div>
            <div className="bg-white p-3">
              <dt className="text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">
                Searches run
              </dt>
              <dd className="text-sm font-mono text-[#141414] mt-1">
                {formatCredits(wallet?.search_count ?? 0)}
              </dd>
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
                {/* channels is guarded rather than assumed. The actionQuote
                    response and the fallbacks built from a partial fetch can
                    both produce a sweep object without it, and .map on undefined
                    threw inside render — which took down the whole billing tab,
                    including the balance that had loaded fine. */}
                {(sweep.channels ?? []).map((c) => CHANNEL_LABEL[c] ?? c).join(', ')} ·{' '}
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
          {packages.map((p) => {
            const isIntended = intendedCode === p.code;
            return (
            <div
              key={p.code}
              className={`border bg-white p-4 flex flex-col transition-colors ${
                isIntended
                  ? 'border-[#141414] ring-1 ring-[#141414]'
                  : 'border-[#e3e3de] hover:border-[#141414]'
              }`}
            >
              {isIntended && (
                <p className="text-[9px] font-mono uppercase tracking-wider text-[#141414] mb-2 -mt-1">
                  You picked this one
                </p>
              )}
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-mono font-medium text-[#141414]">
                  {/* Not rounded to whole dollars. Every seeded package happens to be a round
                    number, so the rounding is invisible today — and then a $24.99
                    package shows as "$25" here and "$24.99" in the payments
                    table twenty lines below, which is two prices for one
                    product on one screen. */}
                    {formatUsd(p.gross_usd)}
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

              {/*
                No per-credit price here, deliberately.

                Every package costs the same $0.05 a credit, so the line repeated
                the same number three times and distinguished nothing. A customer
                choosing between these options is comparing the totals, which are
                already the largest thing on each card. The unit price is still in
                the data — it is what the credit value next to the balance is
                derived from, and the billing page does not need to restate it
                where it cannot inform a choice.
              */}

              <button
                onClick={() => void buy(p.code)}
                disabled={busyCode !== null}
                className={`mt-4 w-full py-2.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                  isIntended
                    ? 'bg-[#141414] text-white hover:bg-[#2a2a2a]'
                    : 'border border-[#141414] text-[#141414] hover:bg-[#141414] hover:text-white'
                }`}
              >
                {busyCode === p.code ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <>Buy {formatCredits(p.total_credits)} credits <ExternalLink className="w-3 h-3" /></>
                )}
              </button>
            </div>
            );
          })}
        </div>
        <p className="text-[10px] text-[#8a8a86] font-mono mt-2">
          Credits do not expire and there is no subscription. What you buy is what
          you keep until you spend it.
        </p>
      </section>

        {/*
          A per-search log used to live here, showing what each call cost us.

          Removed on request. Every column was either internal - our provider
          cost, which the customer cannot act on and did not ask about - or a
          restatement of the credit balance the wallet card above already shows.
          It was also the only section rendering values straight out of the usage
          rows, so it was the one thing here that could go wrong quietly.

          The billing API still returns usage, so this changes what the page shows
          rather than what the system records. The numbers stay in api_usage and in
          the reconciliation views.
        */}

      {/* ---- Payments ----------------------------------------------------- */}
      <section>
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-3">
          Payments
        </h2>
        {history.payments.length === 0 ? (
          <p className="text-xs text-[#8a8a86] py-4">No payments yet.</p>
        ) : (
          <div className="border border-[#e3e3de] bg-white">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#eeeeea] text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">
                  <th className="text-left font-normal px-3 py-2.5">Date</th>
                  <th className="text-left font-normal px-3 py-2.5">Package</th>
                  <th className="text-right font-normal px-3 py-2.5">Amount</th>
                  <th className="text-right font-normal px-3 py-2.5 hidden sm:table-cell">
                    Credits
                  </th>
                  <th className="text-left font-normal px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {history.payments.map((p) => (
                  <tr key={p.id} className="border-b border-[#f5f5f2] last:border-0">
                    <td className="px-3 py-2.5 text-[#8a8a86] truncate">
                      {formatDate(p.created_at)}
                    </td>
                    <td className="px-3 py-2.5 text-[#141414] truncate">{p.package_code}</td>
                    <td className="px-3 py-2.5 text-right text-[#141414]">
                      {formatUsd(p.gross_usd)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[#141414] hidden sm:table-cell">
                      {p.credits_granted > 0 ? formatCredits(p.credits_granted) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
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
          <div className="border border-[#e3e3de] bg-white">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#eeeeea] text-[9px] font-mono uppercase tracking-wider text-[#8a8a86]">
                  <th className="text-left font-normal px-3 py-2.5">When</th>
                  <th className="text-left font-normal px-3 py-2.5">Type</th>
                  <th className="text-right font-normal px-3 py-2.5">Change</th>
                  <th className="text-right font-normal px-3 py-2.5">Balance</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {history.ledger.map((l) => (
                  <tr key={l.id} className="border-b border-[#f5f5f2] last:border-0">
                    <td className="px-3 py-2.5 text-[#8a8a86] truncate">
                      {formatDateTime(l.created_at)}
                    </td>
                    <td className="px-3 py-2.5 text-[#141414] truncate">{ledgerLabel(l.kind, l.note)}</td>
                    <td
                      className={`px-3 py-2.5 text-right ${
                        l.delta >= 0 ? 'text-emerald-700' : 'text-[#141414]'
                      }`}
                    >
                      {l.delta >= 0 ? '+' : ''}
                      {formatCredits(l.delta)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[#8a8a86]">
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

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { label: string; cls: string }> = {
    succeeded: { label: 'Paid', cls: 'text-emerald-700' },
    pending: { label: 'Processing', cls: 'text-amber-700' },
    created: { label: 'Started', cls: 'text-[#8a8a86]' },
    failed: { label: 'Failed', cls: 'text-[#8a2a2a]' },
    refunded: { label: 'Refunded', cls: 'text-[#8a2a2a]' },
    partially_refunded: { label: 'Partly refunded', cls: 'text-[#8a2a2a]' },
    disputed: { label: 'Disputed', cls: 'text-[#8a2a2a]' },
    review: { label: 'Under review', cls: 'text-amber-700' },
  };
  const m = map[status] ?? { label: status, cls: 'text-[#8a8a86]' };
  return <span className={`text-[10px] ${m.cls}`}>{m.label}</span>;
};