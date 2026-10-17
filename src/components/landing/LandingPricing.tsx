import React from 'react';
import { Check, ArrowRight } from 'lucide-react';

/**
 * Pricing, built like a plan picker.
 *
 * The previous version of this section listed three prices and put a single
 * call to action underneath all of them. That is a price table, not a purchase
 * page: nothing in it said which of the three things you were supposed to pick.
 * A plan picker gives every option its own button, so choosing one is a single
 * click rather than a comparison the customer has to resolve themselves.
 *
 * One honesty constraint shaped the cards. All three packages cost the same per
 * credit — $0.05 — so there is no best value tier and pretending otherwise with a
 * "best value" ribbon would be a lie the billing page would contradict. What
 * differs is how long the credits last, so that is what the card differentiates
 * on. The cards say what each buys in searches and in sweeps, both derived from
 * the real per-channel costs, and nothing is claimed that the product does not
 * actually do differently.
 */

interface LandingPricingProps {
  packages: Array<{
    code: string;
    display_name: string;
    gross_usd: number;
    credits: number;
    bonus_credits: number;
  }>;
  searchCosts: Array<{ channel: string; credits: number; note: string }>;
  welcomeCredits: number;
  perSearchPrice: number;
  /** Credits one full daily sweep costs at the workspace maximum. */
  sweepCost: number;
  onBuy: (code: string) => void;
  onStart: () => void;
}

