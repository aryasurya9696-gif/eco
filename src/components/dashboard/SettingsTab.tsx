import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useEcho } from '../../context/EchoContext';
import {
  validateWebhookUrl,
  INTENT_THRESHOLD_OPTIONS,
  RETENTION_OPTIONS,
} from '../../lib/constants';
import {
  Save,
  Bell,
  MessageSquare,
  Clock,
  ShieldCheck,
  Building2,
  Globe,
  Sparkles,
  Calendar,
  Share2,
  Radio,
} from 'lucide-react';
import { PlatformBadge } from '../common/PlatformBadge';
import { getPlan } from '../../lib/billing';

/** Single source of truth for webhook rules lives in lib/constants. */
const validateWebhook = validateWebhookUrl;

export const SettingsTab: React.FC = () => {
  const { user, profile, updateProfile } = useAuth();
  const {
    keywords,
    keywordLimit,
    posts,
    slackWebhook,
    setSlackWebhook,
    emailDigest,
    setEmailDigest,
    lookbackHours,
    setLookbackHours,
    sweepTime,
    setSweepTime,
    sweepCadence,
    setSweepCadence,
    minIntentThreshold,
    setMinIntentThreshold,
    feedRetentionDays,
    setFeedRetentionDays,
    pruneFeed,
    enabledChannels,
    toggleChannel,
    saveSettings,
    sendTestWebhook,
    subscriptionPlan,
    addToast,
  } = useEcho();

  const [fullName, setFullName] = useState<string>(profile?.full_name || '');
  const [website, setWebsite] = useState<string>(profile?.website || '');
  const [coreOffer, setCoreOffer] = useState<string>(profile?.core_offer || '');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isSendingTest, setIsSendingTest] = useState<boolean>(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);

  const planDetails = getPlan(subscriptionPlan);

  const handleWebhookChange = (value: string) => {
    setSlackWebhook(value);
    if (webhookError) setWebhookError(validateWebhook(value));
  };

  const handleWebhookBlur = () => setWebhookError(validateWebhook(slackWebhook));

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    const result = await updateProfile({
      full_name: fullName,
      website: website,
      core_offer: coreOffer,
    });
    await saveSettings();
    setIsSaving(false);
    if (result.error) {
      addToast(`Could not save: ${result.error}`, 'error');
    }
  };

  const handleTestSlack = async () => {
    if (isSendingTest) return;

    const invalid = validateWebhook(slackWebhook);
    if (invalid) {
      setWebhookError(invalid);
      return;
    }

    setIsSendingTest(true);
    const result = await sendTestWebhook();
    setIsSendingTest(false);
    if (!result.success) {
      addToast(result.error || 'Could not reach the webhook.', 'error');
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#e3e3de]">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#141414]">
            Settings & Workspace Preferences
          </h2>
          <p className="text-xs text-[#8a8a86] font-mono mt-0.5">
            Configure buyer intent parameters, webhook alerts, and workspace identity.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSaveProfile}
            disabled={isSaving}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#121212] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer disabled:opacity-50 shadow-xs"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Saving...' : 'Save All Settings'}</span>
          </button>
        </div>
      </div>

      {/* Main 2-Column Responsive Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left Column: Core Forms (2 cols wide) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Workspace & Business Context */}
          <form onSubmit={handleSaveProfile} className="bg-white border border-[#e3e3de] p-6 space-y-6">
            <div className="flex items-start justify-between border-b border-[#eeeeea] pb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-[#f6f6f4] border border-[#e3e3de]">
                  <Building2 className="w-4 h-4 text-[#141414]" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#141414]">
                    Workspace Profile & Value Proposition
                  </h3>
                  <p className="text-xs text-[#8a8a86] font-mono">
                    Used by Echo to personalize lead detection and tailor AI outreach drafts.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[#4a4a47] block font-medium">
                    Company or Founder Name
                  </label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Alex Rivera"
                    className="w-full px-3.5 py-2.5 bg-white border border-[#deded8] hover:border-[#b5b5b0] focus:border-[#141414] focus:ring-1 focus:ring-[#141414] text-xs font-mono text-[#141414] transition-colors outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[#4a4a47] block font-medium">
                    Website URL
                  </label>
                  <div className="relative">
                    <Globe className="w-3.5 h-3.5 text-[#8a8a86] absolute left-3 top-3 pointer-events-none" />
                    <input
                      type="text"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      placeholder="acme.ai"
                      className="w-full pl-9 pr-3.5 py-2.5 bg-white border border-[#deded8] hover:border-[#b5b5b0] focus:border-[#141414] focus:ring-1 focus:ring-[#141414] text-xs font-mono text-[#141414] transition-colors outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-mono uppercase text-[#4a4a47] block font-medium">
                    Core Offer & Product Description
                  </label>
                  <span className="text-[11px] font-mono text-[#8a8a86]">
                    {coreOffer.length} / 280 characters
                  </span>
                </div>
                <textarea
                  rows={3}
                  value={coreOffer}
                  onChange={(e) => setCoreOffer(e.target.value)}
                  placeholder="Explain what your product solves in 1–2 sentences (e.g. Autonomous AI lead qualification agents for B2B outbound teams)..."
                  className="w-full px-3.5 py-2.5 bg-white border border-[#deded8] hover:border-[#b5b5b0] focus:border-[#141414] focus:ring-1 focus:ring-[#141414] text-xs font-mono text-[#141414] transition-colors outline-none resize-none leading-relaxed"
                />
                <p className="text-[11px] font-mono text-[#8a8a86]">
                  Echo injects this context directly into the AI prompt to draft hyper-relevant replies.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-[#eeeeea]">
              <span className="text-[11px] font-mono text-emerald-700 bg-emerald-50 px-2.5 py-1 border border-emerald-200 inline-flex items-center gap-1.5">
                <Sparkles className="w-3 h-3" />
                <span>AI personalization active</span>
              </span>

              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#f6f6f4] hover:bg-[#ecece7] text-[#141414] border border-[#deded8] text-xs font-mono transition-colors cursor-pointer disabled:opacity-50"
              >
                <Save className="w-3 h-3 text-[#4a4a47]" />
                <span>{isSaving ? 'Saving...' : 'Save Profile'}</span>
              </button>
            </div>
          </form>

          {/* Monitored Channels & Platform Selectivity */}
          <div className="bg-white border border-[#e3e3de] p-6 space-y-6">
            <div className="flex items-start justify-between border-b border-[#eeeeea] pb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-[#f6f6f4] border border-[#e3e3de]">
                  <Share2 className="w-4 h-4 text-[#141414]" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#141414]">
                    Monitored Channels & Platform Selectivity
                  </h3>
                  <p className="text-xs text-[#8a8a86] font-mono">
                    Select exactly which channels Echo scans for your keywords. Disabled platforms are skipped to save API credits.
                  </p>
                </div>
              </div>

              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 border border-emerald-200 text-emerald-800 text-[10px] font-mono font-medium">
                <Radio className="w-2.5 h-2.5 text-emerald-600 animate-pulse" />
                <span>{enabledChannels.length} Active</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {[
                {
                  id: 'twitter' as const,
                  name: 'X (formerly Twitter)',
                  desc: 'High-velocity buying discussions, tool questions & complaints.',
                  supported: true,
                },
                {
                  id: 'reddit' as const,
                  name: 'Reddit Communities',
                  desc: 'Deep technical queries, subreddit recommendations & peer reviews.',
                  supported: true,
                },
                {
                  id: 'google' as const,
                  name: 'Web & Google Discussions',
                  desc: 'Public developer forums, tech blogs, and indexed Q&A portals.',
                  supported: true,
                },
                {
                  id: 'linkedin' as const,
                  name: 'LinkedIn Network',
                  desc: 'B2B enterprise executive announcements and role changes.',
                  supported: true,
                },
                {
                  id: 'news' as const,
                  name: 'Press & News',
                  desc: 'Product launches, funding rounds and hiring signals from the press.',
                  supported: true,
                  badge: 'Free',
                },
              ].map((channel) => {
                const isEnabled = enabledChannels.includes(channel.id);
                return (
                  <div
                    key={channel.id}
                    className={`p-4 border transition-all flex flex-col justify-between ${
                      !channel.supported
                        ? 'bg-[#fbfbfa] border-[#eeeeea] opacity-75'
                        : isEnabled
                        ? 'bg-white border-[#141414] shadow-xs'
                        : 'bg-[#fbfbfa] border-[#e3e3de]'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between pb-2">
                        <div className="flex items-center gap-2">
                          <PlatformBadge platform={channel.id} size={20} />
                          <span className="text-xs font-bold text-[#141414]">
                            {channel.name}
                          </span>
                        </div>

                        {channel.supported ? (
                          <button
                            type="button"
                            onClick={() => toggleChannel(channel.id)}
                            className={`w-11 h-6 flex items-center p-0.5 border transition-colors cursor-pointer ${
                              isEnabled
                                ? 'bg-[#141414] border-[#141414] justify-end'
                                : 'bg-white border-[#deded8] justify-start'
                            }`}
                            aria-label={`Toggle ${channel.name}`}
                          >
                            <span
                              className={`w-4 h-4 block ${
                                isEnabled ? 'bg-white' : 'bg-[#8a8a86]'
                              }`}
                            />
                          </button>
                        ) : (
                          <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 bg-white border border-[#deded8] text-[#8a8a86]">
                            {channel.badge}
                          </span>
                        )}
                      </div>

                      <p className="text-[11px] text-[#8a8a86] font-mono leading-relaxed mt-1">
                        {channel.desc}
                      </p>
                    </div>

                    <div className="pt-3 mt-2 border-t border-[#f6f6f4] flex items-center justify-between text-[10px] font-mono">
                      <span className="text-[#8a8a86]">
                        {isEnabled ? '● Scanning every sweep' : '○ Skipped during sweep'}
                      </span>
                      {channel.supported && (
                        <span className={isEnabled ? 'text-emerald-700 font-semibold' : 'text-[#8a8a86]'}>
                          {isEnabled ? 'API calls per sweep' : 'No API cost'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between pt-1 text-[11px] font-mono text-[#8a8a86]">
              <span>Tip: Turning off channels you do not need cuts down your sweep runtime by up to 60%.</span>
            </div>
          </div>

          {/* Notifications & Webhooks */}
          <div className="bg-white border border-[#e3e3de] p-6 space-y-6">
            <div className="flex items-start justify-between border-b border-[#eeeeea] pb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-[#f6f6f4] border border-[#e3e3de]">
                  <Bell className="w-4 h-4 text-[#141414]" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#141414]">
                    Alerts & Webhook Integrations
                  </h3>
                  <p className="text-xs text-[#8a8a86] font-mono">
                    Receive automated notifications when high-intent leads appear on connected social channels and communities.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-5">
              {/* Email Digest */}
              <div className="flex items-center justify-between p-3.5 bg-[#fbfbfa] border border-[#eeeeea]">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-[#141414]">
                      Daily Automated Digest ({sweepTime} UTC)
                    </span>
                    <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 bg-white border border-[#deded8] text-[#4a4a47]">
                      Email
                    </span>
                  </div>
                  <p className="text-[11px] text-[#8a8a86] font-mono">
                    Delivered to <span className="text-[#141414] font-medium">{user?.email || 'your registered email'}</span> after each {sweepTime} UTC sweep.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setEmailDigest(!emailDigest)}
                  className={`w-11 h-6 flex items-center p-0.5 border border-[#141414] transition-colors cursor-pointer ${
                    emailDigest ? 'bg-[#141414] justify-end' : 'bg-white justify-start'
                  }`}
                  aria-label="Toggle email digest"
                >
                  <span className={`w-4 h-4 block ${emailDigest ? 'bg-white' : 'bg-[#141414]'}`} />
                </button>
              </div>

              {/* Slack / Discord Webhook */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-[#141414] flex items-center gap-1.5 font-mono">
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>Slack or Discord Webhook URL</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleTestSlack()}
                    disabled={isSendingTest || !slackWebhook}
                    className="text-[11px] font-mono text-[#141414] hover:underline cursor-pointer font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isSendingTest ? 'Sending…' : 'Send Test Ping →'}
                  </button>
                </div>

                <input
                  type="url"
                  value={slackWebhook}
                  onChange={(e) => handleWebhookChange(e.target.value)}
                  onBlur={handleWebhookBlur}
                  aria-invalid={Boolean(webhookError)}
                  placeholder="https://hooks.slack.com/services/... or https://discord.com/api/webhooks/..."
                  className={`w-full px-3.5 py-2.5 bg-white border hover:border-[#b5b5b0] focus:ring-1 focus:ring-[#141414] text-xs font-mono text-[#141414] transition-colors outline-none ${
                    webhookError
                      ? 'border-red-400 focus:border-red-500 focus:ring-red-200'
                      : 'border-[#deded8] focus:border-[#141414]'
                  }`}
                />

                {webhookError && (
                  <p className="text-[11px] font-mono text-red-600">{webhookError}</p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] font-mono text-[#8a8a86]">
                  <span>Triggers in real-time when new matching leads are parsed.</span>
                  <span className={slackWebhook ? 'text-emerald-700 font-medium' : 'text-[#8a8a86]'}>
                    {slackWebhook ? '● Webhook Connected' : '○ Webhook Unconfigured'}
                  </span>
                </div>
              </div>

              {/* Minimum Intent Filter Threshold */}
              <div className="space-y-2 pt-2 border-t border-[#eeeeea]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#141414] font-mono">
                    Minimum Intent Alert Threshold
                  </span>
                  <span className="text-xs font-mono text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 border border-emerald-200">
                    {minIntentThreshold === 0 ? 'No filtering' : `${minIntentThreshold}%+ Score`}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {INTENT_THRESHOLD_OPTIONS.map((threshold) => (
                    <button
                      key={threshold}
                      type="button"
                      onClick={() => setMinIntentThreshold(threshold)}
                      className={`py-2 px-3 text-xs font-mono border transition-all cursor-pointer ${
                        minIntentThreshold === threshold
                          ? 'bg-[#141414] text-white border-[#141414] font-medium'
                          : 'bg-white text-[#4a4a47] border-[#deded8] hover:bg-[#f6f6f4]'
                      }`}
                    >
                      {threshold === 0
                        ? 'All mentions'
                        : `${threshold}%${threshold === 75 ? ' (Recommended)' : ''}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Feed retention ─────────────────────────────────────── */}
              <div className="space-y-2 pt-2 border-t border-[#eeeeea]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#141414] font-mono">
                    Feed retention
                  </span>
                  <span className="text-xs font-mono text-[#8a8a86]">
                    {feedRetentionDays === 0
                      ? 'Keeping everything'
                      : `Keeping last ${feedRetentionDays} day${feedRetentionDays === 1 ? '' : 's'}`}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {RETENTION_OPTIONS.map((opt) => (
                    <button
                      key={opt.days}
                      type="button"
                      onClick={() => setFeedRetentionDays(opt.days)}
                      className={`px-2.5 py-1.5 text-[11px] font-mono border transition-all duration-150 cursor-pointer active:scale-[0.97] ${
                        feedRetentionDays === opt.days
                          ? 'bg-[#141414] text-white border-[#141414]'
                          : 'bg-white text-[#4a4a47] border-[#e3e3de] hover:border-[#b5b5b0] hover:bg-[#f6f6f4]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <p className="text-[11px] font-mono text-[#8a8a86] leading-relaxed">
                  After every sweep, mentions older than this window are deleted automatically.
                  Whatever that sweep just found is always kept.
                </p>

                {posts.length > 0 && (
                  <button
                    type="button"
                    onClick={async () => {
                      await saveSettings();
                      const result = await pruneFeed();
                      if (result.success) {
                        addToast(
                          result.deleted
                            ? `Removed ${result.deleted} expired mention(s).`
                            : 'Nothing expired yet.',
                          'success',
                        );
                      } else {
                        addToast(result.error || 'Could not prune the feed.', 'error');
                      }
                    }}
                    className="mt-1 px-3 py-1.5 text-[11px] font-mono border border-[#e3e3de] bg-white text-[#4a4a47] hover:bg-[#f6f6f4] hover:border-[#b5b5b0] transition-all duration-150 cursor-pointer active:scale-[0.97]"
                  >
                    Apply now
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Automated Sweep Schedule & Timing */}
          <div className="bg-white border border-[#e3e3de] p-6 space-y-6">
            <div className="flex items-start justify-between border-b border-[#eeeeea] pb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-[#f6f6f4] border border-[#e3e3de]">
                  <Clock className="w-4 h-4 text-[#141414]" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#141414]">
                    Automated Sweep Schedule & Timing
                  </h3>
                  <p className="text-xs text-[#8a8a86] font-mono">
                    Configure custom execution hours, cadence and sweep scope.
                  </p>
                </div>
              </div>

              <span className="text-[10px] font-mono uppercase px-2 py-0.5 bg-[#f6f6f4] border border-[#deded8] text-[#141414] font-medium">
                {sweepCadence === '24h' ? 'Daily Active' : `${sweepCadence} Active`}
              </span>
            </div>

            <div className="space-y-5">
              {/* Custom Execution Time (UTC) */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-[#141414] flex items-center gap-1.5 font-mono">
                    <Calendar className="w-3.5 h-3.5 text-[#8a8a86]" />
                    <span>Custom Sweep Execution Time (UTC)</span>
                  </label>
                  <span className="text-xs font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 border border-emerald-200 font-medium">
                    Scheduled at {sweepTime} UTC
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: '06:00 UTC', sub: 'Early Morning (Default)', value: '06:00' },
                    { label: '09:00 UTC', sub: 'Market Open', value: '09:00' },
                    { label: '14:00 UTC', sub: 'Midday Peak', value: '14:00' },
                    { label: '18:00 UTC', sub: 'Evening Close', value: '18:00' },
                  ].map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => setSweepTime(preset.value)}
                      className={`p-2.5 text-left border transition-all cursor-pointer ${
                        sweepTime === preset.value
                          ? 'bg-[#141414] text-white border-[#141414]'
                          : 'bg-white text-[#4a4a47] border-[#deded8] hover:bg-[#f6f6f4]'
                      }`}
                    >
                      <div className="text-xs font-mono font-bold">{preset.label}</div>
                      <div
                        className={`text-[10px] font-mono mt-0.5 ${
                          sweepTime === preset.value ? 'text-[#deded8]' : 'text-[#8a8a86]'
                        }`}
                      >
                        {preset.sub}
                      </div>
                    </button>
                  ))}
                </div>

                {/* Custom Time Picker */}
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <span className="text-xs font-mono text-[#8a8a86]">Or enter custom time:</span>
                  <div className="inline-flex items-center gap-2">
                    <input
                      type="time"
                      value={sweepTime}
                      onChange={(e) => setSweepTime(e.target.value || '06:00')}
                      className="px-2.5 py-1.5 bg-[#fbfbfa] border border-[#deded8] text-xs font-mono text-[#141414] focus:outline-none focus:border-[#141414] cursor-pointer"
                    />
                    <span className="text-xs font-mono text-[#4a4a47]">UTC</span>
                  </div>
                </div>
              </div>

              {/* Sweep Frequency / Cadence */}
              <div className="space-y-2 pt-2 border-t border-[#eeeeea]">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-[#141414] font-mono">
                    Execution Frequency
                  </label>
                  <span className="text-[11px] font-mono text-[#8a8a86]">
                    Cadence of automated scans
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: '24h', label: 'Every 24 Hours', badge: 'Standard Daily' },
                    { id: '12h', label: 'Every 12 Hours', badge: 'Twice Daily' },
                    { id: '6h', label: 'Every 6 Hours', badge: 'Accelerated' },
                  ].map((cad) => (
                    <button
                      key={cad.id}
                      type="button"
                      onClick={() => setSweepCadence(cad.id as '24h' | '12h' | '6h')}
                      className={`p-2.5 text-center border transition-all cursor-pointer ${
                        sweepCadence === cad.id
                          ? 'bg-[#141414] text-white border-[#141414]'
                          : 'bg-white text-[#4a4a47] border-[#deded8] hover:bg-[#f6f6f4]'
                      }`}
                    >
                      <div className="text-xs font-mono font-medium">{cad.label}</div>
                      <div
                        className={`text-[10px] font-mono mt-0.5 ${
                          sweepCadence === cad.id ? 'text-[#deded8]' : 'text-[#8a8a86]'
                        }`}
                      >
                        {cad.badge}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Lookback & Pagination Safety */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-[#eeeeea] text-xs font-mono">
                <div className="p-4 border border-[#e3e3de] bg-[#fbfbfa] space-y-2 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-[#141414] font-semibold pb-1">
                      <Clock className="w-3.5 h-3.5 text-[#8a8a86]" />
                      <span>Lookback Duration</span>
                    </div>
                    <p className="text-[11px] text-[#8a8a86]">
                      Time window analyzed during each automated sweep.
                    </p>
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setLookbackHours(24)}
                      className={`flex-1 py-1.5 px-2 text-xs border text-center transition-all cursor-pointer ${
                        lookbackHours === 24
                          ? 'bg-[#141414] text-white border-[#141414] font-medium'
                          : 'bg-white text-[#4a4a47] border-[#deded8] hover:bg-[#f6f6f4]'
                      }`}
                    >
                      24h Standard
                    </button>
                    <button
                      type="button"
                      onClick={() => setLookbackHours(48)}
                      className={`flex-1 py-1.5 px-2 text-xs border text-center transition-all cursor-pointer ${
                        lookbackHours === 48
                          ? 'bg-[#141414] text-white border-[#141414] font-medium'
                          : 'bg-white text-[#4a4a47] border-[#deded8] hover:bg-[#f6f6f4]'
                      }`}
                    >
                      48h Extended
                    </button>
                  </div>
                </div>

                <div className="p-4 border border-[#e3e3de] bg-[#fbfbfa] space-y-2 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-[#141414] font-semibold pb-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Pagination Cap</span>
                    </div>
                    <p className="text-[11px] text-[#8a8a86]">
                      Strict 2-page cap per platform protects API credit limits.
                    </p>
                  </div>

                  <div className="pt-2">
                    <div className="px-2.5 py-1.5 bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-semibold flex items-center justify-between">
                      <span>Rate Safety Locked</span>
                      <span>100% Protected</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Status & Operational Summary (1 col wide) */}
        <div className="space-y-6">
          {/* Workspace Status Overview Card */}
          <div className="bg-white border border-[#e3e3de] p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#eeeeea]">
              <span className="text-xs font-mono uppercase font-bold text-[#141414]">
                Workspace Overview
              </span>
              <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 border border-emerald-200 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Active
              </span>
            </div>

            <div className="space-y-3 text-xs font-mono">
              <div className="flex items-center justify-between py-1 border-b border-[#f6f6f4]">
                <span className="text-[#8a8a86]">Account Plan:</span>
                <span className="font-bold text-[#141414]">
                  {planDetails.name} (${planDetails.monthlyPrice}/mo)
                </span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-[#f6f6f4]">
                <span className="text-[#8a8a86]">Monitored Platforms:</span>
                <span className="text-[#141414] font-medium">
                  {enabledChannels.length} Active ({enabledChannels.map((c) => (c === 'twitter' ? 'X' : c === 'google' ? 'Web' : c.charAt(0).toUpperCase() + c.slice(1))).join(', ')})
                </span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-[#f6f6f4]">
                <span className="text-[#8a8a86]">Tracked Keywords:</span>
                <span className="font-semibold text-[#141414]">
                  {keywords.length} / {keywordLimit} active
                </span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-[#f6f6f4]">
                <span className="text-[#8a8a86]">Leads in Feed:</span>
                <span className="font-semibold text-[#141414]">{posts.length} verified mentions</span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-[#f6f6f4]">
                <span className="text-[#8a8a86]">Next Automated Sweep:</span>
                <span className="text-[#141414] font-medium">
                  {sweepCadence === '24h'
                    ? `Daily at ${sweepTime} UTC`
                    : `Every ${sweepCadence} (${sweepTime} UTC)`}
                </span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-[#f6f6f4]">
                <span className="text-[#8a8a86]">Email Digest:</span>
                <span className={emailDigest ? 'text-emerald-700 font-medium' : 'text-[#8a8a86]'}>
                  {emailDigest ? `Active (${sweepTime} UTC)` : 'Disabled'}
                </span>
              </div>

              <div className="flex items-center justify-between py-1">
                <span className="text-[#8a8a86]">Data Security:</span>
                <span className="text-emerald-700 font-medium flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Encrypted & Isolated
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
