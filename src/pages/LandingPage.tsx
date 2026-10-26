import React, { useEffect, useState } from 'react';
import { BrandLogo } from '../components/common/BrandLogo';
import { PlatformBadge } from '../components/common/PlatformBadge';
import { supabase, isConfigured } from '../lib/supabase';
import {
  CHANNEL_LIMIT,
  CHANNEL_SEARCH_CREDITS,
  COMPANY_ENRICH_CREDITS,
  CONNECTED_SEND_CREDITS,
  DIRECT_PHONE_CREDITS,
  HOSTED_SEND_CREDITS,
  KEYWORD_LIMIT,
  MAX_SWEEP_CREDITS,
  PEOPLE_SEARCH_CREDITS,
  VERIFIED_EMAIL_CREDITS,
  WELCOME_CREDITS,
  channelLabel,
  creditsText,
  formatCreditAmount,
} from '../lib/constants';
import { rememberIntendedPackage } from '../lib/tab-routing';
import { LandingPricing, type CostGroup } from '../components/landing/LandingPricing';
import {
  ArrowRight,
  Check,
  ExternalLink,
  ChevronDown,
  Radar,
  UserSearch,
  Send,
  Sparkles,
  BadgeCheck,
  Phone,
  Mail,
} from 'lucide-react';

/**
 * Everything a credit can be spent on, grouped by feature.
 *
 * Every number comes from the one client-side price list in lib/constants
 * (kept equal to pricing_config). This page is public, and the live pricing
 * action needs a session, so the constants are the source here; signed-in
 * views read the live prices through lib/pricing.
 */
const COST_GROUPS: CostGroup[] = [
  {
    feature: 'Feed',
    items: [
      { label: 'X search', credits: CHANNEL_SEARCH_CREDITS.twitter, note: 'per keyword, per sweep' },
      { label: 'Reddit search', credits: CHANNEL_SEARCH_CREDITS.reddit, note: 'per keyword, per sweep' },
      { label: 'Web search', credits: CHANNEL_SEARCH_CREDITS.google, note: 'per keyword, per sweep' },
      { label: 'News search', credits: CHANNEL_SEARCH_CREDITS.news, note: 'always free' },
    ],
  },
  {
    feature: 'Leads',
    items: [
      { label: 'People search', credits: PEOPLE_SEARCH_CREDITS, note: 'per billed provider call; one search can make several' },
      { label: 'Verified work email', credits: VERIFIED_EMAIL_CREDITS, note: 'per email revealed' },
      { label: 'Direct phone', credits: DIRECT_PHONE_CREDITS, note: 'per phone revealed' },
      { label: 'Company profile', credits: COMPANY_ENRICH_CREDITS, note: 'per company found; already-known companies are free' },
    ],
  },
  {
    feature: 'Mail',
    items: [
      { label: 'Send from your mailbox', credits: CONNECTED_SEND_CREDITS, note: 'Gmail, Zoho or any SMTP mailbox' },
      { label: 'Send from an Echo domain', credits: HOSTED_SEND_CREDITS, note: 'your domain, DKIM & SPF set up' },
    ],
  },
];

/** Sweeps the welcome credits cover at the product maximum (8 keywords, 3 paid channels). */
const WELCOME_SWEEPS = MAX_SWEEP_CREDITS > 0 ? Math.floor(WELCOME_CREDITS / MAX_SWEEP_CREDITS) : 0;

/**
 * Fallback prices, used only when Supabase is not configured — the local sandbox
 * case where nothing is deployed anyway. When the database is reachable it is
 * the source, so a price change cannot leave this page advertising something the
 * billing page no longer sells.
 */
const FALLBACK_PACKAGES = [
  { code: 'starter_200', display_name: '200 credits', gross_usd: 10, credits: 200, bonus_credits: 0 },
  { code: 'standard_500', display_name: '500 credits', gross_usd: 25, credits: 500, bonus_credits: 0 },
  { code: 'pack_1000', display_name: '1000 credits', gross_usd: 50, credits: 1000, bonus_credits: 0 },
];

