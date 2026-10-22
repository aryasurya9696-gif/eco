import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useEcho } from '../../context/EchoContext';
import {
  CHANNEL_LIMIT,
  creditsText,
  formatCreditAmount,
  INTENT_THRESHOLD_OPTIONS,
  RETENTION_OPTIONS,
} from '../../lib/constants';
import { usePricing } from '../../lib/pricing';
import { CADENCE_LABELS, formatNextSweep, sweepsPerDay } from '../../lib/schedule';
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

/** Sweep intervals, slowest first. */
const CADENCES = (['24h', '12h', '6h', 'off'] as const).map((id) => ({ id, label: CADENCE_LABELS[id] }));

/** The cron runs hourly, so the start time is an hour (minutes were ignored). */
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

const CHANNELS: {
  id: Platform;
  name: string;
  desc: string;
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
  },
];

const LOOKBACKS = [
  { hours: 24, label: 'Last 24 hours' },
  { hours: 48, label: 'Last 48 hours' },
] as const;

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

/**
 * A labelled field. With `htmlFor` the label is a real <label> for that
 * control; without it (button groups) the children are a group named by it.
 */
const Field: React.FC<{
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, htmlFor, hint, aside, children }) => {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        {htmlFor ? (
          <label htmlFor={htmlFor} id={labelId} className="text-xs font-mono font-medium text-[#141414]">
            {label}
          </label>
        ) : (
          <span id={labelId} className="text-xs font-mono font-medium text-[#141414]">
            {label}
          </span>
        )}
        {aside}
      </div>
      {htmlFor ? (
        children
      ) : (
        <div role="group" aria-labelledby={labelId} aria-describedby={hint ? hintId : undefined}>
          {children}
        </div>
      )}
      {hint && (
        <p id={hintId} className="text-[11px] font-mono text-[#8a8a86] leading-relaxed">{hint}</p>
      )}
    </div>
  );
};

