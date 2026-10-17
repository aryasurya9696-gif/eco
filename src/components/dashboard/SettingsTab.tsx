import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useEcho } from '../../context/EchoContext';
import { INTENT_THRESHOLD_OPTIONS, RETENTION_OPTIONS } from '../../lib/constants';
import {
  Save,
  Building2,
  Globe,
  Radio,
  Clock,
  Inbox,
  Sparkles,
} from 'lucide-react';
import { PlatformBadge } from '../common/PlatformBadge';
import type { Platform } from '../../types';

const CORE_OFFER_MAX = 280;

/** Sweep intervals, slowest first. Index order is the upgrade order. */
const CADENCES = [
  { id: '24h', label: 'Daily', hours: 24 },
  { id: '12h', label: 'Twice a day', hours: 12 },
  { id: '6h', label: 'Every 6 hours', hours: 6 },
] as const;

const CHANNELS: {
  id: Platform;
  name: string;
  desc: string;
  tag?: string;
}[] = [
  {
    id: 'twitter',
    name: 'X (Twitter)',
    desc: 'Buying discussions, tool questions and public complaints.',
  },
  {
    id: 'reddit',
    name: 'Reddit',
    desc: 'Technical queries, peer reviews and community recommendations.',
  },
  {
    id: 'google',
    name: 'Web discussions',
    desc: 'Forums, Q&A portals and indexed community threads.',
  },
  {
    id: 'news',
    name: 'Press & news',
    desc: 'Launches, funding rounds and hiring signals.',
    tag: 'Free',
  },
];

const LOOKBACKS = [
  { hours: 24, label: 'Last 24 hours' },
  { hours: 48, label: 'Last 48 hours' },
] as const;

/**
 * Mirrors isSweepDue() in supabase/functions/daily-sweep. The cron wakes up
 * every hour, so "when is my next sweep" is just the next hour-of-day that
 * satisfies the same modulo rule the sweep itself uses.
 */
function isSweepDue(hour: number, sweepHour: number, cadenceHours: number): boolean {
  if (cadenceHours >= 24) return hour === sweepHour;
  return hour % cadenceHours === sweepHour % cadenceHours;
}

const relative = (target: Date, now: Date): string => {
  const mins = Math.max(1, Math.round((target.getTime() - now.getTime()) / 60000));
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `in ${hrs}h` : `in ${Math.round(hrs / 24)}d`;
};

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const Section: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, description, aside, children }) => (
  <section className="bg-white border border-[#e3e3de]">
    <header className="flex items-start justify-between gap-4 px-6 py-4 border-b border-[#eeeeea]">
      <div className="flex items-start gap-3">
        <span className="shrink-0 w-8 h-8 bg-[#f6f6f4] border border-[#e3e3de] flex items-center justify-center">
          {icon}
        </span>
        <div>
          <h3 className="text-sm font-bold text-[#141414]">{title}</h3>
          <p className="text-[11px] text-[#8a8a86] font-mono mt-0.5 max-w-prose">
            {description}
          </p>
        </div>
      </div>
      {aside}
    </header>
    <div className="p-6 space-y-5">{children}</div>
  </section>
);

const Field: React.FC<{
  label: string;
  hint?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, hint, aside, children }) => (
  <div className="space-y-2">
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs font-mono font-medium text-[#141414]">{label}</span>
      {aside}
    </div>
    {children}
    {hint && (
      <p className="text-[11px] font-mono text-[#8a8a86] leading-relaxed">{hint}</p>
    )}
  </div>
);

//** Segmented control. Every option gets an equal column. */
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  format,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  format?: (option: T) => string;
}) {
  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const selected = option === value;

        return (
          <button
            key={String(option)}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option)}
            className={`px-3 py-2 text-[11px] font-mono border transition-colors duration-150 cursor-pointer active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35 disabled:active:scale-100 ${
              selected
                ? 'bg-[#141414] text-white border-[#141414] font-medium'
                : 'bg-white text-[#4a4a47] border-[#deded8] hover:bg-[#f6f6f4] hover:border-[#b5b5b0]'
            }`}
          >
            {format ? format(option) : String(option)}
          </button>
        );
      })}
    </div>
  );
}

