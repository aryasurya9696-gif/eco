import React, { useCallback, useEffect, useState } from 'react';
import { useEcho } from '../../context/EchoContext';
import {
  SUBSCRIPTION_PLANS,
  getPlan,
  estimateMonthlyCostUsd,
  estimateGrossMargin,
  costCoverageRatio,
  formatUsd as planUsd,
} from '../../lib/billing';
import {
  formatCredits,
  formatUsd,
  ledgerLabel,
  creditValueUsd,
  type BillingConfig,
  type LedgerRow,
  type PaymentRow,
  type TopUpPackage,
} from '../../lib/credits';
import { invokeFunction } from '../../lib/api';
import { CreditCard, Check, ShieldCheck, Coins, AlertTriangle } from 'lucide-react';

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
  payments?: PaymentRow[];
}
interface CheckoutResponse {
  ok: boolean;
  checkoutUrl?: string;
  error?: string;
}

export const BillingTab: React.FC = () => {
  const {
    keywords,
    keywordLimit,
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
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [billingReady, setBillingReady] = useState<boolean | null>(null);

  const currentPlanDetails = getPlan(subscriptionPlan);

  const refresh = useCallback(async () => {
    try {
      const res = await invokeFunction<PricingResponse>('billing', { action: 'pricing' });
      if (res?.ok && res.config) {
        setConfig(res.config);
        setBillingReady(true);
      }

      const bal = await invokeFunction<BalanceResponse>('billing', { action: 'balance' });
      if (bal?.ok) setBalance(Number(bal.balance));

      const hist = await invokeFunction<HistoryResponse>('billing', { action: 'history' });
      if (hist?.ok) {
        setLedger(hist.ledger ?? []);
        setPayments(hist.payments ?? []);
      }
    } catch {
      setBillingReady(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSelectPlan = async (planId: string) => {
    if (planId === subscriptionPlan) return;
    setPendingPlan(planId);
    const result = await changeSubscriptionPlan(
      planId as Parameters<typeof changeSubscriptionPlan>[0],
      interval,
    );
    if (!result.success) {
      addToast(result.error || 'Could not start checkout.', 'error');
    }
    setPendingPlan(null);
  };

  const handleTopUp = async (pkg: TopUpPackage) => {
    setPendingTopUp(pkg.id);
    try {
      const res = await invokeFunction<CheckoutResponse>('billing', {
        action: 'topup',
        packageId: pkg.id,
      });
      if (res?.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        addToast(res?.error || 'Could not start checkout.', 'error');
      }
    } catch (err) {
      addToast((err as Error)?.message || 'Could not start checkout.', 'error');
    }
    setPendingTopUp(null);
  };

  const creditsPerUsd = Number(config?.credit_rate?.creditsPerUsd ?? 20);
  const packages = config?.topup_packages ?? [];
  const allowance = Number(config?.plan_grants?.[subscriptionPlan] ?? 0);
  const renewsLabel = subscriptionRenewsAt
    ? new Date(subscriptionRenewsAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '—';

  return (
    <div className="max-w-4xl space-y-8">
      {/* ---- Balance ---------------------------------------------------- */}
      <div className="bg-white border border-[#e3e3de] p-6">
        <div className="border-b border-[#eeeeea] pb-4 mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-[#141414]">
              Credits &amp; subscription
            </h2>
            <p className="text-xs text-[#8a8a86] font-mono mt-0.5">
              {currentPlanDetails.name} plan, renews {renewsLabel}.
            </p>
          </div>

          <div
            className={`inline-flex items-center gap-1.5 px-3 py-1 border text-xs font-mono ${
              subscriptionStatus === 'active'
                ? 'bg-[#f6f6f4] border-[#e3e3de] text-[#141414]'
                : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}
          >
            <ShieldCheck
              className={`w-3.5 h-3.5 ${
                subscriptionStatus === 'active' ? 'text-emerald-600' : 'text-amber-600'
              }`}
            />
            <span>
              {subscriptionStatus === 'active'
                ? 'Account in good standing'
                : `Status: ${subscriptionStatus}`}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <div className="p-4 bg-[#141414] text-white">
            <div className="flex items-center gap-1.5 text-[#a8a8a4] font-mono text-[10px] uppercase tracking-wide">
              <Coins className="w-3 h-3" />
              Balance
            </div>
            <p className="text-2xl font-bold mt-1">
              {balance === null ? '—' : formatCredits(balance)}
            </p>
            <p className="text-[11px] font-mono text-[#a8a8a4] mt-1">
              {balance === null
                ? ''
                : balance < 0
                ? 'Top up to keep sweeping'
                : `worth ${formatUsd(Math.max(0, balance) * creditValueUsd(creditsPerUsd))}`}
            </p>
          </div>

          <div className="p-4 bg-[#f6f6f4] border border-[#e3e3de] space-y-2">
            <p className="text-[#4a4a47] font-mono text-[11px]">Tracked keywords</p>
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[#8a8a86]">in use</span>
              <span className="font-semibold text-[#141414]">
                {keywords.length} / {keywordLimit}
              </span>
            </div>
            <div className="h-1.5 bg-[#deded8] w-full overflow-hidden">
              <div
                className="h-full bg-[#141414] transition-all"
                style={{
                  width: `${Math.min(100, (keywords.length / Math.max(1, keywordLimit)) * 100)}%`,
                }}
              />
            </div>
            <p className="text-[11px] font-mono text-[#8a8a86] pt-1">
              Resets to the plan limit when you remove one.
            </p>
          </div>

          <div className="p-4 bg-[#f6f6f4] border border-[#e3e3de] space-y-2">
            <p className="text-[#4a4a47] font-mono text-[11px]">Monthly allowance</p>
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[#8a8a86]">renews each billing period</span>
              <span className="font-semibold text-[#141414]">
                {formatCredits(allowance)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[#8a8a86]">conversion</span>
              <span className="font-semibold text-[#141414]">{creditsPerUsd}/USD</span>
            </div>
            <p className="text-[11px] font-mono text-[#8a8a86] pt-1">
              Unused credits roll over; the monthly allowance expires after a year.
            </p>
          </div>
        </div>

        {balance !== null && balance < 0 && (
          <p className="mt-4 flex items-start gap-2 text-[11px] font-mono text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              Your balance is {formatCredits(Math.abs(balance))} credits below zero.
              Sweeps keep running and will settle up once you top up.
            </span>
          </p>
        )}
      </div>

      {/* ---- Top up ----------------------------------------------------- */}
      {packages.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-[#141414]">Top up credits</h3>
            {billingReady === false && (
              <span className="text-[11px] font-mono text-amber-700">
                Payments not configured
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {packages.map((pkg) => {
              const credits = Math.round(pkg.usd * creditsPerUsd + pkg.bonus_credits);
              return (
                <div
                  key={pkg.id}
                  className="bg-white border border-[#e3e3de] p-5 flex flex-col justify-between"
                >
                  <div>
                    <p className="text-xs font-mono uppercase font-bold tracking-wider text-[#141414]">
                      {pkg.label}
                    </p>
                    <p className="text-2xl font-bold text-[#141414] mt-1">
                      ${pkg.usd}
                    </p>
                    <p className="text-[11px] font-mono text-[#141414] mt-1">
                      {formatCredits(credits)} credits
                    </p>
                    {pkg.bonus_credits > 0 && (
                      <p className="text-[11px] font-mono text-emerald-700 mt-0.5">
                        includes {formatCredits(pkg.bonus_credits)} bonus
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleTopUp(pkg)}
                    disabled={pendingTopUp !== null}
                    className="mt-4 w-full py-2 text-xs font-mono bg-[#121212] hover:bg-black text-white transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {pendingTopUp === pkg.id ? 'Redirecting…' : 'Buy credits'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ---- History ---------------------------------------------------- */}
      {(ledger.length > 0 || payments.length > 0) && (
        <div className="bg-white border border-[#e3e3de]">
          <header className="px-6 py-4 border-b border-[#eeeeea]">
            <h3 className="text-sm font-bold text-[#141414]">Credit history</h3>
          </header>

          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-[#8a8a86] text-left border-b border-[#eeeeea]">
                  <th className="px-6 py-2 font-normal">When</th>
                  <th className="px-3 py-2 font-normal">Entry</th>
                  <th className="px-3 py-2 font-normal text-right">Credits</th>
                  <th className="px-6 py-2 font-normal text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f6f6f4]">
                {ledger.map((row) => (
                  <tr key={row.id}>
                    <td className="px-6 py-2 text-[#8a8a86]">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">{ledgerLabel(row)}</td>
                    <td
                      className={`px-3 py-2 text-right font-semibold ${
                        Number(row.delta) >= 0 ? 'text-emerald-700' : 'text-[#141414]'
                      }`}
                    >
                      {Number(row.delta) >= 0 ? '+' : ''}
                      {formatCredits(Number(row.delta))}
                    </td>
                    <td className="px-6 py-2 text-right">
                      {formatCredits(row.balance_after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Plans ------------------------------------------------------ */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#141414]">Available plans</h3>
          <div className="inline-flex border border-[#e3e3de] bg-[#f6f6f4] p-0.5 text-xs font-mono">
            {(['month', 'year'] as const).map((iv) => (
              <button
                key={iv}
                type="button"
                onClick={() => setBillingInterval(iv)}
                className={`px-3 py-1 transition-colors cursor-pointer uppercase ${
                  interval === iv ? 'bg-[#141414] text-white' : 'text-[#4a4a47] hover:text-[#141414]'
                }`}
              >
                {iv === 'month' ? 'Monthly' : 'Yearly'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {SUBSCRIPTION_PLANS.map((p) => {
            const isCurrent = subscriptionPlan === p.id;
            const price = interval === 'month' ? p.monthlyPrice : p.annualPricePerMonth;
            const cost = estimateMonthlyCostUsd(p);

            return (
              <div
                key={p.id}
                className={`bg-white border p-6 flex flex-col justify-between ${
                  isCurrent ? 'border-[#141414] ring-1 ring-[#141414]' : 'border-[#e3e3de]'
                }`}
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono uppercase font-bold tracking-wider text-[#141414]">
                      {p.name}
                    </span>
                    {p.popular && (
                      <span className="px-2 py-0.5 bg-[#141414] text-white text-[9px] font-mono uppercase tracking-wider">
                        Popular
                      </span>
                    )}
                  </div>

                  <div>
                    <span className="text-3xl font-bold tracking-tight text-[#141414]">
                      ${price}
                    </span>
                    <span className="text-xs font-mono text-[#8a8a86]">/month</span>
                    {interval === 'year' && (
                      <p className="text-[10px] font-mono text-[#8a8a86] mt-1">
                        Billed ${p.annualTotal}/year
                      </p>
                    )}
                    <p className="text-xs text-[#4a4a47] mt-2 min-h-[32px]">{p.desc}</p>
                  </div>

                  <ul className="space-y-2 pt-2 border-t border-[#eeeeea] text-xs font-mono text-[#4a4a47]">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check className="w-3.5 h-3.5 text-[#141414] flex-shrink-0 mt-0.5" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Transparent unit economics. This is what the plan costs to
                      serve at its own limits, so the price is not a mystery. */}
                  <div className="pt-3 border-t border-[#eeeeea] text-[11px] font-mono space-y-1">
                    <div className="flex justify-between">
                      <span className="text-[#8a8a86]">Includes</span>
                      <span className="text-[#141414]">
                        {formatCredits(Number(config?.plan_grants?.[p.id] ?? 0))} credits
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#8a8a86]">Search cost at full use</span>
                      <span className="text-[#141414]">{planUsd(cost)}/mo</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#8a8a86]">Margin</span>
                      <span className="text-emerald-700 font-semibold">
                        {(estimateGrossMargin(p) * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                </div>

                <div className="pt-6">
                  <button
                    type="button"
                    onClick={() => void handleSelectPlan(p.id)}
                    disabled={isCurrent || pendingPlan !== null}
                    className={`w-full py-2.5 text-xs font-mono transition-colors cursor-pointer disabled:opacity-60 ${
                      isCurrent
                        ? 'bg-[#eeeeea] text-[#141414] font-semibold'
                        : 'bg-[#121212] hover:bg-black text-white'
                    }`}
                  >
                    {isCurrent
                      ? 'Current Plan'
                      : pendingPlan === p.id
                      ? 'Redirecting to checkout...'
                      : `Switch to ${p.name}`}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[11px] font-mono text-[#8a8a86] leading-relaxed">
          At full use a {getPlan('pro').name} workspace consumes {costCoverageRatio(getPlan('pro')).toFixed(0)}x
          more credits than it costs to serve, so the subscription covers its own search
          many times over.
        </p>
      </div>

      {/* ---- Payment method --------------------------------------------- */}
      <div className="bg-white border border-[#e3e3de] p-6">
        <h3 className="text-sm font-bold text-[#141414] flex items-center gap-2 mb-3">
          <CreditCard className="w-4 h-4" />
          <span>Payment method</span>
        </h3>
        <p className="text-xs text-[#8a8a86] font-mono">
          Card details are stored and processed by Stripe. Echo never sees or stores your
          card number — update it from the Stripe checkout receipt link in your email.
        </p>
      </div>
    </div>
  );
};