/** Segmented control. Every option gets an equal column. */
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
    hasUnsavedSettings,
    discardSettingsChanges,
    addToast,
  } = useEcho();
  const pricing = usePricing(Boolean(profile));

  const [fullName, setFullName] = useState<string>(profile?.full_name || '');
  const [website, setWebsite] = useState<string>(profile?.website || '');
  const [coreOffer, setCoreOffer] = useState<string>(profile?.core_offer || '');
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // The profile often arrives after first render (or changes after a save or
  // onboarding). Re-sync the form when it does, but never over unsaved edits:
  // a field is only replaced while it still shows the previous profile value.
  const syncedProfile = useRef({ full_name: profile?.full_name || '', website: profile?.website || '', core_offer: profile?.core_offer || '' });
  useEffect(() => {
    const next = { full_name: profile?.full_name || '', website: profile?.website || '', core_offer: profile?.core_offer || '' };
    const prev = syncedProfile.current;
    setFullName((v) => (v === prev.full_name ? next.full_name : v));
    setWebsite((v) => (v === prev.website ? next.website : v));
    setCoreOffer((v) => (v === prev.core_offer ? next.core_offer : v));
    syncedProfile.current = next;
  }, [profile?.full_name, profile?.website, profile?.core_offer]);

  // One ticking clock drives every relative timestamp on the page, so the
  // "next sweep" countdown stays honest instead of freezing at first render.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  // Mirrors public.channel_limit() on the server.
  const channelLimit = CHANNEL_LIMIT;

  const profileDirty =
    fullName !== (profile?.full_name || '') ||
    website !== (profile?.website || '') ||
    coreOffer !== (profile?.core_offer || '');
  const isDirty = hasUnsavedSettings || profileDirty;

  // What one sweep costs with the settings on screen (fractional credits).
  const activeKeywordCount = keywords.filter((k) => k.is_active).length;
  const perKeyword = enabledChannels.reduce((sum, c) => sum + pricing.channelCredits(c), 0);
  const sweepCost = activeKeywordCount * perKeyword;
  const perDay = sweepsPerDay(sweepCadence);
  const autoOff = sweepCadence === 'off';

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    // Without the loaded profile the form shows blanks and defaults; saving
    // them would overwrite the real values.
    if (!profile) {
      addToast('Your profile has not loaded yet, so nothing was saved.', 'error');
      return;
    }
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
    const hadUnsaved = hasUnsavedSettings;
    const saved = await saveSettings();
    if (!saved.ok) {
      addToast(saved.warning || 'Could not save your retention setting.', 'error');
      return;
    }

    const result = await pruneFeed();
    if (result.success) {
      // Saving the retention window saves the other pending settings with it,
      // so the message says so instead of implying only a prune happened.
      const outcome = result.deleted
        ? `Removed ${result.deleted} expired mention${result.deleted === 1 ? '' : 's'}.`
        : 'Nothing has expired yet.';
      addToast(hadUnsaved ? `Settings saved. ${outcome}` : outcome, 'success');
    } else {
      addToast(result.error || 'Could not apply retention.', 'error');
    }
  };

  const nextSweepLabel = formatNextSweep(sweepTime, sweepCadence, now);

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
          <p className="text-[11px] text-[#8a8a86] font-mono mt-1" aria-live="polite">
            {!profile
              ? 'Loading your saved settings…'
              : isDirty
              ? 'You have unsaved changes. Sweeps and the feed use your saved settings until you save.'
              : 'Saved to your account and applied to the next sweep.'}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
        {hasUnsavedSettings && (
          <button
            type="button"
            onClick={discardSettingsChanges}
            disabled={isSaving}
            className="px-3 py-2.5 text-xs font-mono border border-[#deded8] bg-white text-[#4a4a47] hover:bg-[#f6f6f4] cursor-pointer disabled:opacity-50"
          >
            Discard changes
          </button>
        )}
        <button
          type="submit"
          disabled={isSaving || !profile}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#121212] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer disabled:opacity-50 shrink-0"
        >
          <Save className="w-3.5 h-3.5" />
          <span>{isSaving ? 'Saving…' : 'Save changes'}</span>
        </button>
        </div>
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
          <Field label="Name" htmlFor="settings-name">
            <input
              id="settings-name"
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Alex Rivera"
              className={inputClass}
            />
          </Field>

          <Field label="Website" htmlFor="settings-website">
            <div className="relative">
              <Globe className="w-3.5 h-3.5 text-[#8a8a86] absolute left-3 top-3 pointer-events-none" aria-hidden="true" />
              <input
                id="settings-website"
                type="text"
                autoComplete="url"
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
          htmlFor="settings-offer"
          hint="One or two sentences. This is what tells a buying mention apart from noise."
          aside={
            <span className="text-[11px] font-mono text-[#8a8a86]">
              {coreOffer.length}/{CORE_OFFER_MAX}
            </span>
          }
        >
          <textarea
            id="settings-offer"
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
        description="Every sweep searches exactly these sources. Credits are charged per keyword on each channel; News is free."
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
                      <span
                        className={`${pillClass} border-[#deded8] text-[#8a8a86]`}
                        title="Credits per keyword, each sweep"
                      >
                        {pricing.channelCredits(channel.id) === 0
                          ? 'Free'
                          : `${formatCreditAmount(pricing.channelCredits(channel.id))} cr / keyword`}
                      </span>
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
        <p className="text-[11px] font-mono text-[#4a4a47]" aria-live="polite">
          {activeKeywordCount} keyword{activeKeywordCount === 1 ? '' : 's'} × {enabledChannels.length} channel
          {enabledChannels.length === 1 ? '' : 's'} ={' '}
          <span className="text-[#141414] font-medium">{creditsText(sweepCost)} per sweep</span>
          {autoOff
            ? ' · automatic sweeps off, so only manual sweeps are charged'
            : perDay > 1
              ? ` · ${creditsText(sweepCost * perDay)} a day`
              : ''}
          {hasUnsavedSettings ? ' (with these unsaved settings)' : ''}
        </p>
      </Section>

      {/* Schedule ------------------------------------------------------- */}
      <Section
        icon={<Clock className="w-4 h-4 text-[#141414]" />}
        title="Sweep schedule"
        description="When Echo runs on its own. All times are UTC. Choose Off to only sweep when you click Run sweep."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field
            label="Start time (UTC)"
            htmlFor="settings-sweep-time"
            hint={autoOff ? 'Not used while automatic sweeps are off.' : 'Sweeps start on the hour.'}
          >
            <select
              id="settings-sweep-time"
              disabled={autoOff}
              value={HOURS.includes(sweepTime) ? sweepTime : `${sweepTime.slice(0, 2)}:00`}
              onChange={(e) => setSweepTime(e.target.value || '06:00')}
              className={`${inputClass} cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
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
          hint="How far back each sweep looks. A wider window catches slower-moving conversations; the price per keyword is the same."
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
