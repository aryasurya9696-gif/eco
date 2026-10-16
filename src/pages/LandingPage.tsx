import React, { useState } from 'react';
import { BrandLogo } from '../components/common/BrandLogo';
import { PlatformBadge } from '../components/common/PlatformBadge';
import {
  ArrowRight,
  Check,
  ExternalLink,
  Sparkles,
  ChevronDown
} from 'lucide-react';

interface LandingPageProps {
  onNavigateAuth: () => void;
  onNavigateDashboard: () => void;
  isLoggedIn: boolean;
}

interface DemoLead {
  id: string;
  keyword: string;
  platform: 'twitter' | 'linkedin' | 'reddit' | 'google' | 'news';
  channel_source?: string;
  author: string;
  handle: string;
  body: string;
  time: string;
  intent: number;
}

const DEMO_LEADS: DemoLead[] = [
  {
    id: 'lead-1',
    keyword: 'ai agents',
    platform: 'twitter',
    author: 'Alex Rivera',
    handle: '@alexrivera_tech',
    body: 'We are migrating our entire outbound prospect qualification flow to autonomous ai agents next week. Currently vetting solutions for CRM enrichment and automatic lead intent scoring. Who are the top 3 contenders I should test right now?',
    time: '2h ago',
    intent: 97,
  },
  {
    id: 'lead-2',
    keyword: 'b2b lead gen',
    platform: 'linkedin',
    author: 'Sarah Chen',
    handle: 'VP of Growth @ Horizon Scale',
    body: "Traditional cold email open rates dropped 35% across our portfolio companies this quarter. We're actively shifting budget toward real-time social listening and buyer-intent triggers on LinkedIn & X. Looking for tools that monitor specific competitor mentions without enterprise bloatware pricing.",
    time: '5h ago',
    intent: 95,
  },
  {
    id: 'lead-3',
    keyword: 'sales automation',
    platform: 'reddit',
    channel_source: 'r/SaaS',
    author: 'u/cloud_architect',
    handle: 'r/SaaS • 14.2k members',
    body: 'Looking for a reliable way to monitor social signals across Reddit, Twitter and Google discussions for people complaining about our competitors. Most tools cost $500+/mo. Are there lean alternatives with webhook alerts?',
    time: '4h ago',
    intent: 96,
  },
  {
    id: 'lead-4',
    keyword: 'ai agents',
    platform: 'news',
    channel_source: 'TechCrunch',
    author: 'TechCrunch',
    handle: 'TechCrunch',
    body: 'Launchpad raises a $40M Series B to put autonomous sales agents in every revenue team; hiring 30 across engineering and GTM.',
    time: '6h ago',
    intent: 94,
  },
  {
    id: 'lead-5',
    keyword: 'sales automation',
    platform: 'google',
    channel_source: 'Google Discussions & Forums',
    author: 'Elena Rostova',
    handle: 'Tech Forum Index • Top Result',
    body: 'What is the modern stack for real-time social intent signals? Need daily automated alerts across public web conversations without getting blocked by rate limits.',
    time: '8h ago',
    intent: 92,
  },
  {
    id: 'lead-6',
    keyword: 'b2b lead gen',
    platform: 'twitter',
    author: 'Marcus Vance',
    handle: '@marcus_founder',
    body: 'Our sales reps spend over 2 hours every day manually scrolling social channels to find prospects complaining about legacy CRM software. If anyone has built clean sales automation that scrapes these mentions into a daily digest, DM me immediately. Budget is ready.',
    time: '9h ago',
    intent: 99,
  },
];

/** Resolved once at module load so the footer year is stable across renders. */
const COPYRIGHT_YEAR = new Date().getFullYear();

