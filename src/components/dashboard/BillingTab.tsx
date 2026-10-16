import React, { useState } from 'react';
import { useEcho } from '../../context/EchoContext';
import { SUBSCRIPTION_PLANS, getPlan } from '../../lib/billing';
import type { PlanId, BillingInterval } from '../../lib/billing';
import { CreditCard, Check, ShieldCheck } from 'lucide-react';

export const BillingTab: React.FC = () => {
  const {
    keywords,
    keywordLimit,
    mentionsFound,
    subscriptionPlan,
    subscriptionStatus,
    subscriptionRenewsAt,
    changeSubscriptionPlan,
    addToast,
  } = useEcho();

  const [interval, setInterval] = useState<BillingInterval>('month');
  const [pendingPlan, setPendingPlan] = useState<PlanId | null>(null);

  const currentPlanDetails = getPlan(subscriptionPlan);

  const handleSelectPlan = async (planId: PlanId) => {
    if (planId === subscriptionPlan) return;

    setPendingPlan(planId);
    const result = await changeSubscriptionPlan(planId, interval);

    if (!result.success) {
      addToast(result.error || 'Could not start checkout.', 'error');
    }
    setPendingPlan(null);
  };

  const renewsLabel = subscriptionRenewsAt
    ? new Date(subscriptionRenewsAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '—';

  return (
    <div className="max-w-4xl space-y-8">
      {/* Usage Overview Card */}
      <div className="bg-white border border-[#e3e3de] p-6">
        <div className="border-b border-[#eeeeea] pb-4 mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-[#141414]">
              Current Subscription & Usage
            </h2>
            <p className="text-xs text-[#8a8a86] font-mono mt-0.5">
              Active plan:{' '}
              <strong className="text-[#141414] uppercase">{subscriptionPlan}</strong> (
              {currentPlanDetails.monthlyPrice}/mo). Renews on {renewsLabel}.
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
              {subscriptionStatus === 'active' ? 'Account in good standing' : `Status: ${subscriptionStatus}`}
            </span>
          </div>
        </div>

        {/* Meters */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <div className="space-y-2 p-4 bg-[#f6f6f4] border border-[#e3e3de]">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[#4a4a47]">Tracked Keywords</span>
              <span className="font-semibold text-[#141414]">
                {keywords.length} / {keywordLimit}
              </span>
            </div>
            <div className="h-1.5 bg-[#deded8] w-full overflow-hidden">
              <div
                className="h-full bg-[#141414] transition-all"
                style={{ width: `${Math.min(100, (keywords.length / keywordLimit) * 100)}%` }}
              />
            </div>
          </div>

          <div className="space-y-2 p-4 bg-[#f6f6f4] border border-[#e3e3de]">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[#4a4a47]">Mentions Found (this session)</span>
              <span className="font-semibold text-[#141414]">{mentionsFound}</span>
            </div>
            <p className="text-[11px] font-mono text-[#8a8a86] pt-1">
              Sweeps run automatically on your configured cadence.
            </p>
          </div>

          <div className="space-y-2 p-4 bg-[#f6f6f4] border border-[#e3e3de]">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[#4a4a47]">Sweep Cadence</span>
              <span className="font-semibold text-[#141414]">{currentPlanDetails.sweepCadence}</span>
            </div>
            <p className="text-[11px] font-mono text-[#8a8a86] pt-1">
              Configurable in Settings.
            </p>
          </div>
        </div>

        </div>

      {/* Plan Selection */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#141414]">Available Plans</h3>
          <div className="inline-flex border border-[#e3e3de] bg-[#f6f6f4] p-0.5 text-xs font-mono">
            {(['month', 'year'] as const).map((iv) => (
              <button
                key={iv}
                type="button"
                onClick={() => setInterval(iv)}
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
            const price =
              interval === 'month' ? p.monthlyPrice : p.annualPricePerMonth;

            return (
              <div
                key={p.id}
                className={`bg-white border p-6 flex flex-col justify-between transition-all ${
                  isCurrent
                    ? 'border-[#141414] shadow-md ring-1 ring-[#141414]'
                    : 'border-[#e3e3de]'
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
      </div>

      {/* Payment Method */}
      <div className="bg-white border border-[#e3e3de] p-6">
        <h3 className="text-sm font-bold text-[#141414] flex items-center gap-2 mb-3">
          <CreditCard className="w-4 h-4" />
          <span>Payment Method</span>
        </h3>
        <p className="text-xs text-[#8a8a86] font-mono">
          Card details are stored and processed by Stripe. Echo never sees or stores your card
          number — update it from the Stripe checkout receipt link in your email.
        </p>
      </div>
    </div>
  );
};