interface LandingPageProps {
  onNavigateAuth: () => void;
  onNavigateDashboard: () => void;
  isLoggedIn: boolean;
}

// ---------------------------------------------------------------------------
// Product preview data. Illustrative only: names and companies are made up.
// ---------------------------------------------------------------------------

interface DemoSignal {
  id: string;
  keyword: string;
  platform: 'twitter' | 'reddit' | 'google' | 'news';
  channel_source?: string;
  author: string;
  handle: string;
  body: string;
  time: string;
}

const DEMO_SIGNALS: DemoSignal[] = [
  {
    id: 's-1',
    keyword: 'crm alternative',
    platform: 'twitter',
    author: 'Alex Rivera',
    handle: '@alexrivera_ops',
    body: 'Our CRM renewal quote just came in 40% higher. Seriously looking at alternatives this month — what are lean teams using for pipeline + outreach?',
    time: '2h ago',
  },
  {
    id: 's-2',
    keyword: 'cold email tool',
    platform: 'reddit',
    channel_source: 'r/sales',
    author: 'u/quota_crusher',
    handle: 'r/sales',
    body: 'Need a cold email setup that does not burn my main domain. Separate sending domain, warm-up limits, something simple. Recommendations?',
    time: '4h ago',
  },
  {
    id: 's-3',
    keyword: 'crm alternative',
    platform: 'news',
    channel_source: 'Press',
    author: 'Industry Wire',
    handle: 'Press release',
    body: 'Northwind Logistics raises $18M Series A and plans to triple its sales team by Q2, hiring across SDR and account executive roles.',
    time: '6h ago',
  },
  {
    id: 's-4',
    keyword: 'cold email tool',
    platform: 'google',
    channel_source: 'Web discussion',
    author: 'Elena Rostova',
    handle: 'Founder forum',
    body: 'What is everyone using to find verified work emails for decision makers? Bounce rates on our current list are above 20%.',
    time: '8h ago',
  },
];

const DEMO_LEADS = [
  { name: 'Priya Nair', title: 'VP Sales', company: 'Northwind Logistics', email: 'priya@northwind.io', phone: '+1 415 •••• 218', status: 'Contacted' },
  { name: 'Daniel Brooks', title: 'Head of Growth', company: 'Lumen Health', email: 'd.brooks@lumenhealth.com', phone: null, status: 'New' },
  { name: 'Sofia Marin', title: 'Revenue Ops Lead', company: 'Brightloop', email: 'sofia.m@brightloop.co', phone: '+44 20 •••• 0193', status: 'Replied' },
  { name: 'Kenji Watanabe', title: 'Founder & CEO', company: 'Fieldnote AI', email: 'kenji@fieldnote.ai', phone: null, status: 'New' },
];

type PreviewTab = 'feed' | 'leads' | 'mail';

/** Resolved once at module load so the footer year is stable across renders. */
const COPYRIGHT_YEAR = new Date().getFullYear();

const FEATURES = [
  {
    icon: Radar,
    name: 'Feed',
    title: 'Catch buying intent the day it is posted',
    body: 'Echo sweeps X, Reddit, the open web and the press on your schedule for the keywords you track — competitor names, pain points, category questions — and drops every match into one deduplicated feed.',
    points: [
      `Up to ${KEYWORD_LIMIT} keywords on ${CHANNEL_LIMIT} of 4 channels`,
      `${formatCreditAmount(CHANNEL_SEARCH_CREDITS.twitter)} credit per keyword per channel; News free`,
      'Each post appears once, ever',
    ],
  },
  {
    icon: UserSearch,
    name: 'Leads',
    title: 'Find the decision maker and their real contact',
    body: 'Search people by company, title, location or industry, or look one person up in seconds. Reveal a verified work email or a direct phone, and keep everyone in a saved pipeline.',
    points: [
      'Prospector & quick lookup',
      `Email ${creditsText(VERIFIED_EMAIL_CREDITS)}, phone ${creditsText(DIRECT_PHONE_CREDITS)}`,
      'Saved pipeline with status',
    ],
  },
  {
    icon: Send,
    name: 'Mail',
    title: 'Send outreach without leaving Echo',
    body: 'Connect Gmail or Zoho with an app password, or send from your own domain with DKIM and SPF set up. Write with AI, fill merge tags per lead, and keep every thread in one inbox.',
    points: ['Your mailbox or your domain', 'Daily send limits per mailbox', 'Merge tags per lead'],
  },
];