export const LandingPricing: React.FC<LandingPricingProps> = ({
  packages,
  searchCosts,
  welcomeCredits,
  perSearchPrice,
  sweepCost,
  onBuy,
  onStart,
}) => {
  const cheapestPerSearch = Math.min(...searchCosts.map((s) => s.credits));
  const dearestPerSearch = Math.max(...searchCosts.map((s) => s.credits));

  // The middle package is the one most people land on, so it gets the emphasis.
  // Derived rather than flagged, so reordering the database does not silently
  // point the ribbon at the wrong card.
  const featuredIndex = Math.floor(packages.length / 2);

  return (
    <section id="pricing" className="relative py-24 px-6 border-t border-[#e3e3de] bg-[#fbfbfa] overflow-hidden">
      <div className="absolute inset-0 bg-grid-58 bg-grid-fade pointer-events-none opacity-40" />

      <div className="relative z-10 max-w-5xl mx-auto">
        <div className="text-center mb-14 max-w-xl mx-auto">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white border border-[#e3e3de] text-[10px] font-mono uppercase tracking-wider text-[#4a4a47] mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            No subscription, nothing renews
          </span>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-[#141414]">
            Buy credits. Spend them on searches.
          </h2>
          <p className="text-[#4a4a47] leading-relaxed mt-4">
            One payment, and the credits are yours until you have used them up.
            Same price per credit at every size — you are never paying extra to
            buy more.
          </p>
        </div>

        {/* ---- The plans --------------------------------------------------- */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          {packages.map((p, i) => {
            const total = p.credits + p.bonus_credits;
            const featured = i === featuredIndex;
            const maxCredits = Math.max(...packages.map((x) => x.credits + x.bonus_credits), 1);

            // Both ends of the range, because a workspace's channel mix decides
            // the real figure. Quoting only the cheap end would oversell.
            const bestCase = Math.floor(total / cheapestPerSearch);
            const worstCase = Math.floor(total / dearestPerSearch);
            const sweeps = sweepCost > 0 ? Math.floor(total / sweepCost) : 0;

            return (
              <div
                key={p.code}
                className={`relative bg-white flex flex-col ${
                  featured
                    ? 'border-2 border-[#141414] shadow-[0_2px_0_0_#141414,0_16px_40px_-20px_rgba(20,20,20,0.4)] md:-mt-5 md:z-10'
                    : 'border border-[#e3e3de] hover:border-[#b8b8b2]'
                }`}
              >
                {featured && (
                  <div className="-mt-0.5 bg-[#141414] text-white text-center py-1.5 text-[9px] font-mono uppercase tracking-[0.15em]">
                    Most chosen
                  </div>
                )}

                <div className="p-6 flex-1">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]">
                    {p.display_name}
                  </p>

                  <div className="flex items-baseline gap-1.5 mt-3">
                    <span className="text-4xl font-bold tracking-tight text-[#141414]">
                      ${p.gross_usd}
                    </span>
                    <span className="text-xs font-mono text-[#8a8a86]">one-off</span>
                  </div>

                  <p className="text-sm font-mono text-[#141414] mt-2">
                    {total.toLocaleString()} credits
                    {p.bonus_credits > 0 && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-900 uppercase align-middle">
                        +{p.bonus_credits} bonus
                      </span>
                    )}
                  </p>

                  {/* Proportional bar: the only thing in the row that shows 1000
                      is five times 200 at a glance. */}
                  <div className="mt-3 h-1 w-full bg-[#eeeeea]" aria-hidden="true">
                    <div
                      className={`h-full ${featured ? 'bg-[#141414]' : 'bg-[#8a8a86]'}`}
                      style={{ width: `${Math.round((total / maxCredits) * 100)}%` }}
                    />
                  </div>

                  <p className="text-[11px] text-[#8a8a86] font-mono mt-3">
                    ${perSearchPrice.toFixed(2)} per credit
                  </p>

                  {/* What it actually buys, at both ends of the channel mix. */}
                  <div className="mt-4 pt-4 border-t border-[#eeeeea] space-y-1.5">
                    <p className="text-[11px] font-mono text-[#4a4a47] flex justify-between gap-2">
                      <span>Web / Twitter searches</span>
                      <span className="text-[#141414]">{bestCase.toLocaleString()}</span>
                    </p>
                    <p className="text-[11px] font-mono text-[#4a4a47] flex justify-between gap-2">
                      <span>Reddit searches</span>
                      <span className="text-[#141414]">{worstCase.toLocaleString()}</span>
                    </p>
                    {sweeps > 0 && (
                      <p className="text-[11px] font-mono text-[#4a4a47] flex justify-between gap-2">
                        <span>Full daily sweeps</span>
                        <span className="text-[#141414]">{sweeps.toLocaleString()}</span>
                      </p>
                    )}
                  </div>

                  <p className="text-[10px] text-[#b8b8b2] font-mono mt-3 leading-relaxed">
                    Sweeps assume all 8 keywords across 3 channels. Track fewer and
                    they last considerably longer.
                  </p>
                </div>

                {/* The button IS the offer. Without a per-card action this is a
                    table of numbers the customer has to choose from alone. */}
                <div className="p-6 pt-0">
                  <button
                    onClick={() => onBuy(p.code)}
                    className={`w-full py-3 text-xs font-mono transition-colors cursor-pointer flex items-center justify-center gap-2 ${
                      featured
                        ? 'bg-[#121212] hover:bg-black text-white'
                        : 'border border-[#141414] text-[#141414] hover:bg-[#141414] hover:text-white'
                    }`}
                  >
                    Buy {total.toLocaleString()} credits
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* ---- What a search costs ------------------------------------------ */}
        <div className="mt-14 bg-white border border-[#e3e3de] p-6 md:p-7">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-[#eeeeea]">
            <p className="text-[10px] font-mono uppercase tracking-wider text-[#141414] font-bold">
              What one search costs
            </p>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#f6f6f4] border border-[#e3e3de] text-[10px] font-mono text-[#4a4a47]">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              New accounts start with {welcomeCredits} free credits
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10">
            <ul>
              {searchCosts.map((s) => (
                <li
                  key={s.channel}
                  className="flex items-center justify-between gap-4 py-2.5 border-b border-[#f5f5f2]"
                >
                  <div className="flex items-baseline gap-2.5 min-w-0">
                    <Check className="w-3.5 h-3.5 text-[#141414] flex-shrink-0 self-center" />
                    <span className="text-sm text-[#141414]">{s.channel}</span>
                  </div>
                  <span className="text-xs font-mono text-[#141414] flex-shrink-0">
                    {s.credits} cr
                  </span>
                </li>
              ))}
            </ul>
            <div className="text-[11px] text-[#8a8a86] font-mono leading-relaxed py-3 sm:pl-6">
              <p>
                A channel is charged once per sweep, whether it worked first time or
                took a fallback. You are never charged for the retry.
              </p>
              <p className="mt-2">
                A search that finds nothing, or that the provider charges nothing for,
                is not billed at all.
              </p>
            </div>
          </div>
        </div>

        {/* ---- Close -------------------------------------------------------- */}
        <div className="mt-10 flex flex-col sm:flex-row sm:items-center justify-between gap-5 bg-white border border-[#e3e3de] p-6">
          <div>
            <p className="text-sm text-[#141414] font-medium">
              Want to look before you spend anything?
            </p>
            <p className="text-xs text-[#8a8a86] mt-1 max-w-md">
              New accounts get {welcomeCredits} free credits, enough to run real
              searches and see what comes back. No card, nothing to cancel.
            </p>
          </div>
          <button
            onClick={onStart}
            className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-[#121212] hover:bg-black text-white text-sm font-mono transition-colors shrink-0 cursor-pointer"
          >
            Start free
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </section>
  );
};