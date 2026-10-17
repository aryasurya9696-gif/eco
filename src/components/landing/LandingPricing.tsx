import React from 'react';
import { Check, ArrowRight } from 'lucide-react';

/**
 * The pricing section.
 *
 * Two things this layout is trying to do that a plain list of prices does not.
 *
 * Give the middle package enough weight that the eye lands there. Three equal
 * cards read as three options of equal merit; a $25 block between $10 and $50 is
 * almost always what someone wants, and a design that hides that is making the
 * customer do arithmetic.
 *
 * Turn credits into something countable. "200 credits" is abstract until it is
 * attached to searches, so every package says roughly what it buys and the
 * per-channel costs sit directly underneath rather than on a separate tab.
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
  onStart: () => void;
}

export const LandingPricing: React.FC<LandingPricingProps> = ({
  packages,
  searchCosts,
  welcomeCredits,
  perSearchPrice,
  onStart,
}) => {
  // Feature the middle option. With an odd count this is the centre; with an
  // even one it is the lower-middle, which is the cheaper of the two larger
  // packages and the one people pick.
  const featuredIndex = Math.min(
    packages.length - 1,
    packages.length % 2 === 1 ? Math.floor(packages.length / 2) : Math.floor(packages.length / 2),
  );
  const maxCredits = Math.max(...packages.map((p) => p.credits + p.bonus_credits), 1);

  return (
    <section id="pricing" className="relative py-24 px-6 border-t border-[#e3e3de] bg-[#fbfbfa] overflow-hidden">
      {/* Same 58px grid and radial fade the hero uses, dialled right down. The
          page's visual language should not stop at the first screen. */}
      <div className="absolute inset-0 bg-grid-58 bg-grid-fade pointer-events-none opacity-40" />

      <div className="relative z-10 max-w-5xl mx-auto">
        <div className="text-center mb-16 max-w-xl mx-auto">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white border border-[#e3e3de] text-[10px] font-mono uppercase tracking-wider text-[#4a4a47] mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            No subscription
          </span>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-[#141414]">
            Pay for searches, not for a seat
          </h2>
          <p className="text-[#4a4a47] leading-relaxed mt-4">
            Buy credits once and spend them down as searches run. Nothing renews,
            nothing expires, and there is no card on file to be surprised by.
          </p>
        </div>

        {/* ---- Packages ---------------------------------------------------- */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          {packages.map((p, i) => {
            const total = p.credits + p.bonus_credits;
            const featured = i === featuredIndex;
            // One cheapest-search estimate per package, from the least expensive
            // operation. Says "as few as N searches", which is the honest floor.
            const cheapest = Math.min(...searchCosts.map((s) => s.credits));
            const searches = Math.floor(total / cheapest);

            return (
              <div
                key={p.code}
                className={`relative bg-white flex flex-col transition-all ${
                  featured
                    ? 'border border-[#141414] shadow-[0_1px_0_0_#141414,0_12px_32px_-16px_rgba(20,20,20,0.35)] md:-mt-4 md:mb-[-1rem] md:z-10'
                    : 'border border-[#e3e3de] hover:border-[#b8b8b2]'
                }`}
              >
                {featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-1 bg-[#141414] text-white text-[9px] font-mono uppercase tracking-wider whitespace-nowrap">
                    Most chosen
                  </span>
                )}

                <div className="p-6 pb-5">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-4xl font-bold tracking-tight text-[#141414]">
                      ${p.gross_usd}
                    </span>
                    <span className="text-xs font-mono text-[#8a8a86]">once</span>
                  </div>

                  <p className="text-sm font-mono text-[#141414] mt-3">
                    {total.toLocaleString()} credits
                    {p.bonus_credits > 0 && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-[#141414] text-white uppercase align-middle">
                        +{p.bonus_credits}
                      </span>
                    )}
                  </p>

                  {/* Credits as a proportional bar. Not decoration: it lets you
                      see at a glance that 1000 credits is five times 200. */}
                  <div className="mt-3 h-1 w-full bg-[#eeeeea]" aria-hidden="true">
                    <div
                      className={`h-full ${featured ? 'bg-[#141414]' : 'bg-[#8a8a86]'}`}
                      style={{ width: `${Math.round((total / maxCredits) * 100)}%` }}
                    />
                  </div>

                  <p className="text-[11px] text-[#8a8a86] font-mono mt-3">
                    about {searches.toLocaleString()} web searches
                    <span className="text-[#b8b8b2]"> · </span>
                    ${perSearchPrice.toFixed(2)} per credit
                  </p>
                </div>

                {/* Divider rather than a border on the next element, so the card
                    reads as one object instead of two stacked ones. */}
                <div className="border-t border-[#eeeeea] px-6 py-3 mt-auto">
                  <span className="text-[11px] font-mono text-[#4a4a47]">
                    {searches >= 1000 ? 'several months of daily sweeps' : 'several weeks of daily sweeps'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* ---- What a search costs ------------------------------------------ */}
        <div className="mt-16 grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 bg-white border border-[#e3e3de] p-6 md:p-7">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-[#eeeeea] mb-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-[#141414] font-bold">
                What one search costs
              </p>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#f6f6f4] border border-[#e3e3de] text-[10px] font-mono text-[#4a4a47]">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Start with {welcomeCredits} free
              </span>
            </div>

            <ul>
              {searchCosts.map((s) => (
                <li
                  key={s.channel}
                  className="flex items-center justify-between gap-4 py-2.5 border-b border-[#f5f5f2] last:border-0"
                >
                  <div className="flex items-baseline gap-2.5 min-w-0">
                    <Check className="w-3.5 h-3.5 text-[#141414] flex-shrink-0 self-center" />
                    <span className="text-sm text-[#141414]">{s.channel}</span>
                    <span className="text-[11px] text-[#8a8a86] truncate hidden md:inline">
                      {s.note}
                    </span>
                  </div>
                  <span className="text-xs font-mono text-[#141414] flex-shrink-0">
                    {s.credits} cr
                  </span>
                </li>
              ))}
            </ul>

            <p className="text-[11px] text-[#8a8a86] font-mono mt-4 leading-relaxed">
              A channel is charged once per sweep, whether it worked first time or
              took a fallback. A search that finds nothing, or that the provider
              charges nothing for, is not billed at all.
            </p>
          </div>

          {/* ---- What every package includes -------------------------------- */}
          <div className="lg:col-span-2 bg-white border border-[#e3e3de] p-6 md:p-7">
            <p className="text-[10px] font-mono uppercase tracking-wider text-[#141414] font-bold pb-4 border-b border-[#eeeeea]">
              Always included
            </p>
            <ul className="space-y-2 mt-4">
              {[
                '8 tracked keywords',
                '3 channels at once',
                'A daily sweep at your hour',
                'Intent scoring on every mention',
                'AI keyword suggestions',
                'AI outreach drafts',
                'CSV and JSON export',
              ].map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-xs text-[#4a4a47]">
                  <Check className="w-3.5 h-3.5 text-[#141414] flex-shrink-0 mt-0.5" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* ---- Close -------------------------------------------------------- */}
        <div className="mt-10 flex flex-col sm:flex-row sm:items-center justify-between gap-5 bg-white border border-[#e3e3de] p-6">
          <p className="text-xs text-[#4a4a47] leading-relaxed max-w-lg">
            Credits are yours once bought. There is no subscription to cancel, no
            renewal to miss, and a sweep that cannot be paid for does not start.
          </p>
          <button
            onClick={onStart}
            className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-[#121212] hover:bg-black text-white text-sm font-mono transition-colors shrink-0 cursor-pointer"
          >
            Start with {welcomeCredits} free credits
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </section>
  );
};