const inputClass =
  'w-full px-3.5 py-2.5 bg-white border border-[#deded8] hover:border-[#b5b5b0] focus:border-[#141414] focus:ring-1 focus:ring-[#141414] text-xs font-mono text-[#141414] transition-colors outline-none';

const pillClass =
  'text-[10px] font-mono px-2 py-0.5 border whitespace-nowrap font-medium';

// ---------------------------------------------------------------------------

export const SettingsTab: React.FC = () => {
  const { profile, updateProfile } = useAuth();
  const {
    keywords,
    keywordLimit,
    posts,
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
    addToast,
  } = useEcho();

  const [fullName, setFullName] = useState<string>(profile?.full_name || '');
  const [website, setWebsite] = useState<string>(profile?.website || '');
  const [coreOffer, setCoreOffer] = useState<string>(profile?.core_offer || '');
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // One ticking clock drives every relative timestamp on the page, so the
  // "next sweep" countdown stays honest instead of freezing at first render.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  // Echo is free, so these are the product's limits rather than anything a
  // workspace can buy past. They mirror public.keyword_limit() and
  // public.channel_limit() on the server.
  const channelLimit = 3;

  const cadenceHours =
    CADENCES.find((c) => c.id === sweepCadence)?.hours ?? 24;
  const sweepHour = useMemo(() => {
    const parsed = /^(\d{1,2}):/.exec(sweepTime);
    const hour = parsed ? Number(parsed[1]) : 6;
    return hour >= 0 && hour <= 23 ? hour : 6;
  }, [sweepTime]);

  const nextSweep = useMemo(() => {
    const midnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    for (let offset = 0; offset <= 24; offset += 1) {
      const candidate = new Date(midnight + (offset * 24 + sweepHour) * 3600_000);
      if (candidate <= now) continue;
      if (isSweepDue(candidate.getUTCHours(), sweepHour, cadenceHours)) {
        return candidate;
      }
    }
    return null;
  }, [now, sweepHour, cadenceHours]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    // Both writes, one message. The profile save is what the user asked for; the
    // settings sync rides along with it, and its outcome is folded into the same
    // notification instead of being announced separately. saveSettings used to
    // toast on both paths, so every Save press produced two messages.
    const [profileResult, settingsResult] = await Promise.all([
      updateProfile({ full_name: fullName, website, core_offer: coreOffer }),
      saveSettings(),
    ]);

    setIsSaving(false);

    if (profileResult.error) {
      addToast(`Could not save: ${profileResult.error}`, 'error');
      return;
    }
    if (settingsResult.warning) {
      addToast(settingsResult.warning, 'error');
      return;
    }
    addToast('Settings saved.', 'success');
  };

  const channelLimitReached = enabledChannels.length >= channelLimit;

  const handleToggleChannel = (id: Platform) => {
    const active = enabledChannels.includes(id);
    if (!active && channelLimitReached) {
      addToast(
        `You can monitor ${channelLimit} channels. Remove one to add another.`,
        'error',
      );
      return;
    }
    toggleChannel(id);
  };

  const handlePrune = async () => {
    // Retention is read from the profile, so the pending retention setting has to
    // land before pruning. Its failure is surfaced rather than swallowed — the
    // prune would otherwise run against the old value and report a success that
    // used the wrong number.
    const saved = await saveSettings();
    if (!saved.ok) {
      addToast(saved.warning || 'Could not save your retention setting.', 'error');
      return;
    }

    const result = await pruneFeed();
    if (result.success) {
      addToast(
        result.deleted
          ? `Removed ${result.deleted} expired mention${result.deleted === 1 ? '' : 's'}.`
          : 'Nothing has expired yet.',
        'success',
      );
    } else {
      addToast(result.error || 'Could not apply retention.', 'error');
    }
  };

  const nextSweepLabel = nextSweep
    ? `${nextSweep.toLocaleString('en-US', {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      })} UTC · ${relative(nextSweep, now)}`
    : 'Not scheduled';

  return (
    <form
      onSubmit={handleSaveProfile}
      className="max-w-4xl mx-auto space-y-5 pb-24"
    >
      {/* Header --------------------------------------------------------- */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#141414]">
            Workspace Settings
          </h2>
          <p className="text-[11px] text-[#8a8a86] font-mono mt-1">
            Saved to your account and applied to the next sweep.
          </p>
        </div>

        <button
          type="submit"
          disabled={isSaving}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#121212] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer disabled:opacity-50 shrink-0"
        >
          <Save className="w-3.5 h-3.5" />
          <span>{isSaving ? 'Saving…' : 'Save changes'}</span>
        </button>
      </div>

      {/* At a glance ---------------------------------------------------- */}
      <dl className="grid grid-cols-2 sm:grid-cols-4 border border-[#e3e3de] bg-white divide-x divide-y sm:divide-y-0 sm:divide-x divide-[#eeeeea]">
        {[
          {
            label: 'Keywords',
            value: `${keywords.length}/${keywordLimit}`,
          },
          {
            label: 'Mentions',
            value: `${posts.length}`,
          },
          {
            label: 'Next sweep',
            value: nextSweepLabel,
            wide: true,
          },
        ].map((stat) => (
          <div key={stat.label} className="px-4 py-3 space-y-0.5">
            <dt className="text-[10px] font-mono uppercase tracking-wide text-[#8a8a86]">
              {stat.label}
            </dt>
            <dd
              className={`text-xs font-mono text-[#141414] font-medium ${
                stat.wide ? 'text-[11px]' : ''
              }`}
            >
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Workspace ------------------------------------------------------ */}
      <Section
        icon={<Building2 className="w-4 h-4 text-[#141414]" />}
        title="Workspace"
        description="Your offer is the context every keyword score and AI draft is built from."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Name">
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Alex Rivera"
              className={inputClass}
            />
          </Field>

          <Field label="Website">
            <div className="relative">
              <Globe className="w-3.5 h-3.5 text-[#8a8a86] absolute left-3 top-3 pointer-events-none" />
              <input
                type="text"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="acme.ai"
                className={`${inputClass} pl-9`}
              />
            </div>
          </Field>
        </div>

        <Field
          label="What you sell"
          hint="One or two sentences. This is what tells a buying mention apart from noise."
          aside={
            <span className="text-[11px] font-mono text-[#8a8a86]">
              {coreOffer.length}/{CORE_OFFER_MAX}
            </span>
          }
        >
          <textarea
            rows={3}
            maxLength={CORE_OFFER_MAX}
            value={coreOffer}
            onChange={(e) => setCoreOffer(e.target.value)}
            placeholder="e.g. Autonomous AI lead qualification agents for B2B outbound teams"
            className={`${inputClass} resize-none leading-relaxed`}
          />
        </Field>

        {coreOffer.trim().length === 0 && (
          <p className="flex items-start gap-2 text-[11px] font-mono text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 leading-relaxed">
            <Sparkles className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              Add your offer to unlock AI keyword suggestions and outreach drafts.
            </span>
          </p>
        )}
      </Section>

      {/* Channels ------------------------------------------------------- */}
      <Section
        icon={<Radio className="w-4 h-4 text-[#141414]" />}
        title="Channels"
        description="Every sweep searches exactly these sources. Fewer channels means faster sweeps and lower cost."
        aside={
          <span
            className={`${pillClass} ${
              channelLimitReached
                ? 'border-[#141414] text-[#141414]'
                : 'border-[#deded8] text-[#8a8a86]'
            }`}
          >
            {enabledChannels.length}/{channelLimit} used
          </span>
        }
      >
        <ul className="divide-y divide-[#f6f6f4] border border-[#f0f0ec]">
          {CHANNELS.map((channel) => {
            const isEnabled = enabledChannels.includes(channel.id);
            const atLimit = !isEnabled && channelLimitReached;

            return (
              <li
                key={channel.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <PlatformBadge platform={channel.id} size={22} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-[#141414]">
                        {channel.name}
                      </span>
                      {channel.tag && (
                        <span
                          className={`${pillClass} border-emerald-200 bg-emerald-50 text-emerald-700`}
                        >
                          {channel.tag}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#8a8a86] font-mono mt-0.5">
                      {channel.desc}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  aria-label={`${channel.name} monitoring`}
                  disabled={atLimit}
                  title={
                    atLimit
                      ? `You can monitor ${channelLimit} channels`
                      : undefined
                  }
                  onClick={() => handleToggleChannel(channel.id)}
                  className={`shrink-0 w-10 h-[22px] flex items-center p-0.5 border transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                    isEnabled
                      ? 'bg-[#141414] border-[#141414] justify-end'
                      : 'bg-white border-[#deded8] justify-start'
                  }`}
                >
                  <span
                    className={`w-3.5 h-3.5 block transition-colors ${
                      isEnabled ? 'bg-white' : 'bg-[#c9c9c4]'
                    }`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* Schedule ------------------------------------------------------- */}
      <Section
        icon={<Clock className="w-4 h-4 text-[#141414]" />}
        title="Sweep schedule"
        description="When Echo runs on its own. All times are UTC."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field label="Start time">
            <input
              type="time"
              value={sweepTime}
              onChange={(e) => setSweepTime(e.target.value || '06:00')}
              className={`${inputClass} cursor-pointer`}
            />
          </Field>

          <Field label="How often">
            <Segmented
              options={CADENCES.map((c) => c.id)}
              value={sweepCadence}
              onChange={setSweepCadence}
              format={(id) => CADENCES.find((c) => c.id === id)?.label ?? id}
            />
          </Field>
        </div>

        <Field
          label="Search window"
          hint="How far back each sweep looks. A wider window costs more but catches slower-moving conversations."
        >
          <Segmented
            options={LOOKBACKS.map((l) => l.hours)}
            value={lookbackHours}
            onChange={setLookbackHours}
            format={(h) => LOOKBACKS.find((l) => l.hours === h)?.label ?? `${h}h`}
          />
        </Field>

        <div className="flex items-center justify-between px-4 py-3 bg-[#fbfbfa] border border-[#eeeeea]">
          <span className="text-[11px] font-mono text-[#8a8a86]">
            Next automated sweep
          </span>
          <span className="text-[11px] font-mono text-[#141414] font-medium">
            {nextSweepLabel}
          </span>
        </div>
      </Section>

      {/* Feed ----------------------------------------------------------- */}
      <Section
        icon={<Inbox className="w-4 h-4 text-[#141414]" />}
        title="Feed"
        description="Decide what lands in your feed and how long it stays."
      >
        <Field
          label="Minimum intent score"
          hint="Mentions scoring below this are hidden. Lower it to see more, raise it to see only strong buying signals."
          aside={
            <span className="text-[11px] font-mono text-[#141414] font-medium">
              {minIntentThreshold === 0 ? 'Showing everything' : `${minIntentThreshold}+`}
            </span>
          }
        >
          <Segmented
            options={INTENT_THRESHOLD_OPTIONS}
            value={minIntentThreshold}
            onChange={setMinIntentThreshold}
            format={(v) => (v === 0 ? 'All' : `${v}+`)}
          />
        </Field>

        <Field
          label="Keep mentions for"
          hint="Applied after every sweep. Mentions older than this are deleted; whatever the current sweep just found is always kept."
          aside={
            posts.length > 0 ? (
              <button
                type="button"
                onClick={handlePrune}
                className="text-[11px] font-mono text-[#4a4a47] hover:text-[#141414] hover:underline cursor-pointer"
              >
                Apply now
              </button>
            ) : undefined
          }
        >
          <Segmented
            options={RETENTION_OPTIONS.map((o) => o.days)}
            value={feedRetentionDays}
            onChange={setFeedRetentionDays}
            format={(d) => RETENTION_OPTIONS.find((o) => o.days === d)?.label ?? `${d}d`}
          />
        </Field>
      </Section>
    </form>
  );
};