export const LandingPage: React.FC<LandingPageProps> = ({
  onNavigateAuth,
  onNavigateDashboard,
  isLoggedIn,
}) => {
  const [previewTab, setPreviewTab] = useState<PreviewTab>('feed');
  const [selectedPlatform, setSelectedPlatform] = useState<string>('all');
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [packages, setPackages] = useState(FALLBACK_PACKAGES);

  /**
   * Buying from the landing page and buying from the billing tab should feel like
   * one continuous action, not two. The package chosen out here is carried across
   * so the billing page opens on the card they picked rather than making them
   * choose it a second time.
   *
   * Stored (localStorage, with a TTL) rather than put in a query string, because
   * it has to survive sign-up through an email link that opens a new tab, and
   * onboarding after that.
   */
  const beginPurchase = (code: string) => {
    rememberIntendedPackage(code);
    if (isLoggedIn) onNavigateDashboard();
    else onNavigateAuth();
  };

  // Prices come from topup_packages, the same table checkout charges from. The
  // fallback above only applies where nothing is deployed. A landing page that
  // quotes its own prices is a page that will eventually be wrong.
  useEffect(() => {
    if (!isConfigured || !supabase) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('topup_packages')
          .select('code, display_name, gross_usd, credits, bonus_credits')
          .eq('active', true)
          .order('sort_order');
        if (!cancelled && !error && data && data.length > 0) {
          setPackages(data.map((p) => ({
            code: p.code,
            display_name: p.display_name,
            gross_usd: Number(p.gross_usd),
            credits: Number(p.credits),
            bonus_credits: Number(p.bonus_credits ?? 0),
          })));
        }
      } catch {
        // A pricing page that fails to load its prices is still better with the
        // seeded ones than blank, and these are the real seeded values.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleCta = () => {
    if (isLoggedIn) {
      onNavigateDashboard();
    } else {
      onNavigateAuth();
    }
  };

  const filteredSignals = DEMO_SIGNALS.filter(
    (l) => selectedPlatform === 'all' || l.platform === selectedPlatform
  );

  const faqs = [
    {
      q: 'What exactly does Echo do?',
      a: 'Three things in one workspace. The Feed finds people talking about the problem you solve on X, Reddit, the web and in the news. Leads finds the decision makers at those companies with verified contact details. Mail lets you write and send the outreach and keeps the replies together.',
    },
    {
      q: 'How does the daily sweep work?',
      a: `At your scheduled time (daily, twice a day or every 6 hours), Echo searches public posts matching your keywords across the channels you enable. X, Reddit and Web cost ${creditsText(CHANNEL_SEARCH_CREDITS.twitter)} per keyword per sweep; News is free. ${KEYWORD_LIMIT} keywords on ${CHANNEL_LIMIT} paid channels is ${creditsText(MAX_SWEEP_CREDITS)} per sweep. Matches are deduplicated — a post that matches several keywords or several sweeps still appears once.`,
    },
    {
      q: 'When am I charged for a lead?',
      a: `A people search costs ${creditsText(PEOPLE_SEARCH_CREDITS)} per billed provider call, and a single search can make more than one call; you are charged for the calls the provider bills, even when a search returns few or no results. Revealing a verified work email costs ${creditsText(VERIFIED_EMAIL_CREDITS)} and a direct phone ${creditsText(DIRECT_PHONE_CREDITS)}. Leads need purchased credits; the welcome credits do not cover them.`,
    },
    {
      q: 'Which mailboxes can I send from?',
      a: 'Gmail / Google Workspace and Zoho Mail with an app password, any provider that offers SMTP over SSL, or an address on your own domain once its DNS records are verified. Each mailbox has a daily send limit to protect its reputation. Your app password is stored encrypted and never shown again.',
    },
    {
      q: 'What happens when my credits run out?',
      a: 'Echo holds the credits a sweep, search or send needs before calling any provider, so if you are short you are told how much and the action does not run. There is no debt and no negative balance, and a failed send is refunded automatically.',
    },
    {
      q: 'Do the credits expire? Is there a subscription?',
      a: `No subscription and nothing renews. Credits you buy stay in your balance until you spend them. New accounts start with ${WELCOME_CREDITS} free credits, no card required. Welcome credits cover feed sweeps only (about ${WELCOME_SWEEPS} full daily sweeps of ${KEYWORD_LIMIT} keywords, roughly a week); Leads and Mail use purchased credits.`,
    },
    {
      q: 'Can I export my data?',
      a: 'Yes. Feed mentions and saved leads export to CSV with one click from the dashboard.',
    },
  ];

  const previewTabs: Array<{ id: PreviewTab; label: string; url: string }> = [
    { id: 'feed', label: 'Feed', url: 'echo.app/feed · sweep 06:00 UTC' },
    { id: 'leads', label: 'Leads', url: 'echo.app/leads · saved pipeline' },
    { id: 'mail', label: 'Mail', url: 'echo.app/mail · sent' },
  ];
  const activePreview = previewTabs.find((t) => t.id === previewTab)!;

  return (
    <div className="min-h-screen bg-[#f6f6f4] text-[#141414] flex flex-col font-sans selection:bg-[#141414] selection:text-white">
      {/* Announcement Banner */}
      <a
        href="#features"
        className="group relative bg-[#0d0d0d] text-[#e0e0dc] py-2.5 px-4 text-xs border-b border-[#222222] transition-colors hover:bg-black block z-50"
      >
        <div className="max-w-5xl mx-auto flex items-center justify-center gap-2.5 text-center flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[11px] font-medium flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            New
          </span>
          <span className="text-white font-medium">Leads & Mail are live:</span>
          <span className="text-[#a0a09a]">
            find verified contacts and send outreach <strong className="text-white font-medium">from the same workspace</strong>
          </span>
          <span className="inline-flex items-center gap-1 text-emerald-400 group-hover:text-emerald-300 font-medium ml-1 transition-transform group-hover:translate-x-0.5">
            <span>See what's new</span>
            <ArrowRight className="w-3 h-3" />
          </span>
        </div>
      </a>

      {/* Navbar */}
      <header className="border-b border-[#e3e3de] bg-[#ffffff]/90 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <BrandLogo size="md" />

          <nav className="hidden md:flex items-center gap-8 text-xs font-medium text-[#5a5a56]">
            <a href="#features" className="hover:text-[#141414] transition-colors">
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
                  Start Free
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* HERO */}
        <section className="relative overflow-hidden pt-16 pb-16 md:pt-20 md:pb-20 px-6 border-b border-[#e3e3de] bg-[#f6f6f4]">
          <div className="absolute inset-0 bg-grid-58 bg-grid-fade pointer-events-none" />
          <div className="absolute top-1/2 left-1/2 w-[720px] h-[520px] rounded-full bg-radial from-emerald-500/10 via-emerald-500/5 to-transparent blur-3xl pointer-events-none animate-ambient-glow" />
          <div className="absolute top-1/3 left-1/2 pointer-events-none -translate-x-1/2 -translate-y-1/2 flex items-center justify-center opacity-60">
            <div className="w-[280px] h-[280px] rounded-full border border-emerald-500/25 animate-ping duration-1000" />
            <div className="absolute w-[460px] h-[460px] rounded-full border border-[#deded8]/60" />
            <div className="absolute w-[680px] h-[680px] rounded-full border border-[#e3e3de]/40" />
            <div className="absolute top-1/2 left-1/2 w-[680px] h-[680px] pointer-events-none animate-radar-beam">
              <div className="w-1/2 h-1/2 bg-gradient-to-br from-emerald-500/10 via-transparent to-transparent origin-bottom-right rounded-tl-full" />
            </div>
          </div>

          <div className="relative z-10 max-w-3xl mx-auto text-center space-y-6">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white border border-[#e3e3de] shadow-xs text-xs font-medium text-[#4a4a47]">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span>Signals → Leads → Outreach, in one workspace</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-[#141414] leading-[1.1] max-w-2xl mx-auto">
              Spot buyers. Find their contact. Send the email.
            </h1>

            <p className="text-base sm:text-lg text-[#555550] max-w-xl mx-auto leading-relaxed">
              Echo watches X, Reddit, the web and the news for people who need what you sell, finds the decision
              makers with verified emails and phones, and sends your outreach from your own mailbox.
            </p>

            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                onClick={handleCta}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3 bg-[#141414] hover:bg-black text-white text-xs font-medium rounded-md transition-all cursor-pointer shadow-sm hover:shadow-md"
              >
                <span>{isLoggedIn ? 'Open Your Workspace' : `Start with ${WELCOME_CREDITS} free credits`}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>

              <a
                href="#preview"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-5 py-3 bg-white hover:bg-[#fafaf8] border border-[#d6d6d0] text-xs font-medium text-[#141414] rounded-md transition-colors cursor-pointer shadow-2xs"
              >
                <span>See the product</span>
                <span className="text-[#8a8a86]">↓</span>
              </a>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-5 text-xs text-[#70706b] pt-1">
              <span className="inline-flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span>No card, no subscription</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                <span>News search always free</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                <span>{WELCOME_CREDITS} free credits for feed sweeps</span>
              </span>
            </div>
          </div>
        </section>

        {/* FEATURES */}
        <section id="features" className="py-16 px-6 bg-[#ffffff] border-b border-[#e3e3de]">
          <div className="max-w-5xl mx-auto space-y-10">
            <div className="text-center max-w-xl mx-auto space-y-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86] block">Product</span>
              <h2 className="text-2xl font-bold tracking-tight text-[#141414]">
                Everything between "someone needs this" and "reply received"
              </h2>
              <p className="text-xs text-[#4a4a47]">
                Three tools that usually live in three subscriptions, sharing one credit balance.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {FEATURES.map((f) => {
                const Icon = f.icon;
                return (
                  <article key={f.name} className="border border-[#e3e3de] bg-[#f6f6f4] p-6 flex flex-col">
                    <div className="flex items-center gap-2.5">
                      <span className="w-8 h-8 flex items-center justify-center bg-[#141414] text-white">
                        <Icon className="w-4 h-4" />
                      </span>
                      <span className="text-[11px] font-mono uppercase tracking-wider text-[#4a4a47]">{f.name}</span>
                    </div>
                    <h3 className="mt-4 text-sm font-bold text-[#141414] leading-snug">{f.title}</h3>
                    <p className="mt-2 text-xs text-[#4a4a47] leading-relaxed flex-1">{f.body}</p>
                    <ul className="mt-4 pt-4 border-t border-[#e3e3de] space-y-1.5">
                      {f.points.map((pt) => (
                        <li key={pt} className="flex items-center gap-2 text-[11px] font-mono text-[#141414]">
                          <Check className="w-3 h-3 text-emerald-600 shrink-0" />
                          {pt}
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* PRODUCT PREVIEW */}
        <section id="preview" className="py-16 px-6 max-w-4xl mx-auto">
          <div className="text-center max-w-xl mx-auto mb-8 space-y-3">
            <span className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86] block">
              Product Preview
            </span>
            <h2 className="text-2xl font-bold tracking-tight text-[#141414]">One workspace. Zero tab-switching.</h2>
            <p className="text-xs text-[#4a4a47]">
              A signal in the feed becomes a saved lead, and a saved lead becomes a sent email — without copying
              anything between tools.
            </p>

            <div className="pt-2 inline-flex items-center border border-[#e3e3de] bg-white p-0.5 text-xs font-mono">
              {previewTabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setPreviewTab(t.id)}
                  className={`px-4 py-1.5 transition-colors cursor-pointer ${
                    previewTab === t.id
                      ? 'bg-[#141414] text-white font-medium shadow-2xs'
                      : 'text-[#4a4a47] hover:text-[#141414]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-[#ffffff] border border-[#e3e3de] shadow-sm overflow-hidden">
            {/* Window chrome */}
            <div className="px-4 py-3 bg-[#f6f6f4] border-b border-[#e3e3de] flex items-center justify-between gap-3 text-[11px] font-mono">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-2.5 h-2.5 shrink-0 rounded-full bg-[#e3e3de] border border-[#cececa]" />
                <div className="w-2.5 h-2.5 shrink-0 rounded-full bg-[#e3e3de] border border-[#cececa]" />
                <div className="w-2.5 h-2.5 shrink-0 rounded-full bg-[#e3e3de] border border-[#cececa]" />
                <span className="ml-2.5 text-[#6e6e6a] truncate">{activePreview.url}</span>
              </div>
              <div className="hidden sm:inline-flex items-center gap-1.5 text-[10px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 border border-emerald-200 rounded-full font-medium shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span>ILLUSTRATIVE DATA</span>
              </div>
            </div>

            {previewTab === 'feed' && (
              <div className="p-5 space-y-3 bg-[#fbfbfa]">
                <div className="flex flex-wrap gap-1.5 pb-1">
                  {(['all', 'twitter', 'reddit', 'google', 'news'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={selectedPlatform === p}
                      onClick={() => setSelectedPlatform(p)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono rounded-full border transition-colors cursor-pointer ${
                        selectedPlatform === p
                          ? 'bg-[#141414] text-white border-[#141414]'
                          : 'bg-white text-[#6e6e6a] border-[#e3e3de] hover:text-[#141414]'
                      }`}
                    >
                      {p !== 'all' && <PlatformBadge platform={p} size={12} />}
                      {p === 'all' ? 'All' : channelLabel(p)}
                    </button>
                  ))}
                </div>
                {filteredSignals.map((lead) => (
                  <article
                    key={lead.id}
                    className="bg-white border border-[#e3e3de] p-4 sm:p-5 transition-colors hover:border-[#141414] space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <PlatformBadge platform={lead.platform} size={20} />
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className="text-xs font-semibold text-[#141414]">{lead.author}</span>
                          <span className="text-[11px] text-[#8a8a86] font-mono truncate">{lead.handle}</span>
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
                    <p className="text-xs text-[#262626] leading-relaxed sm:pl-7">"{lead.body}"</p>
                  </article>
                ))}
              </div>
            )}

            {previewTab === 'leads' && (
              <div className="bg-[#fbfbfa] overflow-x-auto">
                <table className="w-full min-w-[640px] text-left">
                  <thead>
                    <tr className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] border-b border-[#e3e3de]">
                      <th className="px-5 py-2.5 font-medium">Person</th>
                      <th className="px-3 py-2.5 font-medium">Work email</th>
                      <th className="px-3 py-2.5 font-medium">Direct phone</th>
                      <th className="px-5 py-2.5 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#eeeeea] bg-white">
                    {DEMO_LEADS.map((l) => (
                      <tr key={l.email}>
                        <td className="px-5 py-3">
                          <div className="text-xs font-semibold text-[#141414]">{l.name}</div>
                          <div className="text-[11px] text-[#8a8a86]">
                            {l.title} · {l.company}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-[#141414]">
                            <BadgeCheck className="w-3.5 h-3.5 text-emerald-600" />
                            {l.email}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          {l.phone ? (
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-[#141414]">
                              <Phone className="w-3 h-3 text-[#4a4a47]" />
                              {l.phone}
                            </span>
                          ) : (
                            <span className="text-[11px] font-mono text-[#8a8a86]">Find · {formatCreditAmount(DIRECT_PHONE_CREDITS)} cr</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <span
                            className={`inline-flex px-2 py-0.5 text-[10px] font-mono rounded-full border ${
                              l.status === 'Replied'
                                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                : l.status === 'Contacted'
                                ? 'bg-sky-50 text-sky-800 border-sky-200'
                                : 'bg-[#f6f6f4] text-[#4a4a47] border-[#e3e3de]'
                            }`}
                          >
                            {l.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-5 py-3 text-[11px] font-mono text-[#8a8a86] border-t border-[#e3e3de]">
                  Verified email {creditsText(VERIFIED_EMAIL_CREDITS)} · direct phone {creditsText(DIRECT_PHONE_CREDITS)}.
                </p>
              </div>
            )}

            {previewTab === 'mail' && (
              <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr] bg-white">
                <ul className="border-b sm:border-b-0 sm:border-r border-[#e3e3de] divide-y divide-[#eeeeea] bg-[#fbfbfa]">
                  {DEMO_LEADS.slice(0, 3).map((l, i) => (
                    <li key={l.email} className={`px-4 py-3 ${i === 0 ? 'bg-white' : ''}`}>
                      <div className="text-xs font-semibold text-[#141414] truncate">{l.name}</div>
                      <div className="text-[11px] text-[#8a8a86] truncate">Quick intro // {l.company}</div>
                    </li>
                  ))}
                </ul>
                <div className="p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-bold text-[#141414]">Quick intro // Northwind Logistics</div>
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 border border-emerald-200 rounded-full">
                      <Check className="w-3 h-3" aria-hidden="true" /> Sent · {creditsText(CONNECTED_SEND_CREDITS)}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-[#8a8a86] space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <Mail className="w-3 h-3" /> From: you@yourcompany.com
                    </div>
                    <div>To: Priya Nair &lt;priya@northwind.io&gt;</div>
                  </div>
                  <div className="text-xs text-[#262626] leading-relaxed space-y-2 border-t border-[#eeeeea] pt-3">
                    <p>Hi Priya,</p>
                    <p>
                      Congrats on the Series A — tripling a sales team in two quarters usually means pipeline tooling
                      starts to creak. We help teams like Northwind find in-market buyers and reach them the same day.
                    </p>
                    <p>Worth a 15-minute look next week?</p>
                  </div>
                  <div className="inline-flex items-center gap-1.5 text-[10px] font-mono text-[#4a4a47] bg-[#f6f6f4] border border-[#e3e3de] px-2 py-1">
                    <Sparkles className="w-3 h-3" aria-hidden="true" /> Drafted from the signal
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section id="how-it-works" className="py-16 px-6 border-t border-[#e3e3de] bg-[#ffffff]">
          <div className="max-w-5xl mx-auto space-y-10">
            <div className="text-center max-w-md mx-auto space-y-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86] block">Workflow</span>
              <h2 className="text-2xl font-bold tracking-tight text-[#141414]">How Echo Works</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                {
                  n: '01',
                  t: 'Track your keywords',
                  b: `Competitors, pain points, category questions — up to ${KEYWORD_LIMIT} per workspace.`,
                },
                {
                  n: '02',
                  t: 'Get a feed on your schedule',
                  b: 'Daily, twice a day or every 6 hours, Echo sweeps X, Reddit, the web and the press and adds every new match to your feed.',
                },
                {
                  n: '03',
                  t: 'Find the right person',
                  b: 'Search the company for the decision maker and reveal a verified work email or direct phone.',
                },
                {
                  n: '04',
                  t: 'Send & follow through',
                  b: 'Draft with AI, send from your mailbox or domain, and move the lead through your pipeline.',
                },
              ].map((s) => (
                <div key={s.n} className="border border-[#e3e3de] p-5 space-y-3 bg-[#f6f6f4]">
                  <span className="text-xl font-mono font-bold text-[#8a8a86]">{s.n}</span>
                  <h3 className="text-sm font-bold text-[#141414]">{s.t}</h3>
                  <p className="text-xs text-[#4a4a47] font-mono leading-relaxed">{s.b}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <LandingPricing
          packages={packages}
          costGroups={COST_GROUPS}
          welcomeCredits={WELCOME_CREDITS}
          welcomeSweeps={WELCOME_SWEEPS}
          sweepCost={MAX_SWEEP_CREDITS}
          emailRevealCredits={VERIFIED_EMAIL_CREDITS}
          connectedSendCredits={CONNECTED_SEND_CREDITS}
          keywordLimit={KEYWORD_LIMIT}
          channelLimit={CHANNEL_LIMIT}
          onBuy={beginPurchase}
          onStart={() => (isLoggedIn ? onNavigateDashboard() : onNavigateAuth())}
        />

        {/* FAQ */}
        <section id="faq" className="py-16 px-6 border-t border-[#e3e3de] bg-[#f6f6f4]">
          <div className="max-w-3xl mx-auto space-y-8">
            <div className="text-center max-w-sm mx-auto space-y-1">
              <span className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86] block">FAQ</span>
              <h2 className="text-2xl font-bold tracking-tight text-[#141414]">Frequently Asked Questions</h2>
            </div>

            <div className="divide-y divide-[#e3e3de] border-y border-[#e3e3de]">
              {faqs.map((faq, idx) => {
                const isOpen = openFaq === idx;
                return (
                  <div key={idx} className="py-4">
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? null : idx)}
                      aria-expanded={isOpen}
                      aria-controls={`faq-answer-${idx}`}
                      className="w-full flex items-center justify-between gap-4 text-left text-xs font-mono font-semibold text-[#141414] hover:text-black cursor-pointer"
                    >
                      <span>{faq.q}</span>
                      <ChevronDown
                        className={`w-3.5 h-3.5 shrink-0 text-[#8a8a86] transition-transform ${isOpen ? 'rotate-180 text-[#141414]' : ''}`}
                      />
                    </button>
                    {isOpen && (
                      <p id={`faq-answer-${idx}`} className="mt-2 text-xs font-mono text-[#4a4a47] leading-relaxed pr-6">{faq.a}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="py-16 px-6 border-t border-[#e3e3de] bg-[#141414] text-white text-center">
          <div className="max-w-2xl mx-auto space-y-5">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Your next customer is posting about it today.
            </h2>
            <p className="text-xs text-[#8a8a86] font-mono">
              {WELCOME_CREDITS} free credits for feed sweeps to start. No card, no subscription.
            </p>
            <div>
              <button
                onClick={handleCta}
                className="inline-flex items-center gap-2 px-6 py-3 bg-white hover:bg-[#f6f6f4] text-[#141414] text-xs font-mono font-semibold transition-colors cursor-pointer"
              >
                <span>{isLoggedIn ? 'Go to Dashboard' : 'Create free account'}</span>
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
          <p>© {COPYRIGHT_YEAR} Echo. All rights reserved.</p>
          <div className="flex items-center gap-3 text-[#4a4a47]">
            <a href="#features" className="hover:text-[#141414]">Feed</a>
            <span>•</span>
            <a href="#features" className="hover:text-[#141414]">Leads</a>
            <span>•</span>
            <a href="#features" className="hover:text-[#141414]">Mail</a>
            <span>•</span>
            <a href="#pricing" className="hover:text-[#141414]">Pricing</a>
          </div>
        </div>
      </footer>
    </div>
  );
};
