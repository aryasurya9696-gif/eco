import React from 'react';
import { useEcho } from '../../context/EchoContext';
import { CreditCard, Check, Download, ShieldCheck } from 'lucide-react';

export const BillingTab: React.FC = () => {
  const { currentPlan, setCurrentPlan, keywords, monthlyCreditsUsed, invoices, addToast } = useEcho();

  const plans = [
    {
      id: 'starter' as const,
      name: 'Starter',
      price: '$29',
      period: '/month',
      desc: 'Ideal for solo founders monitoring core brand mentions.',
      features: [
        'Up to 5 tracked keywords',
        'Daily sweep (X & LinkedIn — 2 channels)',
        'Standard intent detection',
        'Email notifications',
        'Community support',
      ],
      keywordLimit: 5,
      creditLimit: 500,
    },
    {
      id: 'pro' as const,
      name: 'Pro',
      price: '$79',
      period: '/month',
      popular: true,
      desc: 'For high-growth B2B sales teams and outbound agencies.',
      features: [
        'Up to 10 tracked keywords',
        'All 5 channels (X, LinkedIn, Reddit, FB, Google)',
        'AI Outreach response drafter',
        'Slack & Discord webhooks',
        'CSV & JSON lead export',
        'Priority support',
      ],
      keywordLimit: 10,
      creditLimit: 1000,
    },
    {
      id: 'scale' as const,
      name: 'Scale',
      price: '$199',
      period: '/month',
      desc: 'Deep market intelligence and competitor tracking.',
      features: [
        'Up to 25 tracked keywords',
        'All 5 channels + 12h accelerated sweep',
        'Unlimited AI response drafts',
        'Custom webhook payload mapping',
        'HubSpot & Salesforce sync (v2)',
        'Dedicated account rep',
      ],
      keywordLimit: 25,
      creditLimit: 3000,
    },
  ];

  const currentPlanDetails = plans.find((p) => p.id === currentPlan) || plans[1];

  const handleSelectPlan = (planId: 'starter' | 'pro' | 'scale') => {
    setCurrentPlan(planId);
    addToast(`Successfully upgraded to ${planId.toUpperCase()} plan.`, 'success');
  };

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
              Active plan: <strong className="text-[#141414] uppercase">{currentPlan}</strong> ({currentPlanDetails.price}/mo). Renews on June 1, 2025.
            </p>
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#f6f6f4] border border-[#e3e3de] text-xs font-mono text-[#141414]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            <span>Account in Good Standing</span>
          </div>
        </div>

        {/* Meters */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {/* Keywords Meter */}
          <div className="space-y-2 p-4 bg-[#f6f6f4] border border-[#e3e3de]">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[#4a4a47]">Tracked Keywords</span>
              <span className="font-semibold text-[#141414]">
                {keywords.length} / {currentPlanDetails.keywordLimit}
              </span>
            </div>
            <div className="h-1.5 bg-[#deded8] w-full overflow-hidden">
              <div
                className="h-full bg-[#141414] transition-all"
                style={{
                  width: `${Math.min(100, (keywords.length / currentPlanDetails.keywordLimit) * 100)}%`,
                }}
              />
            </div>
          </div>

          {/* Credits Meter */}
          <div className="space-y-2 p-4 bg-[#f6f6f4] border border-[#e3e3de]">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[#4a4a47]">Monthly API Credits</span>
              <span className="font-semibold text-[#141414]">
                {monthlyCreditsUsed} / {currentPlanDetails.creditLimit}
              </span>
            </div>
            <div className="h-1.5 bg-[#deded8] w-full overflow-hidden">
              <div
                className="h-full bg-[#141414] transition-all"
                style={{
                  width: `${Math.min(100, (monthlyCreditsUsed / currentPlanDetails.creditLimit) * 100)}%`,
                }}
              />
            </div>
          </div>

          {/* Sweeps count */}
          <div className="space-y-2 p-4 bg-[#f6f6f4] border border-[#e3e3de]">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-[#4a4a47]">Daily Sweeps Run</span>
              <span className="font-semibold text-emerald-700">31 Completed</span>
            </div>
            <p className="text-[11px] font-mono text-[#8a8a86] pt-1">
              Zero errors in current 30-day window.
            </p>
          </div>
        </div>
      </div>

      {/* Plan Selection Cards */}
      <div className="space-y-4">
        <h3 className="text-sm font-bold text-[#141414]">
          Available Plans
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map((p) => {
            const isCurrent = currentPlan === p.id;
            return (
              <div
                key={p.id}
                className={`bg-white border p-6 flex flex-col justify-between transition-all ${
                  isCurrent ? 'border-[#141414] shadow-md ring-1 ring-[#141414]' : 'border-[#e3e3de]'
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
                      {p.price}
                    </span>
                    <span className="text-xs font-mono text-[#8a8a86]">
                      {p.period}
                    </span>
                    <p className="text-xs text-[#4a4a47] mt-2 min-h-[32px]">
                      {p.desc}
                    </p>
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
                    onClick={() => handleSelectPlan(p.id)}
                    disabled={isCurrent}
                    className={`w-full py-2.5 text-xs font-mono transition-colors cursor-pointer ${
                      isCurrent
                        ? 'bg-[#eeeeea] text-[#141414] font-semibold cursor-default'
                        : 'bg-[#121212] hover:bg-black text-white'
                    }`}
                  >
                    {isCurrent ? 'Current Plan' : `Switch to ${p.name}`}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Payment Method & Invoices */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Payment Card */}
        <div className="bg-white border border-[#e3e3de] p-6 space-y-4">
          <h3 className="text-sm font-bold text-[#141414] flex items-center gap-2">
            <CreditCard className="w-4 h-4" />
            <span>Payment Method</span>
          </h3>
          <div className="p-3 bg-[#f6f6f4] border border-[#e3e3de] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-5 bg-[#141414] rounded-xs text-white text-[8px] font-mono flex items-center justify-center font-bold">
                VISA
              </div>
              <div className="text-xs font-mono">
                <span className="text-[#141414] block">•••• •••• •••• 4242</span>
                <span className="text-[#8a8a86] text-[10px]">Expires 12/28</span>
              </div>
            </div>
            <button
              onClick={() => addToast('Payment gateway opened in secure modal.', 'info')}
              className="text-xs font-mono text-[#141414] underline hover:no-underline cursor-pointer"
            >
              Update
            </button>
          </div>
        </div>

        {/* Billing History */}
        <div className="bg-white border border-[#e3e3de] p-6 space-y-4">
          <h3 className="text-sm font-bold text-[#141414]">
            Recent Invoices
          </h3>
          {invoices.length === 0 ? (
            <p className="text-xs text-[#8a8a86] font-mono py-4">No billing invoices generated yet.</p>
          ) : (
            <div className="divide-y divide-[#eeeeea] text-xs font-mono">
              {invoices.map((inv) => (
                <div key={inv.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <span className="text-[#141414] block">{inv.id}</span>
                    <span className="text-[10px] text-[#8a8a86]">{inv.date}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-[#141414]">${inv.amount.toFixed(2)}</span>
                    <button
                      onClick={() => addToast(`Receipt ${inv.id} downloaded.`, 'success')}
                      className="p-1 text-[#8a8a86] hover:text-[#141414] cursor-pointer"
                      title="Download PDF"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
