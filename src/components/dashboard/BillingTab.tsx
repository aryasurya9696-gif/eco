import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useEcho } from '../../context/EchoContext';
import { SUBSCRIPTION_PLANS, getPlan } from '../../lib/billing';
import {
  formatCredits,
  formatUsd,
  ledgerLabel,
  creditValueUsd,
  type BillingConfig,
  type LedgerRow,
  type TopUpPackage,
} from '../../lib/credits';
import { invokeFunction } from '../../lib/api';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Coins } from 'lucide-react';

interface PricingResponse {
  ok: boolean;
  config?: BillingConfig;
}
interface BalanceResponse {
  ok: boolean;
  balance?: number;
  error?: string;
}
interface HistoryResponse {
  ok: boolean;
  ledger?: LedgerRow[];
}
interface CheckoutResponse {
  ok: boolean;
  checkoutUrl?: string;
  error?: string;
}

// ---------------------------------------------------------------------------

const card = 'bg-white border border-[#e3e3de]';
const stat = 'px-5 py-4';

const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: React.ReactNode }> = ({
  label,
  value,
  hint,
}) => (
  <div className={stat}>
    <p className="text-[10px] font-mono uppercase tracking-wide text-[#8a8a86]">{label}</p>
    <p className="text-base font-bold text-[#141414] mt-1 tabular-nums">{value}</p>
    {hint && <p className="text-[11px] font-mono text-[#8a8a86] mt-0.5">{hint}</p>}
  </div>
);