export const LandingPage: React.FC<LandingPageProps> = ({
  onNavigateAuth,
  onNavigateDashboard,
  isLoggedIn,
}) => {
  const [selectedKeyword, setSelectedKeyword] = useState<string>('all');
  const [selectedPlatform, setSelectedPlatform] = useState<string>('all');
  const [annualBilling, setAnnualBilling] = useState<boolean>(true);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const handleCta = () => {
    if (isLoggedIn) {
      onNavigateDashboard();
    } else {
      onNavigateAuth();
    }
  };

  const filteredLeads = DEMO_LEADS.filter((l) => {
    const matchKw = selectedKeyword === 'all' || l.keyword === selectedKeyword;
    const matchPlat = selectedPlatform === 'all' || l.platform === selectedPlatform;
    return matchKw && matchPlat;
  });

  const faqs = [
    {
      q: 'How does the daily sweep work?',
      a: 'Every morning at your configured schedule (e.g. 06:00 UTC), Echo sweeps public posts matching your keywords across X, LinkedIn, Reddit, the open web and the press. Matches are deduplicated and qualified straight into your feed.',
    },
    {
      q: 'How does Echo prevent runaway API usage?',
      a: 'Each sweep strictly caps pagination at 2 pages per keyword per platform, and disabled channels are skipped entirely. API consumption stays bounded and predictable.',
    },
    {
      q: 'Are historical duplicates prevented?',
      a: 'Yes. Our database enforces a unique constraint on (user_id, post_url). Even if a post matches multiple keywords or spans across multiple sweeps, it only appears once in your feed.',
    },
    {
      q: 'Can I export leads to my CRM or CSV?',
      a: 'Yes. You can export your filtered mentions to CSV or JSON with one click directly from your dashboard.',
    },
  ];

  return (
    <div className="min-h-screen bg-[#f6f6f4] text-[#141414] flex flex-col font-sans selection:bg-[#141414] selection:text-white">
      {/* Top Modern Announcement Banner */}
      <a
        href="#preview"
        className="group relative bg-[#0d0d0d] text-[#e0e0dc] py-2.5 px-4 text-xs border-b border-[#222222] transition-colors hover:bg-black block z-50"
      >
        <div className="max-w-5xl mx-auto flex items-center justify-center gap-2.5 text-center flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[11px] font-medium flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            New
          </span>
          <span className="text-white font-medium">Multi-Platform Intelligence is live:</span>
          <span className="text-[#a0a09a]">
            Now monitoring buyer intent across <strong className="text-white font-medium">X, LinkedIn, Reddit, Web & News</strong>
          </span>
          <span className="inline-flex items-center gap-1 text-emerald-400 group-hover:text-emerald-300 font-medium ml-1 transition-transform group-hover:translate-x-0.5">
            <span>Explore live feed</span>
            <ArrowRight className="w-3 h-3" />
          </span>
        </div>
      </a>

      {/* Modern Navbar */}
      <header className="border-b border-[#e3e3de] bg-[#ffffff]/90 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <BrandLogo size="md" />

          <nav className="hidden md:flex items-center gap-8 text-xs font-medium text-[#5a5a56]">
            <a href="#preview" className="hover:text-[#141414] transition-colors">
              Product
            </a>
            <a href="#how-it-works" className="hover:text-[#141414] transition-colors">
              How it works
            </a>
            <a href="#pricing" className="hover:text-[#141414] transition-colors">
              Pricing
            </a>
            <a href="#faq" className="hover:text-[#141414] transition-colors">
              FAQ
            </a>
          </nav>

          <div className="flex items-center gap-3">
            {isLoggedIn ? (
              <button
                onClick={onNavigateDashboard}
                className="px-4 py-2 bg-[#141414] hover:bg-black text-white text-xs font-medium rounded-md transition-all shadow-xs cursor-pointer"
              >
                Go to Dashboard →
              </button>
            ) : (
              <>
                <button
                  onClick={onNavigateAuth}
                  className="px-3.5 py-1.5 text-xs font-medium text-[#5a5a56] hover:text-[#141414] transition-colors cursor-pointer"
                >
                  Sign in
                </button>
                <button
                  onClick={onNavigateAuth}
                  className="px-4 py-2 bg-[#141414] hover:bg-black text-white text-xs font-medium rounded-md transition-all shadow-xs hover:shadow-sm cursor-pointer"
                >
                  Start Free Trial
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1">
        {/* HERO SECTION */}
        <section className="relative overflow-hidden pt-16 pb-16 md:pt-20 md:pb-20 px-6 border-b border-[#e3e3de] bg-[#f6f6f4]">
          {/* Architectural 58px Grid Theme with Radial Fade */}
          <div className="absolute inset-0 bg-grid-58 bg-grid-fade pointer-events-none" />

          {/* Animated Ambient Pulse Glow in Background */}
          <div className="absolute top-1/2 left-1/2 w-[720px] h-[520px] rounded-full bg-radial from-emerald-500/10 via-emerald-500/5 to-transparent blur-3xl pointer-events-none animate-ambient-glow" />

          {/* Animated Concentric Radar Scanner Rings */}
          <div className="absolute top-1/3 left-1/2 pointer-events-none -translate-x-1/2 -translate-y-1/2 flex items-center justify-center opacity-60">
            <div className="w-[280px] h-[280px] rounded-full border border-emerald-500/25 animate-ping duration-1000" />
            <div className="absolute w-[460px] h-[460px] rounded-full border border-[#deded8]/60" />
            <div className="absolute w-[680px] h-[680px] rounded-full border border-[#e3e3de]/40" />
            {/* Rotating Radar Sweep Light Beam */}
            <div className="absolute top-1/2 left-1/2 w-[680px] h-[680px] pointer-events-none animate-radar-beam">
              <div className="w-1/2 h-1/2 bg-gradient-to-br from-emerald-500/10 via-transparent to-transparent origin-bottom-right rounded-tl-full" />
            </div>
          </div>

          <div className="relative z-10 max-w-3xl mx-auto text-center space-y-6">
            {/* Pill Tag */}
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white border border-[#e3e3de] shadow-xs text-xs font-medium text-[#4a4a47]">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span>Autonomous Buyer Intent Intelligence</span>
            </div>

            {/* Main Headline */}
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-[#141414] leading-[1.1] max-w-2xl mx-auto">
              Turn social conversations into ready-to-buy pipeline.
            </h1>

            {/* Subtitle */}
            <p className="text-base sm:text-lg text-[#555550] max-w-xl mx-auto leading-relaxed">
              Track keywords that signal purchase intent. Every morning, Echo automatically sweeps discussions across 5 platforms and delivers qualified buyer leads straight to your feed.
            </p>

            {/* Dual CTAs */}
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                onClick={handleCta}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3 bg-[#141414] hover:bg-black text-white text-xs font-medium rounded-md transition-all cursor-pointer shadow-sm hover:shadow-md"
              >
                <span>{isLoggedIn ? 'Open Your Feed' : 'Start 14-Day Free Trial'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>

              <a
                href="#preview"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-5 py-3 bg-white hover:bg-[#fafaf8] border border-[#d6d6d0] text-xs font-medium text-[#141414] rounded-md transition-colors cursor-pointer shadow-2xs"
              >
                <span>Live Feed Preview</span>
                <span className="text-[#8a8a86]">↓</span>
              </a>
            </div>

            {/* Trust Badges */}
            <div className="flex flex-wrap items-center justify-center gap-5 text-xs text-[#70706b] pt-1">
              <span className="inline-flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span>No credit card required</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span>2-minute setup</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span>Zero duplicate leads</span>
              </span>
            </div>
          </div>
        </section>

        {/* LIVE FEED PREVIEW */}
        <section id="preview" className="py-16 px-6 max-w-4xl mx-auto">
          <div className="text-center max-w-xl mx-auto mb-8 space-y-3">
            <span className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86] block">
              Live Product Preview
            </span>
            <h2 className="text-2xl font-bold tracking-tight text-[#141414]">
              Clean feed. Zero noise.
            </h2>
            <p className="text-xs text-[#4a4a47]">
              Real-time qualified buyer leads categorized by platform and intent score.
            </p>

            {/* Filter controls */}
            <div className="pt-2 space-y-2.5">
              {/* Platform selector */}
              <div className="inline-flex flex-wrap items-center justify-center border border-[#e3e3de] bg-white p-0.5 text-xs font-mono">
                {(['all', 'twitter', 'linkedin', 'reddit', 'google', 'news'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setSelectedPlatform(p)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 transition-colors cursor-pointer ${
                      selectedPlatform === p
                        ? 'bg-[#141414] text-white font-medium shadow-2xs'
                        : 'text-[#4a4a47] hover:text-[#141414]'
                    }`}
                  >
                    {p !== 'all' && <PlatformBadge platform={p} size={13} />}
                    <span>
                      {p === 'all'
                        ? 'All Channels'
                        : p === 'twitter'
                        ? 'X'
                        : p === 'linkedin'
                        ? 'LinkedIn'
                        : p === 'reddit'
                        ? 'Reddit'
                        : p === 'news'
                        ? 'News'
                        : 'Google'}
                    </span>
                  </button>
                ))}
              </div>

              {/* Keyword selector */}
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {['all', 'ai agents', 'b2b lead gen', 'sales automation'].map((kw) => (
                  <button
                    key={kw}
                    onClick={() => setSelectedKeyword(kw)}
                    className={`px-2.5 py-0.5 text-[11px] font-mono rounded-full border transition-colors cursor-pointer capitalize ${
                      selectedKeyword === kw
                        ? 'bg-[#141414] text-white border-[#141414]'
                        : 'bg-white text-[#6e6e6a] border-[#e3e3de] hover:text-[#141414] hover:bg-[#f6f6f4]'
                    }`}
                  >
                    {kw === 'all' ? 'All Keywords' : kw}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Preview Card Shell */}
          <div className="bg-[#ffffff] border border-[#e3e3de] shadow-sm rounded-none overflow-hidden">
            {/* Refined Window Chrome Header */}
            <div className="px-4 py-3 bg-[#f6f6f4] border-b border-[#e3e3de] flex items-center justify-between text-[11px] font-mono">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-[#e3e3de] border border-[#cececa]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[#e3e3de] border border-[#cececa]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[#e3e3de] border border-[#cececa]" />
                <span className="ml-2.5 text-[#6e6e6a]">
                  echo.app/feed • 24h sweep active (06:00 UTC)
                </span>
              </div>
              <div className="inline-flex items-center gap-1.5 text-[10px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 border border-emerald-200 rounded-full font-medium">
                <span className="flex h-1.5 w-1.5 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                </span>
                <span>MONITORING ACTIVE</span>
              </div>
            </div>

            {/* Cards List */}
            <div className="p-5 space-y-3 bg-[#fbfbfa]">
              {filteredLeads.map((lead) => (
                <article
                  key={lead.id}
                  className="bg-white border border-[#e3e3de] p-4 sm:p-5 transition-colors hover:border-[#141414] space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <PlatformBadge platform={lead.platform} size={20} />
                      <div className="flex flex-wrap items-center gap-2 truncate">
                        <span className="text-xs font-semibold text-[#141414]">
                          {lead.author}
                        </span>
                        <span className="text-[11px] text-[#8a8a86] font-mono truncate">
                          {lead.handle}
                        </span>
                        {lead.channel_source && (
                          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded-xs border font-medium ${
                            lead.platform === 'reddit'
                              ? 'bg-orange-50 text-[#ff4500] border-orange-200'
                              : lead.platform === 'news'
                              ? 'bg-amber-50 text-[#b45309] border-amber-200'
                              : 'bg-indigo-50 text-[#4285f4] border-indigo-200'
                          }`}>
                            {lead.channel_source}
                          </span>
                        )}
                        <span className="inline-flex items-center px-2 py-0.5 bg-[#eeeeea] text-[#141414] text-[10px] font-mono rounded-full border border-[#deded8]">
                          matched: {lead.keyword}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0 text-[11px] font-mono text-[#8a8a86]">
                      <span>{lead.time}</span>
                      <ExternalLink className="w-3 h-3 text-[#4a4a47]" />
                    </div>
                  </div>

                  <p className="text-xs text-[#262626] leading-relaxed pl-7">
                    "{lead.body}"
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section id="how-it-works" className="py-16 px-6 border-t border-[#e3e3de] bg-[#ffffff]">
          <div className="max-w-4xl mx-auto space-y-10">
            <div className="text-center max-w-md mx-auto space-y-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86] block">
                Workflow
              </span>
              <h2 className="text-2xl font-bold tracking-tight text-[#141414]">
                How Echo Works
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="border border-[#e3e3de] p-5 space-y-3 bg-[#f6f6f4]">
                <span className="text-xl font-mono font-bold text-[#8a8a86]">01</span>
                <h3 className="text-sm font-bold text-[#141414]">Set your keywords</h3>
                <p className="text-xs text-[#4a4a47] font-mono leading-relaxed">
                  Enter keywords describing your buyer pain points, competitors, or category queries — 5 on Starter, 10 on Pro, 25 on Scale.
                </p>
              </div>

              <div className="border border-[#e3e3de] p-5 space-y-3 bg-[#f6f6f4]">
                <span className="text-xl font-mono font-bold text-[#8a8a86]">02</span>
                <h3 className="text-sm font-bold text-[#141414]">Multi-channel daily sweep</h3>
                <p className="text-xs text-[#4a4a47] font-mono leading-relaxed">
                  Every morning at your scheduled time, Echo scans X, LinkedIn, Reddit, the open web and the press for buyer mentions.
                </p>
              </div>

              <div className="border border-[#e3e3de] p-5 space-y-3 bg-[#f6f6f4]">
                <span className="text-xl font-mono font-bold text-[#8a8a86]">03</span>
                <h3 className="text-sm font-bold text-[#141414]">Reach out & convert</h3>
                <p className="text-xs text-[#4a4a47] font-mono leading-relaxed">
                  Review fresh mentions in your feed, generate AI outreach drafts, or export directly to CSV.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* PRICING */}
        <section id="pricing" className="py-20 px-6 border-t border-[#e3e3de] bg-[#ffffff]">
          <div className="max-w-5xl mx-auto space-y-12">
            {/* Header & Toggle */}
            <div className="text-center max-w-xl mx-auto space-y-4">
              <span className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86] block">
                Transparent Pricing
              </span>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#141414]">
                Simple, predictable plans for every team.
              </h2>
              <p className="text-xs sm:text-sm text-[#4a4a47]">
                Track high-intent buyer leads with zero surprise bills. Daily sweeps with bounded pagination.
              </p>

              {/* Segmented Pill Toggle */}
              <div className="pt-2 flex justify-center">
                <div className="inline-flex items-center p-1 bg-[#f0f0ec] border border-[#e3e3de] rounded-full text-xs font-mono">
                  <button
                    type="button"
                    onClick={() => setAnnualBilling(false)}
                    className={`px-4 py-2 rounded-full transition-all duration-200 cursor-pointer ${
                      !annualBilling
                        ? 'bg-white text-[#141414] font-semibold shadow-xs'
                        : 'text-[#6e6e6a] hover:text-[#141414]'
                    }`}
                  >
                    Monthly billing
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnnualBilling(true)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full transition-all duration-200 cursor-pointer ${
                      annualBilling
                        ? 'bg-[#141414] text-white font-semibold shadow-xs'
                        : 'text-[#6e6e6a] hover:text-[#141414]'
                    }`}
                  >
                    <span>Annual billing</span>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold transition-colors ${
                        annualBilling
                          ? 'bg-emerald-400 text-[#141414]'
                          : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      Save 20%
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* 3 Pricing Cards */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
              {/* Starter */}
              <div className="border border-[#e3e3de] p-7 flex flex-col justify-between bg-white hover:border-[#141414] transition-all duration-200 hover:shadow-md">
                <div>
                  {/* Card Header */}
                  <div className="flex items-center justify-between pb-3">
                    <span className="text-xs font-mono uppercase font-bold text-[#141414] tracking-wide">
                      Starter
                    </span>
                    <span className="text-[11px] font-mono text-[#8a8a86]">Solo & Brand</span>
                  </div>

                  <p className="text-xs text-[#5a5a56] min-h-[36px] leading-relaxed">
                    For founders and early products monitoring brand mentions and initial pain points.
                  </p>

                  {/* Price Block */}
                  <div className="pt-5 pb-5 border-t border-[#eeeeea] mt-4">
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-bold font-mono text-[#141414] tracking-tight">
                        {annualBilling ? '$23' : '$29'}
                      </span>
                      <span className="text-xs font-mono text-[#8a8a86]">/ month</span>
                      {annualBilling && (
                        <span className="text-xs font-mono text-[#8a8a86] line-through">
                          $29
                        </span>
                      )}
                    </div>

                    <div className="mt-2 min-h-[24px] flex items-center justify-between text-[11px] font-mono">
                      <span className="text-[#8a8a86]">
                        {annualBilling ? 'Billed annually ($276/yr)' : 'Billed month-to-month'}
                      </span>
                      {annualBilling && (
                        <span className="text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded-xs border border-emerald-200">
                          Save $72/yr
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Feature List */}
                  <ul className="space-y-3 pt-5 border-t border-[#eeeeea] text-xs font-mono text-[#4a4a47]">
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>Up to 5 tracked keywords</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>2 Channels: X & LinkedIn daily sweeps</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>Strict 2-page safety bounds</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>Automatic duplicate prevention</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>Daily email digest alerts</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>CSV & JSON lead export</span>
                    </li>
                  </ul>
                </div>

                {/* Button */}
                <div className="pt-8 mt-auto">
                  <button
                    onClick={handleCta}
                    className="w-full h-11 bg-white hover:bg-[#f6f6f4] border border-[#deded8] hover:border-[#141414] text-xs font-mono text-[#141414] font-medium transition-all duration-200 cursor-pointer shadow-2xs"
                  >
                    Start 14-Day Free Trial
                  </button>
                </div>
              </div>

              {/* Pro (Highlighted / Most Popular) */}
              <div className="border-2 border-[#141414] p-7 flex flex-col justify-between bg-white shadow-xl relative hover:shadow-2xl transition-all duration-200">
                {/* Floating Top Badge */}
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-3.5 py-0.5 bg-[#141414] text-white text-[10px] font-mono uppercase tracking-wider font-semibold shadow-xs">
                  Most Popular
                </div>

                <div>
                  {/* Card Header */}
                  <div className="flex items-center justify-between pb-3">
                    <span className="text-xs font-mono uppercase font-bold text-[#141414] tracking-wide">
                      Pro
                    </span>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 text-[10px] font-mono font-medium rounded-xs">
                      Best Value
                    </span>
                  </div>

                  <p className="text-xs text-[#5a5a56] min-h-[36px] leading-relaxed">
                    For B2B outbound teams turning active social conversations into pipeline.
                  </p>

                  {/* Price Block */}
                  <div className="pt-5 pb-5 border-t border-[#eeeeea] mt-4">
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-bold font-mono text-[#141414] tracking-tight">
                        {annualBilling ? '$63' : '$79'}
                      </span>
                      <span className="text-xs font-mono text-[#8a8a86]">/ month</span>
                      {annualBilling && (
                        <span className="text-xs font-mono text-[#8a8a86] line-through">
                          $79
                        </span>
                      )}
                    </div>

                    <div className="mt-2 min-h-[24px] flex items-center justify-between text-[11px] font-mono">
                      <span className="text-[#8a8a86]">
                        {annualBilling ? 'Billed annually ($756/yr)' : 'Billed month-to-month'}
                      </span>
                      {annualBilling && (
                        <span className="text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded-xs border border-emerald-200">
                          Save $192/yr
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Feature List */}
                  <ul className="space-y-3 pt-5 border-t border-[#eeeeea] text-xs font-mono text-[#4a4a47]">
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      <span className="font-medium text-[#141414]">Up to 10 tracked keywords</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      <span className="font-medium text-[#141414]">All 5 Channels (X, IN, Reddit, FB, Google)</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Sparkles className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      <span className="font-medium text-[#141414]">AI Outreach Drafter (4 tones)</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      <span>Real-time Slack & Discord alerts</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      <span>Buyer intent score qualification</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      <span>Priority API sweep queue</span>
                    </li>
                  </ul>
                </div>

                {/* Button */}
                <div className="pt-8 mt-auto">
                  <button
                    onClick={handleCta}
                    className="w-full h-11 bg-[#141414] hover:bg-black text-white text-xs font-mono font-medium transition-all duration-200 cursor-pointer shadow-sm hover:shadow-md"
                  >
                    Start Pro Free Trial →
                  </button>
                </div>
              </div>

              {/* Scale */}
              <div className="border border-[#e3e3de] p-7 flex flex-col justify-between bg-white hover:border-[#141414] transition-all duration-200 hover:shadow-md">
                <div>
                  {/* Card Header */}
                  <div className="flex items-center justify-between pb-3">
                    <span className="text-xs font-mono uppercase font-bold text-[#141414] tracking-wide">
                      Scale
                    </span>
                    <span className="text-[11px] font-mono text-[#8a8a86]">Agencies & RevOps</span>
                  </div>

                  <p className="text-xs text-[#5a5a56] min-h-[36px] leading-relaxed">
                    For agencies and scaleups tracking whole market categories and competitors.
                  </p>

                  {/* Price Block */}
                  <div className="pt-5 pb-5 border-t border-[#eeeeea] mt-4">
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-bold font-mono text-[#141414] tracking-tight">
                        {annualBilling ? '$159' : '$199'}
                      </span>
                      <span className="text-xs font-mono text-[#8a8a86]">/ month</span>
                      {annualBilling && (
                        <span className="text-xs font-mono text-[#8a8a86] line-through">
                          $199
                        </span>
                      )}
                    </div>

                    <div className="mt-2 min-h-[24px] flex items-center justify-between text-[11px] font-mono">
                      <span className="text-[#8a8a86]">
                        {annualBilling ? 'Billed annually ($1,908/yr)' : 'Billed month-to-month'}
                      </span>
                      {annualBilling && (
                        <span className="text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded-xs border border-emerald-200">
                          Save $480/yr
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Feature List */}
                  <ul className="space-y-3 pt-5 border-t border-[#eeeeea] text-xs font-mono text-[#4a4a47]">
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>Up to 25 tracked keywords</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>12h accelerated sweep frequency</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Sparkles className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>Unlimited AI response drafts</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>Multi-seat team workspace</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>Custom CRM & Zapier sync</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#141414] flex-shrink-0 mt-0.5" />
                      <span>Dedicated onboarding assistance</span>
                    </li>
                  </ul>
                </div>

                {/* Button */}
                <div className="pt-8 mt-auto">
                  <button
                    onClick={handleCta}
                    className="w-full h-11 bg-white hover:bg-[#f6f6f4] border border-[#deded8] hover:border-[#141414] text-xs font-mono text-[#141414] font-medium transition-all duration-200 cursor-pointer shadow-2xs"
                  >
                    Start Scale Free Trial
                  </button>
                </div>
              </div>
            </div>

            {/* Bottom Assurance */}
            <div className="pt-4 flex flex-wrap items-center justify-center gap-6 text-xs font-mono text-[#8a8a86] border-t border-[#eeeeea]">
              <span>✓ 14-day free trial on all plans</span>
              <span>•</span>
              <span>✓ No credit card required</span>
              <span>•</span>
              <span>✓ Cancel or switch anytime with 1 click</span>
            </div>
          </div>
        </section>

        {/* FAQ ACCORDION */}
        <section id="faq" className="py-16 px-6 border-t border-[#e3e3de] bg-[#f6f6f4]">
          <div className="max-w-3xl mx-auto space-y-8">
            <div className="text-center max-w-sm mx-auto space-y-1">
              <span className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86] block">
                FAQ
              </span>
              <h2 className="text-2xl font-bold tracking-tight text-[#141414]">
                Frequently Asked Questions
              </h2>
            </div>

            <div className="divide-y divide-[#e3e3de] border-y border-[#e3e3de]">
              {faqs.map((faq, idx) => {
                const isOpen = openFaq === idx;
                return (
                  <div key={idx} className="py-4">
                    <button
                      onClick={() => setOpenFaq(isOpen ? null : idx)}
                      className="w-full flex items-center justify-between text-left text-xs font-mono font-semibold text-[#141414] hover:text-black cursor-pointer"
                    >
                      <span>{faq.q}</span>
                      <ChevronDown
                        className={`w-3.5 h-3.5 text-[#8a8a86] transition-transform ${isOpen ? 'rotate-180 text-[#141414]' : ''
                          }`}
                      />
                    </button>
                    {isOpen && (
                      <p className="mt-2 text-xs font-mono text-[#4a4a47] leading-relaxed pr-6">
                        {faq.a}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* FINAL SIMPLE CTA */}
        <section className="py-16 px-6 border-t border-[#e3e3de] bg-[#141414] text-white text-center">
          <div className="max-w-2xl mx-auto space-y-5">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Start monitoring buyer intent today.
            </h2>
            <p className="text-xs text-[#8a8a86] font-mono">
              Sign up in 30 seconds. No email verification required.
            </p>
            <div>
              <button
                onClick={handleCta}
                className="inline-flex items-center gap-2 px-6 py-3 bg-white hover:bg-[#f6f6f4] text-[#141414] text-xs font-mono font-semibold transition-colors cursor-pointer"
              >
                <span>{isLoggedIn ? 'Go to Dashboard' : 'Start Monitoring Now'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#e3e3de] bg-[#ffffff] py-6 px-6 text-xs font-mono text-[#8a8a86]">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <BrandLogo size="sm" />
          <p>© {COPYRIGHT_YEAR} Echo Social Intelligence. All rights reserved.</p>
          <div className="flex items-center gap-3 text-[#4a4a47]">
            <span>X (Twitter)</span>
            <span>•</span>
            <span>LinkedIn</span>
            <span>•</span>
            <span>Reddit</span>
            <span>•</span>
            <span>Web</span>
            <span>•</span>
            <span>News</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
