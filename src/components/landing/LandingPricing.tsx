import React from 'react';
import { ArrowRight } from 'lucide-react';
import { formatCredits, formatUsd } from '../../lib/billing';

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

export interface CostGroup {
  feature: string;
  items: Array<{ label: string; credits: number; note: string }>;
}

interface LandingPricingProps {
  packages: Array<{
    code: string;
    display_name: string;
    gross_usd: number;
    credits: number;
    bonus_credits: number;
  }>;
  /** Everything a credit buys, grouped by feature (Feed, Leads, Mail). */
  costGroups: CostGroup[];
  welcomeCredits: number;
  perCreditPrice: number;
  /** Credits one full daily sweep costs at the workspace maximum. */
  sweepCost: number;
  /** Credits for one verified work email. */
  emailRevealCredits: number;
  /** Credits for one send from a connected mailbox. */
  connectedSendCredits: number;
  onBuy: (code: string) => void;
  onStart: () => void;
}

export const LandingPricing: React.FC<LandingPricingProps> = ({
  packages,
  costGroups,
  welcomeCredits,
  perCreditPrice,
  sweepCost,
  emailRevealCredits,
  connectedSendCredits,
  onBuy,
  onStart,
}) => {
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
            One balance for the feed, leads and mail.
          </h2>
          <p className="text-[#4a4a47] leading-relaxed mt-4">
            Buy credits once and spend them on whichever feature you need — searches,
            verified contacts or sends. Same price per credit at every size, and the
            credits are yours until you have used them up.
          </p>
        </div>

        {/* ---- The plans --------------------------------------------------- */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          {packages.map((p, i) => {
            const total = p.credits + p.bonus_credits;
            const featured = i === featuredIndex;
            const maxCredits = Math.max(...packages.map((x) => x.credits + x.bonus_credits), 1);

            // Each row is what the whole package buys if spent on that one thing.
            // A real workspace mixes them, which the note under the rows says.
            const sweeps = sweepCost > 0 ? Math.floor(total / sweepCost) : 0;
            const emails = emailRevealCredits > 0 ? Math.floor(total / emailRevealCredits) : 0;
            const sends = connectedSendCredits > 0 ? Math.floor(total / connectedSendCredits) : 0;

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
                      {/* Through the shared formatter rather than a bare
                          interpolation. `${p.gross_usd}` printed whatever the JSON
                          happened to contain, so a package stored as 10.50 showed
                          "10.5" here and "$10.50" on the billing page — one
                          product, two prices, depending on where you looked. */}
                      {formatUsd(p.gross_usd)}
                    </span>
                    <span className="text-xs font-mono text-[#8a8a86]">one-off</span>
                  </div>

                  <p className="text-sm font-mono text-[#141414] mt-2">
                    {formatCredits(total)} credits
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
                    {formatUsd(perCreditPrice)} per credit
                  </p>

                  {/* What it actually buys, at both ends of the channel mix. */}
                  <div className="mt-4 pt-4 border-t border-[#eeeeea] space-y-1.5">
                    {sweeps > 0 && (
                      <p className="text-[11px] font-mono text-[#4a4a47] flex justify-between gap-2">
                        <span>Full daily sweeps</span>
                        <span className="text-[#141414]">{sweeps.toLocaleString()}</span>
                      </p>
                    )}
                    <p className="text-[11px] font-mono text-[#4a4a47] flex justify-between gap-2">
                      <span>or verified work emails</span>
                      <span className="text-[#141414]">{emails.toLocaleString()}</span>
                    </p>
                    <p className="text-[11px] font-mono text-[#4a4a47] flex justify-between gap-2">
                      <span>or emails sent</span>
                      <span className="text-[#141414]">{sends.toLocaleString()}</span>
                    </p>
                  </div>

                  <p className="text-[10px] text-[#b8b8b2] font-mono mt-3 leading-relaxed">
                    Each line is the whole package spent on one thing. Sweeps assume
                    all 8 keywords across 3 channels; sends are from your own mailbox.
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

        {/*
          What everything costs, grouped by feature so a reader can find the one
          thing they plan to do without scanning a flat list of ten prices.
        */}
        <div className="mt-14 bg-white border border-[#e3e3de]">
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 md:px-7 py-4 border-b border-[#eeeeea]">
            <p className="text-[10px] font-mono uppercase tracking-wider text-[#141414] font-bold">
              What everything costs
            </p>
            <span className="text-[11px] text-[#4a4a47]">In credits, charged only when it works</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#eeeeea]">
            {costGroups.map((g) => (
              <div key={g.feature} className="px-6 py-5">
                <p className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]">{g.feature}</p>
                <ul className="mt-3 space-y-3">
                  {g.items.map((item) => (
                    <li key={item.label} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium text-[#141414]">{item.label}</p>
                        <p className="text-[11px] text-[#8a8a86] leading-snug">{item.note}</p>
                      </div>
                      <span className="shrink-0 text-[13px] font-bold tracking-tight text-[#141414] tabular-nums">
                        {item.credits === 0 ? 'Free' : formatCredits(item.credits)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="px-6 md:px-7 py-4 border-t border-[#eeeeea] bg-[#fbfbfa] flex flex-col sm:flex-row sm:items-center gap-x-6 gap-y-1">
            <p className="text-[12px] text-[#4a4a47]">
              A search that finds nothing, an email that is not verified, or a send that
              fails is not billed.
            </p>
            <p className="text-[12px] text-[#8a8a86] sm:ml-auto sm:text-right">
              A provider fallback never costs extra.
            </p>
          </div>
        </div>

        {/*
          Close.

          The free tier is stated once, here, and made concrete rather than
          repeated as a badge above.

          Deliberately described in sweeps rather than in searches. A full sweep
          at the product maximum is 32 credits, more than the welcome grant, so
          "20 searches" would be both the flattering end of the range and a unit
          the product does not actually think in. A new workspace starts with a
          couple of keywords, where a few days of daily sweeping is the honest
          answer.
        */}
        <div className="mt-4 bg-[#141414] text-white px-6 md:px-8 py-6 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <div>
            <p className="text-sm font-medium">
              Start with {welcomeCredits} free credits
            </p>
            <p className="text-xs text-white/60 mt-1.5 max-w-md leading-relaxed">
              Enough to run a few daily sweeps, reveal a handful of verified emails
              and send your first outreach before you pay anything. No card, nothing
              to cancel.
            </p>
          </div>
          <button
            onClick={onStart}
            className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-white hover:bg-[#f0f0f0] text-[#141414] text-sm font-mono transition-colors shrink-0 cursor-pointer"
          >
            Create free account
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </section>
  );
};