export const BillingTab: React.FC = () => {
  const {
    subscriptionPlan,
    subscriptionStatus,
    subscriptionRenewsAt,
    changeSubscriptionPlan,
    addToast,
  } = useEcho();

  const [interval, setBillingInterval] = useState<'month' | 'year'>('month');
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [pendingTopUp, setPendingTopUp] = useState<string | null>(null);

  const [config, setConfig] = useState<BillingConfig | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);

  const creditsPerUsd = Number(config?.credit_rate?.creditsPerUsd ?? 20);
  const packages = useMemo<TopUpPackage[]>(() => config?.topup_packages ?? [], [config]);
  const allowance = Number(config?.plan_grants?.[subscriptionPlan] ?? 0);
  const plan = getPlan(subscriptionPlan);

  /**
   * The calendar month is read once per mount rather than during render, so the
   * figure cannot shift underneath the page on an unrelated re-render. It is
   * refreshed whenever the ledger is reloaded.
   */
  const [currentMonth, setCurrentMonth] = useState<string>(() =>
    new Date().toISOString().slice(0, 7),
  );

  const load = useCallback(async () => {
    try {
      const pricing = await invokeFunction<PricingResponse>('billing', { action: 'pricing' });
      if (pricing?.ok && pricing.config) setConfig(pricing.config);

      const bal = await invokeFunction<BalanceResponse>('billing', { action: 'balance' });
      if (bal?.ok) setBalance(Number(bal.balance));

      const hist = await invokeFunction<HistoryResponse>('billing', { action: 'history' });
      if (hist?.ok) {
        setLedger(hist.ledger ?? []);
        setCurrentMonth(new Date().toISOString().slice(0, 7));
      }
    } catch {
      // Billing endpoints need a configured project. The page still renders the
      // plans and simply shows the balance as unknown rather than failing.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Credits drawn down in the current calendar month, from the ledger. */
  const spentThisMonth = useMemo(
    () =>
      ledger
        .filter((r) => r.kind === 'usage' && r.created_at.slice(0, 7) === currentMonth)
        .reduce((sum, r) => sum + Math.abs(Number(r.delta)), 0),
    [ledger, currentMonth],
  );

  const renewalLabel = subscriptionRenewsAt
    ? new Date(subscriptionRenewsAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '—';

  const choosePlan = async (planId: string) => {
    if (planId === subscriptionPlan) return;
    setPendingPlan(planId);
    const res = await changeSubscriptionPlan(
      planId as Parameters<typeof changeSubscriptionPlan>[0],
      interval,
    );
    if (!res.success) addToast(res.error || 'Could not start checkout.', 'error');
    setPendingPlan(null);
  };

  const buyCredits = async (pkg: TopUpPackage) => {
    setPendingTopUp(pkg.id);
    try {
      const res = await invokeFunction<CheckoutResponse>('billing', {
        action: 'topup',
        packageId: pkg.id,
      });
      if (res?.checkoutUrl) window.location.assign(res.checkoutUrl);
      else addToast(res?.error || 'Could not start checkout.', 'error');
    } catch (err) {
      addToast((err as Error)?.message || 'Could not start checkout.', 'error');
    }
    setPendingTopUp(null);
  };

  const negative = balance !== null && balance < 0;
  const remaining = balance === null ? null : Math.max(0, balance);
  const allowancePct =
    remaining !== null && allowance > 0
      ? Math.min(100, Math.round((remaining / allowance) * 100))
      : null;

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-8">
      {/* ---- Wallet ----------------------------------------------------- */}
      <section className={card}>
        <div className="px-5 py-5 sm:px-6 flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-[#eeeeea]">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wide text-[#8a8a86]">
              Credit balance
            </p>
            <div className="flex items-baseline gap-2.5 mt-1">
              <span
                className={`text-4xl font-bold tracking-tight tabular-nums ${
                  negative ? 'text-amber-700' : 'text-[#141414]'
                }`}
              >
                {balance === null ? '—' : formatCredits(balance)}
              </span>
              <span className="text-xs font-mono text-[#8a8a86]">
                {remaining !== null &&
                  `${formatUsd(remaining * creditValueUsd(creditsPerUsd))} of search`}
              </span>
            </div>
          </div>

          <span
            className={`self-start sm:self-auto inline-flex items-center gap-1.5 px-2.5 py-1 border text-[11px] font-mono ${
              subscriptionStatus === 'active'
                ? 'border-[#e3e3de] bg-[#f6f6f4] text-[#4a4a47]'
                : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                subscriptionStatus === 'active' ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
            />
            {subscriptionStatus === 'active' ? 'Active' : subscriptionStatus}
          </span>
        </div>

        {allowancePct !== null && allowance > 0 && (
          <div className="px-5 sm:px-6 pt-5">
            <div className="flex items-center justify-between text-[11px] font-mono mb-1.5">
              <span className="text-[#8a8a86]">
                {formatCredits(remaining)} of {formatCredits(allowance)} monthly credits left
              </span>
              <span className="text-[#4a4a47]">{allowancePct}%</span>
            </div>
            <div className="h-1.5 bg-[#ecece7] w-full overflow-hidden">
              <div
                className={`h-full transition-all ${
                  allowancePct < 15 ? 'bg-amber-500' : 'bg-[#141414]'
                }`}
                style={{ width: `${allowancePct}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-[#eeeeea] border-t border-[#eeeeea]">
          <Stat
            label="Plan"
            value={plan.name}
            hint={`${plan.keywordLimit} keywords · ${plan.maxChannels} channels`}
          />
          <Stat
            label="Sweep cadence"
            value={`Every ${plan.sweepCadenceHours}h`}
            hint="or slower, you choose the hour"
          />
          <Stat
            label="Spent this month"
            value={formatCredits(spentThisMonth)}
            hint={`${creditsPerUsd} credits = $1`}
          />
          <Stat label="Renews" value={renewalLabel} hint={`$${plan.monthlyPrice}/month`} />
        </div>

        {negative && (
          <p className="mx-5 sm:mx-6 mb-5 mt-5 flex items-start gap-2 text-[11px] font-mono text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2.5 leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              You are {formatCredits(Math.abs(balance as number))} credits below zero.
              Sweeps keep running and settle up as soon as you top up.
            </span>
          </p>
        )}
      </section>

      {/* ---- Top up ------------------------------------------------------ */}
      {packages.length > 0 && (
        <section>
          <h3 className="text-sm font-bold text-[#141414] mb-3">Top up</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-[#e3e3de] border border-[#e3e3de]">
            {packages.map((pkg) => {
              const credits = Math.round(pkg.usd * creditsPerUsd + pkg.bonus_credits);
              return (
                <div key={pkg.id} className="bg-white px-5 py-4 flex flex-col">
                  <div className="flex items-baseline justify-between">
                    <span className="text-base font-bold text-[#141414]">${pkg.usd}</span>
                    <span className="text-[11px] font-mono text-[#8a8a86]">{pkg.label}</span>
                  </div>
                  <p className="text-[11px] font-mono text-[#4a4a47] mt-1">
                    {formatCredits(credits)} credits
                    {pkg.bonus_credits > 0 && (
                      <span className="text-emerald-700"> · {formatCredits(pkg.bonus_credits)} bonus</span>
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={() => void buyCredits(pkg)}
                    disabled={pendingTopUp !== null}
                    className="mt-3 w-full py-2 text-[11px] font-mono border border-[#deded8] bg-white text-[#141414] hover:bg-[#141414] hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {pendingTopUp === pkg.id ? 'Redirecting…' : 'Buy credits'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ---- Plans -------------------------------------------------------- */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-[#141414]">Plan</h3>
          <div className="inline-flex border border-[#e3e3de] bg-[#f6f6f4] p-0.5 text-[11px] font-mono">
            {(['month', 'year'] as const).map((iv) => (
              <button
                key={iv}
                type="button"
                onClick={() => setBillingInterval(iv)}
                className={`px-2.5 py-1 transition-colors cursor-pointer uppercase ${
                  interval === iv ? 'bg-[#141414] text-white' : 'text-[#4a4a47] hover:text-[#141414]'
                }`}
              >
                {iv === 'month' ? 'Monthly' : 'Yearly'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {SUBSCRIPTION_PLANS.map((p) => {
            const isCurrent = subscriptionPlan === p.id;
            const price = interval === 'month' ? p.monthlyPrice : p.annualPricePerMonth;
            const grant = Number(config?.plan_grants?.[p.id] ?? 0);

            return (
              <div
                key={p.id}
                className={`bg-white border p-5 flex flex-col ${
                  isCurrent ? 'border-[#141414]' : 'border-[#e3e3de]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono uppercase font-bold tracking-wider text-[#141414]">
                    {p.name}
                  </span>
                  {p.popular && (
                    <span className="px-1.5 py-0.5 bg-[#141414] text-white text-[9px] font-mono uppercase tracking-wider">
                      Popular
                    </span>
                  )}
                </div>

                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-3xl font-bold tracking-tight text-[#141414]">
                    ${price}
                  </span>
                  <span className="text-[11px] font-mono text-[#8a8a86]">/mo</span>
                </div>
                {interval === 'year' && (
                  <p className="text-[10px] font-mono text-[#8a8a86] mt-0.5">
                    ${p.annualTotal} billed yearly
                  </p>
                )}

                <dl className="mt-4 pt-4 border-t border-[#eeeeea] space-y-1.5 text-[11px] font-mono">
                  <div className="flex justify-between">
                    <dt className="text-[#8a8a86]">Credits / month</dt>
                    <dd className="text-[#141414] font-semibold">{formatCredits(grant)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#8a8a86]">Keywords</dt>
                    <dd className="text-[#141414]">{p.keywordLimit}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#8a8a86]">Channels</dt>
                    <dd className="text-[#141414]">{p.maxChannels}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#8a8a86]">Sweeps / day</dt>
                    <dd className="text-[#141414]">{24 / p.sweepCadenceHours}</dd>
                  </div>
                </dl>

                <p className="text-[11px] text-[#4a4a47] mt-4 leading-relaxed">{p.desc}</p>

                <button
                  type="button"
                  onClick={() => void choosePlan(p.id)}
                  disabled={isCurrent || pendingPlan !== null}
                  className={`mt-5 w-full py-2 text-[11px] font-mono transition-colors cursor-pointer disabled:cursor-default ${
                    isCurrent
                      ? 'bg-[#f6f6f4] text-[#4a4a47] border border-[#e3e3de]'
                      : 'bg-[#121212] hover:bg-black text-white'
                  }`}
                >
                  {isCurrent
                    ? 'Current plan'
                    : pendingPlan === p.id
                    ? 'Redirecting…'
                    : `Switch to ${p.name}`}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---- Activity ------------------------------------------------------ */}
      {ledger.length > 0 && (
        <section className={card}>
          <header className="px-5 sm:px-6 py-4 border-b border-[#eeeeea] flex items-center justify-between">
            <h3 className="text-sm font-bold text-[#141414]">Activity</h3>
            <span className="text-[11px] font-mono text-[#8a8a86]">last {ledger.length}</span>
          </header>

          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-[#8a8a86] text-left border-b border-[#eeeeea]">
                  <th className="px-5 sm:px-6 py-2 font-normal">When</th>
                  <th className="px-3 py-2 font-normal">Entry</th>
                  <th className="px-3 py-2 font-normal text-right">Credits</th>
                  <th className="px-5 sm:px-6 py-2 font-normal text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f6f6f4]">
                {ledger.map((row) => {
                  const delta = Number(row.delta);
                  return (
                    <tr key={row.id}>
                      <td className="px-5 sm:px-6 py-2.5 text-[#8a8a86] whitespace-nowrap">
                        {new Date(row.created_at).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="px-3 py-2.5">{ledgerLabel(row)}</td>
                      <td
                        className={`px-3 py-2.5 text-right font-semibold whitespace-nowrap ${
                          delta >= 0 ? 'text-emerald-700' : 'text-[#141414]'
                        }`}
                      >
                        <span className="inline-flex items-center gap-0.5">
                          {delta >= 0 ? (
                            <ArrowUpRight className="w-3 h-3" />
                          ) : (
                            <ArrowDownRight className="w-3 h-3" />
                          )}
                          {formatCredits(Math.abs(delta))}
                        </span>
                      </td>
                      <td className="px-5 sm:px-6 py-2.5 text-right tabular-nums">
                        {formatCredits(row.balance_after)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="flex items-start gap-2 text-[11px] font-mono text-[#8a8a86] leading-relaxed">
        <Coins className="w-3.5 h-3.5 shrink-0 mt-px" />
        <span>
          One search call costs 1 credit on X and the web, 2 on Reddit, and nothing on
          press and news. Credits bought in a top-up never expire; the monthly plan
          allowance lapses after a year.
        </span>
      </p>
    </div>
  );
};
